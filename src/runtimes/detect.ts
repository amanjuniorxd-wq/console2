/**
 * Universal game detection: one entry point for everything the player selects (a file, a set of disc files, or a
 * game folder). Decisions come from bytes — magic numbers, executable headers, filesystems, PARAM.SFO — never from
 * file names alone. Console images reuse the emulator detector (src/emu/detect.ts); this layer adds browser games,
 * Windows/Linux executables, PSP game folders and archives (ZIP/RAR/7z), and maps every result onto the registry.
 */
import { detect as detectDisc, classifyPbp, CONSOLE_EXT, type Detection } from '../emu/detect';
import { listArchive, likelyPlatform, type ArchiveListing } from './archive';
import type { RuntimeId, PlatformId } from './registry';

export interface UniversalDetection {
  ok: boolean;
  platform?: PlatformId;
  runtime?: RuntimeId;
  kind?: 'browser-wasm' | 'browser-html' | 'windows-exe' | 'linux-elf' | 'console-image' | 'psp-folder' | 'archive';
  format?: string;
  title?: string;
  serial?: string;
  arch?: 'x64' | 'x86';
  files: File[];
  /** Paths relative to the selection root (folders keep their structure for upload). */
  paths: string[];
  size: number;
  warnings: string[];
  error?: string;
  disc?: Detection;
  archive?: ArchiveListing;
}

