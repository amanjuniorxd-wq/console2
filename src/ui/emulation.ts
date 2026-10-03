/** Upload Game · Emulators · Controllers (lazy-loaded with the emulation features). */
import { detect, ACCEPT, type Detection } from '../emu/detect';
import { CORES, STATUS_LABEL } from '../emu/registry';
import { addEmuGame } from '../games/catalog';
import { biosInfo, setBios, clearBios } from '../emu/storage';
import { KEYMAP, PADMAP } from '../runtime/local-emu';
import { PAD, type PadButton } from '../emu/types';
import { getPackage, compiled } from '../mpc/store';
import { h, esc, toast, fmtBytes } from '../components/ui';
import { ic } from '../components/icons';
import { focusEl } from '../components/nav';

const LEGAL = 'Use only games and BIOS files you own and are legally entitled to use. Mishrin does not include or download games, BIOS, firmware or keys. Your files stay on this device and are never uploaded.';
const statusChip = (s: keyof typeof STATUS_LABEL) => `<span class="badge status-${s}">${STATUS_LABEL[s]}</span>`;

// ------------------------------------------------------------------ Upload Game
export function upload(el: HTMLElement) {
  el.innerHTML = `<div class="page">
<h1 class="page-title">Upload Game</h1>
<p class="note legal">${LEGAL}</p>
<label class="dropzone" tabindex="0" data-autofocus>${ic.upload}<b>Choose game files</b><span>${esc(ACCEPT.replaceAll(',', ' '))} · select a CUE together with its BIN files</span>
<input type="file" multiple accept="${ACCEPT}" hidden></label>
<div class="detect" aria-live="polite"></div></div>`;
  const zone = el.querySelector<HTMLLabelElement>('.dropzone')!;
  const input = zone.querySelector('input')!;
  const out = el.querySelector<HTMLElement>('.detect')!;
  zone.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); input.click(); } });
  const handle = async (files: File[]) => {
    out.innerHTML = '<p class="note">Checking files…</p>';
    const t0 = performance.now();
    const d = await detect(files);
    render(d, performance.now() - t0);
  };
  input.onchange = () => input.files?.length && handle([...input.files]);
  zone.addEventListener('dragover', e => { e.preventDefault(); zone.classList.add('over'); });
  zone.addEventListener('dragleave', () => zone.classList.remove('over'));
  zone.addEventListener('drop', e => { e.preventDefault(); zone.classList.remove('over'); if (e.dataTransfer?.files.length) handle([...e.dataTransfer.files]); });

  function render(d: Detection, ms: number) {
    if (!d.ok || !d.platform) { out.innerHTML = `<div class="setrow"><div><span class="lbl">Can't use these files</span><span class="hint err">${esc(d.error || 'Unknown format.')}</span></div></div>`; return; }
    const core = CORES[d.platform];
    out.innerHTML = `<div class="emu-card">
<div class="emu-head"><span class="emu-name">${esc(core.name)}</span>${statusChip(core.status)}</div>
<div class="kv"><span>Game</span><b>${esc(d.title || d.primary || '')}</b>${d.serial ? `<span>Serial</span><b>${esc(d.serial)}</b>` : ''}
<span>Format</span><b>${esc(d.format || '')}</b><span>Files</span><b>${d.files.length} · ${fmtBytes(d.size)}</b><span>Compatibility</span><b>${core.available ? 'Runs on this device' : esc(core.reason || '')}</b><span>Checked in</span><b>${ms.toFixed(0)} ms (headers only)</b></div>
${d.warnings.length ? `<p class="note warn">${d.warnings.map(esc).join('<br>')}</p>` : ''}
<div class="actions" style="margin-top:16px"></div><div class="bar" hidden><i></i></div></div>`;
    const acts = out.querySelector<HTMLElement>('.actions')!;
    if (!core.available) {
      const b = h('button', 'btn', core.status === 'research' ? 'Research — not available' : 'Experimental — coming soon'); b.disabled = true; acts.append(b);
      return;
    }
    const add = h('button', 'btn btn-play', `${ic.plus}Add to Library`);
    acts.append(add);
    focusEl(add);
    add.onclick = async () => {
      add.disabled = true;
      const bar = out.querySelector<HTMLElement>('.bar')!; bar.hidden = false;
      try {
        const t0 = performance.now();
        const g = await addEmuGame(d, (done, total) => { (bar.firstElementChild as HTMLElement).style.width = `${Math.round((done / total) * 100)}%`; });
        toast(`${g.title} added · copied locally in ${((performance.now() - t0) / 1000).toFixed(1)} s`);
        location.hash = `#/game/${g.id}`;
      } catch (e) { toast((e as Error).message, 5000); add.disabled = false; bar.hidden = true; }
    };
  }
}

