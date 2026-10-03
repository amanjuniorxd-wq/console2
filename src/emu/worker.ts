/// <reference lib="webworker" />
/**
 * Mishrin emulator worker: one per running game. Owns the backend (core), the deterministic frame scheduler,
 * the presenter (WebGPU or Canvas2D) and audio output. The UI thread only forwards input and draws nothing.
 */
import type { CoreInfo, EmulatorBackend, EmuStats, InitOptions } from './types';
import type { Presenter } from './present';
import { framesDue, adaptPresent, type Plan } from '../mpc/optimizer';

const post = (m: unknown, t: Transferable[] = []) => (self as unknown as DedicatedWorkerGlobalScope).postMessage(m, t);
const BACKENDS: Record<string, () => Promise<() => EmulatorBackend>> = {
  p1: () => import('./backends/p1').then(m => m.createP1),
};

let be: EmulatorBackend | null = null;
let presenter: Presenter | null = null;
let info: CoreInfo;
let running = false, paused = false, stepping = false;
let start = 0, framesRun = 0, presentEvery = 1, maxCatchUp = 3, budget: Plan | null = null;
let audioSab: Int16Array | null = null, audioCtl: Int32Array | null = null, audioPort: MessagePort | null = null;
const mask = [0, 0];
/** Buttons pressed since the last emulated frame: a tap shorter than one frame is still delivered for one frame. */
const latch = [0, 0];
// rolling 1s stats
let sFrames = 0, sPresented = 0, sEmu = 0, sPresent = 0, sBehind = 0, sBusy = 0, sT = performance.now();
let lastCardHash = 0, cardT = 0;
let gpuLost = '';
let pendingInputAt = 0, appliedInputAt = 0, latSum = 0, latN = 0;

const raf: (cb: (t: number) => void) => unknown = typeof requestAnimationFrame === 'function'
  ? requestAnimationFrame : (cb) => setTimeout(() => cb(performance.now()), 4);

