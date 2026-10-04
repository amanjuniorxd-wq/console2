// Server-side content inspection for uploads. The platform of an upload is decided from the bytes the
// scheduler actually stored (headers, filesystems, signatures) — never from file names or client claims.
import { chunkedReader } from './storage.mjs';
import { peInfo } from './manifest.mjs';
import { inflateRawSync } from 'node:zlib';

export class InspectError extends Error { constructor(msg, status = 415) { super(msg); this.status = status; } }
const PS3 = 'PS3 games are not supported by Mishrin.';

const ascii = b => b.toString('latin1');

/** Minimal ISO 9660 reader (2048-byte cooked or 2352-byte raw sectors) over a random-access reader. */
export function openIso(r) {
  for (const [sec, off] of [[2048, 0], [2352, 24], [2352, 16]]) {
    const pvd = r.read(16 * sec + off, 2048);
    if (pvd.length >= 190 && pvd[0] === 1 && ascii(pvd.subarray(1, 6)) === 'CD001') {
      const read = (lba, len) => {
        if (sec === 2048) return r.read(lba * 2048, len);
        const out = []; let left = len;
        for (let l = lba; left > 0; l++) { const n = Math.min(2048, left); out.push(r.read(l * sec + off, n)); left -= n; }
        return Buffer.concat(out);
      };
      const list = (lba, size) => {
        const data = read(lba, Math.min(size, 64 * 1024)), out = new Map();
        for (let o = 0; o < data.length;) {
          const len = data[o];
          if (!len) { o = (Math.floor(o / 2048) + 1) * 2048; continue; }
          if (o + 33 > data.length) break;
          const nl = data[o + 32];
          const name = ascii(data.subarray(o + 33, o + 33 + nl)).replace(/;1$/, '').toUpperCase();
          if (nl && data[o + 33] > 1) out.set(name, { lba: data.readUInt32LE(o + 2), size: data.readUInt32LE(o + 10), dir: !!(data[o + 25] & 2) });
          o += len;
        }
        return out;
      };
      const root = list(pvd.readUInt32LE(158), pvd.readUInt32LE(166));
      return {
        system: ascii(pvd.subarray(8, 40)).trim(), volume: ascii(pvd.subarray(40, 72)).trim(), root,
        text(name) { const e = root.get(name); return e && !e.dir && e.size < 65536 ? read(e.lba, e.size).toString('utf8') : null; },
        sub(dir, name) { const d = root.get(dir); const e = d?.dir ? list(d.lba, d.size).get(name) : null; return e && !e.dir && e.size < 65536 ? read(e.lba, e.size) : null; },
      };
    }
  }
  return null;
}

/** PARAM.SFO (PSF) key/value table → { TITLE, TITLE_ID, CATEGORY, ... } */
export function parseSfo(b) {
  if (b.length < 20 || b.readUInt32BE(0) !== 0x00505346) return null; // "\0PSF"
  const keyTab = b.readUInt32LE(8), dataTab = b.readUInt32LE(12), n = b.readUInt32LE(16), out = {};
  for (let i = 0; i < n && 20 + i * 16 + 16 <= b.length; i++) {
    const e = 20 + i * 16;
    const kOff = keyTab + b.readUInt16LE(e), fmt = b.readUInt16LE(e + 2), len = b.readUInt32LE(e + 4), dOff = dataTab + b.readUInt32LE(e + 12);
    const kEnd = b.indexOf(0, kOff); if (kEnd < 0) break;
    const key = ascii(b.subarray(kOff, kEnd));
    if (fmt === 0x0404) out[key] = b.readUInt32LE(dOff);
    else out[key] = b.subarray(dOff, dOff + len).toString('utf8').replace(/\0+$/, '');
  }
  return out;
}

const chdKind = r => {
  const h = r.read(0, 124);
  if (ascii(h.subarray(0, 8)) !== 'MComprHD' || h.readUInt32BE(12) !== 5) return null;
  let meta = Number(h.readBigUInt64BE(48));
  for (let i = 0; meta && meta < r.size && i < 64; i++) {
    const m = r.read(meta, 16), tag = ascii(m.subarray(0, 4));
    if (tag === 'DVD ') return 'dvd';
    if (['CHT2', 'CHTR', 'CHCD', 'CHGD'].includes(tag)) return 'cd';
    meta = Number(m.readBigUInt64BE(8));
  }
  return null;
};

