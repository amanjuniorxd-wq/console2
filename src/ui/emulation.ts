/** Upload Game · Emulators · Controllers (lazy-loaded with the emulation features). */
import { ACCEPT } from '../emu/detect';
import { detectAny, type UniversalDetection } from '../runtimes/detect';
import { RUNTIMES, byRuntimeId, liveStatus, MATURITY_LABEL, type Maturity, type RuntimeDescriptor } from '../runtimes/registry';
import { cloudReport } from '../runtimes/cloud-status';
import { probe } from '../mpc/probe';
import { settings } from './settings-store';
import { CORES } from '../emu/registry';
import { addEmuGame, addFromFile, addCloudGame } from '../games/catalog';
import { biosInfo, setBios, clearBios } from '../emu/storage';
import { KEY_FULL, KEY_LOGICAL, STD_INDEX, FULL, FB, type FullButton } from '../input/pad';
import { onPad, pads } from '../input/gamepad';
import { getPackage, compiled } from '../mpc/store';
import { h, esc, toast, fmtBytes } from '../components/ui';
import { ic } from '../components/icons';
import { focusEl } from '../components/nav';

const LEGAL = 'Use only games and BIOS files you own and are legally entitled to use. Mishrin does not include or download games, BIOS, firmware or keys. Your files stay on this device and are never uploaded unless you explicitly choose to upload a game to your own cloud.';
const maturityChip = (m: Maturity) => `<span class="badge maturity-${m}">${MATURITY_LABEL[m]}</span>`;

// ------------------------------------------------------------------ Upload Game
const ACCEPT_ALL = `${ACCEPT},.wasm,.html,.htm`;

