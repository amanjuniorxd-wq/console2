/**
 * ZIP / RAR / 7z archives in the browser: recognised by magic bytes, listed from their headers only (ZIP central
 * directory, RAR4/RAR5 block headers) — nothing is decompressed or expanded here. The archive is uploaded as one
 * file; the cloud extracts it safely and decides the platform from the extracted contents (server/lib/archive.mjs).
 */
export type ArchiveKind = 'zip' | 'rar' | '7z';
export interface ArchiveEntry { name: string; size: number }
export interface ArchiveListing { kind: ArchiveKind; entries: ArchiveEntry[]; complete: boolean; encrypted?: boolean }

const MAX_ENTRIES = 20000;
const read = async (f: Blob, off: number, len: number) => new Uint8Array(await f.slice(off, Math.min(f.size, off + len)).arrayBuffer());
const u16 = (b: Uint8Array, o: number) => b[o] | (b[o + 1] << 8);
const u32 = (b: Uint8Array, o: number) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
const u64 = (b: Uint8Array, o: number) => u32(b, o) + u32(b, o + 4) * 2 ** 32;
const utf8 = (b: Uint8Array) => new TextDecoder().decode(b);

export function archiveKind(h: Uint8Array): ArchiveKind | null {
  if (h[0] === 0x50 && h[1] === 0x4b && ((h[2] === 3 && h[3] === 4) || (h[2] === 5 && h[3] === 6))) return 'zip';
  if (h[0] === 0x52 && h[1] === 0x61 && h[2] === 0x72 && h[3] === 0x21 && h[4] === 0x1a && h[5] === 0x07 && (h[6] === 0 || (h[6] === 1 && h[7] === 0))) return 'rar';
  if (h[0] === 0x37 && h[1] === 0x7a && h[2] === 0xbc && h[3] === 0xaf && h[4] === 0x27 && h[5] === 0x1c) return '7z';
  return null;
}

async function listZip(f: Blob): Promise<ArchiveListing> {
  const tail = await read(f, Math.max(0, f.size - 65557), 65557);
  let e = -1;
  for (let i = tail.length - 22; i >= 0; i--) if (u32(tail, i) === 0x06054b50) { e = i; break; }
  if (e < 0) return { kind: 'zip', entries: [], complete: false };
  let count = u16(tail, e + 10), cdSize = u32(tail, e + 12), cdOff = u32(tail, e + 16);
  if (cdOff === 0xffffffff || count === 0xffff) {                       // ZIP64: locator just before the EOCD
    const loc = e - 20;
    if (loc >= 0 && u32(tail, loc) === 0x07064b50) {
      const z = await read(f, u64(tail, loc + 8), 56);
      if (u32(z, 0) === 0x06064b50) { count = u64(z, 32); cdSize = u64(z, 40); cdOff = u64(z, 48); }
    }
  }
  const cd = await read(f, cdOff, Math.min(cdSize, 32 * 1024 * 1024));
  const entries: ArchiveEntry[] = [];
  let encrypted = false;
  for (let o = 0; o + 46 <= cd.length && u32(cd, o) === 0x02014b50 && entries.length < MAX_ENTRIES;) {
    const nl = u16(cd, o + 28), xl = u16(cd, o + 30), cl = u16(cd, o + 32);
    if (u16(cd, o + 8) & 1) encrypted = true;
    entries.push({ name: utf8(cd.subarray(o + 46, o + 46 + nl)), size: u32(cd, o + 24) });
    o += 46 + nl + xl + cl;
  }
  return { kind: 'zip', entries: entries.filter(x => !x.name.endsWith('/')), complete: entries.length >= Math.min(count, MAX_ENTRIES), encrypted };
}

function vint(b: Uint8Array, o: number): [number, number] {
  let v = 0, mul = 1, i = o;
  for (; i < b.length && i < o + 10; i++) { v += (b[i] & 0x7f) * mul; mul *= 128; if (!(b[i] & 0x80)) return [v, i + 1 - o]; }
  return [v, i - o];
}

