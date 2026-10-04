/**
 * Mishrin Emulator API (main thread). One EmulatorSession per running game; every platform backend is driven
 * through these same methods, so the console never depends on a specific core.
 *   detectFormat() → initialize() → loadGame() → [runFrame()] → pause() / reset() / saveState() / loadState()
 *   → setControllerInput() → shutdown()
 */
import { detect, type Detection, type Platform } from './detect';
import { CORES } from './registry';
import type { CoreInfo, EmuStats, GameFile, InitOptions } from './types';
import { getPackage, compiled } from '../mpc/store';
import type { Plan } from '../mpc/optimizer';

export interface InitArgs { host: HTMLElement; plan: Plan; scaling: 'sharp' | 'pixel' | 'smooth'; presenter: 'webgpu' | 'canvas2d' }
export interface LoadArgs { files: GameFile[]; primary: string; bios: GameFile[]; card: Uint8Array | null; options?: Record<string, string>; devices?: ('pad' | 'mouse')[] }

let audioCtx: AudioContext | null = null;

export class EmulatorSession {
  static detectFormat(files: File[]): Promise<Detection> { return detect(files); }

  info?: CoreInfo;
  stats?: EmuStats;
  onStats?: (s: EmuStats) => void;
  onCard?: (d: Uint8Array) => void;
  onEnd?: (reason: string) => void;
  onLog?: (l: string) => void;
  onPresenter?: (kind: string, reason?: string) => void;
  readonly canvas = document.createElement('canvas');
  private worker?: Worker;
  private seq = 0;
  private pending = new Map<number, (m: any) => void>();
  private lastBeat = 0;
  private watchdog = 0;
  private audioNode?: AudioWorkletNode;
  private ro?: ResizeObserver;
  private ended = false;
  private args!: InitArgs;
  private ready?: { resolve: (i: CoreInfo) => void; reject: (e: Error) => void };
  timings: Record<string, number> = {};

  constructor(readonly platform: Platform) {
    const d = CORES[platform];
    if (!d?.available) throw Object.assign(new Error(`${d?.name ?? platform}: ${d?.reason ?? 'not available'}`), { code: 'unsupported' });
  }

  /** Fetch + compile the core (cached by content hash: second launch = zero downloads, zero compile). */
  async initialize(a: InitArgs): Promise<void> {
    this.args = a;
    const t0 = performance.now();
    const manifest = await fetch(CORES[this.platform].coreManifest!).then(r => { if (!r.ok) throw new Error('Emulator core is not installed on this server.'); return r.json(); });
    const pkg = await getPackage({ id: `core-${this.platform}`, title: '', artwork: '', description: '', runtime: 'wasm', url: new URL(manifest.url, new URL(CORES[this.platform].coreManifest!, location.href)).href, sha256: manifest.sha256 });
    this.timings.coreFetchMs = performance.now() - t0;
    const t1 = performance.now();
    const { module, reused } = await compiled(pkg);
    this.timings.compileMs = performance.now() - t1;
    this.timings.coreCached = pkg.fromCache ? 1 : 0;
    this.timings.moduleReused = reused ? 1 : 0;
    this.module = module;
    this.canvas.className = 'game-surface emu-surface';
    a.host.append(this.canvas);
  }
  private module?: WebAssembly.Module;

