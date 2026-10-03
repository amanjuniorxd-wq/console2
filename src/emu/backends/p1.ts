/** Mishrin P1 backend: PCSX-ReARMed (GPLv2) compiled to WASI WebAssembly, driven through emulators/p1/host.c. */
import type { CoreInfo, EmulatorBackend, InitOptions } from '../types';
import { ReadOnlyWasi, blobSource, syncHandleSource, type Source } from '../wasi';

interface P1Exports {
  memory: WebAssembly.Memory;
  _initialize?: () => void;
  p1_init(): number; p1_buf(n: number): number; p1_free(p: number): void;
  p1_set_option(k: number, v: number): void; p1_load(path: number): number; p1_run(): number; p1_reset(): void; p1_unload(): void;
  p1_set_input(port: number, mask: number): void;
  p1_set_port_device?(port: number, kind: number): void; p1_add_mouse?(port: number, dx: number, dy: number, buttons: number): void;
  p1_fb(): number; p1_fb_w(): number; p1_fb_h(): number; p1_audio(): number; p1_audio_frames(): number;
  p1_fps_x1000(): number; p1_sample_rate(): number; p1_aspect_x1000(): number;
  p1_state_size(): number; p1_state_save(p: number, n: number): number; p1_state_load(p: number, n: number): number;
  p1_sram(): number; p1_sram_size(): number; p1_message(): number;
}

const REQUIRED = ['p1_init', 'p1_load', 'p1_run', 'p1_fb', 'p1_state_save'];

async function open(f: { name: string; blob?: Blob; opfs?: string[] }, cacheBlocks: number): Promise<Source> {
  if (f.opfs) {
    let dir = await navigator.storage.getDirectory();
    for (const part of f.opfs.slice(0, -1)) dir = await dir.getDirectoryHandle(part);
    const fh = await dir.getFileHandle(f.opfs[f.opfs.length - 1]);
    const h = await (fh as FileSystemFileHandle & { createSyncAccessHandle(): Promise<any> }).createSyncAccessHandle();
    return syncHandleSource(h);
  }
  if (!f.blob) throw new Error(`missing data for ${f.name}`);
  return blobSource(f.blob, 1 << 16, cacheBlocks);
}

