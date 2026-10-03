/**
 * Controller-first navigation: spatial focus for arrows / D-pad / stick, A = select, B = back,
 * LB/RB = switch sections. Gamepad polling runs only while a pad is connected (no idle rAF).
 */
import { Btn } from '../runtime/types';

type PadHandler = (b: Btn, down: boolean) => void;
type Dir = 'up' | 'down' | 'left' | 'right';

const root = document.documentElement;
const backStack: (() => void)[] = [];
let padHandler: PadHandler | null = null;
let overlayToggle: (() => void) | null = null;
let sectionStep: ((d: 1 | -1) => void) | null = null;
let padEnabled = true;
export function setPadEnabled(on: boolean) { padEnabled = on; if (on) startPoll(); }

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
export function capturePad(h: PadHandler | null, toggleOverlay: (() => void) | null = null) { padHandler = h; overlayToggle = toggleOverlay; }
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

// ---- gamepad -------------------------------------------------------------------------
let polling = false;
let prev: boolean[] = [];
const held: Record<string, number> = {};
const MAP: [number, Btn][] = [[12, Btn.Up], [13, Btn.Down], [14, Btn.Left], [15, Btn.Right], [0, Btn.A], [1, Btn.B], [9, Btn.Start]];

function pads(): Gamepad[] { return navigator.getGamepads ? ([...navigator.getGamepads()].filter(Boolean) as Gamepad[]) : []; }

function poll(t: number): void {
  const list = pads();
  if (!list.length || !padEnabled) { polling = false; prev = []; return; }
  requestAnimationFrame(poll);
  const p = list[0];
  const btn = (i: number) => !!p.buttons[i]?.pressed;
  const ax = p.axes[0] ?? 0, ay = p.axes[1] ?? 0;
  const now: boolean[] = [];
  for (let i = 0; i < p.buttons.length; i++) now[i] = btn(i);
  // stick → d-pad
  now[12] ||= ay < -0.5; now[13] ||= ay > 0.5; now[14] ||= ax < -0.5; now[15] ||= ax > 0.5;
  const pressed = (i: number) => now[i] && !prev[i];
  if (now.some(Boolean)) setInputMode('pad');

  if (padHandler) {
    for (const [i, b] of MAP) if (now[i] !== !!prev[i]) padHandler(b, now[i]);
    if (pressed(16) || (now[8] && pressed(9)) || (now[9] && pressed(8))) overlayToggle?.();
  } else {
    const dirs: [number, Dir][] = [[12, 'up'], [13, 'down'], [14, 'left'], [15, 'right']];
    for (const [i, d] of dirs) {
      if (pressed(i)) { move(d); held[d] = t + 350; }
      else if (now[i] && t >= (held[d] ?? Infinity)) { move(d); held[d] = t + 110; }
      else if (!now[i]) delete held[d];
    }
    if (pressed(0)) (document.activeElement as HTMLElement | null)?.click();
    if (pressed(1)) back();
    if (pressed(4)) sectionStep?.(-1);
    if (pressed(5)) sectionStep?.(1);
  }
  prev = now;
}
function startPoll() { if (!polling && padEnabled && pads().length) { polling = true; requestAnimationFrame(poll); } }
export const padConnected = () => pads().length > 0;

export function initNav(): void {
  addEventListener('keydown', onKey);
  addEventListener('pointerdown', e => setInputMode((e as PointerEvent).pointerType === 'touch' ? 'touch' : 'pointer'), { passive: true });
  addEventListener('gamepadconnected', () => { setInputMode('pad'); startPoll(); dispatchEvent(new Event('mishrin:pad')); });
  addEventListener('gamepaddisconnected', () => dispatchEvent(new Event('mishrin:pad')));
  startPoll();
}
