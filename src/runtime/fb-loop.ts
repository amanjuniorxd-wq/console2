/**
 * MPC Framebuffer ABI v1 runner. Shared by the worker (OffscreenCanvas) and the main-thread fallback.
 * Zero-copy: the ImageData is a view over WASM linear memory, rebuilt only if memory grows.
 */
export interface FbExports {
  memory: WebAssembly.Memory;
  mpc_init(seed: number): void;
  mpc_width(): number;
  mpc_height(): number;
  mpc_frame(dtMs: number): number;
  mpc_input(b: number, down: number): void;
  mpc_pointer?(x: number, y: number, buttons: number): void;
  mpc_state_ptr?(): number;
  mpc_state_size?(): number;
}

export type Ctx2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
export type LoopMsg =
  | { t: 'input'; b: number; down: boolean }
  | { t: 'pointer'; x: number; y: number; b: number }
  | { t: 'pause'; on: boolean }
  | { t: 'fps'; max: number }
  | { t: 'save'; id: number }
  | { t: 'load'; id: number; data: Uint8Array }
  | { t: 'stop' };
export type LoopOut =
  | { t: 'ready'; w: number; h: number; canSave: boolean; canPointer: boolean }
  | { t: 'stats'; fps: number; frameMs: number }
  | { t: 'saved'; id: number; data: Uint8Array | null }
  | { t: 'loaded'; id: number; ok: boolean }
  | { t: 'error'; message: string };

const REQUIRED = ['memory', 'mpc_init', 'mpc_width', 'mpc_height', 'mpc_frame', 'mpc_input'];

export async function startLoop(module: WebAssembly.Module, canvas: HTMLCanvasElement | OffscreenCanvas, maxFps: number, post: (m: LoopOut, transfer?: Transferable[]) => void) {
  const names = WebAssembly.Module.exports(module).map(e => e.name);
  const missing = REQUIRED.filter(n => !names.includes(n));
  if (missing.length) throw new Error(`Not an MPC game module (missing ${missing.join(', ')})`);
  // Sandbox: the module gets no imports at all — no network, DOM, clock or filesystem.
  if (WebAssembly.Module.imports(module).length) throw new Error('Module requests host imports; ABI v1 modules must be import-free.');
  const inst = await WebAssembly.instantiate(module, {});
  const x = inst.exports as unknown as FbExports;
  x.mpc_init((Math.random() * 2 ** 31) | 0);
  const w = x.mpc_width(), h = x.mpc_height();
  if (!(w > 0 && h > 0 && w * h <= 4096 * 4096)) throw new Error('Invalid framebuffer size');
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext('2d', { alpha: false, desynchronized: true }) as Ctx2D | null;
  if (!ctx) throw new Error('2D canvas unavailable');
  const canSave = typeof x.mpc_state_ptr === 'function' && typeof x.mpc_state_size === 'function';
  post({ t: 'ready', w, h, canSave, canPointer: typeof x.mpc_pointer === 'function' });

  let img: ImageData | null = null, imgBuf: ArrayBuffer | null = null, imgPtr = -1;
  let paused = false, stopped = false, minDt = maxFps > 0 ? 1000 / maxFps - 1 : 0;
  let last = performance.now(), lastDraw = 0, frames = 0, work = 0, statT = last;
  const raf: (cb: (t: number) => void) => unknown =
    typeof requestAnimationFrame === 'function' ? requestAnimationFrame : (cb) => setTimeout(() => cb(performance.now()), 16);

  const tick = (t: number) => {
    if (stopped) return;
    raf(tick);
    if (paused) { last = t; return; }
    if (minDt && t - lastDraw < minDt) return;
    lastDraw = t;
    const dt = t - last; last = t;
    const s = performance.now();
    const ptr = x.mpc_frame(dt);
    if (!img || imgBuf !== x.memory.buffer || imgPtr !== ptr) {
      imgBuf = x.memory.buffer; imgPtr = ptr;
      img = new ImageData(new Uint8ClampedArray(imgBuf, ptr, w * h * 4), w, h);
    }
    ctx.putImageData(img, 0, 0);
    work += performance.now() - s; frames++;
    if (t - statT >= 1000) { post({ t: 'stats', fps: Math.round((frames * 1000) / (t - statT)), frameMs: +(work / frames).toFixed(2) }); frames = 0; work = 0; statT = t; }
  };
  raf(tick);

  return (m: LoopMsg) => {
    switch (m.t) {
      case 'input': x.mpc_input(m.b, m.down ? 1 : 0); break;
      case 'pointer': x.mpc_pointer?.(Math.round(m.x), Math.round(m.y), m.b & 7); break;
      case 'pause': paused = m.on; break;
      case 'fps': minDt = m.max > 0 ? 1000 / m.max - 1 : 0; break;
      case 'save': {
        if (!canSave) { post({ t: 'saved', id: m.id, data: null }); break; }
        const d = new Uint8Array(x.memory.buffer, x.mpc_state_ptr!(), x.mpc_state_size!()).slice();
        post({ t: 'saved', id: m.id, data: d }, [d.buffer]);
        break;
      }
      case 'load': {
        const size = canSave ? x.mpc_state_size!() : -1;
        const ok = canSave && m.data.byteLength === size;
        if (ok) new Uint8Array(x.memory.buffer, x.mpc_state_ptr!(), size).set(m.data);
        post({ t: 'loaded', id: m.id, ok });
        break;
      }
      case 'stop': stopped = true; break;
    }
  };
}