async function listRar(f: Blob): Promise<ArchiveListing> {
  const sig = await read(f, 0, 8);
  const entries: ArchiveEntry[] = [];
  if (sig[6] === 1) {                                                 // RAR 5
    let pos = 8;
    while (pos < f.size && entries.length < MAX_ENTRIES) {
      const b = await read(f, pos, 4 + 3 + 256 + 64);
      let o = 4;
      const [hsize, n1] = vint(b, o); o += n1;
      const start = o;
      const [type, n2] = vint(b, o); o += n2;
      const [flags, n3] = vint(b, o); o += n3;
      if (flags & 1) o += vint(b, o)[1];
      let data = 0;
      if (flags & 2) { const [d, n] = vint(b, o); data = d; o += n; }
      if (type === 4) return { kind: 'rar', entries, complete: false, encrypted: true };   // encrypted headers
      if (type === 2) {
        let [fflags, n] = vint(b, o); o += n;
        const [unp, n4] = vint(b, o); o += n4;
        o += vint(b, o)[1];                                            // attributes
        if (fflags & 2) o += 4;
        if (fflags & 4) o += 4;
        o += vint(b, o)[1]; o += vint(b, o)[1];                        // compression, host OS
        const [nl, n5] = vint(b, o); o += n5;
        if (!(fflags & 1)) entries.push({ name: utf8(b.subarray(o, o + nl)), size: unp });
      }
      if (type === 5 || !hsize) break;
      pos += start + hsize + data;
    }
  } else {                                                            // RAR 1.5–4.x
    let pos = 7;
    while (pos < f.size && entries.length < MAX_ENTRIES) {
      const b = await read(f, pos, 32 + 512);
      if (b.length < 7) break;
      const type = b[2], flags = u16(b, 3), hsize = u16(b, 5);
      const add = flags & 0x8000 ? u32(b, 7) : 0;
      if (type === 0x73 && flags & 0x80) return { kind: 'rar', entries, complete: false, encrypted: true };
      if (type === 0x74) {
        const high = flags & 0x100;
        const unp = u32(b, 11) + (high ? u32(b, 36) * 2 ** 32 : 0), nl = u16(b, 26);
        const nameAt = 32 + (high ? 8 : 0);
        if ((flags & 0xe0) !== 0xe0) entries.push({ name: utf8(b.subarray(nameAt, nameAt + nl)).split('\0')[0].replace(/\\/g, '/'), size: unp });
      }
      if (type === 0x7b || hsize < 7) break;
      pos += hsize + add;
    }
  }
  return { kind: 'rar', entries, complete: true };
}

export async function listArchive(f: Blob): Promise<ArchiveListing | null> {
  const kind = archiveKind(await read(f, 0, 8));
  if (kind === 'zip') return listZip(f);
  if (kind === 'rar') return listRar(f);
  if (kind === '7z') return { kind, entries: [], complete: false };    // 7z headers are usually compressed: the cloud lists it
  return null;
}

/** A hint only (shown before upload). The cloud decides the platform from the extracted bytes. */
export function likelyPlatform(entries: ArchiveEntry[]): string {
  const names = entries.map(e => e.name.toLowerCase());
  const has = (re: RegExp) => names.some(n => re.test(n));
  if (has(/(^|\/)ps3_game\//)) return 'PS3 (not supported)';
  if (has(/\.cso$/) || has(/(^|\/)psp_game\//) || has(/(^|\/)umd_data\.bin$/)) return 'PSP';
  if (has(/(^|\/)eboot\.pbp$/)) return 'PSP or PS1 (EBOOT.PBP)';
  if (has(/\.cue$/)) return 'PS1 (CUE + BIN)';
  if (has(/\.chd$/)) return 'PS1 or PS2 (CHD)';
  const iso = entries.find(e => /\.iso$/i.test(e.name));
  if (iso) return iso.size > 900 * 1024 ** 2 ? 'PS2 or PSP (ISO)' : 'PS1, PS2 or PSP (ISO)';
  if (has(/\.exe$/)) return 'Windows';
  return 'unknown — the cloud will inspect the contents';
}
