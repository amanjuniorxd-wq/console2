/** In-game view: fullscreen surface, input routing, minimal overlay (Performance / Resolution / Controls / Save State / Exit). */
import { byId } from '../games/catalog';
import type { Game } from '../games/types';
import { launch, caps, reclaimAll } from '../mpc';
import type { Session } from '../runtime/types';
import { Btn } from '../runtime/types';
import { writeSave, readSave, saveInfo } from '../mpc/saves';
import { settings, setSetting } from './settings-store';
import { capturePad, focusEl, pushBack } from '../components/nav';
import { logo } from '../components/logo';
import { ic } from '../components/icons';
import { esc, h, chips, toast, fmtBytes } from '../components/ui';
import { exitFullscreen } from './fullscreen';

const KEYMAP: Record<string, Btn> = {
  ArrowUp: Btn.Up, KeyW: Btn.Up, ArrowDown: Btn.Down, KeyS: Btn.Down, ArrowLeft: Btn.Left, KeyA: Btn.Left, ArrowRight: Btn.Right, KeyD: Btn.Right,
  Space: Btn.A, Enter: Btn.A, KeyZ: Btn.A, KeyJ: Btn.A, KeyX: Btn.B, KeyK: Btn.B, KeyP: Btn.Start, Tab: Btn.Start,
};
type Panel = 'perf' | 'res' | 'controls' | 'save';

