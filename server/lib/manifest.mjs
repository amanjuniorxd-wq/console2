// Windows game manifest validation (scheduler gatekeeper; the worker re-validates with mishrin_worker/manifest.py).
// The browser only ever names a game. Commands are never accepted from clients: the executable must be a
// declared .exe inside the game's own file list and is launched as an argv array by the worker.
import { createHash } from 'node:crypto';

const ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const SHA = /^[a-f0-9]{64}$/;
const SEG = /^[A-Za-z0-9 _\-.()[\]+,'&!@#=~]{1,128}$/;
const ARG = /^[A-Za-z0-9 _\-=.,:/+]{0,128}$/;
const RESERVED = new Set(['con', 'prn', 'aux', 'nul', ...Array.from({ length: 9 }, (_, i) => `com${i + 1}`), ...Array.from({ length: 9 }, (_, i) => `lpt${i + 1}`)]);
const GRAPHICS = new Set(['auto', 'dxvk', 'vkd3d', 'wined3d', 'gdi']);
const ARCH = new Set(['auto', 'x64', 'x86']);
const KEYS = new Set(['Up', 'Down', 'Left', 'Right', 'Return', 'Escape', 'space', 'Tab', 'BackSpace', 'Shift_L', 'Control_L', 'Alt_L',
  ...'abcdefghijklmnopqrstuvwxyz', ...'0123456789', ...Array.from({ length: 12 }, (_, i) => `F${i + 1}`)]);
const PAD = new Set(['up', 'down', 'left', 'right', 'a', 'b', 'start']);
export const DEFAULT_PAD = { up: 'Up', down: 'Down', left: 'Left', right: 'Right', a: 'Return', b: 'Escape', start: 'Escape' };

export class ManifestError extends Error {}
const fail = m => { throw new ManifestError(m); };

export function relPath(p, what, allowEmpty = false) {
  if (typeof p !== 'string') fail(`${what} must be a string`);
  p = p.replaceAll('\\', '/').trim();
  if (p === '' || p === '.') return allowEmpty ? '' : fail(`${what} is empty`);
  if (p.length > 260 || p.startsWith('/') || /^[A-Za-z]:/.test(p) || p.includes('\0')) fail(`${what} must be a relative path inside the game`);
  const segs = p.split('/');
  for (const s of segs) {
    if (s === '' || s === '.' || s === '..' || !SEG.test(s) || RESERVED.has(s.split('.')[0].toLowerCase()) || /[. ]$/.test(s)) fail(`${what} has an invalid segment: ${JSON.stringify(s)}`);
  }
  return segs.join('/');
}

/** Full controller vocabulary (standard gamepad layout). Windows titles use the 7 logical buttons; emulator titles all 16. */
export const FULL_PAD = ['up', 'down', 'left', 'right', 'cross', 'circle', 'square', 'triangle', 'l1', 'r1', 'l2', 'r2', 'select', 'start', 'l3', 'r3'];
/** Emulator platforms the worker pool can host. The emulator is fixed per platform: clients can never pick a binary. */
export const EMULATOR_PLATFORMS = {
  ps2: { emulator: 'pcsx2', boot: /\.(iso|chd|cue)$/i, ram: 4096, cpus: 2, storageMB: 8192 },
  ps3: { emulator: 'rpcs3', boot: /(^|\/)EBOOT\.BIN$|\.iso$/i, ram: 8192, cpus: 4, storageMB: 65536 },
};
/** Default keyboard bindings the worker's emulator profiles configure (Keyboard pad handler). */
export const DEFAULT_FULL_PAD = { up: 'Up', down: 'Down', left: 'Left', right: 'Right', cross: 'x', circle: 'c', square: 'z', triangle: 'v',
  l1: 'q', r1: 'e', l2: '1', r2: '3', select: 'BackSpace', start: 'Return', l3: 'f', r3: 'g' };

function validateFiles(m, out) {
  if (!Array.isArray(m.files) || !m.files.length || m.files.length > 200000) fail('files must be a non-empty list');
  const seen = new Set(); let total = 0;
  out.files = m.files.map(f => {
    if (!f || typeof f !== 'object') fail('file entry must be an object');
    const path = relPath(f.path, 'file path');
    if (seen.has(path.toLowerCase())) fail(`duplicate file ${path}`);
    seen.add(path.toLowerCase());
    if (!Number.isInteger(f.size) || f.size < 0) fail(`bad size for ${path}`);
    if (!Array.isArray(f.chunks) || (f.size > 0 && !f.chunks.length) || !f.chunks.every(c => typeof c === 'string' && SHA.test(c))) fail(`bad chunks for ${path}`);
    total += f.size;
    return { path, size: f.size, chunks: [...f.chunks] };
  });
  if (total > 256 * 1024 ** 3) fail('game too large');
  return seen;
}

function validateCommon(m, out, defaults) {
  const net = m.network ?? false;
  if (net !== false) fail('network access is not permitted for games');
  out.network = false;
  const r = m.requirements ?? {};
  if (typeof r !== 'object' || Array.isArray(r)) fail('requirements must be an object');
  const ram = r.ram ?? defaults.ram, gpu = r.gpu ?? true, cpus = r.cpus ?? defaults.cpus, storageMB = r.storageMB ?? defaults.storageMB, maxMinutes = r.maxMinutes ?? 240;
  if (!Number.isInteger(ram) || ram < 128 || ram > 65536) fail('requirements.ram must be 128..65536 MB');
  if (typeof gpu !== 'boolean') fail('requirements.gpu must be boolean');
  if (typeof cpus !== 'number' || cpus < 0.25 || cpus > 32) fail('requirements.cpus must be 0.25..32');
  if (!Number.isInteger(storageMB) || storageMB < 64 || storageMB > 262144) fail('requirements.storageMB must be 64..262144');
  if (typeof maxMinutes !== 'number' || maxMinutes < 0.05 || maxMinutes > 1440) fail('requirements.maxMinutes out of range');
  out.requirements = { ram, gpu, cpus, storageMB, maxMinutes };
  const d = m.display ?? { width: 1280, height: 720 };
  if (!Number.isInteger(d.width) || !Number.isInteger(d.height) || d.width < 320 || d.width > 3840 || d.height < 240 || d.height > 2160) fail('display must be 320x240..3840x2160');
  out.display = { width: d.width & ~1, height: d.height & ~1 };
}

/** PS2/PS3-class titles on an emulator worker. The worker builds argv from its own emulator profile + `boot`. */
function validateEmulator(m, out) {
  const plat = EMULATOR_PLATFORMS[m.platform];
  if (!plat) fail(`platform must be one of ${Object.keys(EMULATOR_PLATFORMS).join('|')}`);
  if ((m.emulator ?? plat.emulator) !== plat.emulator) fail(`emulator for ${m.platform} must be ${plat.emulator}`);
  Object.assign(out, { type: 'emulator', platform: m.platform, emulator: plat.emulator });
  const seen = validateFiles(m, out);
  const boot = relPath(m.boot, 'boot');
  if (!plat.boot.test(boot)) fail(`boot is not a valid ${m.platform} boot file`);
  if (!seen.has(boot.toLowerCase())) fail('boot is not part of the game files');
  out.boot = boot;
  if (m.args !== undefined && !(Array.isArray(m.args) && m.args.length === 0)) fail('emulator titles take no arguments');
  validateCommon(m, out, plat);
  const cm = m.controllerMap ?? {};
  if (typeof cm !== 'object' || Array.isArray(cm)) fail('controllerMap must be an object');
  out.controllerMap = { ...DEFAULT_FULL_PAD };
  for (const [k, v] of Object.entries(cm)) { if (!FULL_PAD.includes(k) || !KEYS.has(v)) fail(`controllerMap ${k}->${v} not allowed`); out.controllerMap[k] = v; }
  return out;
}

export function validateManifest(m, { allowNetwork = false } = {}) {
  if (!m || typeof m !== 'object' || Array.isArray(m)) fail('manifest must be an object');
  if (typeof m.id !== 'string' || !ID.test(m.id)) fail('id must match ^[a-z0-9][a-z0-9-]{0,63}$');
  if (m.type === 'emulator') return validateEmulator(m, { id: m.id, title: String(m.title || m.id).slice(0, 80) });
  if (m.type !== 'windows') fail('type must be "windows" or "emulator"');
  if (m.runtime !== 'wine') fail('runtime must be "wine"');
  const out = { id: m.id, title: String(m.title || m.id).slice(0, 80), type: 'windows', runtime: 'wine' };
  const seen = validateFiles(m, out);
  const exe = relPath(m.executable, 'executable');
  if (!exe.toLowerCase().endsWith('.exe')) fail('executable must be a .exe');
  if (!seen.has(exe.toLowerCase())) fail('executable is not part of the game files');
  out.executable = exe;
  const wd = relPath(m.workingDirectory ?? (exe.includes('/') ? exe.slice(0, exe.lastIndexOf('/')) : ''), 'workingDirectory', true);
  if (wd && ![...seen].some(p => p.startsWith(wd.toLowerCase() + '/'))) fail('workingDirectory does not exist in the game');
  out.workingDirectory = wd;
  const args = m.args ?? [];
  if (!Array.isArray(args) || args.length > 16 || !args.every(a => typeof a === 'string' && ARG.test(a))) fail('args must be up to 16 plain strings');
  out.args = [...args];
  const net = m.network ?? false;
  if (net !== false && !(allowNetwork && net === true)) fail('network access is not permitted for games');
  out.network = !!net;
  const r = m.requirements ?? {};
  if (typeof r !== 'object' || Array.isArray(r)) fail('requirements must be an object');
  const ram = r.ram ?? 2048, gpu = r.gpu ?? true, cpus = r.cpus ?? 2, storageMB = r.storageMB ?? 2048, maxMinutes = r.maxMinutes ?? 240;
  if (!Number.isInteger(ram) || ram < 128 || ram > 65536) fail('requirements.ram must be 128..65536 MB');
  if (typeof gpu !== 'boolean') fail('requirements.gpu must be boolean');
  if (typeof cpus !== 'number' || cpus < 0.25 || cpus > 32) fail('requirements.cpus must be 0.25..32');
  if (!Number.isInteger(storageMB) || storageMB < 64 || storageMB > 262144) fail('requirements.storageMB must be 64..262144');
  if (typeof maxMinutes !== 'number' || maxMinutes < 0.05 || maxMinutes > 1440) fail('requirements.maxMinutes out of range');
  out.requirements = { ram, gpu, cpus, storageMB, maxMinutes };
  const g = m.graphics ?? 'auto'; if (!GRAPHICS.has(g)) fail('graphics must be auto|dxvk|vkd3d|wined3d|gdi'); out.graphics = g;
  const a = m.arch ?? 'auto'; if (!ARCH.has(a)) fail('arch must be auto|x64|x86'); out.arch = a;
  const cm = m.controllerMap ?? {};
  if (typeof cm !== 'object' || Array.isArray(cm)) fail('controllerMap must be an object');
  out.controllerMap = { ...DEFAULT_PAD };
  for (const [k, v] of Object.entries(cm)) { if (!PAD.has(k) || !KEYS.has(v)) fail(`controllerMap ${k}->${v} not allowed`); out.controllerMap[k] = v; }
  const d = m.display ?? { width: 1280, height: 720 };
  if (!Number.isInteger(d.width) || !Number.isInteger(d.height) || d.width < 320 || d.width > 3840 || d.height < 240 || d.height > 2160) fail('display must be 320x240..3840x2160');
  out.display = { width: d.width & ~1, height: d.height & ~1 };
  return out;
}

/** Content identity of a game version (same formula as the worker): only files matter. */
export function manifestHash(m) {
  return createHash('sha256').update(JSON.stringify(m.files.map(f => [f.path, f.size, f.chunks]))).digest('hex');
}

/** Inspect a PE header: returns { arch: 'x64'|'x86' } or null if the bytes are not a Windows executable. */
export function peInfo(buf) {
  if (buf.length < 64 || buf[0] !== 0x4d || buf[1] !== 0x5a) return null;
  const off = buf.readUInt32LE(0x3c);
  if (off + 6 > buf.length || buf.readUInt32LE(off) !== 0x00004550) return null;
  const machine = buf.readUInt16LE(off + 4);
  if (machine === 0x8664) return { arch: 'x64' };
  if (machine === 0x14c) return { arch: 'x86' };
  return null; // ARM64 / other machines are not supported by this worker pool
}

/** A single uploaded .exe becomes a one-file game. The executable name is fixed by us, never by the client. */
export function uploadManifest(sha, size, title, arch) {
  return validateManifest({
    id: `upload-${sha.slice(0, 16)}`, title: title || 'Uploaded game', type: 'windows', runtime: 'wine', executable: 'game.exe',
    files: [{ path: 'game.exe', size, chunks: [sha] }], network: false, arch, graphics: 'auto',
    requirements: { ram: 2048, gpu: true, maxMinutes: 240 },
  });
}

/** The worker runtime a validated manifest needs (what workers advertise and the scheduler matches on). */
export function runtimeOf(m) {
  if (m.type === 'emulator') return m.platform;
  return m.arch === 'x86' ? 'x86' : 'x64-win';
}
