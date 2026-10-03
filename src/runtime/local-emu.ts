/** Console adapter for user-imported console games: Mishrin Emulator API ↔ the console player. */
import type { LaunchContext, RuntimeAdapter, Session, Stats, Btn } from './types';
import { EmulatorSession } from '../emu/session';
import { PAD } from '../emu/types';
import { gameFiles, getBios, loadCard, storeCard } from '../emu/storage';
import { plan as makePlan } from '../mpc/optimizer';
import { probe } from '../mpc/probe';
import { settings } from '../ui/settings-store';
import { CORES } from '../emu/registry';

/** Keyboard → controller (KeyboardEvent.code). Shown on the Controllers page. */
export const KEYMAP: Record<string, number> = {
  ArrowUp: PAD.up, ArrowDown: PAD.down, ArrowLeft: PAD.left, ArrowRight: PAD.right,
  KeyZ: PAD.cross, KeyX: PAD.circle, KeyA: PAD.square, KeyS: PAD.triangle,
  KeyQ: PAD.l1, KeyW: PAD.r1, KeyE: PAD.l2, KeyR: PAD.r2, Enter: PAD.start, ShiftRight: PAD.select, Backspace: PAD.select,
};
/** Standard-mapping gamepad button index → controller bit. */
export const PADMAP: number[] = [PAD.cross, PAD.circle, PAD.square, PAD.triangle, PAD.l1, PAD.r1, PAD.l2, PAD.r2, PAD.select, PAD.start, PAD.l3, PAD.r3, PAD.up, PAD.down, PAD.left, PAD.right];
const LOGICAL: Record<number, number> = { 0: PAD.up, 1: PAD.down, 2: PAD.left, 3: PAD.right, 4: PAD.cross, 5: PAD.circle, 6: PAD.start };

export function padMask(p: Gamepad | null): number {
  if (!p) return 0;
  let m = 0;
  for (let i = 0; i < PADMAP.length; i++) if (p.buttons[i]?.pressed) m |= 1 << PADMAP[i];
  const ax = p.axes[0] ?? 0, ay = p.axes[1] ?? 0;                     // left stick drives the D-pad (digital pad)
  if (ax < -0.5) m |= 1 << PAD.left; if (ax > 0.5) m |= 1 << PAD.right;
  if (ay < -0.5) m |= 1 << PAD.up; if (ay > 0.5) m |= 1 << PAD.down;
  return m;
}

