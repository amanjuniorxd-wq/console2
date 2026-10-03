/**
 * Minimal, read-only WASI (preview1) for emulator cores, running inside the emulator worker.
 *
 * The core sees exactly three preopened directories: /game (the user's selected files), /bios (optional,
 * user-supplied) and /save (empty). Files are read lazily through a block cache straight from the user's local
 * File/Blob or OPFS sync handle — "memory-mapped style": a 700 MB disc costs only the cached blocks in RAM.
 * Nothing can be written, created, deleted, listed outside these folders, or sent over a network:
 * the core module receives no other imports.
 */
export interface Source { readonly size: number; read(offset: number, dst: Uint8Array): number; close?(): void }

/** Random-access reads from a Blob/File via FileReaderSync with an LRU block cache (workers only). */
export function blobSource(blob: Blob, blockSize = 1 << 16, maxBlocks = 256): Source & { stats: { hits: number; misses: number } } {
  const cache = new Map<number, Uint8Array>();
  const reader = new FileReaderSync();
  const stats = { hits: 0, misses: 0 };
  const block = (i: number) => {
    let b = cache.get(i);
    if (b) { cache.delete(i); cache.set(i, b); stats.hits++; return b; }
    stats.misses++;
    b = new Uint8Array(reader.readAsArrayBuffer(blob.slice(i * blockSize, Math.min(blob.size, (i + 1) * blockSize))));
    cache.set(i, b);
    if (cache.size > maxBlocks) cache.delete(cache.keys().next().value!);
    return b;
  };
  return {
    size: blob.size, stats,
    read(offset, dst) {
      let done = 0;
      while (done < dst.length && offset + done < blob.size) {
        const pos = offset + done, bi = Math.floor(pos / blockSize), b = block(bi), o = pos - bi * blockSize;
        const n = Math.min(b.length - o, dst.length - done);
        if (n <= 0) break;
        dst.set(b.subarray(o, o + n), done);
        done += n;
      }
      return done;
    },
  };
}

/** OPFS FileSystemSyncAccessHandle: synchronous positional reads with no extra copies. */
export function syncHandleSource(h: { getSize(): number; read(b: Uint8Array, o: { at: number }): number; close(): void }): Source {
  const size = h.getSize();
  return { size, read: (offset, dst) => (offset >= size ? 0 : h.read(dst, { at: offset })), close: () => h.close() };
}

export function bytesSource(bytes: Uint8Array): Source {
  return { size: bytes.length, read: (o, d) => { const n = Math.max(0, Math.min(d.length, bytes.length - o)); d.set(bytes.subarray(o, o + n)); return n; } };
}

const E = { SUCCESS: 0, ACCES: 2, BADF: 8, INVAL: 28, ISDIR: 31, NOENT: 44, NOSYS: 52, NOTDIR: 54, ROFS: 69, SPIPE: 70 } as const;
const FT = { CHAR: 2, DIR: 3, FILE: 4 } as const;
export class WasiExit extends Error { constructor(public code: number) { super(`exit ${code}`); } }

interface Dir { path: string; entries: Map<string, { name: string; src: Source }> }
interface Open { kind: 'file'; src: Source; pos: number; name: string }
interface OpenDir { kind: 'dir'; dir: Dir }

export class ReadOnlyWasi {
  private mem!: WebAssembly.Memory;
  private fds = new Map<number, Open | OpenDir>();
  private dirs: Dir[] = [];
  private next = 0;
  private log = '';
  readonly stats = { opens: 0, bytesRead: 0, reads: 0, denied: 0 };

  constructor(dirs: Record<string, Record<string, Source>>, private onLog: (line: string) => void = () => {}) {
    let fd = 3;
    for (const [path, files] of Object.entries(dirs)) {
      const d: Dir = { path, entries: new Map(Object.entries(files).map(([n, src]) => [n.toLowerCase(), { name: n, src }])) };
      this.dirs.push(d);
      this.fds.set(fd++, { kind: 'dir', dir: d });
    }
    this.next = fd;
  }
  bind(memory: WebAssembly.Memory) { this.mem = memory; }
  private get dv() { return new DataView(this.mem.buffer); }
  private get u8() { return new Uint8Array(this.mem.buffer); }
  private str(p: number, n: number) { return new TextDecoder().decode(this.u8.subarray(p, p + n)); }