const EMU_RUNTIME: Record<string, [PlatformId, RuntimeId]> = { p1: ['ps1', 'mishrin-p1'], p2: ['ps2', 'ps2'], psp: ['psp', 'psp'], p4: ['ps4', 'ps4'] };
const head = async (f: Blob, n: number) => new Uint8Array(await f.slice(0, n).arrayBuffer());
const relPath = (f: File) => ((f as File & { webkitRelativePath?: string }).webkitRelativePath || f.name).replace(/\\/g, '/');
const SAFE = /^[^:*?"<>|\x00-\x1f]{1,255}$/;

/** PE header → architecture (x64/x86) or null. Same rule as the cloud scheduler (server/lib/manifest.mjs peInfo). */
export function peArch(b: Uint8Array): 'x64' | 'x86' | null {
  if (b.length < 64 || b[0] !== 0x4d || b[1] !== 0x5a) return null;
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const off = dv.getUint32(0x3c, true);
  if (off + 6 > b.length || dv.getUint32(off, true) !== 0x00004550) return null;
  const m = dv.getUint16(off + 4, true);
  return m === 0x8664 ? 'x64' : m === 0x14c ? 'x86' : null;
}

/** PARAM.SFO (PSF) → key/value map. */
export function parseSfo(b: Uint8Array): Record<string, string | number> | null {
  if (b.length < 20 || b[0] !== 0 || b[1] !== 0x50 || b[2] !== 0x53 || b[3] !== 0x46) return null;
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const keyTab = dv.getUint32(8, true), dataTab = dv.getUint32(12, true), n = dv.getUint32(16, true), out: Record<string, string | number> = {};
  for (let i = 0; i < n && 20 + i * 16 + 16 <= b.length; i++) {
    const e = 20 + i * 16, kOff = keyTab + dv.getUint16(e, true), fmt = dv.getUint16(e + 2, true), len = dv.getUint32(e + 4, true), dOff = dataTab + dv.getUint32(e + 12, true);
    let kEnd = kOff; while (kEnd < b.length && b[kEnd]) kEnd++;
    const key = String.fromCharCode(...b.subarray(kOff, kEnd));
    out[key] = fmt === 0x0404 ? dv.getUint32(dOff, true) : new TextDecoder().decode(b.subarray(dOff, dOff + len)).replace(/\0+$/, '');
  }
  return out;
}

export async function detectAny(input: File[]): Promise<UniversalDetection> {
  const files = [...input];
  const paths = files.map(relPath);
  const size = files.reduce((a, f) => a + f.size, 0);
  const res: UniversalDetection = { ok: false, files, paths, size, warnings: [] };
  const fail = (error: string): UniversalDetection => ({ ...res, error });
  if (!files.length) return fail('No file selected.');
  if (paths.some(p => !SAFE.test(p) || p.split('/').some(s => s === '..' || s === '.'))) return fail('Unsafe file name in the selection.');

  if (paths.some(p => /(^|\/)PS3_GAME\/PARAM\.SFO$/i.test(p))) return fail('PS3 games are not supported by Mishrin.');

  if (files.length === 1) {
    const listing = await listArchive(files[0]);
    if (listing) {
      if (listing.encrypted) return fail('This archive is password-protected. Upload an unencrypted archive.');
      return { ...res, ok: true, kind: 'archive', format: listing.kind, title: files[0].name.replace(/\.[^.]+$/, ''), archive: listing,
        warnings: [`Likely contents: ${likelyPlatform(listing.entries)}${listing.entries.length ? ` · ${listing.entries.length} files` : ''}. The cloud extracts it and decides the platform from its contents.`] };
    }
  }

  // PSP game folder (homebrew / PSN layout): <folder>/EBOOT.PBP
  if (files.length > 1) {
    const at = paths.findIndex(p => /(^|\/)EBOOT\.PBP$/i.test(p));
    if (at >= 0) {
      const c = await classifyPbp(files[at]);
      if (c.platform === 'psp') return { ...res, ok: true, platform: 'psp', runtime: 'psp', kind: 'psp-folder', format: 'folder', title: c.title || paths[at].split('/').slice(-2, -1)[0] || 'PSP game', serial: c.serial };
    }
    // A folder: only the files that can form a console game are examined (no per-folder file limit).
    const pick = files.map((f, i) => [f, i] as const).filter(([f]) => CONSOLE_EXT.has(f.name.split('.').pop()!.toLowerCase()));
    if (pick.length && pick.length < files.length) {
      const sets = pick.filter(([f]) => /\.(cue|m3u)$/i.test(f.name));
      const chosen = sets.length ? pick : [pick.reduce((a, b) => (b[0].size > a[0].size ? b : a))];
      const disc = await detectDisc(chosen.map(([f]) => f));
      if (!disc.ok || !disc.platform) return { ...res, disc, error: disc.error || 'No supported game found in this folder.' };
      const [platform, runtime] = EMU_RUNTIME[disc.platform];
      const sel = chosen.map(([, i]) => i);
      return { ...res, files: sel.map(i => files[i]), paths: sel.map(i => paths[i]), size: sel.reduce((a, i) => a + files[i].size, 0),
        ok: true, platform, runtime, kind: 'console-image', format: disc.format, title: disc.title, serial: disc.serial, warnings: disc.warnings, disc };
    }
  }

  if (files.length === 1) {
    const f = files[0], h = await head(f, 4096);
    if (h[0] === 0 && h[1] === 0x61 && h[2] === 0x73 && h[3] === 0x6d) return { ...res, ok: true, platform: 'browser', runtime: 'browser', kind: 'browser-wasm', format: 'wasm', title: f.name.replace(/\.[^.]+$/, '') };
    const text = new TextDecoder().decode(h.subarray(0, 512)).trimStart().toLowerCase();
    if (/\.html?$/i.test(f.name) && text.startsWith('<')) return { ...res, ok: true, platform: 'browser', runtime: 'browser', kind: 'browser-html', format: 'html', title: f.name.replace(/\.[^.]+$/, '') };
    const arch = peArch(h);
    if (arch) return { ...res, ok: true, platform: 'windows', runtime: 'windows-cloud', kind: 'windows-exe', format: 'exe', arch, title: f.name.replace(/\.[^.]+$/, '') };
    if (h[0] === 0x4d && h[1] === 0x5a) return fail('This is a DOS/other executable, not a supported 32/64-bit Windows program.');
    if (h[0] === 0x7f && h[1] === 0x45 && h[2] === 0x4c && h[3] === 0x46) return { ...res, ok: false, platform: 'linux', kind: 'linux-elf', format: 'elf', error: 'Linux games have no cloud worker yet (not implemented).' };
  }
  const disc = await detectDisc(files);
  if (!disc.ok || !disc.platform) return { ...res, disc, error: disc.error || 'Unsupported file.' };
  const [platform, runtime] = EMU_RUNTIME[disc.platform];
  return { ...res, ok: true, platform, runtime, kind: 'console-image', format: disc.format, title: disc.title, serial: disc.serial, warnings: disc.warnings, disc };
}