export function createP1(): EmulatorBackend {
  let x: P1Exports;
  let wasi: ReadOnlyWasi;
  let sources: Source[] = [];
  const cstr = (s: string) => { const b = new TextEncoder().encode(s + '\0'); const p = x.p1_buf(b.length); new Uint8Array(x.memory.buffer).set(b, p); return p; };
  const readStr = (p: number) => { const u = new Uint8Array(x.memory.buffer, p, 256); const n = u.indexOf(0); return new TextDecoder().decode(u.subarray(0, n < 0 ? 256 : n)); };

  return {
    async initialize(o: InitOptions, log): Promise<CoreInfo> {
      const t0 = performance.now();
      const names = WebAssembly.Module.exports(o.module).map(e => e.name);
      if (!REQUIRED.every(r => names.includes(r))) throw new Error('This is not a Mishrin P1 core.');
      // The core may only import WASI; anything else means a wrong/unsafe module.
      if (WebAssembly.Module.imports(o.module).some(i => i.module !== 'wasi_snapshot_preview1')) throw new Error('Core requests non-WASI imports.');
      const blocks = Math.max(16, Math.round((o.diskCacheMB * 1024 * 1024) / (1 << 16)));
      const game: Record<string, Source> = {}, bios: Record<string, Source> = {};
      for (const f of o.files) { const s = await open(f, blocks); sources.push(s); game[f.name] = s; }
      for (const f of o.bios) { const s = await open(f, 16); sources.push(s); bios[f.name] = s; }
      wasi = new ReadOnlyWasi({ '/game': game, '/bios': bios, '/save': {} }, log);
      const inst = await WebAssembly.instantiate(o.module, { wasi_snapshot_preview1: wasi.imports() });
      x = inst.exports as unknown as P1Exports;
      wasi.bind(x.memory);
      x._initialize?.();
      x.p1_init();
      const opts: Record<string, string> = {
        pcsx_rearmed_bios: o.bios.length ? 'auto' : 'HLE',     // open HLE BIOS unless the user supplied their own
        pcsx_rearmed_region: 'auto', pcsx_rearmed_frameskip_type: 'disabled', pcsx_rearmed_memcard2: 'disabled',
        ...o.options,
      };
      for (const [k, v] of Object.entries(opts)) x.p1_set_option(cstr(k), cstr(v));
      const initMs = performance.now() - t0;
      if (!x.p1_load(cstr('/game/' + o.primary))) {
        const m = readStr(x.p1_message());
        // The core's BIOS notice is informational, not the reason a load failed.
        throw new Error(m && !/BIOS/i.test(m) ? m : 'This image could not be loaded — it may be damaged, incomplete or not a P1-class disc.');
      }
      o.devices?.forEach((d, port) => { if (d === 'mouse') x.p1_set_port_device?.(port, 2); });
      if (o.card) {
        const n = x.p1_sram_size();
        if (n && o.card.length === n) new Uint8Array(x.memory.buffer, x.p1_sram(), n).set(o.card);
      }
      const msg = readStr(x.p1_message());
      return {
        fps: x.p1_fps_x1000() / 1000, sampleRate: x.p1_sample_rate(), width: x.p1_fb_w() || 320, height: x.p1_fb_h() || 240,
        aspect: x.p1_aspect_x1000() / 1000 || 4 / 3, bios: o.bios.length && !/HLE|No PlayStation BIOS/i.test(msg) ? 'user' : 'open-hle',
        presenter: o.presenter, loadMs: performance.now() - t0, initMs, stateSize: x.p1_state_size(), message: msg,
      };
    },
    runFrame: () => !!x.p1_run(),
    framebuffer() {
      const w = x.p1_fb_w(), h = x.p1_fb_h();
      return { data: new Uint8Array(x.memory.buffer, x.p1_fb(), w * h * 4), width: w, height: h };
    },
    audio: () => new Int16Array(x.memory.buffer, x.p1_audio(), x.p1_audio_frames() * 2),
    reset: () => x.p1_reset(),
    saveState() {
      const n = x.p1_state_size(), p = x.p1_buf(n);
      try {
        if (!x.p1_state_save(p, n)) throw new Error('save state failed');
        return new Uint8Array(x.memory.buffer, p, n).slice();
      } finally { x.p1_free(p); }
    },
    loadState(s) {
      const p = x.p1_buf(s.length);
      try { new Uint8Array(x.memory.buffer, p, s.length).set(s); return !!x.p1_state_load(p, s.length); }
      finally { x.p1_free(p); }
    },
    setControllerInput: (port, mask) => x.p1_set_input(port, mask),
    setPortDevice: (port, d) => x.p1_set_port_device?.(port, d === 'mouse' ? 2 : 1),
    // DOM buttons (1 left, 2 right) → core bits (1 left, 2 right); deltas in screen pixels, clamped per frame by the core
    setPointerInput: (port, dx, dy, b) => x.p1_add_mouse?.(port, Math.round(dx), Math.round(dy), (b & 1) | ((b & 2) ? 2 : 0)),
    memoryCard() { const n = x.p1_sram_size(); return n ? new Uint8Array(x.memory.buffer, x.p1_sram(), n) : null; },
    memoryBytes: () => x.memory.buffer.byteLength,
    diskStats() {
      const st = (sources as (Source & { stats?: { hits: number; misses: number } })[]).reduce((a, s) => ({ h: a.h + (s.stats?.hits ?? 0), m: a.m + (s.stats?.misses ?? 0) }), { h: 0, m: 0 });
      return { reads: wasi.stats.reads, bytes: wasi.stats.bytesRead, hit: st.h + st.m ? st.h / (st.h + st.m) : 1 };
    },
    shutdown() {
      try { x?.p1_unload(); } catch { /* core may already be gone */ }
      wasi?.close();
      for (const s of sources) s.close?.();
      sources = [];
    },
  };
}