  private resolve(dirfd: number, path: string): { dir: Dir; name: string } | number {
    const base = this.fds.get(dirfd);
    if (!base || base.kind !== 'dir') return E.BADF;
    const parts = path.split('/').filter(p => p && p !== '.');
    if (parts.some(p => p === '..')) { this.stats.denied++; return E.ACCES; }      // no escaping the preopen
    if (parts.length > 1) return E.NOENT;                                           // flat folders only
    return { dir: base.dir, name: parts[0] ?? '' };
  }
  private filestat(ptr: number, type: number, size: number) {
    const dv = this.dv;
    for (let i = 0; i < 64; i += 4) dv.setUint32(ptr + i, 0, true);
    dv.setUint8(ptr + 16, type);
    dv.setBigUint64(ptr + 24, 1n, true);
    dv.setBigUint64(ptr + 32, BigInt(size), true);
  }

  imports(): WebAssembly.ModuleImports {
    const self = this;
    const impl: Record<string, (...a: any[]) => number | void> = {
      args_sizes_get(c: number, s: number) { self.dv.setUint32(c, 0, true); self.dv.setUint32(s, 0, true); return 0; },
      args_get() { return 0; },
      environ_sizes_get(c: number, s: number) { self.dv.setUint32(c, 0, true); self.dv.setUint32(s, 0, true); return 0; },
      environ_get() { return 0; },
      clock_time_get(id: number, _prec: bigint, out: number) {
        const ns = id === 0 ? BigInt(Date.now()) * 1000000n : BigInt(Math.round(performance.now() * 1e6));
        self.dv.setBigUint64(out, ns, true); return 0;
      },
      random_get(p: number, n: number) { crypto.getRandomValues(self.u8.subarray(p, p + n)); return 0; },
      proc_exit(code: number) { throw new WasiExit(code); },
      sched_yield() { return 0; },
      fd_prestat_get(fd: number, p: number) {
        const o = self.fds.get(fd);
        if (!o || o.kind !== 'dir' || fd >= 3 + self.dirs.length) return E.BADF;
        self.dv.setUint8(p, 0); self.dv.setUint32(p + 4, new TextEncoder().encode(o.dir.path).length, true); return 0;
      },
      fd_prestat_dir_name(fd: number, p: number, n: number) {
        const o = self.fds.get(fd); if (!o || o.kind !== 'dir') return E.BADF;
        self.u8.set(new TextEncoder().encode(o.dir.path).subarray(0, n), p); return 0;
      },
      fd_fdstat_get(fd: number, p: number) {
        const o = self.fds.get(fd);
        const type = fd <= 2 ? FT.CHAR : o?.kind === 'dir' ? FT.DIR : o ? FT.FILE : -1;
        if (type < 0) return E.BADF;
        self.dv.setUint8(p, type); self.dv.setUint16(p + 2, 0, true);
        self.dv.setBigUint64(p + 8, 0xffffffffffffffffn, true); self.dv.setBigUint64(p + 16, 0xffffffffffffffffn, true); return 0;
      },
      fd_fdstat_set_flags() { return 0; },
      path_open(dirfd: number, _df: number, pp: number, pl: number, oflags: number, _rb: bigint, _ri: bigint, _ff: number, out: number) {
        const r = self.resolve(dirfd, self.str(pp, pl));
        if (typeof r === 'number') return r;
        if (oflags & (1 | 4 | 8)) { self.stats.denied++; return E.ROFS; }               // CREAT / EXCL / TRUNC: read-only FS
        let o: Open | OpenDir;
        if (!r.name) o = { kind: 'dir', dir: r.dir };
        else {
          const e = r.dir.entries.get(r.name.toLowerCase());
          if (!e) return E.NOENT;
          if (oflags & 2) return E.NOTDIR;
          o = { kind: 'file', src: e.src, pos: 0, name: e.name };
        }
        const fd = self.next++; self.fds.set(fd, o); self.dv.setUint32(out, fd, true); self.stats.opens++; return 0;
      },
      fd_close(fd: number) { if (fd < 3 + self.dirs.length) return fd <= 2 ? 0 : E.BADF; return self.fds.delete(fd) ? 0 : E.BADF; },
      fd_read(fd: number, iovs: number, n: number, out: number) {
        const o = self.fds.get(fd);
        if (!o) return fd === 0 ? (self.dv.setUint32(out, 0, true), 0) : E.BADF;
        if (o.kind !== 'file') return E.ISDIR;
        let total = 0;
        for (let i = 0; i < n; i++) {
          const buf = self.dv.getUint32(iovs + i * 8, true), len = self.dv.getUint32(iovs + i * 8 + 4, true);
          const got = o.src.read(o.pos, self.u8.subarray(buf, buf + len));
          o.pos += got; total += got;
          if (got < len) break;
        }
        self.stats.reads++; self.stats.bytesRead += total;
        self.dv.setUint32(out, total, true); return 0;
      },
      fd_seek(fd: number, off: bigint, whence: number, out: number) {
        const o = self.fds.get(fd);
        if (!o) return fd <= 2 ? E.SPIPE : E.BADF;
        if (o.kind !== 'file') return E.ISDIR;
        const base = whence === 0 ? 0 : whence === 1 ? o.pos : o.src.size;
        const pos = base + Number(off);
        if (pos < 0) return E.INVAL;
        o.pos = pos; self.dv.setBigUint64(out, BigInt(pos), true); return 0;
      },
      fd_tell(fd: number, out: number) { const o = self.fds.get(fd); if (!o || o.kind !== 'file') return E.BADF; self.dv.setBigUint64(out, BigInt(o.pos), true); return 0; },
      fd_filestat_get(fd: number, p: number) {
        const o = self.fds.get(fd);
        if (!o) return fd <= 2 ? (self.filestat(p, FT.CHAR, 0), 0) : E.BADF;
        self.filestat(p, o.kind === 'dir' ? FT.DIR : FT.FILE, o.kind === 'dir' ? 0 : o.src.size); return 0;
      },
      path_filestat_get(dirfd: number, _f: number, pp: number, pl: number, p: number) {
        const r = self.resolve(dirfd, self.str(pp, pl));
        if (typeof r === 'number') return r;
        if (!r.name) { self.filestat(p, FT.DIR, 0); return 0; }
        const e = r.dir.entries.get(r.name.toLowerCase());
        if (!e) return E.NOENT;
        self.filestat(p, FT.FILE, e.src.size); return 0;
      },
      fd_readdir(fd: number, buf: number, len: number, cookie: bigint, out: number) {
        const o = self.fds.get(fd);
        if (!o || o.kind !== 'dir') return E.NOTDIR;
        const list = [...o.dir.entries.values()];
        let used = 0;
        for (let i = Number(cookie); i < list.length; i++) {
          const name = new TextEncoder().encode(list[i].name);
          const ent = new Uint8Array(24 + name.length), dv = new DataView(ent.buffer);
          dv.setBigUint64(0, BigInt(i + 1), true); dv.setBigUint64(8, BigInt(i + 1), true);
          dv.setUint32(16, name.length, true); dv.setUint8(20, FT.FILE); ent.set(name, 24);
          const n = Math.min(ent.length, len - used);
          self.u8.set(ent.subarray(0, n), buf + used); used += n;
          if (used >= len) break;
        }
        self.dv.setUint32(out, used, true); return 0;
      },
      fd_write(fd: number, iovs: number, n: number, out: number) {
        if (fd !== 1 && fd !== 2) { self.stats.denied++; return E.BADF; }   // no file writes at all
        let total = 0;
        for (let i = 0; i < n; i++) {
          const b = self.dv.getUint32(iovs + i * 8, true), l = self.dv.getUint32(iovs + i * 8 + 4, true);
          self.log += self.str(b, l); total += l;
        }
        if (self.log.length > 4096) self.log = self.log.slice(-4096);
        let nl;
        while ((nl = self.log.indexOf('\n')) >= 0) { self.onLog(self.log.slice(0, nl)); self.log = self.log.slice(nl + 1); }
        self.dv.setUint32(out, total, true); return 0;
      },
    };
    // Anything else the core might import is denied rather than missing.
    return new Proxy(impl, { get: (t, k: string) => t[k] ?? (() => { self.stats.denied++; return E.NOSYS; }) }) as WebAssembly.ModuleImports;
  }

  close() { this.fds.clear(); } // sources are owned (and closed) by the backend
}