/** CSO (CISO v1) → random-access reader over the uncompressed image (only touched blocks are inflated). */
export function cisoReader(r) {
  const h = r.read(0, 24);
  if (h.length < 24 || ascii(h.subarray(0, 4)) !== 'CISO') return null;
  const total = Number(h.readBigUInt64LE(8)), block = h.readUInt32LE(16), align = h[21];
  if (!block || block > 1 << 20) return null;
  const cache = new Map();
  const blockAt = i => {
    if (cache.has(i)) return cache.get(i);
    const ix = r.read(24 + i * 4, 8), a = ix.readUInt32LE(0), b = ix.readUInt32LE(4);
    const start = (a & 0x7fffffff) * 2 ** align, end = (b & 0x7fffffff) * 2 ** align;
    let d = r.read(start, end - start);
    if (!(a & 0x80000000)) d = inflateRawSync(d);
    if (cache.size > 64) cache.clear();
    cache.set(i, d);
    return d;
  };
  return {
    size: total,
    read(off, len) {
      const parts = [];
      for (len = Math.min(len, total - off); len > 0;) { const i = Math.floor(off / block), w = off % block, n = Math.min(len, block - w); parts.push(blockAt(i).subarray(w, w + n)); off += n; len -= n; }
      return Buffer.concat(parts);
    },
  };
}

const isPsp = iso => iso.root.has('PSP_GAME') || iso.root.has('UMD_DATA.BIN') || iso.system.startsWith('PSP GAME');
const pspTitle = iso => (parseSfo(iso.sub('PSP_GAME', 'PARAM.SFO') || Buffer.alloc(0)) || {}).TITLE || iso.volume;
const pspSerial = iso => (iso.text('UMD_DATA.BIN') || '').split('|')[0];

/** EBOOT.PBP → PARAM.SFO fields, or null when it is not a PBP. */
export function pbpInfo(r) {
  const h = r.read(0, 40);
  if (h.length < 40 || h[0] !== 0 || ascii(h.subarray(1, 4)) !== 'PBP') return null;
  const off = h.readUInt32LE(8), next = h.readUInt32LE(12);
  const p = next > off && next - off < 65536 ? parseSfo(r.read(off, next - off)) : null;
  return { category: p?.CATEGORY || '', title: p?.TITLE || '', serial: p?.DISC_ID || '' };
}

/** Classify an upload (validated file list whose chunks are all stored). opts.ps1: return PS1 instead of refusing it
 *  (archives: the extracted game is handed back to the browser, where P1 runs it). */
