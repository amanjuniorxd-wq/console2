/**
 * Controller-first navigation: spatial focus for arrows / D-pad / stick, A = select, B = back,
 * LB/RB = switch sections. Gamepad polling runs only while a pad is connected (no idle rAF).
 */
import { Btn } from '../runtime/types';
import { onPad, pads, type PadState } from '../input/gamepad';
import { FB, LOGICAL_FROM_FULL } from '../input/pad';

type PadHandler = (b: Btn, down: boolean) => void;
type FullHandler = (full: number, raw: number, axes: [number, number, number, number]) => void;
type Dir = 'up' | 'down' | 'left' | 'right';

const root = document.documentElement;
const backStack: (() => void)[] = [];
let padHandler: PadHandler | null = null;
let fullHandler: FullHandler | null = null;
let overlayToggle: (() => void) | null = null;
let sectionStep: ((d: 1 | -1) => void) | null = null;
let padEnabled = true;
export function setPadEnabled(on: boolean) { padEnabled = on; }

export const setInputMode = (m: string) => { if (root.dataset.input !== m) root.dataset.input = m; };

export function pushBack(fn: () => void): () => void {
  backStack.push(fn);
  return () => { const i = backStack.lastIndexOf(fn); if (i >= 0) backStack.splice(i, 1); };
}
export function back(): void {
  const fn = backStack.pop();
  if (fn) return fn();
  if (location.hash && !/^#\/?(home)?$/.test(location.hash)) history.back();
}

/** While a game is running, pad buttons go to the session instead of the UI. */
export function capturePad(h: PadHandler | null, toggleOverlay: (() => void) | null = null, full: FullHandler | null = null) { padHandler = h; overlayToggle = toggleOverlay; fullHandler = full; lastFull = -1; lastSig = ''; }
export function onSection(f: (d: 1 | -1) => void) { sectionStep = f; }

const SEL = 'button:not([disabled]),a[href],input:not([disabled]),[tabindex="0"]';
function focusables(): HTMLElement[] {
  const scope = (document.querySelector('[data-modal]') as HTMLElement | null) ?? document.body;
  return [...scope.querySelectorAll<HTMLElement>(SEL)].filter(e => {
    if (e.closest('[hidden],[inert]')) return false;
    const r = e.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  });
}

export function move(dir: Dir): void {
  const cur = document.activeElement as HTMLElement | null;
  const list = focusables();
  if (!cur || cur === document.body || !list.includes(cur)) { focusFirst(); return; }
  const a = cur.getBoundingClientRect();
  const ax = a.left + a.width / 2, ay = a.top + a.height / 2;
  let best: HTMLElement | null = null, bestScore = Infinity;
  for (const el of list) {
    if (el === cur) continue;
    const b = el.getBoundingClientRect();
    const bx = b.left + b.width / 2, by = b.top + b.height / 2;
    const dx = bx - ax, dy = by - ay;
    let primary: number, secondary: number;
    if (dir === 'right') { if (b.left < a.right - 4 && dx <= 4) continue; primary = dx; secondary = Math.abs(dy); }
    else if (dir === 'left') { if (b.right > a.left + 4 && dx >= -4) continue; primary = -dx; secondary = Math.abs(dy); }
    else if (dir === 'down') { if (b.top < a.bottom - 4 && dy <= 4) continue; primary = dy; secondary = Math.abs(dx); }
    else { if (b.bottom > a.top + 4 && dy >= -4) continue; primary = -dy; secondary = Math.abs(dx); }
    if (primary <= 0) continue;
    const score = primary + secondary * 2.2;
    if (score < bestScore) { bestScore = score; best = el; }
  }
  if (best) focusEl(best);
}

export function focusEl(el: HTMLElement): void {
  el.focus({ preventScroll: true });
  el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}
export function focusFirst(scope: ParentNode = document): void {
  const el = (scope.querySelector('[data-autofocus]') as HTMLElement | null) ?? (scope.querySelector('#view ' + SEL.split(',').join(',#view ')) as HTMLElement | null) ?? focusables()[0];
  if (el) focusEl(el);
}

const KEYDIR: Record<string, Dir> = { ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right' };

function onKey(e: KeyboardEvent): void {
  setInputMode('key');
  if (padHandler) return; // player owns keyboard while a game runs
  const t = e.target as HTMLElement;
  const typing = t instanceof HTMLInputElement && /^(text|search|url|number)$/.test(t.type);
  const d = KEYDIR[e.key];
  if (d) {
    if (typing && (d === 'left' || d === 'right')) return;
    e.preventDefault(); move(d); return;
  }
  if (e.key === 'Escape' || (e.key === 'Backspace' && !typing)) { e.preventDefault(); back(); return; }
  if ((e.key === 'q' || e.key === 'e') && !typing && !e.ctrlKey && !e.metaKey) sectionStep?.(e.key === 'e' ? 1 : -1);
}

// ---- gamepad (shared poller: src/input/gamepad.ts) ---------------------------------------
let prevFull = 0, prevHome = false, prevSel = false, prevStart = false, lastFull = -1;
const held: Record<string, number> = {};
const DIRS: [Dir, number][] = [['up', FB.up], ['down', FB.down], ['left', FB.left], ['right', FB.right]];

let lastSig = '';
function onPadState({ full, raw, axes, home }: PadState): void {
  if (!padEnabled) { prevFull = full; return; }
  const t = performance.now();
  const is = (bit: number) => !!(full & (1 << bit)), was = (bit: number) => !!(prevFull & (1 << bit));
  const pressed = (bit: number) => is(bit) && !was(bit);
  if (full || home) setInputMode('pad');
  const sel = is(FB.select), start = is(FB.start);
  const menuCombo = (sel && start && !(prevSel && prevStart));
  if (padHandler || fullHandler) {
    if (fullHandler) { const sig = `${full}|${raw}|${axes.map(v => (v > 64 ? 1 : v < -64 ? -1 : 0)).join()}`; if (full !== lastFull || sig !== lastSig) { lastFull = full; lastSig = sig; fullHandler(full, raw, axes); } }
    else for (const [f, b] of LOGICAL_FROM_FULL) if (is(FB[f]) !== was(FB[f])) padHandler!(b, is(FB[f]));
    if ((home && !prevHome) || menuCombo) overlayToggle?.();
  } else {
    for (const [d, bit] of DIRS) {
      if (pressed(bit)) { move(d); held[d] = t + 350; }
      else if (is(bit) && t >= (held[d] ?? Infinity)) { move(d); held[d] = t + 110; }
      else if (!is(bit)) delete held[d];
    }
    if (pressed(FB.cross)) (document.activeElement as HTMLElement | null)?.click();
    if (pressed(FB.circle)) back();
    if (pressed(FB.l1)) sectionStep?.(-1);
    if (pressed(FB.r1)) sectionStep?.(1);
  }
  prevFull = full; prevHome = home; prevSel = sel; prevStart = start;
}
export const padConnected = () => pads().length > 0;

export function initNav(): void {
  addEventListener('keydown', onKey);
  addEventListener('pointerdown', e => setInputMode((e as PointerEvent).pointerType === 'touch' ? 'touch' : 'pointer'), { passive: true });
  addEventListener('gamepadconnected', () => { setInputMode('pad'); dispatchEvent(new Event('mishrin:pad')); });
  addEventListener('gamepaddisconnected', () => dispatchEvent(new Event('mishrin:pad')));
  onPad(onPadState);
}
