// Server-side content inspection for uploads. The platform of an upload is decided from the bytes the
// scheduler actually stored (headers, filesystems, signatures) — never from file names or client claims.
import { chunkedReader } from './storage.mjs';
import { peInfo } from './manifest.mjs';

export class InspectError extends Error { constructor(msg, status = 415) { super(msg); this.status = status; } }

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

/** Classify an upload (validated file list whose chunks are all stored). */
export function inspectUpload(files, store) {
  const byPath = new Map(files.map(f => [f.path.toLowerCase(), f]));
  const reader = f => chunkedReader(store, f);
  const ps1Local = () => new InspectError('This is a PS1-class disc. It runs locally in your browser with Mishrin P1 — no upload needed.', 422);

  // PS3-class disc folder: [prefix/]PS3_GAME/PARAM.SFO + PS3_GAME/USRDIR/EBOOT.BIN
  const sfo = files.find(f => /(^|\/)PS3_GAME\/PARAM\.SFO$/i.test(f.path));
  if (sfo) {
    const prefix = sfo.path.slice(0, sfo.path.length - 'PS3_GAME/PARAM.SFO'.length);
    const eboot = byPath.get(`${prefix}PS3_GAME/USRDIR/EBOOT.BIN`.toLowerCase());
    if (!eboot) throw new InspectError('PS3_GAME/USRDIR/EBOOT.BIN is missing from this game folder.', 422);
    const head = reader(eboot).read(0, 4);
    if (!(head.equals(Buffer.from('SCE\0', 'latin1')) || head.equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46])))) throw new InspectError('EBOOT.BIN is not a SELF/ELF executable.', 422);
    const p = parseSfo(reader(sfo).read(0, Math.min(sfo.size, 65536)));
    if (!p) throw new InspectError('PARAM.SFO is damaged.', 422);
    return { platform: 'ps3', boot: eboot.path, title: p.TITLE || '', serial: p.TITLE_ID || '', category: p.CATEGORY || '' };
  }
  // ZIP/RAR archives are kept intact during upload. The Windows GPU worker extracts
  // the archive in the session sandbox and recursively chooses the real PE executable.
  if (files.length === 1) {
    const f = files[0], h = reader(f).read(0, 16);
    const zip = h.length >= 4 && h[0] === 0x50 && h[1] === 0x4b && [0x03, 0x05, 0x07].includes(h[2]);
    const rar = h.length >= 7 && h[0] === 0x52 && h[1] === 0x61 && h[2] === 0x72 && h[3] === 0x21 && h[4] === 0x1a && h[5] === 0x07;
    if (zip || rar) return { platform: 'windows', arch: 'auto', executable: '__AUTO__', archive: { path: f.path, format: zip ? 'zip' : 'rar' }, title: f.path.replace(/\.(zip|rar)$/i, '').split('/').pop() || '' };
  }
  // Windows games are packages, not single files. Inspect every .exe candidate and
  // choose a deterministic launch executable: title/root matches first, then largest PE.
  const peCandidates = [];
  for (const f of files) {
    if (!/\.exe$/i.test(f.path)) continue;
    const pe = peInfo(reader(f).read(0, 4096));
    if (pe) peCandidates.push({ path: f.path, arch: pe.arch, size: f.size });
  }
  if (peCandidates.length) {
    const root = peCandidates.filter(x => !x.path.includes('/'));
    const titleHint = String(files[0]?.path || '').split('/')[0].replace(/\.(zip|exe)$/i, '').toLowerCase();
    const score = x => (root.includes(x) ? 1000 : 0) + (titleHint && x.path.toLowerCase().includes(titleHint) ? 500 : 0) + Math.min(100, Math.floor(x.size / 1048576));
    peCandidates.sort((a, b) => score(b) - score(a) || b.size - a.size || a.path.localeCompare(b.path));
    return { platform: 'windows', arch: peCandidates[0].arch, executable: peCandidates[0].path, executables: peCandidates.slice(0, 32), title: '' };
  }
  if (files.length === 1) {
    const f = files[0], r = reader(f), head = r.read(0, 4096);
    if (head.subarray(0, 4).equals(Buffer.from([0x7f, 0x50, 0x4b, 0x47]))) throw new InspectError('PS3 PKG files must be installed by the emulator first; PKG upload is not supported yet. Upload the game folder or disc image instead.');
    if (head.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))) throw new InspectError('Linux executables have no cloud worker yet.');
    if (ascii(head.subarray(0, 8)) === 'MComprHD') {
      const k = chdKind(r);
      if (k === 'dvd') return { platform: 'ps2', boot: f.path, title: '' };
      if (k === 'cd') throw ps1Local();
      throw new InspectError('Unsupported CHD (v5 with CD/DVD metadata required).');
    }
  }
  // Disc images: an .iso, or a .cue whose first BIN carries the filesystem
  const disc = files.find(f => /\.iso$/i.test(f.path)) || files.find(f => /\.cue$/i.test(f.path));
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
    if (iso.root.has('PS3_GAME') || iso.root.has('PS3_DISC.SFB')) return { platform: 'ps3', boot: disc.path, title: iso.volume };
    const cnf = iso.text('SYSTEM.CNF') || '';
    const boot2 = cnf.match(/^\s*BOOT2\s*=\s*cdrom0?:\\?([^;\s]+)/im);
    if (boot2) return { platform: 'ps2', boot: disc.path, title: iso.volume, serial: boot2[1] };
    if (/^\s*BOOT\s*=/im.test(cnf) || iso.system.startsWith('PLAYSTATION')) throw ps1Local();
    throw new InspectError('This disc does not look like a supported console game.');
  }
  throw new InspectError('Unsupported upload. Supported for cloud play: Windows .exe, PS2-class ISO/CHD/CUE, PS3-class game folder or ISO.');
}