export const localEmu: RuntimeAdapter = {
  backend: 'local-emu',
  async launch(ctx: LaunchContext): Promise<Session> {
    const { game, host, status } = ctx;
    const e = game.emu;
    if (!e) throw new Error('Not an emulation title.');
    const core = CORES[e.platform];
    if (!core.available) throw Object.assign(new Error(`${core.name}: ${core.reason}`), { code: 'unsupported' });
    status('Loading emulator', 0.1);
    const caps = await probe();
    const pl = makePlan(settings.emuProfile ?? 'auto', { cores: caps.cores, memGB: caps.memGB, webgpu: caps.webgpu, mobile: caps.mobile, lowMemory: settings.lowMemory });
    // Canvas 2D (compositor scaling) is the default; WebGPU sharp scaling is opt-in (Sharp scaling or Maximum profile).
    const presenter = (settings.emuScaling === 'sharp' || pl.profile === 'maximum') && caps.webgpu ? 'webgpu' : 'canvas2d';
    const emu = new EmulatorSession(e.platform);
    await emu.initialize({ host, plan: pl, scaling: settings.emuScaling ?? 'pixel', presenter });
    status('Starting game', 0.6);
    const [files, bios, card] = await Promise.all([gameFiles(['games', game.id], e.files.map(f => f.name), e.store), getBios(e.platform), loadCard(game.id)]);
    const options: Record<string, string> = pl.profile === 'maximum' ? { pcsx_rearmed_spu_interpolation: 'gaussian', pcsx_rearmed_dithering: 'enabled' }
      : pl.profile === 'battery' ? { pcsx_rearmed_spu_interpolation: 'simple' } : {};
    const t0 = performance.now();
    // Mouse peripheral: Port 2 keeps the controller on port 1 (both usable); Port 1 is for mouse-only games.
    const mousePort = settings.emuMouse === 'port1' ? 0 : settings.emuMouse === 'port2' ? 1 : -1;
    const devices: ('pad' | 'mouse')[] = ['pad', 'pad'];
    if (mousePort >= 0) devices[mousePort] = 'mouse';
    const info = await emu.loadGame({ files, primary: e.primary, bios, card, options, devices });
    emu.timings.loadMs = performance.now() - t0;
    emu.onCard = d => { storeCard(game.id, d).catch(() => {}); };
    try { if (localStorage.getItem('mishrin.debug') === '1') (globalThis as { __mishrinEmu?: EmulatorSession }).__mishrinEmu = emu; } catch { /* no storage */ }

    let keys = 0, pad = 0, touch = 0, last = -1, raf = 0, onEnd: ((r: string) => void) | undefined;
    let inputAt = 0;
    const push = () => { const m = keys | pad | touch; if (m !== last) { last = m; emu.setControllerInput(0, m, inputAt || performance.timeOrigin + performance.now()); inputAt = 0; } };
    const poll = () => {                                     // full controller (all 16 buttons), not just the UI subset
      const p = navigator.getGamepads ? [...navigator.getGamepads()].find(Boolean) ?? null : null;
      pad = padMask(p); push();
      raf = requestAnimationFrame(poll);
    };
    raf = requestAnimationFrame(poll);
    emu.onEnd = r => onEnd?.(r);
    let paused = false;
    const st: Stats = { fps: 0, frameMs: 0, width: info.width, height: info.height, route: `Local · ${core.name} · WASM SIMD · ${info.presenter === 'webgpu' ? 'WebGPU' : 'Canvas 2D'}` };
    emu.onStats = s => {
      Object.assign(st, { fps: s.fps, frameMs: s.emuMs, width: s.width, height: s.height });
      st.route = `Local · ${core.name} · WASM SIMD · ${info.presenter === 'webgpu' ? 'WebGPU' : 'Canvas 2D'}`;
      st.details = [
        ['Emulator', core.name], ['FPS', `${s.fps} shown · ${s.emuFps} emulated`], ['Frame time', `${s.emuMs} ms core · ${s.presentMs} ms present`],
        ['CPU (worker)', `${Math.round(s.utilization * 100)}%`], ['GPU', info.presenter === 'webgpu' ? `WebGPU${info.shaderMs ? ` · shader ${info.shaderMs.toFixed(1)} ms` : ''}` : `Canvas 2D (compositor scaling)${info.fallback ? ' · WebGPU lost, recovered' : ''}`],
        ['RAM', `${s.wasmMB} MB core`], ['Backend', `WASM SIMD · ${info.bios === 'user' ? 'your BIOS' : 'open HLE BIOS'}`], ['Profile', pl.profile], ['Threads', `1 emulation worker + audio thread (budget ${pl.workers})`],
        ['Ports', mousePort >= 0 ? `1: ${mousePort === 0 ? 'PS Mouse' : 'controller'} · 2: ${mousePort === 1 ? 'PS Mouse' : 'controller'}` : '1: controller · 2: controller'], ['Disc', `${s.diskReads} reads · ${s.diskMB} MB · cache ${Math.round(s.cacheHit * 100)}%`],
        ['Input → frame', s.inputMs >= 0 ? `${s.inputMs} ms (to next presented frame)` : '—'],
      ];
    };

    return {
      backend: 'local-emu',
      canSave: true,
      ownsInput: false,
      input() { /* keyboard arrives through rawKey (full mapping); avoid double input */ },
      padInput(b: Btn, down: boolean) { const bit = 1 << LOGICAL[b]; touch = down ? touch | bit : touch & ~bit; push(); },
      rawKey(code: string, down: boolean) {
        if (down) inputAt = performance.timeOrigin + performance.now();
        const b = KEYMAP[code];
        if (b === undefined) return;
        keys = down ? keys | (1 << b) : keys & ~(1 << b); push();
      },
      ...(mousePort >= 0 ? {
        pointerMode: 'relative' as const,
        pointerRel(dx: number, dy: number, b: number) { emu.setPointerInput(mousePort, dx, dy, b); },
      } : {}),
      async save() { return emu.saveState(); },
      async load(d) { return emu.loadState(d); },
      pause(on) { paused = on; emu.pause(on); },
      setScale() { /* internal resolution is fixed by the software renderer; see setScaling */ },
      setScaling(m: 'pixel' | 'smooth' | 'sharp') { emu.setScaling(m); },
      async reset() { await emu.reset(); },
      controlsHelp: [['D-pad', 'Arrows · D-pad · left stick'], ['✕ ○ □ △', 'Z X A S · pad A B X Y'], ['L1 R1 L2 R2', 'Q W E R · bumpers/triggers'], ['Start / Select', 'Enter / Right Shift · Start / Back']],
      setMaxFps() { /* game speed is fixed by the console; presentation adapts automatically */ },
      stats: () => st,
      get onEnd() { return onEnd; },
      set onEnd(f) { onEnd = f; },
      dispose() { cancelAnimationFrame(raf); emu.shutdown(); void paused; },
      emulator: emu,
    } as Session & { emulator: EmulatorSession };
  },
};