export function upload(el: HTMLElement) {
  el.innerHTML = `<div class="page">
<h1 class="page-title">Upload Game</h1>
<p class="note legal">${LEGAL}</p>
<label class="dropzone" tabindex="0" data-autofocus>${ic.upload}<b>Choose game files</b><span>${esc(ACCEPT_ALL.replaceAll(',', ' '))} · select a CUE together with its BIN files</span>
<input type="file" multiple accept="${ACCEPT_ALL}" hidden data-files></label>
<div class="actions" style="margin-top:12px"><button class="btn btn-sm" data-folder>${ic.file}Choose a game folder</button><input type="file" hidden webkitdirectory multiple data-dir></div>
<div class="detect" aria-live="polite"></div></div>`;
  const zone = el.querySelector<HTMLLabelElement>('.dropzone')!;
  const input = el.querySelector<HTMLInputElement>('[data-files]')!;
  const dir = el.querySelector<HTMLInputElement>('[data-dir]')!;
  const out = el.querySelector<HTMLElement>('.detect')!;
  el.querySelector<HTMLButtonElement>('[data-folder]')!.onclick = () => dir.click();
  zone.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); input.click(); } });
  const handle = async (files: File[]) => {
    out.innerHTML = '<p class="note">Checking files…</p>';
    const t0 = performance.now();
    const d = await detectAny(files);
    await render(d, performance.now() - t0);
  };
  input.onchange = () => input.files?.length && handle([...input.files]);
  dir.onchange = () => dir.files?.length && handle([...dir.files]);
  zone.addEventListener('dragover', e => { e.preventDefault(); zone.classList.add('over'); });
  zone.addEventListener('dragleave', () => zone.classList.remove('over'));
  zone.addEventListener('drop', e => { e.preventDefault(); zone.classList.remove('over'); if (e.dataTransfer?.files.length) handle([...e.dataTransfer.files]); });

  async function render(d: UniversalDetection, ms: number) {
    if (!d.ok || !d.runtime) { out.innerHTML = `<div class="setrow"><div><span class="lbl">Can't use these files</span><span class="hint err">${esc(d.error || 'Unknown format.')}</span></div></div>`; return; }
    const rt = byRuntimeId(d.runtime);
    const caps = await probe();
    const report = rt.cloudRuntimes?.length ? await cloudReport(0) : null;
    const live = liveStatus(rt, caps, report, !!settings.cloudEndpoint);
    out.innerHTML = `<div class="emu-card" data-runtime="${rt.id}" data-state="${live.state}">
<div class="emu-head"><span class="emu-name">${esc(rt.name)}</span>${maturityChip(rt.maturity)}<span class="badge live-${live.state}">${esc(live.label)}</span></div>
<div class="kv"><span>Game</span><b>${esc(d.title || d.paths[0] || '')}</b>${d.serial ? `<span>Serial</span><b>${esc(d.serial)}</b>` : ''}
<span>Platform</span><b>${esc(rt.platformLabel)}</b><span>Runtime</span><b>${esc(rt.where.map(w => w.toUpperCase()).join(' / ') || '—')} · ${esc(rt.engine)}</b>
<span>Format</span><b>${esc(d.format || '')}${d.arch ? ` · ${d.arch}` : ''}</b><span>Files</span><b>${d.files.length} · ${fmtBytes(d.size)}</b>
<span>Status</span><b>${esc(live.detail)}</b>${rt.userFiles ? `<span>You provide</span><b>${esc(rt.userFiles)}</b>` : ''}<span>Checked in</span><b>${ms.toFixed(0)} ms (headers only)</b></div>
${d.warnings.length ? `<p class="note warn">${d.warnings.map(esc).join('<br>')}</p>` : ''}
<div class="actions" style="margin-top:16px"></div><div class="bar" hidden><i></i></div><p class="note" data-prog hidden></p></div>`;
    const acts = out.querySelector<HTMLElement>('.actions')!;
    const bar = out.querySelector<HTMLElement>('.bar')!, prog = out.querySelector<HTMLElement>('[data-prog]')!;
    const setBar = (f: number, text = '') => { bar.hidden = false; (bar.firstElementChild as HTMLElement).style.width = `${Math.round(f * 100)}%`; if (text) { prog.hidden = false; prog.textContent = text; } };
    const disabled = (label: string) => { const b = h('button', 'btn', label); b.disabled = true; acts.append(b); };

    if (d.kind === 'browser-wasm' || d.kind === 'browser-html' || d.kind === 'windows-exe') {
      const add = h('button', 'btn btn-play', `${ic.plus}Add to Library`);
      acts.append(add); focusEl(add);
      if (d.kind === 'windows-exe') acts.insertAdjacentHTML('beforeend', `<p class="note">Windows games stream from your cloud: the .exe is uploaded (chunked, deduplicated) when you first press Play.</p>`);
      add.onclick = async () => {
        add.disabled = true;
        try { const g = await addFromFile(d.files[0], d.title); toast(`${g.title} added`); location.hash = `#/game/${g.id}`; } catch (e) { toast((e as Error).message, 5000); add.disabled = false; }
      };
      return;
    }
    if (d.runtime === 'mishrin-p1') {
      const add = h('button', 'btn btn-play', `${ic.plus}Add to Library`);
      acts.append(add); focusEl(add);
      add.onclick = async () => {
        add.disabled = true;
        try {
          const t0 = performance.now();
          const g = await addEmuGame(d.disc!, (done, total) => setBar(done / total));
          toast(`${g.title} added · copied locally in ${((performance.now() - t0) / 1000).toFixed(1)} s`);
          location.hash = `#/game/${g.id}`;
        } catch (e) { toast((e as Error).message, 5000); add.disabled = false; bar.hidden = true; }
      };
      return;
    }
    if (rt.maturity === 'research' || !rt.cloudRuntimes?.length) return disabled('Research — not available');
    // PS2/PS3-class: cloud only, and only after the player explicitly authorizes the upload to *their* cloud.
    if (!live.ok && live.state !== 'mock-only') return disabled(live.state === 'no-cloud' ? 'Needs your cloud (Settings → Cloud Gaming)' : `${rt.name}: ${live.label}`);
    const consent = h('label', 'consent');
    consent.innerHTML = `<input type="checkbox" data-consent> I own this game and authorize uploading ${fmtBytes(d.size)} to my cloud (${esc(settings.cloudEndpoint)}). It is stored there for my account only.`;
    const go = h('button', 'btn btn-play', `${ic.upload}Upload to your cloud & add`);
    go.disabled = true;
    if (live.state === 'mock-only') acts.insertAdjacentHTML('beforeend', `<p class="note warn">Only a mock ${esc(rt.platformLabel)} worker (test double) is deployed on this cloud. It exercises the pipeline; it does not emulate games.</p>`);
    acts.append(consent, go);
    consent.querySelector('input')!.onchange = e => { go.disabled = !(e.target as HTMLInputElement).checked; };
    go.onclick = async () => {
      go.disabled = true;
      try {
        const { upload: send } = await import('../storage/upload');
        const r = await send(d.files.map((f, i) => ({ path: d.paths[i], blob: f })), { title: d.title, onProgress: p => setBar(p.total ? p.done / p.total : 1,
          p.phase === 'hashing' ? `Hashing ${fmtBytes(p.done)} / ${fmtBytes(p.total)}` : p.phase === 'uploading' ? `Uploading ${fmtBytes(p.done)} / ${fmtBytes(p.total)}${p.dedupBytes ? ` · ${fmtBytes(p.dedupBytes)} already in the cloud` : ''}` : 'Cloud is checking the files…') });
        const g = await addCloudGame(r, d);
        toast(`${g.title} uploaded · ${r.platform.toUpperCase()}-class detected by the cloud`);
        location.hash = `#/game/${g.id}`;
      } catch (e) { toast((e as Error).message, 6000); go.disabled = false; }
    };
  }
}

