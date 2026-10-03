/** One gamepad poller for the whole console: a single rAF loop reads navigator.getGamepads() once per frame and
 *  fans the state out to subscribers (UI navigation, the player, emulator adapters, the Controllers page). */
import { readFull, STD_HOME } from './pad';

export interface PadState { pad: Gamepad | null; full: number; home: boolean; buttons: boolean[] }
type Sub = (s: PadState) => void;
const subs = new Set<Sub>();
let raf = 0;

export function pads(): Gamepad[] { return navigator.getGamepads ? ([...navigator.getGamepads()].filter(Boolean) as Gamepad[]) : []; }

function tick() {
  raf = 0;
  const p = pads()[0] ?? null;
  const buttons = p ? p.buttons.map(b => !!b?.pressed) : [];
  const state: PadState = { pad: p, full: readFull(p), home: !!buttons[STD_HOME], buttons };
  for (const f of subs) f(state);
  if (subs.size && p) raf = requestAnimationFrame(tick);
}
function kick() { if (!raf && subs.size) raf = requestAnimationFrame(tick); }
addEventListener('gamepadconnected', kick);

/** Subscribe to per-frame pad state. Polling runs only while someone listens and a pad is connected. */
export function onPad(f: Sub): () => void {
  subs.add(f); kick();
  return () => { subs.delete(f); if (!subs.size && raf) { cancelAnimationFrame(raf); raf = 0; } };
}
export const padConnected = () => pads().length > 0;
