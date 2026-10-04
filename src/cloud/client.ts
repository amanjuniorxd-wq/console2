/**
 * Cloud adapter: isolated compatibility node streams the game over WebRTC; input goes back over
 * an unordered/unreliable DataChannel (lowest latency). Protocol: server/PROTOCOL.md.
 */
import type { LaunchContext, RuntimeAdapter, Session, Stats, Btn } from '../runtime/types';
import type { Settings } from '../ui/settings-store';
import type { Caps } from '../mpc/probe';
import { getPackage } from '../mpc/store';
import { saveKey, idHeaders } from './identity';
import { FB, LOGICAL_FROM_FULL } from '../input/pad';

/** Console runtime kind → worker runtime on the wire (emulator platforms use their cloud runtime ids). */
export const WIRE_RUNTIME: Record<string, string> = { p2: 'ps2', psp: 'psp' };

export interface Quality { height: number; fps: number; kbps: number }

/** Initial stream target from settings + measured network. Adapted live afterwards. */
export function initialQuality(s: Settings, caps: Caps): Quality {
  const presets: Record<string, Quality> = {
    performance: { height: 720, fps: 60, kbps: 6000 },
    balanced: { height: 1080, fps: 60, kbps: 12000 },
    quality: { height: 1440, fps: 60, kbps: 20000 },
  };
  let q: Quality;
  if (s.cloudQuality !== 'auto') q = { ...presets[s.cloudQuality] };
  else {
    const down = caps.net.downMbps || 10; // downlink is capped at 10 by browsers; treat as "good"
    // Browsers cap/round downlink estimates; start at a sane floor and let live adaptation (adapt()) correct it.
    const kbps = Math.max(4000, Math.min(20000, down * 1000 * 0.6));
    q = { height: kbps >= 12000 ? 1080 : kbps >= 5000 ? 720 : 540, fps: caps.mobile && kbps < 5000 ? 30 : 60, kbps };
  }
  if (s.resolution !== 'auto' && s.resolution !== 'native') q.height = +s.resolution;
  if (s.resolution === 'native') q.height = Math.round(screen.height * devicePixelRatio);
  if (s.maxFps) q.fps = Math.min(q.fps, s.maxFps);
  if (caps.net.saveData) q.kbps = Math.min(q.kbps, 3000);
  return q;
}

/** Pure adaptation step (AIMD): back off fast on loss/latency, probe up slowly. */
export function adapt(q: Quality, max: Quality, loss: number, rttMs: number): Quality {
  if (loss > 0.02 || rttMs > 150) return { ...q, kbps: Math.max(1000, Math.round(q.kbps * 0.75)), height: q.kbps * 0.75 < 4000 ? Math.min(q.height, 720) : q.height };
  if (loss < 0.005 && rttMs < 80) return { ...q, kbps: Math.min(max.kbps, Math.round(q.kbps * 1.08)), height: q.kbps * 1.08 >= 8000 ? max.height : q.height };
  return q;
}

const base = (s: Settings) => s.cloudEndpoint.replace(/\/+$/, '');
let iceCache: { ep: string; servers: RTCIceServer[] } | null = null;

async function api(s: Settings, path: string, init?: RequestInit): Promise<Response> {
  const r = await fetch(base(s) + path, { ...init, headers: { 'content-type': 'application/json', ...idHeaders(), ...(init?.headers || {}) } });
  return r;
}

async function iceServers(s: Settings): Promise<RTCIceServer[]> {
  if (iceCache?.ep === s.cloudEndpoint) return iceCache.servers;
  const r = await api(s, '/v1/config').catch(() => { throw new Error('Cloud endpoint unreachable.'); });
  if (!r.ok) throw new Error(`Cloud endpoint error (${r.status}).`);
  const j = await r.json();
  iceCache = { ep: s.cloudEndpoint, servers: Array.isArray(j.iceServers) ? j.iceServers : [] };
  return iceCache.servers;
}