// ------------------------------------------------------------------ Emulators
const CORE_RUNTIME = { p1: 'mishrin-p1', p2: 'ps2', p3: 'ps3-cloud', p4: 'ps4' } as const;
const DOT: Record<string, string> = { available: 'ok', busy: 'warn', 'mock-only': 'warn', 'not-deployed': 'off', 'no-cloud': 'off', unsupported: 'off', unavailable: 'off' };

/** Runtime Status: LOCAL / CLOUD, every row derived from the registry + live checks (device caps, /api/runtimes). */
export async function runtimeStatus(box: HTMLElement): Promise<void> {
  const caps = await probe();
  const p1 = await fetch(CORES.p1.coreManifest!, { method: 'HEAD' }).then(r => r.ok).catch(() => false);
  const report = settings.cloudEndpoint ? await cloudReport() : null;
  const row = (d: RuntimeDescriptor) => {
    const l = liveStatus(d, caps, report, !!settings.cloudEndpoint, p1);
    return `<div class="rt-row" data-rt="${d.id}" data-state="${l.state}"><span class="dot ${DOT[l.state]}" aria-hidden="true">●</span><span class="rt-name">${esc(d.name)} <small>${esc(d.platformLabel)}</small></span>${maturityChip(d.maturity)}<span class="rt-live">${esc(l.label)}</span><span class="rt-detail">${esc(l.detail)}</span></div>`;
  };
  const group = (title: string, list: RuntimeDescriptor[]) => `<h2 class="sub-title">${title}</h2><div class="rt-list">${list.map(row).join('')}</div>`;
  box.innerHTML = group('Local', RUNTIMES.filter(d => d.where.includes('local') && d.maturity === 'ready'))
    + group('Cloud', RUNTIMES.filter(d => d.where.includes('cloud')))
    + `<p class="note">Status comes from this device and, for cloud runtimes, from the workers your cloud reports right now${report ? ` (${report.sessions} active session${report.sessions === 1 ? '' : 's'})` : ''}. “Mock worker” means a test double is deployed, not an emulator.</p>`;
}

