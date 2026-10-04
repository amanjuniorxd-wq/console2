/**
 * Platform + format detection for user-supplied console images. Reads only headers / a few sectors via
 * Blob.slice — a 700 MB disc is never loaded into memory. Also the first line of validation: structure,
 * sizes, references between files (CUE/M3U), and path-traversal-free names.
 */
export type Platform = 'p1' | 'p2' | 'psp' | 'p4';
export interface Detection {
  ok: boolean;
  platform?: Platform;
  format?: string;
  primary?: string;
  title?: string;
  serial?: string;
  files: File[];
  size: number;
  warnings: string[];
  error?: string;
}

export const MAX_TOTAL = 64 * 1024 ** 3;     // 64 GB: covers dual-layer DVD images with headroom
const MAX_CD = 1024 ** 3;                      // a CD image (one track file) cannot exceed ~900 MB
const MAX_SIDECAR = 64 * 1024;                 // .cue / .m3u text
const NAME = /^[^\\/:*?"<>|\x00-\x1f]{1,200}$/;
export const ACCEPT = '.cue,.bin,.img,.iso,.cso,.chd,.exe,.pbp,.m3u';
/** Extensions that can belong to a console game set (used to pick candidates out of a folder selection). */
export const CONSOLE_EXT = new Set(['cue', 'bin', 'img', 'iso', 'cso', 'chd', 'pbp', 'm3u']);

const lower = (n: string) => n.toLowerCase();
const ext = (n: string) => lower(n.split('.').pop() || '');

async function bytes(f: Blob, off: number, len: number): Promise<Uint8Array> {
  if (off >= f.size) return new Uint8Array(0);
  return new Uint8Array(await f.slice(off, Math.min(f.size, off + len)).arrayBuffer());
}
const ascii = (b: Uint8Array) => String.fromCharCode(...b);
const u32le = (b: Uint8Array, o: number) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
const u32be = (b: Uint8Array, o: number) => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;

/** Parse a CUE sheet: referenced files (basenames only) and track modes. */
export function parseCue(text: string): { files: string[]; modes: string[] } {
  const files: string[] = [], modes: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    const f = line.match(/^FILE\s+"([^"]+)"\s+\w+/i) || line.match(/^FILE\s+(\S+)\s+\w+/i);
    if (f) files.push(f[1]);
    const t = line.match(/^TRACK\s+\d+\s+(\S+)/i);
    if (t) modes.push(t[1].toUpperCase());
  }
  return { files, modes };
}

type Reader = (off: number, len: number) => Promise<Uint8Array>;

/** CSO (CISO v1): deflate-compressed blocks + index. Only the blocks a read touches are inflated. */
export async function cisoReader(f: Blob): Promise<Reader | null> {
  const h = await bytes(f, 0, 24);
  if (ascii(h.subarray(0, 4)) !== 'CISO') return null;
  const total = u32le(h, 8) + u32le(h, 12) * 2 ** 32, block = u32le(h, 16), align = h[21];
  if (!block || block > 1 << 20 || !total) return null;
  const nblocks = Math.ceil(total / block);
  const cache = new Map<number, Uint8Array>();
  const blockAt = async (i: number) => {
    if (cache.has(i)) return cache.get(i)!;
    const ix = await bytes(f, 24 + i * 4, 8);
    const a = u32le(ix, 0), b = u32le(ix, 4);
    const start = (a & 0x7fffffff) * 2 ** align, end = (b & 0x7fffffff) * 2 ** align;
    let data = await bytes(f, start, end - start);
    if (!(a & 0x80000000)) data = new Uint8Array(await new Response(new Blob([data as BlobPart]).stream().pipeThrough(new DecompressionStream('deflate-raw'))).arrayBuffer());
    cache.set(i, data);
    return data;
  };
  return async (off, len) => {
    const out = new Uint8Array(Math.max(0, Math.min(len, total - off)));
    for (let o = 0; o < out.length;) {
      const i = Math.floor((off + o) / block), within = (off + o) % block;
      if (i >= nblocks) break;
      const d = await blockAt(i), n = Math.min(out.length - o, block - within);
      out.set(d.subarray(within, within + n), o); o += n;
    }
    return out;
  };
}