export function player(_el: HTMLElement, id: string) {
  const game = byId(id);
  if (!game) { toast('Game not found'); location.replace('#/library'); return; }
  const g: Game = game;
  const app = document.getElementById('app')!;
  const root = document.getElementById('player')!;
  root.hidden = false; app.inert = true;
  root.innerHTML = `<div class="surface"></div>
<div class="loading" role="status"><span>${logo()}</span><h2>${esc(g.title)}</h2><div class="msg">Preparing</div><div class="bar indet"><i></i></div><div class="actions" data-err hidden></div></div>
<button class="ovl-btn" aria-label="Game menu" hidden>${ic.settings}</button>
<div class="overlay" hidden><div class="bar-top"><span class="gt">${esc(g.title)}</span></div><div class="ovl-panel" hidden></div></div>
<div class="stats-hud" hidden></div>`;
  const surface = root.querySelector<HTMLElement>('.surface')!;
  const loading = root.querySelector<HTMLElement>('.loading')!;
  const msg = loading.querySelector<HTMLElement>('.msg')!;
  const bar = loading.querySelector<HTMLElement>('.bar')!;
  const errActs = loading.querySelector<HTMLElement>('[data-err]')!;
  const ovlBtn = root.querySelector<HTMLButtonElement>('.ovl-btn')!;
  const overlay = root.querySelector<HTMLElement>('.overlay')!;
  const panel = overlay.querySelector<HTMLElement>('.ovl-panel')!;
  const hud = root.querySelector<HTMLElement>('.stats-hud')!;

  let session: Session | null = null;
  let ctrl: AbortController | null = null;
  let closed = false, wasFullscreen = false, pixelPerfect = false;
  let touchEl: HTMLElement | null = null;
  const timers: number[] = [];

  // ---------- lifecycle ----------
  const status = (m: string, p?: number) => {
    msg.textContent = m;
    if (p === undefined || p <= 0 || p >= 1) bar.classList.add('indet');
    else { bar.classList.remove('indet'); (bar.firstElementChild as HTMLElement).style.width = `${Math.round(p * 100)}%`; }
  };

  async function start() {
    teardownSession();
    ctrl = new AbortController();
    loading.hidden = false; loading.classList.remove('error'); errActs.hidden = true; errActs.replaceChildren(); bar.hidden = false;
    status('Preparing');
    try {
      const r = await launch(g, surface, { status, signal: ctrl.signal });
      if (closed) { r.session.dispose(); return; }
      session = r.session;
      session.onEnd = reason => fail(reason, 'ended');
      session.setMaxFps?.(settings.maxFps);
      loading.hidden = true; ovlBtn.hidden = false;
      capturePad(padToGame, toggleOverlay);
      if (r.fellBack) toast('Optimized for this device');
      if (!session.ownsInput) setupTouch();
      applyDisplay();
      if (settings.showStats) startHud();
      const f = surface.querySelector<HTMLElement>('iframe, canvas, video'); f?.setAttribute('tabindex', '-1'); f?.focus();
    } catch (e) {
      if (closed || ctrl?.signal.aborted) return;
      fail((e as Error).message || 'Could not start the game.', (e as { code?: string }).code);
    }
  }

  function fail(reason: string, code?: string) {
    teardownSession();
    capturePad(null); popOverlayBack?.(); popOverlayBack = null;
    overlay.hidden = true; ovlBtn.hidden = true;
    loading.hidden = false; loading.classList.add('error'); bar.hidden = true;
    msg.textContent = reason;
    errActs.hidden = false; errActs.replaceChildren();
    const actions: [string, () => void, boolean?][] = [];
    if (code === 'needs-cloud') actions.push(['Cloud settings', () => { exit(); location.hash = '#/settings/cloud'; }, true]);
    else if (code !== 'no-file' && code !== 'unsupported') actions.push(['Retry', start, true]);
    actions.push(['Back', exit]);
    for (const [label, fn, primary] of actions) {
      const b = h('button', `btn${primary ? ' btn-play' : ''}`, label); b.onclick = fn; errActs.append(b);
    }
    focusEl(errActs.firstElementChild as HTMLElement);
  }

  function teardownSession() {
    ctrl?.abort(); ctrl = null;
    session?.dispose(); session = null;
    touchEl?.remove(); touchEl = null;
    while (timers.length) clearInterval(timers.pop());
    hud.hidden = true;
    surface.replaceChildren();
  }

  function exit() {
    if (closed) return;
    location.replace(`#/game/${g.id}`);
  }

  // ---------- overlay ----------
  const OVL: [Panel | 'exit', string][] = [['perf', 'Performance'], ['res', 'Resolution'], ['controls', 'Controls'], ['save', 'Save State'], ['exit', 'Exit']];
  const top = overlay.querySelector('.bar-top')!;
  for (const [k, label] of OVL) {
    const b = h('button', `btn btn-sm${k === 'exit' ? '' : ''}`, label); b.dataset.p = k;
    b.onclick = () => (k === 'exit' ? exit() : showPanel(k));
    top.append(b);
  }
  let popOverlayBack: (() => void) | null = null;
  function openOverlay() {
    if (!session || !overlay.hidden) return;
    overlay.hidden = false; session.pause(true);
    if (document.pointerLockElement) document.exitPointerLock(); // the menu needs a free cursor
    capturePad(null); // UI navigation (arrows / D-pad / B) while the menu is open
    popOverlayBack = pushBack(closeOverlay);
    focusEl(top.querySelector('button')!);
  }
  function closeOverlay() {
    if (overlay.hidden) return;
    overlay.hidden = true; panel.hidden = true; session?.pause(false);
    popOverlayBack?.(); popOverlayBack = null;
    if (session) capturePad(padToGame, toggleOverlay);
    surface.querySelector<HTMLElement>('iframe, canvas, video')?.focus();
  }
  const toggleOverlay = () => (overlay.hidden ? openOverlay() : closeOverlay());
  ovlBtn.onclick = toggleOverlay;

  async function showPanel(p: Panel) {
    panel.hidden = false; panel.replaceChildren();
    while (timers.length > (hud.hidden ? 0 : 1)) clearInterval(timers.pop());
    if (!session) return;
    const s = session;
    if (p === 'perf') {
      const kv = h('div', 'kv'); panel.append(kv);
      const draw = () => {
        const st = s.stats(); const mem = (performance as Performance & { memory?: { usedJSHeapSize: number } }).memory;
        if (st.details) { kv.innerHTML = st.details.map(([k, v]) => `<span>${esc(k)}</span><b>${esc(v)}</b>`).join('') + (mem ? `<span>Console memory</span><b>${fmtBytes(mem.usedJSHeapSize)}</b>` : ''); return; }
        kv.innerHTML = `<span>Path</span><b>${esc(st.route)}</b><span>FPS</span><b>${st.fps || '—'}</b><span>Frame time</span><b>${st.frameMs ? st.frameMs + ' ms' : '—'}</b><span>Resolution</span><b>${st.width ? `${st.width}×${st.height}` : '—'}</b>${st.extra ? `<span>Network</span><b>${esc(st.extra)}</b>` : ''}${mem ? `<span>Console memory</span><b>${fmtBytes(mem.usedJSHeapSize)}</b>` : ''}`;
      };
      draw(); timers.push(window.setInterval(draw, 1000));
      const fps = h('div', 'setrow'); fps.innerHTML = '<span class="lbl">Max FPS</span>';
      fps.append(chips([[30, '30'], [60, '60'], [120, '120'], [0, '∞']], settings.maxFps as number, v => s.setMaxFps?.(v)));
      panel.append(fps);
    } else if (p === 'res') {
      const r = h('div', 'setrow');
      if (s.setScaling) {
        r.innerHTML = '<span class="lbl">Scaling<span class="hint">Internal resolution is the console\'s native resolution (software renderer); this sets how it is scaled to your screen.</span></span>';
        r.append(chips([['pixel', 'Pixel'], ['smooth', 'Smooth'], ['sharp', 'Sharp (WebGPU)']], settings.emuScaling, v => { setSetting('emuScaling', v); s.setScaling!(v); }));
      } else if (s.backend === 'local-wasm') {
        r.innerHTML = '<span class="lbl">Display<span class="hint">Rendered at native size, scaled by the GPU.</span></span>';
        r.append(chips([['fit', 'Fit screen'], ['pixel', 'Pixel perfect']], pixelPerfect ? 'pixel' : 'fit', v => { pixelPerfect = v === 'pixel'; applyDisplay(); }));
      } else {
        r.innerHTML = `<span class="lbl">Render scale<span class="hint">${s.backend === 'cloud' ? 'Lower uses less bandwidth.' : 'Lower is faster on weak GPUs.'}</span></span>`;
        r.append(chips([[1, '100%'], [0.75, '75%'], [0.5, '50%']], 1, v => s.setScale?.(v)));
      }
      panel.append(r);
    } else if (p === 'controls') {
      panel.innerHTML = s.controlsHelp
        ? `<div class="kv">${s.controlsHelp.map(([k, v]) => `<span>${esc(k)}</span><b>${esc(v)}</b>`).join('')}<span>Menu</span><b>Esc · Home · Start+Select</b></div>`
        : `<div class="kv"><span>Move</span><b>Arrows / WASD · D-pad · Stick</b><span>A</span><b>Space / Enter / Z</b><span>B</span><b>X / K</b><span>Start</span><b>P / Tab</b><span>Menu</span><b>Esc · Home · Start+Select</b></div>`;
      if (!s.ownsInput && (await caps()).touch) {
        const r = h('div', 'setrow'); r.innerHTML = '<span class="lbl">Touch controls</span>';
        r.append(chips([['on', 'Show'], ['off', 'Hide']], touchEl ? 'on' : 'off', v => { v === 'on' ? setupTouch(true) : (touchEl?.remove(), (touchEl = null)); }));
        panel.append(r);
      }
    } else if (p === 'save') {
      if (!s.canSave) { panel.innerHTML = '<p class="note" style="margin:0">This game does not support save states.</p>'; return; }
      const info = await saveInfo(g.id);
      const r = h('div', 'setrow');
      r.innerHTML = `<span class="lbl">Save state<span class="hint">${info ? `Saved ${new Date(info.ts).toLocaleString()} · ${fmtBytes(info.data.size)}` : 'No save yet.'}</span></span>`;
      const acts = h('div', 'actions');
      const sb = h('button', 'btn btn-sm btn-play', 'Save'), lb = h('button', 'btn btn-sm', 'Load');
      lb.disabled = !info;
      sb.onclick = async () => {
        const d = await s.save();
        if (!d) return toast('Save failed');
        const rec = await writeSave(g.id, d);
        toast(`Saved · ${fmtBytes(rec.data.size)}${rec.gz ? ` (from ${fmtBytes(rec.raw)})` : ''}`); showPanel('save');
      };
      lb.onclick = async () => {
        const d = await readSave(g.id);
        if (d && (await s.load(d))) { toast('State loaded'); closeOverlay(); } else toast('Could not load this save');
      };
      acts.append(sb, lb);
      if (s.reset) {
        const rb = h('button', 'btn btn-sm', 'Reset game');
        rb.onclick = async () => { await s.reset!(); toast('Game reset'); closeOverlay(); };
        acts.append(rb);
      }
      r.append(acts); panel.append(r);
    }
    focusEl(panel.querySelector('button') ?? (top.querySelector(`[data-p=${p}]`) as HTMLElement));
  }

  function startHud() {
    hud.hidden = false;
    const t = window.setInterval(() => { const st = session?.stats(); if (st) hud.textContent = `${st.fps || '—'} FPS · ${st.frameMs || '—'} ms${st.extra ? ' · ' + st.extra : ''}`; }, 1000);
    timers.unshift(t);
  }

  function applyDisplay() {
    const c = surface.querySelector('canvas');
    if (!c || !session) return;
    c.classList.toggle('pixelated', g.launchConfig?.pixelated !== false);
    if (pixelPerfect) {
      const st = session.stats(); const k = Math.max(1, Math.floor(Math.min(innerWidth / st.width, innerHeight / st.height)));
      c.style.width = `${st.width * k}px`; c.style.height = `${st.height * k}px`;
    } else { c.style.width = ''; c.style.height = ''; }
  }

  // ---------- input ----------
  const padToGame = (b: Btn, down: boolean) => (session?.padInput ?? session?.input)?.call(session, b, down);
  const popExit = pushBack(exit); // B / Esc on loading & error screens leaves the game

  const onKey = (e: KeyboardEvent) => {
    if (closed) return;
    // Only while a game is running with the menu closed; otherwise the console's UI navigation handles keys.
    if (!session || !overlay.hidden) return;
    const down = e.type === 'keydown';
    if (e.key === 'Escape') { if (down) { e.preventDefault(); e.stopPropagation(); openOverlay(); } return; }
    if (session.ownsInput) return;
    const b = KEYMAP[e.code];
    session.rawKey?.(e.code, down);
    if (b !== undefined) { e.preventDefault(); if (!e.repeat) session.input?.(b, down); }
  };
  addEventListener('keydown', onKey, true); addEventListener('keyup', onKey, true);

  // ---------- mouse: one path for every game surface (local canvas, emulator canvas, cloud video) ----------
  /** The rectangle the picture actually occupies inside an object-fit: contain element (letterbox excluded). */
  const pictureRect = (el: HTMLCanvasElement | HTMLVideoElement) => {
    const r = el.getBoundingClientRect();
    const w = el instanceof HTMLVideoElement ? el.videoWidth : el.width, h = el instanceof HTMLVideoElement ? el.videoHeight : el.height;
    if (!w || !h) return r;
    const k = Math.min(r.width / w, r.height / h), pw = w * k, ph = h * k;
    return { left: r.left + (r.width - pw) / 2, top: r.top + (r.height - ph) / 2, width: pw, height: ph };
  };
  let lockFailed = false;
  document.addEventListener('pointerlockerror', () => { lockFailed = true; });
  const onPointer = (e: PointerEvent) => {
    if (!session || !overlay.hidden || session.ownsInput || e.pointerType === 'touch') return; // touch uses the on-screen pad
    const el = (e.target as HTMLElement).closest?.('canvas.game-surface, video.game-surface') as HTMLCanvasElement | HTMLVideoElement | null;
    if (!el && document.pointerLockElement !== surface) return;
    if (session.pointerMode === 'relative' && session.pointerRel) {
      // Relative devices: capture the mouse on first click (pointer lock), movement deltas otherwise.
      // Until the cursor is captured, hovering doesn't drive the game (only clicks do); without pointer lock support, plain movement is used.
      const locked = document.pointerLockElement === surface;
      if (e.type === 'pointerdown' && !locked) {
        const r = surface.requestPointerLock?.() as unknown as Promise<void> | undefined;
        if (!surface.requestPointerLock) lockFailed = true; else r?.catch?.(() => { lockFailed = true; });
      }
      const move = locked || lockFailed;
      if (e.type === 'pointermove' && !move) return;
      session.pointerRel(move ? e.movementX || 0 : 0, move ? e.movementY || 0 : 0, e.buttons);
    } else if (session.pointer && el) {
      const r = pictureRect(el);
      const x = (e.clientX - r.left) / r.width, y = (e.clientY - r.top) / r.height;
      if (e.type !== 'pointerup' && (x < 0 || y < 0 || x > 1 || y > 1)) return; // letterbox bars are not part of the game
      session.pointer(Math.min(1, Math.max(0, x)), Math.min(1, Math.max(0, y)), e.buttons);
    } else return;
    if (e.type === 'pointerdown') e.preventDefault();
  };
  for (const t of ['pointermove', 'pointerdown', 'pointerup'] as const) surface.addEventListener(t, onPointer);
  // Wheel: accumulate pixel/line deltas into notches (one notch ≈ 100 px) so touchpads and wheels behave alike.
  let wheelAcc = 0;
  surface.addEventListener('wheel', e => {
    if (!session?.wheel || !overlay.hidden || session.ownsInput) return;
    e.preventDefault();
    wheelAcc += e.deltaMode === 1 ? e.deltaY * 33 : e.deltaMode === 2 ? e.deltaY * 100 : e.deltaY;
    const n = Math.trunc(wheelAcc / 100);
    if (n) { wheelAcc -= n * 100; session.wheel(n); }
  }, { passive: false });
  surface.addEventListener('contextmenu', e => { if (session && !session.ownsInput) e.preventDefault(); }); // right click belongs to the game

  async function setupTouch(force = false) {
    if (touchEl || !session || session.ownsInput) return;
    const c = await caps();
    if (!force && (settings.touchControls === 'off' || (settings.touchControls === 'auto' && !c.touch) || g.touch === false)) return;
    touchEl = h('div', 'touchpad');
    touchEl.innerHTML = `<div class="dpad" aria-label="D-pad"><button data-b="0" aria-label="Up">▲</button><button data-b="1" aria-label="Down">▼</button><button data-b="2" aria-label="Left">◀</button><button data-b="3" aria-label="Right">▶</button></div><div class="abtns"><button data-b="4">A</button><button data-b="5">B</button></div>`;
    const dpad = touchEl.querySelector<HTMLElement>('.dpad')!;
    const held = new Set<Btn>();
    const setDirs = (next: Set<Btn>) => {
      for (const b of held) if (!next.has(b)) { padToGame(b, false); held.delete(b); dpad.querySelector(`[data-b="${b}"]`)?.classList.remove('on'); }
      for (const b of next) if (!held.has(b)) { padToGame(b, true); held.add(b); dpad.querySelector(`[data-b="${b}"]`)?.classList.add('on'); }
    };
    const fromPoint = (e: PointerEvent) => {
      const r = dpad.getBoundingClientRect(); const x = e.clientX - r.left - r.width / 2, y = e.clientY - r.top - r.height / 2;
      const s = new Set<Btn>(); const dz = r.width * 0.12;
      if (y < -dz) s.add(Btn.Up); if (y > dz) s.add(Btn.Down); if (x < -dz) s.add(Btn.Left); if (x > dz) s.add(Btn.Right);
      setDirs(s);
    };
    dpad.addEventListener('pointerdown', e => { dpad.setPointerCapture(e.pointerId); fromPoint(e); e.preventDefault(); });
    dpad.addEventListener('pointermove', e => { if (dpad.hasPointerCapture(e.pointerId)) fromPoint(e); });
    const up = () => setDirs(new Set());
    dpad.addEventListener('pointerup', up); dpad.addEventListener('pointercancel', up);
    touchEl.querySelectorAll<HTMLButtonElement>('.abtns button').forEach(b => {
      const k = +b.dataset.b! as Btn;
      b.addEventListener('pointerdown', e => { b.setPointerCapture(e.pointerId); b.classList.add('on'); padToGame(k, true); e.preventDefault(); });
      const rel = () => { b.classList.remove('on'); padToGame(k, false); };
      b.addEventListener('pointerup', rel); b.addEventListener('pointercancel', rel);
    });
    root.append(touchEl);
  }

  // ---------- environment ----------
  const onNotice = (e: Event) => toast((e as CustomEvent<string>).detail);
  addEventListener('mishrin:notice', onNotice);
  const onVis = () => { if (!session) return; if (document.hidden) session.pause(true); else if (overlay.hidden) session.pause(false); };
  const onFs = () => {
    if (document.fullscreenElement) wasFullscreen = true;
    else if (wasFullscreen && session && overlay.hidden) openOverlay();
    applyDisplay();
  };
  const onResize = () => applyDisplay();
  document.addEventListener('visibilitychange', onVis);
  document.addEventListener('fullscreenchange', onFs);
  addEventListener('resize', onResize);
  wasFullscreen = !!document.fullscreenElement;

  start();

  return () => {
    closed = true;
    teardownSession();
    capturePad(null);
    removeEventListener('keydown', onKey, true); removeEventListener('keyup', onKey, true);
    popExit(); popOverlayBack?.();
    removeEventListener('resize', onResize);
    removeEventListener('mishrin:notice', onNotice);
    document.removeEventListener('visibilitychange', onVis);
    document.removeEventListener('fullscreenchange', onFs);
    if (document.pointerLockElement) document.exitPointerLock();
    exitFullscreen();
    root.hidden = true; root.replaceChildren(); app.inert = false;
    if (settings.lowMemory) reclaimAll();
  };
}