export async function emulators(el: HTMLElement) {
  el.innerHTML = `<div class="page"><h1 class="page-title">Emulators</h1><p class="note legal">${LEGAL}</p>
<section class="rt-status" aria-label="Runtime status"><h2 class="sub-title">Runtime status</h2><div data-rt-box><p class="note">Checking…</p></div></section>
<h2 class="sub-title">Cores</h2><div class="emu-grid"></div></div>`;
  const box = el.querySelector<HTMLElement>('[data-rt-box]')!;
  const refresh = () => runtimeStatus(box).catch(() => {});
  refresh();
  const timer = setInterval(refresh, 10_000);
  const grid = el.querySelector<HTMLElement>('.emu-grid')!;
  for (const core of Object.values(CORES)) {
    const d = byRuntimeId(CORE_RUNTIME[core.id]);
    const card = h('section', 'emu-card');
    card.innerHTML = `<div class="emu-head"><span class="emu-name">${esc(core.name)}</span>${maturityChip(d.maturity)}</div>
<p class="desc">${esc(core.summary)}</p>
<div class="kv"><span>Formats</span><b>${esc(core.formats.join(' · '))}</b><span>Runs</span><b>${esc(d.where.map(w => w.toUpperCase()).join(' / ') || '—')} · ${esc(d.engine)}</b>${core.license ? `<span>Core</span><b>${esc(core.license)}</b>` : ''}${core.reason ? `<span>Status</span><b>${esc(core.reason)}</b>` : ''}${d.userFiles ? `<span>You provide</span><b>${esc(d.userFiles)}</b>` : ''}</div>
<div class="actions" style="margin-top:14px"></div>`;
    const acts = card.querySelector<HTMLElement>('.actions')!;
    if (core.available && core.coreManifest) {
      const manifest = await fetch(core.coreManifest).then(r => (r.ok ? r.json() : null)).catch(() => null);
      const rel = (u: string) => new URL(u, new URL(core.coreManifest!, location.href)).href;
      if (manifest) card.querySelector('.kv')!.insertAdjacentHTML('beforeend', `<span>Download</span><b>${fmtBytes(manifest.size)} (loaded only when you play)</b>`
        + (manifest.sourceArchive ? `<span>Licence</span><b><a href="${esc(rel(manifest.notice))}" target="_blank" rel="noopener">GPL notice</a> · <a href="${esc(rel(manifest.licenseText))}" target="_blank" rel="noopener">GPL text</a> · <a href="${esc(rel(manifest.sourceArchive))}" download>Complete source</a></b>` : ''));
      const pre = h('button', 'btn btn-sm', 'Preload core');
      pre.onclick = async () => {
        pre.disabled = true;
        try {
          const t0 = performance.now();
          const pkg = await getPackage({ id: `core-${core.id}`, title: '', artwork: '', description: '', runtime: 'wasm', url: rel(manifest.url), sha256: manifest.sha256 });
          const t1 = performance.now();
          await compiled(pkg);
          pre.textContent = `Ready · fetch ${(t1 - t0).toFixed(0)} ms${pkg.fromCache ? ' (cached)' : ''} · compile ${(performance.now() - t1).toFixed(0)} ms`;
        } catch (e) { toast((e as Error).message); pre.disabled = false; }
      };
      acts.append(pre);
      // optional user BIOS
      const bi = await biosInfo(core.id);
      const row = h('div', 'setrow');
      row.innerHTML = `<div><span class="lbl">BIOS</span><span class="hint">${bi ? `Using your BIOS: ${esc(bi.name)}` : 'Using the open HLE BIOS built into the core. Add your own BIOS dump for best compatibility.'}</span></div>`;
      const file = h('input'); file.type = 'file'; file.accept = '.bin'; file.hidden = true;
      const add = h('button', 'btn btn-sm', bi ? 'Replace BIOS' : 'Add your BIOS');
      add.onclick = () => file.click();
      file.onchange = async () => { const f = file.files?.[0]; if (!f) return; try { await setBios(core.id, f); toast('BIOS stored on this device'); emulators(el); } catch (e) { toast((e as Error).message, 4500); } };
      row.append(add, file);
      if (bi) { const rm = h('button', 'btn btn-sm', 'Remove BIOS'); rm.onclick = async () => { await clearBios(core.id); toast('BIOS removed'); emulators(el); }; row.append(rm); }
      card.append(row);
    } else {
      const label = d.maturity === 'research' ? 'Research — not available' : d.cloudRuntimes?.length ? 'Cloud only — see Runtime status' : `${MATURITY_LABEL[d.maturity]} — not available`;
      const b = h('button', 'btn btn-sm', label); b.disabled = true; acts.append(b);
    }
    grid.append(card);
  }
  return () => clearInterval(timer);
}