/** ISO9660 reader over an image with a given sector layout (2048 cooked, 2352 raw Mode1/Mode2). */
class Iso {
  constructor(private rd: Reader, private secSize: number, private dataOff: number) {}
  read(lba: number, len: number) { return this.rd(lba * this.secSize + this.dataOff, len); }
  static async open(f: Blob | Reader): Promise<Iso | null> {
    const rd: Reader = typeof f === 'function' ? f : (o, l) => bytes(f, o, l);
    for (const [size, off] of [[2048, 0], [2352, 24], [2352, 16]] as const) {
      const pvd = await new Iso(rd, size, off).read(16, 2048);
      if (pvd.length >= 190 && pvd[0] === 1 && ascii(pvd.subarray(1, 6)) === 'CD001') return new Iso(rd, size, off);
    }
    return null;
  }
  async pvd() { return this.read(16, 2048); }
  /** Root directory entries: name → { lba, size, dir } (first two levels are enough for detection). */
  async list(lba?: number, size?: number): Promise<Map<string, { lba: number; size: number; dir: boolean }>> {
    if (lba === undefined) { const p = await this.pvd(); lba = u32le(p, 156 + 2); size = u32le(p, 156 + 10); }
    const out = new Map<string, { lba: number; size: number; dir: boolean }>();
    const data = await this.read(lba, Math.min(size || 2048, 64 * 1024));
    for (let off = 0; off < data.length;) {
      const len = data[off];
      if (!len) { off = (Math.floor(off / 2048) + 1) * 2048; continue; }
      if (off + 33 > data.length) break;
      const nameLen = data[off + 32];
      const name = ascii(data.subarray(off + 33, off + 33 + nameLen)).replace(/;1$/, '').toUpperCase();
      if (nameLen > 0 && data[off + 33] > 1) out.set(name, { lba: u32le(data, off + 2), size: u32le(data, off + 10), dir: !!(data[off + 25] & 2) });
      off += len;
    }
    return out;
  }
  async file(name: string) {
    const e = (await this.list()).get(name.toUpperCase());
    return e && !e.dir && e.size < 64 * 1024 ? new TextDecoder().decode(await this.read(e.lba, e.size)) : null;
  }
  /** Bytes of a file one directory deep, e.g. ('PSP_GAME', 'PARAM.SFO'). */
  async sub(dir: string, name: string) {
    const d = (await this.list()).get(dir);
    const e = d?.dir ? (await this.list(d.lba, d.size)).get(name) : undefined;
    return e && !e.dir && e.size < 64 * 1024 ? this.read(e.lba, e.size) : null;
  }
}

const UNSUPPORTED_PS3 = 'PS3 games are not supported by Mishrin.';

/** PSP title from PARAM.SFO (TITLE / DISC_ID / CATEGORY). */
function sfoInfo(b: Uint8Array | null): { title?: string; serial?: string; category?: string } {
  if (!b || b.length < 20 || ascii(b.subarray(0, 4)) !== '\0PSF') return {};
  const keyTab = u32le(b, 8), dataTab = u32le(b, 12), n = u32le(b, 16), out: Record<string, string> = {};
  for (let i = 0; i < n && 20 + i * 16 + 16 <= b.length; i++) {
    const e = 20 + i * 16, kOff = keyTab + (b[e] | (b[e + 1] << 8)), fmt = b[e + 2] | (b[e + 3] << 8), len = u32le(b, e + 4), dOff = dataTab + u32le(b, e + 12);
    let k = kOff; while (k < b.length && b[k]) k++;
    if (fmt === 0x0204) out[ascii(b.subarray(kOff, k))] = new TextDecoder().decode(b.subarray(dOff, dOff + len)).replace(/\0+$/, '');
  }
  return { title: out.TITLE, serial: out.DISC_ID, category: out.CATEGORY };
}

/** EBOOT.PBP: PSone classic (CATEGORY ME → P1) or PSP game/homebrew (→ PSP). */
export async function classifyPbp(f: Blob): Promise<{ platform?: Platform; title?: string; serial?: string; error?: string }> {
  const h = await bytes(f, 0, 40);
  if (h[0] !== 0 || ascii(h.subarray(1, 4)) !== 'PBP') return { error: 'Not a PBP file.' };
  const sfoOff = u32le(h, 8), next = u32le(h, 12);
  const s = sfoInfo(next > sfoOff && next - sfoOff < 65536 ? await bytes(f, sfoOff, next - sfoOff) : null);
  if (s.category === 'ME') return { platform: 'p1', title: s.title, serial: s.serial };
  return { platform: 'psp', title: s.title, serial: s.serial };
}