export function inspectUpload(files, store, opts = {}) {
  const byPath = new Map(files.map(f => [f.path.toLowerCase(), f]));
  const reader = f => chunkedReader(store, f);
  const ps1Local = () => new InspectError('This is a PS1-class disc. It runs locally in your browser with Mishrin P1 — no upload needed.', 422);
  const ps1 = (boot, title = '') => { if (opts.ps1) return { platform: 'ps1', boot, title }; throw ps1Local(); };

  if (files.some(f => /(^|\/)PS3_GAME\/PARAM\.SFO$/i.test(f.path))) throw new InspectError(PS3, 422);

  // PSP game folder / single EBOOT.PBP (PSone classics in a PBP are PS1 → local)
  const pbp = files.length === 1 ? files[0] : files.find(f => /(^|\/)EBOOT\.PBP$/i.test(f.path));
  if (pbp) {
    const c = pbpInfo(reader(pbp));
    if (c) {
      if (c.category === 'ME') { if (opts.ps1) return { platform: 'ps1', boot: pbp.path, title: c.title || '' }; throw ps1Local(); }
      return { platform: 'psp', boot: pbp.path, title: c.title || '', serial: c.serial || '', format: 'pbp' };
    }
  }
  // CSO (compressed UMD image)
  const cso = files.length === 1 && ascii(reader(files[0]).read(0, 4)) === 'CISO' ? files[0] : null;
  if (cso) {
    const iso = openIso(cisoReader(reader(cso)) || { read: () => Buffer.alloc(0) });
    if (iso && isPsp(iso)) return { platform: 'psp', boot: cso.path, title: pspTitle(iso), serial: pspSerial(iso), format: 'cso' };
    throw new InspectError('This CSO image is not a PSP game.', 422);
  }

  if (files.length === 1) {
    const f = files[0], r = reader(f), head = r.read(0, 4096);
    const pe = peInfo(head);
    if (pe) return { platform: 'windows', arch: pe.arch, title: '' };
    if (head.subarray(0, 4).equals(Buffer.from([0x7f, 0x50, 0x4b, 0x47]))) throw new InspectError('PKG packages are not supported. Upload the game image (ISO/CSO) or game folder instead.');
    if (head.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))) throw new InspectError('Linux executables have no cloud worker yet.');
    if (ascii(head.subarray(0, 8)) === 'MComprHD') {
      const k = chdKind(r);
      if (k === 'dvd') return { platform: 'ps2', boot: f.path, title: '' };
      if (k === 'cd') return ps1(f.path);
      throw new InspectError('Unsupported CHD (v5 with CD/DVD metadata required).');
    }
  }
  // Disc images: an .iso, or a .cue whose first BIN carries the filesystem
  const disc = files.find(f => /\.iso$/i.test(f.path)) || files.find(f => /\.cue$/i.test(f.path))
    || (files.length === 1 && /\.(bin|img)$/i.test(files[0].path) ? files[0] : null);
  if (disc) {
    let img = disc;
    if (/\.cue$/i.test(disc.path)) {
      const cue = reader(disc).read(0, Math.min(disc.size, 65536)).toString('utf8');
      const ref = (cue.match(/^\s*FILE\s+"([^"]+)"/im) || cue.match(/^\s*FILE\s+(\S+)/im))?.[1];
      const dir = disc.path.includes('/') ? disc.path.slice(0, disc.path.lastIndexOf('/') + 1) : '';
      img = ref && byPath.get((dir + ref).toLowerCase());
      if (!img) throw new InspectError('The CUE sheet references a file that was not uploaded.', 422);
    }
    const iso = openIso(reader(img));
    if (!iso) throw new InspectError('No ISO 9660 filesystem found in this disc image.');
    if (iso.root.has('PS3_GAME') || iso.root.has('PS3_DISC.SFB')) throw new InspectError(PS3, 422);
    if (isPsp(iso)) return { platform: 'psp', boot: disc.path, title: pspTitle(iso), serial: pspSerial(iso), format: 'iso' };
    const cnf = iso.text('SYSTEM.CNF') || '';
    const boot2 = cnf.match(/^\s*BOOT2\s*=\s*cdrom0?:\\?([^;\s]+)/im);
    if (boot2) return { platform: 'ps2', boot: disc.path, title: iso.volume, serial: boot2[1] };
    if (/^\s*BOOT\s*=/im.test(cnf) || iso.system.startsWith('PLAYSTATION')) return ps1(disc.path, iso.volume);
    throw new InspectError('This disc does not look like a supported console game.');
  }
  // Windows game folder (e.g. extracted from an archive): the shallowest, then largest, PE executable
  const exes = files.filter(f => /\.exe$/i.test(f.path)).map(f => ({ f, pe: peInfo(reader(f).read(0, 4096)) })).filter(x => x.pe);
  if (exes.length) {
    exes.sort((a, b) => a.f.path.split('/').length - b.f.path.split('/').length || b.f.size - a.f.size);
    return { platform: 'windows', arch: exes[0].pe.arch, executable: exes[0].f.path, title: '' };
  }
  throw new InspectError('Unsupported upload. Supported for cloud play: Windows .exe, PS2-class ISO/CHD/CUE, PSP ISO/CSO/EBOOT.PBP, or a ZIP/RAR/7z containing one of them.');
}