// ------------------------------------------------------------------ Emulators
export async function emulators(el: HTMLElement) {
  el.innerHTML = `<div class="page"><h1 class="page-title">Emulators</h1><p class="note legal">${LEGAL}</p><div class="emu-grid"></div></div>`;
  const grid = el.querySelector<HTMLElement>('.emu-grid')!;
  for (const core of Object.values(CORES)) {
    const card = h('section', 'emu-card');
    card.innerHTML = `<div class="emu-head"><span class="emu-name">${esc(core.name)}</span>${statusChip(core.status)}</div>
<p class="desc">${esc(core.summary)}</p>
<div class="kv"><span>Formats</span><b>${esc(core.formats.join(' · '))}</b>${core.license ? `<span>Core</span><b>${esc(core.license)}</b>` : ''}${core.reason ? `<span>Status</span><b>${esc(core.reason)}</b>` : ''}</div>
<div class="actions" style="margin-top:14px"></div>`;
    const acts = card.querySelector<HTMLElement>('.actions')!;
    if (core.available && core.coreManifest) {
      const manifest = await fetch(core.coreManifest).then(r => (r.ok ? r.json() : null)).catch(() => null);
      if (manifest) card.querySelector('.kv')!.insertAdjacentHTML('beforeend', `<span>Download</span><b>${fmtBytes(manifest.size)} (loaded only when you play)</b>`
        + (manifest.sourceArchive ? `<span>Licence</span><b><a href="${esc(manifest.notice)}" target="_blank" rel="noopener">GPL notice</a> · <a href="${esc(manifest.licenseText)}" target="_blank" rel="noopener">GPL text</a> · <a href="${esc(manifest.sourceArchive)}" download>Complete source</a></b>` : ''));
      const pre = h('button', 'btn btn-sm', 'Preload core');
      pre.onclick = async () => {
        pre.disabled = true;
        try {
          const t0 = performance.now();
          const pkg = await getPackage({ id: `core-${core.id}`, title: '', artwork: '', description: '', runtime: 'wasm', url: manifest.url, sha256: manifest.sha256 });
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
      const b = h('button', 'btn btn-sm', core.status === 'research' ? 'Research — not available' : 'Experimental — coming soon'); b.disabled = true; acts.append(b);
    }
    grid.append(card);
  }
}

// ------------------------------------------------------------------ Controllers
const LABELS: Record<PadButton, string> = { cross: '✕', circle: '○', square: '□', triangle: '△', l1: 'L1', r1: 'R1', l2: 'L2', r2: 'R2', select: 'Select', start: 'Start', l3: 'L3', r3: 'R3', up: '↑', down: '↓', left: '←', right: '→' };
const KEYNAME = (c: string) => c.replace(/^Key/, '').replace(/^Arrow/, '').replace('ShiftRight', 'Right Shift');

export function controllers(el: HTMLElement) {
  const order = Object.keys(PAD) as PadButton[];
  const keyFor = (b: number) => Object.entries(KEYMAP).filter(([, v]) => v === b).map(([k]) => KEYNAME(k)).join(' / ');
  const padFor = (b: number) => PADMAP.map((v, i) => (v === b ? i : -1)).filter(i => i >= 0).map(i => `#${i}`).join(' ');
  el.innerHTML = `<div class="page"><h1 class="page-title">Controllers</h1>
<div class="setrow"><div><span class="lbl">Connected</span><span class="hint" data-pads>No controller detected — press any button on it.</span></div></div>
<div class="pad-viz" aria-label="Live controller state">${order.map(b => `<span class="padkey" data-b="${b}">${LABELS[b]}</span>`).join('')}</div>
<h2 class="sub-title">Mapping (Mishrin P1)</h2>
<div class="map"><div class="kv">${order.map(b => `<span>${LABELS[b]}</span><b>${esc(keyFor(PAD[b]) || '—')} · pad ${padFor(PAD[b])}</b>`).join('')}</div></div>
<h2 class="sub-title">Mouse</h2>
<div class="map"><div class="kv"><span>Web / WASM games</span><b>Click inside the picture (if the game uses a mouse)</b><span>Windows (cloud)</span><b>Move, left/right/middle click, wheel — mapped to the game window</b><span>P1</span><b>Settings → Controls → P1 mouse: plug a mouse into port 1 or 2 (games that support it). The cursor is captured on first click; Esc releases it.</b></div></div>
<p class="note">Keyboard, controller, mouse and touch all work at the same time. In-game menu: Esc, Home, or Start+Select. Touch screens get on-screen controls automatically.</p></div>`;
  const label = el.querySelector<HTMLElement>('[data-pads]')!;
  let raf = 0;
  const keys = new Set<string>();
  const kd = (e: KeyboardEvent) => keys.add(e.code), ku = (e: KeyboardEvent) => keys.delete(e.code);
  addEventListener('keydown', kd); addEventListener('keyup', ku);
  const loop = () => {
    const pads = navigator.getGamepads ? [...navigator.getGamepads()].filter(Boolean) as Gamepad[] : [];
    label.textContent = pads.length ? pads.map(p => `${p.id.slice(0, 60)} (${p.mapping || 'non-standard'} mapping)`).join(' · ') : 'No controller detected — press any button on it.';
    let mask = 0;
    const p = pads[0];
    if (p) for (let i = 0; i < PADMAP.length; i++) if (p.buttons[i]?.pressed) mask |= 1 << PADMAP[i];
    for (const k of keys) if (KEYMAP[k] !== undefined) mask |= 1 << KEYMAP[k];
    for (const b of order) el.querySelector(`[data-b="${b}"]`)?.classList.toggle('on', !!(mask & (1 << PAD[b])));
    raf = requestAnimationFrame(loop);
  };
  raf = requestAnimationFrame(loop);
  return () => { cancelAnimationFrame(raf); removeEventListener('keydown', kd); removeEventListener('keyup', ku); };
}