/** Classify a data disc by its filesystem: SYSTEM.CNF BOOT/BOOT2, PS3_GAME, etc. */
async function classifyDisc(f: Blob | Reader): Promise<{ platform?: Platform; title?: string; serial?: string; warning?: string; unsupported?: string }> {
  const iso = await Iso.open(f);
  if (!iso) return { warning: 'No ISO 9660 filesystem found (audio-only or unusual disc).' };
  const pvd = await iso.pvd();
  const system = ascii(pvd.subarray(8, 40)).trim();
  const volume = ascii(pvd.subarray(40, 72)).trim();
  const root = await iso.list();
  if (root.has('PS3_GAME') || root.has('PS3_DISC.SFB') || system.includes('PS3')) return { unsupported: UNSUPPORTED_PS3, title: volume };
  if (root.has('PSP_GAME') || root.has('UMD_DATA.BIN') || system.startsWith('PSP GAME')) {
    const s = sfoInfo(await iso.sub('PSP_GAME', 'PARAM.SFO'));
    const umd = root.has('UMD_DATA.BIN') ? await iso.file('UMD_DATA.BIN') : null;
    return { platform: 'psp', title: s.title || volume, serial: s.serial || umd?.split('|')[0] };
  }
  const cnf = root.has('SYSTEM.CNF') ? await iso.file('SYSTEM.CNF') : null;
  if (cnf) {
    const boot2 = cnf.match(/^\s*BOOT2\s*=\s*cdrom0?:\\?([^;\s]+)/im);
    const boot = cnf.match(/^\s*BOOT\s*=\s*cdrom:\\?([^;\s]+)/im);
    if (boot2) return { platform: 'p2', title: volume, serial: boot2[1] };
    if (boot) return { platform: 'p1', title: volume, serial: boot[1] };
  }
  if (system.startsWith('PLAYSTATION')) return { platform: 'p1', title: volume, warning: 'No SYSTEM.CNF; will try the default executable.' };
  return { title: volume, warning: 'Disc does not look like a console game disc.' };
}

/** CHD v5: CD (CHT2/CHTR/CHCD) vs DVD metadata decides P1-class vs P2-class. */
async function classifyChd(f: Blob): Promise<{ platform?: Platform; error?: string }> {
  const h = await bytes(f, 0, 124);
  if (ascii(h.subarray(0, 8)) !== 'MComprHD') return { error: 'Not a CHD file.' };
  const version = u32be(h, 12);
  if (version !== 5) return { error: `CHD version ${version} is not supported (use chdman to convert to v5).` };
  let meta = Number((BigInt(u32be(h, 48)) << 32n) | BigInt(u32be(h, 52)));
  for (let i = 0; meta && meta < f.size && i < 64; i++) {
    const m = await bytes(f, meta, 16);
    const tag = ascii(m.subarray(0, 4));
    if (tag === 'DVD ') return { platform: 'p2' };
    if (tag === 'CHT2' || tag === 'CHTR' || tag === 'CHCD' || tag === 'CHGD') return { platform: 'p1' };
    meta = Number((BigInt(u32be(m, 8)) << 32n) | BigInt(u32be(m, 12)));
  }
  return { error: 'CHD has no CD/DVD metadata.' };
}

