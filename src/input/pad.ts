/**
 * Unified input vocabulary. One table per device, one canonical controller: the 16-button "full pad" in the
 * standard Gamepad layout. Every runtime adapter derives what it needs from it:
 *   console UI / MPC WASM / web → 7 logical buttons (Btn)      Mishrin P1 → libretro joypad bits (PAD)
 *   cloud PC titles → logical buttons → manifest controllerMap   cloud emulator titles → full mask on the wire (type 5)
 */
import { Btn } from '../runtime/types';

export const FULL = ['up', 'down', 'left', 'right', 'cross', 'circle', 'square', 'triangle', 'l1', 'r1', 'l2', 'r2', 'select', 'start', 'l3', 'r3'] as const;
export type FullButton = (typeof FULL)[number];
export const FB = Object.fromEntries(FULL.map((n, i) => [n, i])) as Record<FullButton, number>;

/** W3C "standard" gamepad mapping: button index for each full-pad bit. */
export const STD_INDEX: Record<FullButton, number> = {
  cross: 0, circle: 1, square: 2, triangle: 3, l1: 4, r1: 5, l2: 6, r2: 7, select: 8, start: 9, l3: 10, r3: 11, up: 12, down: 13, left: 14, right: 15,
};
export const STD_HOME = 16;
const STICK = 0.5;

/** Gamepad → full-pad bitmask (left stick folds into the D-pad unless `fold` is false). Pure: unit-tested. */
export function readFull(p: Pick<Gamepad, 'buttons' | 'axes'> | null | undefined, fold = true): number {
  if (!p) return 0;
  let m = 0;
  for (const n of FULL) if (p.buttons[STD_INDEX[n]]?.pressed) m |= 1 << FB[n];
  if (!fold) return m;
  const ax = p.axes[0] ?? 0, ay = p.axes[1] ?? 0;
  if (ax < -STICK) m |= 1 << FB.left; if (ax > STICK) m |= 1 << FB.right;
  if (ay < -STICK) m |= 1 << FB.up; if (ay > STICK) m |= 1 << FB.down;
  return m;
}

/** Analog sticks as signed bytes (-127..127): [LX, LY, RX, RY] (standard mapping axes 0..3). */
export function readAxes(p: Pick<Gamepad, 'axes'> | null | undefined): [number, number, number, number] {
  const a = (i: number) => Math.max(-127, Math.min(127, Math.round((p?.axes[i] ?? 0) * 127)));
  return [a(0), a(1), a(2), a(3)];
}

/** Keyboard → full pad (KeyboardEvent.code). Shown on the Controllers page. */
export const KEY_FULL: Record<string, FullButton> = {
  ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right',
  KeyZ: 'cross', KeyX: 'circle', KeyA: 'square', KeyS: 'triangle',
  KeyQ: 'l1', KeyW: 'r1', KeyE: 'l2', KeyR: 'r2', Enter: 'start', ShiftRight: 'select', Backspace: 'select',
};

/** Keyboard → logical buttons (menus, MPC WASM/web titles, cloud PC titles). */
export const KEY_LOGICAL: Record<string, Btn> = {
  ArrowUp: Btn.Up, KeyW: Btn.Up, ArrowDown: Btn.Down, KeyS: Btn.Down, ArrowLeft: Btn.Left, KeyA: Btn.Left, ArrowRight: Btn.Right, KeyD: Btn.Right,
  Space: Btn.A, Enter: Btn.A, KeyZ: Btn.A, KeyJ: Btn.A, KeyX: Btn.B, KeyK: Btn.B, KeyP: Btn.Start, Tab: Btn.Start,
};

/** Full pad → logical buttons. */
export const LOGICAL_FROM_FULL: [FullButton, Btn][] = [['up', Btn.Up], ['down', Btn.Down], ['left', Btn.Left], ['right', Btn.Right], ['cross', Btn.A], ['circle', Btn.B], ['start', Btn.Start]];
export function logicalMask(full: number): number {
  let m = 0;
  for (const [f, b] of LOGICAL_FROM_FULL) if (full & (1 << FB[f])) m |= 1 << b;
  return m;
}
/** Logical button → full-pad bit (touch controls on full-pad runtimes). */
export const FULL_FROM_LOGICAL: Record<number, FullButton> = { [Btn.Up]: 'up', [Btn.Down]: 'down', [Btn.Left]: 'left', [Btn.Right]: 'right', [Btn.A]: 'cross', [Btn.B]: 'circle', [Btn.Start]: 'start' };

/** Re-map a full-pad mask into another bit layout (e.g. libretro joypad bits for Mishrin P1). */
export function remap(full: number, layout: Record<FullButton, number>): number {
  let m = 0;
  for (const n of FULL) if (full & (1 << FB[n])) m |= 1 << layout[n];
  return m;
}