/** Ship user-attached packages once per content hash (dedup → no re-upload across sessions/devices). */
async function packageRef(ctx: LaunchContext): Promise<{ url?: string; cas?: string; catalogId?: string; upload?: string }> {
  const { game, settings: s, status, signal } = ctx;
  // Titles registered on the cloud (e.g. Windows games published with cloud/tools/pack.mjs) are named, never shipped.
  if (game.url.startsWith('cloud:')) return { catalogId: game.url.slice(6) };
  // Console titles the player uploaded to their cloud (Upload Game → "Upload to your cloud").
  if (game.url.startsWith('upload:')) return { upload: game.url.slice(7) };
  // A Windows .exe kept on this device: chunked, resumable, deduplicated upload; the cloud inspects the bytes.
  if (game.url.startsWith('idb:') && (game.runtime === 'x64-win' || game.runtime === 'x86')) {
    const pkg = await getPackage(game);
    const { upload } = await import('../storage/upload');
    status('Uploading', 0);
    const r = await upload([{ path: 'game.exe', blob: new Blob([pkg.bytes]) }], { title: game.title, signal, onProgress: p => status(p.phase === 'hashing' ? 'Preparing upload' : 'Uploading', p.total ? p.done / p.total : 0) });
    return { upload: r.id };
  }
  if (!game.url.startsWith('idb:') && !game.sha256) return { url: new URL(game.url, location.href).href };
  const hash = game.sha256 ?? (await getPackage(game)).hash;
  const head = await api(s, `/v1/packages/${hash}`, { method: 'HEAD', signal });
  if (head.ok) return { cas: hash };
  if (!game.url.startsWith('idb:')) return { url: new URL(game.url, location.href).href };
  status('Uploading', 0);
  const pkg = await getPackage(game);
  const put = await fetch(`${base(s)}/v1/packages/${hash}`, { method: 'PUT', body: pkg.bytes, headers: { 'content-type': 'application/octet-stream' }, signal });
  if (!put.ok) throw new Error(`Upload rejected (${put.status}).`);
  return { cas: hash };
}


const notice = (text: string) => dispatchEvent(new CustomEvent('mishrin:notice', { detail: text }));

function waitIce(pc: RTCPeerConnection, ms: number): Promise<void> {
  if (pc.iceGatheringState === 'complete') return Promise.resolve();
  return new Promise(res => {
    const t = setTimeout(res, ms);
    pc.addEventListener('icegatheringstatechange', () => { if (pc.iceGatheringState === 'complete') { clearTimeout(t); res(); } });
  });
}