/** Detect what the user selected. Accepts one image or an image set (CUE + BINs, M3U + discs). */
export async function detect(input: File[]): Promise<Detection> {
  const files = [...input];
  const size = files.reduce((a, f) => a + f.size, 0);
  const res: Detection = { ok: false, files, size, warnings: [] };
  const fail = (error: string) => ({ ...res, error });
  if (!files.length) return fail('No file selected.');
  if (files.length > 64) return fail('Select one game at a time: a disc image, or a CUE/M3U with the files it lists.');
  for (const f of files) if (!NAME.test(f.name)) return fail(`Unsafe file name: ${JSON.stringify(f.name)}`);
  if (new Set(files.map(f => lower(f.name))).size !== files.length) return fail('Duplicate file names.');
  if (size > MAX_TOTAL) return fail('Selection exceeds 64 GB.');
  const byName = new Map(files.map(f => [lower(f.name), f]));

  const m3u = files.find(f => ext(f.name) === 'm3u');
  const cue = files.find(f => ext(f.name) === 'cue');
  if (m3u) {
    if (m3u.size > MAX_SIDECAR) return fail('Playlist too large.');
    const entries = (await m3u.text()).split(/\r?\n/).map(l => l.trim()).filter(l => l && !l.startsWith('#'));
    if (!entries.length) return fail('Empty playlist.');
    for (const e of entries) if (!NAME.test(e) || !byName.has(lower(e))) return fail(`Playlist references a file that was not selected: ${e}`);
    const first = await detect(files.filter(f => f !== m3u && (lower(f.name) === lower(entries[0]) || ext(f.name) === 'bin')));
    return { ...first, files, size, format: 'm3u', primary: m3u.name, warnings: [...first.warnings, `${entries.length} disc(s)`] };
  }
  if (cue) {
    if (cue.size > MAX_SIDECAR) return fail('CUE sheet too large.');
    const { files: refs, modes } = parseCue(await cue.text());
    if (!refs.length) return fail('CUE sheet references no tracks.');
    for (const r of refs) {
      if (!NAME.test(r) || r.includes('..')) return fail(`CUE references an unsafe path: ${r}`);
      if (!byName.has(lower(r))) return fail(`Also select "${r}" (referenced by the CUE sheet).`);
      if (byName.get(lower(r))!.size > MAX_CD) return fail(`${r} is larger than any CD image.`);
    }
    const data = byName.get(lower(refs[0]))!;
    const c = await classifyDisc(data);
    if (c.unsupported) return fail(c.unsupported);
    if (c.warning) res.warnings.push(c.warning);
    if (modes.some(m => !/^(MODE1\/2048|MODE1\/2352|MODE2\/2352|MODE2\/2336|AUDIO)$/.test(m))) return fail(`Unsupported track mode in CUE: ${modes.join(', ')}`);
    return { ...res, ok: !!c.platform, platform: c.platform, format: 'cue+bin', primary: cue.name, title: c.title, serial: c.serial, error: c.platform ? undefined : 'Not a recognised console disc.' };
  }
  if (files.length > 1) return fail('Select a single image, or a CUE/M3U together with the files it lists.');
  const f = files[0];
  const e = ext(f.name);
  const head = await bytes(f, 0, 16);
  if (ascii(head.subarray(0, 8)) === 'PS-X EXE') {
    if (f.size > 2 * 1024 * 1024) return fail('Executable larger than console RAM.');
    return { ...res, ok: true, platform: 'p1', format: 'exe', primary: f.name, title: f.name.replace(/\.[^.]+$/, '') };
  }
  if (head[0] === 0 && ascii(head.subarray(1, 4)) === 'PBP') {
    const c = await classifyPbp(f);
    if (c.error) return fail(c.error);
    return { ...res, ok: true, platform: c.platform, format: 'pbp', primary: f.name, title: c.title || f.name.replace(/\.[^.]+$/, ''), serial: c.serial };
  }
  if (ascii(head.subarray(0, 4)) === 'CISO') {
    const rd = await cisoReader(f);
    const c = rd ? await classifyDisc(rd) : { warning: 'Damaged CSO header.' } as Awaited<ReturnType<typeof classifyDisc>>;
    if (c.unsupported) return fail(c.unsupported);
    if (c.platform !== 'psp') return fail(c.warning || 'This CSO image is not a PSP game.');
    return { ...res, ok: true, platform: 'psp', format: 'cso', primary: f.name, title: c.title, serial: c.serial };
  }
  if (head[0] === 0x7f && ascii(head.subarray(1, 4)) === 'CNT') return { ...res, ok: true, platform: 'p4', format: 'pkg', primary: f.name, title: f.name };
  if (head[0] === 0x7f && ascii(head.subarray(1, 4)) === 'PKG') return fail('PKG packages are not supported. Upload the game image (ISO/CSO) or game folder instead.');
  if (ascii(head.subarray(0, 8)) === 'MComprHD') {
    const c = await classifyChd(f);
    if (c.error) return fail(c.error);
    return { ...res, ok: true, platform: c.platform, format: 'chd', primary: f.name, title: f.name.replace(/\.[^.]+$/, '') };
  }
  if (['iso', 'bin', 'img'].includes(e)) {
    if (e !== 'iso' && f.size > MAX_CD) return fail('Image is larger than any CD; DVD images use .iso.');
    if (f.size % 2048 && f.size % 2352 && f.size % 2336) res.warnings.push('Image size is not a whole number of sectors.');
    const c = await classifyDisc(f);
    if (c.unsupported) return fail(c.unsupported);
    if (c.warning) res.warnings.push(c.warning);
    if (!c.platform) return fail(c.warning || 'Not a recognised console disc image.');
    if (e === 'bin' && f.size % 2352 === 0) res.warnings.push('No CUE sheet: assuming a single data track.');
    return { ...res, ok: true, platform: c.platform, format: e, primary: f.name, title: c.title, serial: c.serial };
  }
  return fail(`Unsupported file type ".${e}". Supported: ${ACCEPT}`);
}