// ------------------------------------------------------------------ Controllers
const LABELS: Record<FullButton, string> = { cross: '✕', circle: '○', square: '□', triangle: '△', l1: 'L1', r1: 'R1', l2: 'L2', r2: 'R2', select: 'Select', start: 'Start', l3: 'L3', r3: 'R3', up: '↑', down: '↓', left: '←', right: '→' };
const KEYNAME = (c: string) => c.replace(/^Key/, '').replace(/^Arrow/, '').replace('ShiftRight', 'Right Shift');

export function controllers(el: HTMLElement) {
  const order = [...FULL];
  const keyFor = (b: FullButton) => Object.entries(KEY_FULL).filter(([, v]) => v === b).map(([k]) => KEYNAME(k)).join(' / ');
  const logical = ['Up', 'Down', 'Left', 'Right', 'A', 'B', 'Start'].map((n, b) => `<span>${n}</span><b>${esc(Object.entries(KEY_LOGICAL).filter(([, v]) => v === b).map(([k]) => KEYNAME(k)).join(' / '))}</b>`).join('');
  el.innerHTML = `<div class="page"><h1 class="page-title">Controllers</h1>
<div class="setrow"><div><span class="lbl">Connected</span><span class="hint" data-pads>No controller detected — press any button on it.</span></div></div>
<div class="pad-viz" aria-label="Live controller state">${order.map(b => `<span class="padkey" data-b="${b}">${LABELS[b]}</span>`).join('')}</div>
<h2 class="sub-title">Full controller (Mishrin P1 · cloud console titles)</h2>
<div class="map"><div class="kv">${order.map(b => `<span>${LABELS[b]}</span><b>${esc(keyFor(b) || '—')} · pad #${STD_INDEX[b]}</b>`).join('')}</div></div>
<h2 class="sub-title">Menus · browser games · Windows (cloud)</h2>
<div class="map"><div class="kv">${logical}<span>Controller</span><b>D-pad / left stick · A · B · Start (Windows titles map these through the game's controller map)</b></div></div>
<h2 class="sub-title">Mouse</h2>
<div class="map"><div class="kv"><span>Web / WASM games</span><b>Click inside the picture (if the game uses a mouse)</b><span>Windows (cloud)</span><b>Move, left/right/middle click, wheel — mapped to the game window</b><span>P1</span><b>Settings → Controls → P1 mouse: plug a mouse into port 1 or 2 (games that support it). The cursor is captured on first click; Esc releases it.</b></div></div>
<p class="note">Keyboard, controller, mouse and touch all work at the same time. In-game menu: Esc, Home, or Start+Select. Touch screens get on-screen controls automatically.</p></div>`;
  const label = el.querySelector<HTMLElement>('[data-pads]')!;
  const keys = new Set<string>();
  let padMask = 0;
  const paint = () => {
    const ps = pads();
    label.textContent = ps.length ? ps.map(p => `${p.id.slice(0, 60)} (${p.mapping || 'non-standard'} mapping)`).join(' · ') : 'No controller detected — press any button on it.';
    let mask = padMask;
    for (const k of keys) if (KEY_FULL[k] !== undefined) mask |= 1 << FB[KEY_FULL[k]];
    for (const b of order) el.querySelector(`[data-b="${b}"]`)?.classList.toggle('on', !!(mask & (1 << FB[b])));
  };
  const kd = (e: KeyboardEvent) => { keys.add(e.code); paint(); }, ku = (e: KeyboardEvent) => { keys.delete(e.code); paint(); };
  addEventListener('keydown', kd); addEventListener('keyup', ku);
  const off = onPad(st => { padMask = st.full; paint(); });   // the console's one shared poller (src/input/gamepad.ts)
  const conn = () => paint();
  addEventListener('gamepadconnected', conn); addEventListener('gamepaddisconnected', conn);
  paint();
  return () => { off(); removeEventListener('keydown', kd); removeEventListener('keyup', ku); removeEventListener('gamepadconnected', conn); removeEventListener('gamepaddisconnected', conn); };
}
