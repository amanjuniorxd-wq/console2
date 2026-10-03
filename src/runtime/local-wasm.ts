/** LocalWASM adapter: MPC Framebuffer ABI modules in a dedicated worker (OffscreenCanvas), main-thread fallback. */
import type { LaunchContext, RuntimeAdapter, Session, Stats, Btn } from './types';
import type { LoopMsg, LoopOut } from './fb-loop';
import { getPackage, compiled } from '../mpc/store';

function validateWasm(b: ArrayBuffer): void {
  const v = new Uint8Array(b, 0, Math.min(4, b.byteLength));
  if (v[0] === 0x3c) throw new Error('The game URL returned a web page instead of a game file. Check the URL.');
  if (v[0] !== 0 || v[1] !== 0x61 || v[2] !== 0x73 || v[3] !== 0x6d) throw new Error('File is not a WebAssembly module.');
  if (!WebAssembly.validate(b)) throw new Error('WebAssembly module failed validation.');
}

export const localWasm: RuntimeAdapter = {
  backend: 'local-wasm',
  async launch(ctx: LaunchContext): Promise<Session> {
    const { game, host, caps, settings, signal, status } = ctx;
    status('Loading', 0);
    const pkg = await getPackage(game, (l, t) => status('Loading', t ? l / t : 0), signal);
    status('Preparing', 1);
    // Bytes from the MPC store were validated when they were stored; only fresh downloads are re-checked.
    if (!pkg.fromCache) validateWasm(pkg.bytes);
    const { module, reused } = await compiled(pkg);
    signal.throwIfAborted();

    const canvas = document.createElement('canvas');
    canvas.className = 'game-surface' + (game.launchConfig?.pixelated === false ? '' : ' pixelated');
    host.append(canvas);

    let post: (m: LoopMsg, tr?: Transferable[]) => void;
    let worker: Worker | null = null;
    const pending = new Map<number, (v: LoopOut) => void>();
    let seq = 0;
    let stats: Stats = { fps: 0, frameMs: 0, width: 0, height: 0, route: `Local · WASM${caps.simd ? ' SIMD' : ''}${caps.offscreen ? ' · worker' : ''}${reused ? ' · reused' : ''}` };
    let ready!: (v: LoopOut) => void, fail!: (e: Error) => void;
    const readyP = new Promise<LoopOut>((res, rej) => { ready = res; fail = rej; });
    let onEnd: ((r: string) => void) | undefined;

    const onOut = (m: LoopOut) => {
      if (m.t === 'ready') { stats.width = m.w; stats.height = m.h; ready(m); }
      else if (m.t === 'stats') { stats.fps = m.fps; stats.frameMs = m.frameMs; }
      else if (m.t === 'error') { fail(new Error(m.message)); onEnd?.(m.message); }
      else if (m.t === 'saved' || m.t === 'loaded') { pending.get(m.id)?.(m); pending.delete(m.id); }
    };
    const maxFps = settings.maxFps;

    if (caps.offscreen) {
      worker = new Worker(new URL('./wasm-worker.ts', import.meta.url), { type: 'module', name: 'mpc-wasm' });
      worker.onmessage = e => onOut(e.data);
      worker.onerror = e => { fail(new Error(e.message || 'Runtime worker crashed')); onEnd?.('Runtime crashed'); };
      const off = canvas.transferControlToOffscreen();
      worker.postMessage({ t: 'boot', module, canvas: off, maxFps }, [off]);
      post = (m, tr = []) => worker!.postMessage(m, tr);
    } else {
      const { startLoop } = await import('./fb-loop');
      const h = await startLoop(module, canvas, maxFps, onOut).catch(e => { fail(e); return null; });
      post = m => h?.(m);
    }

    try { await readyP; } catch (e) { worker?.terminate(); canvas.remove(); throw e; }
    const { canSave, canPointer } = await readyP as Extract<LoopOut, { t: 'ready' }>;

    const call = (m: LoopMsg, tr?: Transferable[]) => new Promise<LoopOut>(res => { pending.set((m as { id: number }).id, res); post(m, tr); });

    return {
      backend: 'local-wasm',
      canSave,
      ownsInput: false,
      input: (b: Btn, down: boolean) => post({ t: 'input', b, down }),
      // Mouse only for modules exporting mpc_pointer (optional ABI extension): normalized → framebuffer pixels.
      ...(canPointer ? { pointer: (nx: number, ny: number, b: number) => post({ t: 'pointer', x: nx * (stats.width - 1), y: ny * (stats.height - 1), b }) } : {}),
      async save() { const r = await call({ t: 'save', id: ++seq }); return r.t === 'saved' ? r.data : null; },
      async load(d) { const c = d.slice(); const r = await call({ t: 'load', id: ++seq, data: c }, [c.buffer]); return r.t === 'loaded' && r.ok; },
      pause: on => post({ t: 'pause', on }),
      setMaxFps: max => post({ t: 'fps', max }),
      setScale: s => { canvas.style.setProperty('--fit', String(s)); },
      stats: () => stats,
      get onEnd() { return onEnd; },
      set onEnd(f) { onEnd = f; },
      dispose() { post({ t: 'stop' }); worker?.terminate(); worker = null; canvas.remove(); pending.clear(); },
    };
  },
};