/** Diagnostics: centroid/extent of saffron (#FF8A00-like) pixels, normalised to the image. */
function locate(d: Uint8Array, w: number, h: number) {
  let n = 0, sx = 0, sy = 0, x0 = w, x1 = -1, y0 = h, y1 = -1, black = 0, gold = 0, green = 0;
  for (let i = 0; i < w * h; i++) {
    const R = d[i * 4], G = d[i * 4 + 1], B = d[i * 4 + 2];
    if (R > 220 && G > 100 && G < 170 && B < 50) { n++; const x = i % w, y = (i / w) | 0; sx += x; sy += y; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
    else if (R + G + B === 0) black++;
    else if (R > 190 && G > 150 && G < 200 && B < 90) gold++;
    else if (R < 40 && G > 200 && B < 40) green++;
  }
  return { pixels: n, x: n ? sx / n / w : -1, y: n ? sy / n / h : -1, boxW: n ? x1 - x0 + 1 : 0, boxH: n ? y1 - y0 + 1 : 0, blackRatio: +(black / (w * h)).toFixed(3), gold, green };
}

function fnv(u: Uint8Array) { let h = 0x811c9dc5; for (let i = 0; i < u.length; i += 4) h = Math.imul(h ^ (u[i] | (u[i + 1] << 8) | (u[i + 2] << 16) | (u[i + 3] << 24)), 16777619); return h >>> 0; }

function pushAudio(pcm: Int16Array) {
  if (!pcm.length) return;
  if (audioSab && audioCtl) {
    // single-producer ring: [0]=write index, [1]=read index (in samples), capacity = audioSab.length
    const cap = audioSab.length, w = Atomics.load(audioCtl, 0), r = Atomics.load(audioCtl, 1);
    const free = cap - 1 - ((w - r + cap) % cap);
    const n = Math.min(pcm.length, free);
    for (let i = 0; i < n; i++) audioSab[(w + i) % cap] = pcm[i];
    Atomics.store(audioCtl, 0, (w + n) % cap);
  } else if (audioPort) {
    const copy = pcm.slice();
    audioPort.postMessage(copy, [copy.buffer]);
  }
}

function emulate(n: number) {
  for (let i = 0; i < n; i++) {
    for (let p = 0; p < 2; p++) { be!.setControllerInput(p, mask[p] | latch[p]); latch[p] = 0; }
    if (pendingInputAt) { appliedInputAt = pendingInputAt; pendingInputAt = 0; }
    const t0 = performance.now();
    be!.runFrame();
    const t1 = performance.now();
    sEmu += t1 - t0; sFrames++; framesRun++;
    pushAudio(be!.audio());
    const last = i === n - 1;
    if (last && framesRun % presentEvery === 0) {
      const fb = be!.framebuffer();
      if (fb.width && fb.height) {
        presenter!.present(fb.data, fb.width, fb.height); sPresented++;
        if (appliedInputAt) { latSum += performance.timeOrigin + performance.now() - appliedInputAt; latN++; appliedInputAt = 0; }
      }
      sPresent += performance.now() - t1;
    }
  }
}

function tick(now: number) {
  if (!running) return;
  raf(tick);
  if (paused) { start = now - (framesRun * 1000) / info.fps; return; }
  const t0 = performance.now();
  const d = framesDue(start, now, framesRun, info.fps, maxCatchUp);
  if (d.resync) start = now - (framesRun * 1000) / info.fps;
  if (d.run > 1) sBehind++;
  if (d.run) emulate(d.run);
  sBusy += performance.now() - t0;
  if (now - cardT > 2000) {                       // persist memory card only when its contents change
    cardT = now;
    const c = be!.memoryCard();
    if (c) { const h = fnv(c); if (lastCardHash && h !== lastCardHash) post({ t: 'card', data: c.slice() }); lastCardHash = h; }
  }
  if (now - sT >= 1000) report(now);
}

function report(now: number) {
  const dt = (now - sT) / 1000;
  const disk = be!.diskStats();
  const fb = be!.framebuffer();
  const audioMs = audioSab && audioCtl ? ((Atomics.load(audioCtl, 0) - Atomics.load(audioCtl, 1) + audioSab.length) % audioSab.length) / 2 / info.sampleRate * 1000 : -1;
  const stats: EmuStats = {
    fps: Math.round(sPresented / dt), emuFps: Math.round(sFrames / dt), emuMs: +(sEmu / Math.max(1, sFrames)).toFixed(2),
    presentMs: +(sPresent / Math.max(1, sPresented)).toFixed(2), utilization: +(sBusy / (dt * 1000)).toFixed(3),
    wasmMB: +(be!.memoryBytes() / 1048576).toFixed(1), behind: sBehind, presentEvery, audioMs: Math.round(audioMs),
    diskReads: disk.reads, diskMB: +(disk.bytes / 1048576).toFixed(2), cacheHit: +disk.hit.toFixed(3), width: fb.width, height: fb.height, frames: framesRun,
    inputMs: latN ? +(latSum / latN).toFixed(1) : -1,
  };
  if (budget) presentEvery = adaptPresent(presentEvery, budget, { emuMs: stats.emuMs, presentMs: stats.presentMs, behind: sBehind });
  post({ t: 'stats', stats });
  sFrames = sPresented = sEmu = sPresent = sBehind = sBusy = 0; sT = now;
}

self.onmessage = async (e: MessageEvent) => {
  const m = e.data;
  try {
    switch (m.t) {
      case 'init': {
        const o = m.opts as InitOptions & { canvas: OffscreenCanvas; size: [number, number]; plan: Plan };
        const make = BACKENDS[o.platform];
        if (!make) throw new Error(`No backend for ${o.platform}`);
        be = (await make())();
        const { canvas2d, webgpu } = await import('./present');
        // WebGPU device loss (driver reset, unsupported compositor) → ask for a fresh canvas, continue on Canvas 2D.
        presenter = o.presenter === 'webgpu' ? await webgpu(o.canvas, reason => { gpuLost = reason; post({ t: 'need-canvas', reason }); }).catch(() => null) : null;
        presenter ??= canvas2d(o.canvas);
        presenter.resize(o.size[0], o.size[1]);
        presenter.setMode(o.scaling);
        if (o.audio?.sab) { audioSab = new Int16Array(o.audio.sab, 8); audioCtl = new Int32Array(o.audio.sab, 0, 2); }
        audioPort = o.audio?.port ?? null;
        info = await be.initialize({ ...o, presenter: presenter.kind }, line => post({ t: 'log', line }));
        info.presenter = presenter.kind;
        info.shaderMs = presenter.shaderMs;
        budget = o.plan; maxCatchUp = o.plan.maxCatchUp; presentEvery = o.plan.presentEvery;
        lastCardHash = be.memoryCard() ? fnv(be.memoryCard()!) : 0;
        post({ t: 'ready', info });
        running = true; start = performance.now(); framesRun = 0; sT = start;
        raf(tick);
        setInterval(() => post({ t: 'beat', frames: framesRun, paused }), 500);   // watchdog heartbeat
        break;
      }
      case 'input': { const pt = m.port & 1, nm = m.mask & 0xffff; latch[pt] |= nm & ~mask[pt]; mask[pt] = nm; if (m.at) pendingInputAt = m.at; break; }
      case 'mouse': be?.setPointerInput?.(m.port & 1, m.dx, m.dy, m.buttons); if (m.at) pendingInputAt = m.at; break;
      case 'device': be?.setPortDevice?.(m.port & 1, m.device); break;
      case 'pause': paused = !!m.on; break;
      case 'reset': be?.reset(); post({ t: 'done', id: m.id, ok: true }); break;
      case 'step': if (paused && be && !stepping) { stepping = true; emulate(1); stepping = false; } post({ t: 'done', id: m.id, ok: true, frames: framesRun }); break;
      case 'save': { const d = be!.saveState(); post({ t: 'done', id: m.id, ok: true, data: d }, [d.buffer]); break; }
      case 'load': post({ t: 'done', id: m.id, ok: be!.loadState(m.data) }); break;
      case 'canvas': {
        const { canvas2d } = await import('./present');
        presenter = canvas2d(m.canvas);
        info.presenter = 'canvas2d';
        post({ t: 'presenter', kind: 'canvas2d', reason: gpuLost });
        break;
      }
      case 'resize': presenter?.resize(m.w, m.h); break;
      case 'gpu-selftest': {   // run the real WebGPU scaling pipeline offscreen on the live frame and analyse it
        const { gpuSelfTest } = await import('./present');
        const fb = be!.framebuffer();
        const r = await gpuSelfTest(fb.data.slice(), fb.width, fb.height, m.w ?? 1280, m.h ?? 720, m.mode ?? 0);
        if (!r) { post({ t: 'done', id: m.id, ok: false, error: 'WebGPU unavailable' }); break; }
        post({ t: 'done', id: m.id, ok: true, probe: { ...locate(r.data, r.w, r.h), presenter: 'webgpu-offscreen', w: r.w, h: r.h, shaderMs: r.shaderMs, gpuMs: r.gpuMs, adapter: r.adapter } });
        break;
      }
      case 'probe': {   // diagnostics/tests: where is the saffron (#FF8A00-ish) object in what the presenter actually produced?
        if (!presenter!.readback) { post({ t: 'done', id: m.id, ok: false, error: 'presenter cannot read back' }); break; }
        const r = await presenter!.readback();
        post({ t: 'done', id: m.id, ok: true, probe: { ...locate(r.data, r.w, r.h), presenter: presenter!.kind, w: r.w, h: r.h } });
        break;
      }
      case 'scaling': presenter?.setMode(m.mode); break;
      case 'plan': budget = m.plan; maxCatchUp = m.plan.maxCatchUp; presentEvery = m.plan.presentEvery; break;
      case 'shutdown': {
        running = false;
        const c = be?.memoryCard();
        if (c && fnv(c) !== lastCardHash) post({ t: 'card', data: c.slice() });
        be?.shutdown(); presenter?.destroy();
        post({ t: 'done', id: m.id, ok: true });
        break;
      }
    }
  } catch (err) {
    post({ t: m.id ? 'done' : 'error', id: m.id, ok: false, error: (err as Error).message || String(err) });
  }
};