  async loadGame(l: LoadArgs): Promise<CoreInfo> {
    const a = this.args;
    const w = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module', name: `mishrin-${this.platform}` });
    this.worker = w;
    w.onmessage = e => this.onMessage(e.data);
    w.onerror = e => this.fail(e.message || 'Emulator crashed.');
    const audio = await this.setupAudio().catch(() => null);
    const off = this.canvas.transferControlToOffscreen();
    const r = this.canvas.getBoundingClientRect();
    const size: [number, number] = [Math.round((r.width || 1280) * devicePixelRatio), Math.round((r.height || 720) * devicePixelRatio)];
    const opts: InitOptions & { canvas: OffscreenCanvas; size: [number, number]; plan: Plan } = {
      platform: this.platform, module: this.module!, files: l.files, primary: l.primary, bios: l.bios, card: l.card,
      options: l.options ?? {}, devices: l.devices, presenter: a.presenter, scaling: a.scaling, diskCacheMB: a.plan.diskCacheMB,
      maxCatchUp: a.plan.maxCatchUp, presentEvery: a.plan.presentEvery, audio: audio?.wire ?? null, canvas: off, size, plan: a.plan,
    };
    const transfer: Transferable[] = [off];
    if (audio?.wire?.port) transfer.push(audio.wire.port);
    const t0 = performance.now();
    const info = await new Promise<CoreInfo>((resolve, reject) => {
      this.ready = { resolve, reject };
      w.postMessage({ t: 'init', opts }, transfer);
      this.lastBeat = Date.now() + 25_000;  // loading budget: a damaged image must not hang the console
      this.startWatchdog();
    });
    this.timings.bootMs = performance.now() - t0;
    this.info = info;
    this.canvas.classList.toggle('pixelated', info.presenter === 'canvas2d' && a.scaling !== 'smooth');
    this.ro = new ResizeObserver(() => { const b = this.canvas.getBoundingClientRect(); this.post({ t: 'resize', w: Math.round(b.width * devicePixelRatio), h: Math.round(b.height * devicePixelRatio) }); });
    this.ro.observe(this.canvas);
    return info;
  }

  private async setupAudio(): Promise<{ wire: InitOptions['audio'] } | null> {
    if (typeof AudioWorkletNode === 'undefined') return null;
    audioCtx ??= new AudioContext({ latencyHint: 'interactive' });
    await audioCtx.audioWorklet.addModule(`${import.meta.env.BASE_URL}emu/mishrin-audio.worklet.js`);
    const inRate = 44100;
    let sab: SharedArrayBuffer | undefined;
    if (self.crossOriginIsolated) sab = new SharedArrayBuffer(8 + 2 * inRate); // ~0.5 s stereo int16 ring + 2 indices
    this.audioNode = new AudioWorkletNode(audioCtx, 'mishrin-audio', { outputChannelCount: [2], processorOptions: { inRate, sab } });
    this.audioNode.connect(audioCtx.destination);
    const resume = () => audioCtx?.resume().catch(() => {});
    resume(); addEventListener('pointerdown', resume, { once: true }); addEventListener('keydown', resume, { once: true });
    if (sab) return { wire: { sab } };
    const ch = new MessageChannel();                      // worker → worklet directly, no main-thread hop
    this.audioNode.port.postMessage({ port: ch.port1 }, [ch.port1]);
    return { wire: { port: ch.port2 } };
  }

  private startWatchdog() {
    clearInterval(this.watchdog);
    this.watchdog = window.setInterval(() => {
      if (!this.ended && Date.now() - this.lastBeat > 6000) this.fail('The emulator stopped responding. The image may be damaged or unsupported.');
    }, 1000);
  }

  private onMessage(m: any) {
    if (m.t === 'beat') { this.lastBeat = Date.now(); return; }
    if (m.t === 'ready') { this.lastBeat = Date.now(); this.ready?.resolve(m.info); this.ready = undefined; return; }
    if (m.t === 'error') { if (this.ready) { this.ready.reject(new Error(m.error)); this.ready = undefined; this.shutdown(); } else this.fail(m.error); return; }
    if (m.t === 'stats') { this.stats = m.stats; this.onStats?.(m.stats); return; }
    if (m.t === 'card') { this.onCard?.(m.data); return; }
    if (m.t === 'log') { this.onLog?.(m.line); return; }
    if (m.t === 'need-canvas') {                 // GPU lost: swap in a fresh canvas for the Canvas 2D presenter
      const c = document.createElement('canvas');
      c.className = this.canvas.className;
      this.canvas.replaceWith(c);
      (this as { canvas: HTMLCanvasElement }).canvas = c;
      const off = c.transferControlToOffscreen();
      this.post({ t: 'canvas', canvas: off }, [off]);
      return;
    }
    if (m.t === 'presenter') {
      if (this.info) { this.info.presenter = m.kind; this.info.fallback = m.reason; }
      this.canvas.classList.toggle('pixelated', this.args.scaling !== 'smooth');
      this.ro?.disconnect(); this.ro?.observe(this.canvas);
      this.onPresenter?.(m.kind, m.reason);
      return;
    }
    if (m.t === 'done') { this.pending.get(m.id)?.(m); this.pending.delete(m.id); }
  }
  private fail(reason: string) {
    if (this.ended) return;
    if (this.ready) { this.ready.reject(new Error(reason)); this.ready = undefined; }
    this.shutdown();
    this.onEnd?.(reason);
  }
  private post(m: object, tr: Transferable[] = []) { this.worker?.postMessage(m, tr); }
  private call(m: Record<string, unknown>, tr: Transferable[] = [], timeout = 10000): Promise<any> {
    const id = ++this.seq;
    return new Promise((res, rej) => {
      this.pending.set(id, res);
      this.post({ ...m, id }, tr);
      setTimeout(() => { if (this.pending.delete(id)) rej(new Error('Emulator did not respond.')); }, timeout);
    });
  }