export const cloud: RuntimeAdapter = {
  backend: 'cloud',
  async launch(ctx: LaunchContext): Promise<Session> {
    const { game, host, caps, settings: s, signal, status } = ctx;
    if (!s.cloudEndpoint) throw new Error('No cloud endpoint configured.');
    status('Connecting to cloud', 0);
    const [servers, ref] = await Promise.all([iceServers(s), packageRef(ctx)]);
    signal.throwIfAborted();

    // Control handlers exist before negotiation so the node's first message (caps) is never missed.
    let ended = false, onEnd: ((r: string) => void) | undefined;
    const end = (why: string) => { if (ended) return; ended = true; onEnd?.(why); };
    const pending = new Map<number, (m: { data?: string; ok?: boolean }) => void>();
    let seq = 0, canSave = false, paused = false, fullPad = false;
    const onCtl = (e: MessageEvent) => {
      try {
        const m = JSON.parse(e.data);
        if (m.t === 'caps') { canSave = !!m.save; fullPad = m.pad === 'full'; }
        else if ((m.t === 'saved' || m.t === 'loaded') && pending.has(m.id)) { pending.get(m.id)!(m); pending.delete(m.id); }
        else if (m.t === 'notice' && typeof m.text === 'string') notice(m.text.slice(0, 120));
        else if (m.t === 'end') end(m.reason || 'Cloud session ended.');
      } catch { /* ignore malformed */ }
    };
    const makePeer = async () => {
      const pc = new RTCPeerConnection({ iceServers: servers, bundlePolicy: 'max-bundle' });
      const vt = pc.addTransceiver('video', { direction: 'recvonly' });
      pc.addTransceiver('audio', { direction: 'recvonly' });
      // Prefer codecs with broad hardware decode for the lowest client CPU.
      const codecs = RTCRtpReceiver.getCapabilities?.('video')?.codecs ?? [];
      const rank = (m: string) => (/h264/i.test(m) ? 0 : /vp8/i.test(m) ? 1 : /av1/i.test(m) ? 2 : /vp9/i.test(m) ? 3 : 4);
      if (codecs.length && vt.setCodecPreferences) try { vt.setCodecPreferences([...codecs].sort((a, b) => rank(a.mimeType) - rank(b.mimeType))); } catch { /* keep default */ }
      const inputCh = pc.createDataChannel('input', { ordered: false, maxRetransmits: 0 });
      const ctl = pc.createDataChannel('ctl');
      inputCh.binaryType = 'arraybuffer';
      ctl.onmessage = onCtl;
      await pc.setLocalDescription(await pc.createOffer());
      await waitIce(pc, 2500);
      return { pc, inputCh, ctl };
    };
    let peer = await makePeer();
    const sendCtl = (m: object) => { if (peer.ctl.readyState === 'open') peer.ctl.send(JSON.stringify(m)); };
    const pc0 = peer.pc;

    let q = initialQuality(s, caps);
    // Ceiling for upward probing: the chosen preset, or the top tier on Auto (Data Saver keeps its cap).
    const max: Quality = { ...q, kbps: s.cloudQuality === 'auto' && !caps.net.saveData ? 20000 : q.kbps };
    const body = { game: { id: game.id, title: game.title, runtime: WIRE_RUNTIME[game.runtime] ?? game.runtime, launchConfig: game.launchConfig ?? {}, ...ref }, offer: pc0.localDescription!.sdp, prefs: q, client: { os: caps.os, mobile: caps.mobile, saveKey: saveKey() } };
    const create = (extra: object = {}) => api(s, '/api/session', { method: 'POST', signal, body: JSON.stringify({ ...body, ...extra }) })
      .catch(e => { pc0.close(); throw signal.aborted ? e : new Error('Cloud endpoint unreachable.'); });
    let r = await create();
    // Every slot busy → the cloud put us in line: show the position, claim the reserved slot when it is our turn.
    for (let j = r.status === 503 ? await r.clone().json().catch(() => ({})) : {}; r.status === 503 && j.queue; ) {
      const t = j.queue as { ticket: string; token: string; position: number };
      let st = { state: 'waiting', position: t.position };
      while (st.state !== 'ready') {
        status(`Waiting for a cloud slot · position ${st.position}`, 0);
        await new Promise(res => setTimeout(res, 1500));
        signal.throwIfAborted();
        const qr = await api(s, `/api/queue/${t.ticket}?token=${encodeURIComponent(t.token)}`, { signal });
        if (!qr.ok) { pc0.close(); throw new Error('Lost your place in the queue. Try again.'); }
        st = await qr.json();
      }
      status('Starting', 0.3);
      r = await create({ ticket: t.ticket, ticketToken: t.token });
      j = r.status === 503 ? await r.clone().json().catch(() => ({})) : {};
    }
    if (!r.ok) {
      pc0.close();
      const msg = await r.json().then(j => j.error as string).catch(() => '');
      throw new Error(msg || (r.status === 503 ? 'No cloud node available for this title right now.' : `Cloud session refused (${r.status}).`));
    }
    const { id, answer, token } = await r.json() as { id: string; answer: string; token?: string };
    const auth = { 'x-session-token': token || '' };
    await pc0.setRemoteDescription({ type: 'answer', sdp: answer });
    status('Starting stream', 0.6);

    const video = document.createElement('video');
    video.className = 'game-surface';
    video.autoplay = true; video.playsInline = true; video.muted = true;
    video.disablePictureInPicture = true;
    const attach = (pc: RTCPeerConnection) => {
      const stream = new MediaStream();
      pc.getReceivers().forEach(rc => {
        stream.addTrack(rc.track);
        const r2 = rc as RTCRtpReceiver & { jitterBufferTarget?: number; playoutDelayHint?: number };
        try { r2.jitterBufferTarget = 0; } catch { /* unsupported */ }
        try { r2.playoutDelayHint = 0; } catch { /* unsupported */ }
      });
      video.srcObject = stream;
    };
    attach(pc0);
    host.append(video);

    await new Promise<void>((res, rej) => {
      const t = setTimeout(() => rej(new Error('Cloud stream did not start. The network may block WebRTC.')), 15000);
      video.addEventListener('loadeddata', () => { clearTimeout(t); res(); }, { once: true });
      pc0.addEventListener('connectionstatechange', () => { if (pc0.connectionState === 'failed') { clearTimeout(t); rej(new Error('Cloud connection failed.')); } });
      signal.addEventListener('abort', () => { clearTimeout(t); rej(signal.reason); }, { once: true });
    }).catch(e => { pc0.close(); video.remove(); fetch(`${base(s)}/api/session/${id}`, { method: 'DELETE', keepalive: true, headers: auth }).catch(() => {}); throw e; });
    video.play().catch(() => {});
    // Audio is muted until the first user gesture inside the session (autoplay policy).
    const unmute = () => { video.muted = false; };
    addEventListener('pointerdown', unmute, { once: true }); addEventListener('keydown', unmute, { once: true });

    // ---- reconnect: a dropped link (or a failed cloud node) resumes the same session, possibly on another node ----
    let reconnecting = false, dropTimer = 0;
    const reconnect = async () => {
      if (reconnecting || ended) return;
      reconnecting = true;
      notice('Connection lost — reconnecting…');
      for (let attempt = 0; attempt < 4 && !ended; attempt++) {
        try {
          const next = await makePeer();
          const rr = await api(s, `/api/session/${id}/reconnect`, { method: 'POST', headers: auth, body: JSON.stringify({ offer: next.pc.localDescription!.sdp }) });
          if (rr.status === 404 || rr.status === 410) { next.pc.close(); break; }
          if (!rr.ok) { next.pc.close(); throw new Error(String(rr.status)); }
          const j = await rr.json();
          await next.pc.setRemoteDescription({ type: 'answer', sdp: j.answer });
          const old = peer; peer = next; watch(next.pc); attach(next.pc); video.play().catch(() => {});
          old.pc.close();
          notice(j.reassigned ? 'Resumed on another cloud node.' : 'Reconnected.');
          reconnecting = false;
          return;
        } catch { await new Promise(r => setTimeout(r, 1000 * 2 ** attempt)); }
      }
      reconnecting = false;
      end('Cloud connection lost.');
    };
    const watch = (pc: RTCPeerConnection) => pc.addEventListener('connectionstatechange', () => {
      if (pc !== peer.pc || ended) return;
      clearTimeout(dropTimer);
      if (pc.connectionState === 'failed' || pc.connectionState === 'closed') reconnect();
      else if (pc.connectionState === 'disconnected') dropTimer = window.setTimeout(reconnect, 3000); // brief blips recover on their own
    });
    watch(pc0);
    const call = (m: { t: string; data?: string }, timeout = 5000) => new Promise<{ data?: string; ok?: boolean }>(res => {
      const k = ++seq; pending.set(k, res); sendCtl({ ...m, id: k });
      setTimeout(() => { if (pending.delete(k)) res({}); }, timeout);
    });

    // ---- live stats + adaptive bitrate / resolution / fps ----
    const stats: Stats = { fps: 0, frameMs: 0, width: 0, height: 0, route: 'Cloud · stream' };
    let prev = { lost: 0, recv: 0, frames: 0, bytes: 0, t: performance.now() };
    let codec = '';
    const statT = setInterval(async () => {
      let lost = 0, recv = 0, rtt = 0, bytes = 0, jitter = 0;
      const all = await peer.pc.getStats();
      all.forEach((st: any) => {
        if (st.type === 'inbound-rtp' && st.kind === 'video') {
          lost = st.packetsLost ?? 0; recv = st.packetsReceived ?? 0; bytes = st.bytesReceived ?? 0; jitter = (st.jitterBufferDelay ?? 0) / Math.max(1, st.jitterBufferEmittedCount ?? 1) * 1000;
          const fr = st.framesDecoded ?? 0, now = performance.now(); stats.fps = Math.round(st.framesPerSecond ?? ((fr - prev.frames) * 1000) / (now - prev.t)); prev.frames = fr;
          stats.width = st.frameWidth ?? 0; stats.height = st.frameHeight ?? 0; stats.frameMs = +(((st.totalDecodeTime ?? 0) / Math.max(1, st.framesDecoded ?? 1)) * 1000).toFixed(2);
          if (st.codecId) codec = (all.get(st.codecId) as any)?.mimeType?.replace('video/', '') ?? codec;
        }
        if (st.type === 'candidate-pair' && st.state === 'succeeded' && st.nominated) rtt = (st.currentRoundTripTime ?? 0) * 1000;
      });
      const now = performance.now();
      const kbps = Math.round(((bytes - prev.bytes) * 8) / Math.max(1, now - prev.t));
      const dl = lost - prev.lost, dr = recv - prev.recv; prev.lost = lost; prev.recv = recv; prev.bytes = bytes; prev.t = now;
      const loss = dr + dl > 0 ? dl / (dr + dl) : 0;
      const nq = adapt(q, max, loss, rtt);
      if (nq.kbps !== q.kbps || nq.height !== q.height) { q = nq; sendCtl({ t: 'quality', ...q }); }
      stats.extra = `${Math.round(rtt)} ms · ${(kbps / 1000).toFixed(1)} Mbps`;
      stats.details = [
        ['Path', 'Cloud · stream'], ['Connection', `${peer.pc.connectionState}${reconnecting ? ' · reconnecting' : ''}`], ['FPS', String(stats.fps)],
        ['Latency (RTT)', `${Math.round(rtt)} ms`], ['Bitrate', `${(kbps / 1000).toFixed(1)} Mbps received · target ${(q.kbps / 1000).toFixed(1)}`],
        ['Packet loss', `${(loss * 100).toFixed(1)}%`], ['Jitter buffer', `${jitter.toFixed(0)} ms`], ['Video', `${codec || '—'} ${stats.width}×${stats.height}`],
        ['Controller', fullPad ? 'full pad (16 buttons)' : 'logical (mapped by the game)'],
      ];
    }, 2000);

    // ---- keepalive + idle shutdown (frees the cloud node) ----
    let lastInput = Date.now(), hiddenAt = 0;
    const hb = setInterval(() => {
      if (Date.now() - lastInput > s.idleShutdownMin * 60000) return end('Closed after inactivity to free cloud resources.');
      if (hiddenAt && Date.now() - hiddenAt > 120000) return end('Closed while in background to free cloud resources.');
      api(s, `/api/session/${id}/heartbeat`, { method: 'POST', headers: auth }).then(r => { if (r.status === 404) end('Cloud session expired.'); }).catch(() => {});
    }, 15000);
    const vis = () => { hiddenAt = document.hidden ? Date.now() : 0; };
    document.addEventListener('visibilitychange', vis);

    const buf = new Uint8Array(3);
    let prevFull = 0;
    const sendInput = (a: number, b: number, c: number) => { lastInput = Date.now(); if (peer.inputCh.readyState !== 'open') return; buf[0] = a; buf[1] = b; buf[2] = c; peer.inputCh.send(buf); };

    return {
      backend: 'cloud',
      get canSave() { return canSave; },
      ownsInput: false,
      input: (b: Btn, down: boolean) => sendInput(1, b, down ? 1 : 0),
      // Controller / touch buttons use their own message type so PC nodes don't double-press keyboard input.
      padInput: (b: Btn, down: boolean) => sendInput(3, b, down ? 1 : 0),
      // Unified input: emulator workers (caps.pad === 'full') take the whole 16-button state; PC titles get logical
      // button edges, which the worker maps through the game's controllerMap.
      padState(full: number, raw = full, axes: [number, number, number, number] = [0, 0, 0, 0]) {
        // Emulator titles get the real controller: buttons unfolded + both analog sticks (int8) — wire type 5.
        if (fullPad) { lastInput = Date.now(); if (peer.inputCh.readyState === 'open') peer.inputCh.send(new Uint8Array([5, (raw >> 8) & 0xff, raw & 0xff, ...axes.map(v => v & 0xff)])); }
        else for (const [f, b] of LOGICAL_FROM_FULL) { const bit = 1 << FB[f]; if ((full ^ prevFull) & bit) sendInput(3, b, full & bit ? 1 : 0); }
        prevFull = full;
      },
      rawKey(code: string, down: boolean) { lastInput = Date.now(); if (peer.inputCh.readyState === 'open') peer.inputCh.send(`k${down ? 1 : 0}${code}`); },
      pointer(x: number, y: number, buttons: number) {
        lastInput = Date.now(); if (peer.inputCh.readyState !== 'open') return;
        const p = new DataView(new ArrayBuffer(6)); p.setUint8(0, 2); p.setUint8(1, buttons); p.setUint16(2, Math.round(x * 65535)); p.setUint16(4, Math.round(y * 65535)); peer.inputCh.send(p.buffer);
      },
      wheel(steps: number) {
        lastInput = Date.now(); if (peer.inputCh.readyState !== 'open' || !steps) return;
        const p = new DataView(new ArrayBuffer(2)); p.setUint8(0, 4); p.setInt8(1, Math.max(-8, Math.min(8, steps))); peer.inputCh.send(p.buffer);
      },
      async save() { const m = await call({ t: 'save' }, 30000); return m.data ? Uint8Array.from(atob(m.data), c => c.charCodeAt(0)) : null; },
      async load(d) { let bin = ''; d.forEach(b => (bin += String.fromCharCode(b))); return !!(await call({ t: 'load', data: btoa(bin) }, 120000)).ok; },
      pause(on) { if (on !== paused) { paused = on; sendCtl({ t: 'pause', on }); } },
      setScale(k) { q = { ...q, height: Math.max(360, Math.round(max.height * k)) }; sendCtl({ t: 'quality', ...q }); },
      setMaxFps(f) { q = { ...q, fps: f || 60 }; sendCtl({ t: 'quality', ...q }); },
      stats: () => stats,
      get onEnd() { return onEnd; },
      set onEnd(f) { onEnd = f; },
      dispose() {
        ended = true; clearInterval(statT); clearInterval(hb); clearTimeout(dropTimer);
        document.removeEventListener('visibilitychange', vis);
        removeEventListener('pointerdown', unmute); removeEventListener('keydown', unmute);
        fetch(`${base(s)}/api/session/${id}`, { method: 'DELETE', keepalive: true, headers: auth }).catch(() => {});
        peer.pc.close(); video.srcObject = null; video.remove();
      },
    } as Session;
  },
};