  runFrame(): Promise<number> { return this.call({ t: 'step' }).then(r => r.frames); }
  pause(on: boolean) { this.post({ t: 'pause', on }); }
  reset(): Promise<void> { return this.call({ t: 'reset' }); }
  async saveState(): Promise<Uint8Array> { const r = await this.call({ t: 'save' }); if (!r.ok) throw new Error(r.error || 'Save failed'); return r.data; }
  async loadState(d: Uint8Array): Promise<boolean> { const c = d.slice(); return (await this.call({ t: 'load', data: c }, [c.buffer])).ok; }
  /** Audio pipeline statistics from the AudioWorklet (buffer level, underruns, frames played). */
  audioStats(): Promise<Record<string, number | boolean> | null> {
    const n = this.audioNode; if (!n) return Promise.resolve(null);
    return new Promise(res => { const h = (e: MessageEvent) => { if (e.data?.stats) { n.port.removeEventListener('message', h); res({ ...e.data.stats, context: audioCtx?.state ?? 'none' } as Record<string, number | boolean>); } }; n.port.addEventListener('message', h); n.port.start(); n.port.postMessage({ q: 'stats' }); setTimeout(() => res(null), 2000); });
  }
  /** Diagnostics: locate the saffron test object in the presented output (used by automated tests). */
  probe(): Promise<{ presenter: string; w: number; h: number; pixels: number; x: number; y: number; boxW: number; boxH: number }> { return this.call({ t: 'probe' }).then(r => { if (!r.ok) throw new Error(r.error); return r.probe; }); }
  gpuSelfTest(w = 1280, h = 720, mode = 0): Promise<Record<string, number | string>> { return this.call({ t: 'gpu-selftest', w, h, mode }, [], 20000).then(r => { if (!r.ok) throw new Error(r.error); return r.probe; }); }
  /** `at` = absolute event time (timeOrigin-based) for input→frame latency measurement. */
  setControllerInput(port: number, mask: number, at = performance.timeOrigin + performance.now()) { this.post({ t: 'input', port, mask, at }); }
  /** Mouse/pointer device input (relative movement + buttons) — e.g. the P1 PlayStation Mouse. */
  setPointerInput(port: number, dx: number, dy: number, buttons: number, at = performance.timeOrigin + performance.now()) { this.post({ t: 'mouse', port, dx, dy, buttons, at }); }
  setPortDevice(port: number, device: 'pad' | 'mouse') { this.post({ t: 'device', port, device }); }
  setScaling(mode: 'sharp' | 'pixel' | 'smooth') {
    this.post({ t: 'scaling', mode });
    this.canvas.classList.toggle('pixelated', this.info?.presenter === 'canvas2d' && mode !== 'smooth');
  }
  setPlan(plan: Plan) { this.post({ t: 'plan', plan }); }

  shutdown() {
    if (this.ended) return;
    this.ended = true;
    clearInterval(this.watchdog);
    this.ro?.disconnect();
    const w = this.worker;
    if (w) {
      // give the worker a moment to flush the memory card, then reclaim everything
      const done = () => w.terminate();
      const id = ++this.seq; this.pending.set(id, done);
      w.postMessage({ t: 'shutdown', id });
      setTimeout(done, 800);
    }
    this.audioNode?.disconnect();
    this.canvas.remove();
  }
}
