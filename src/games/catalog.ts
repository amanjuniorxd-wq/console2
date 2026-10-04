import type { Game, RuntimeKind } from './types';
import { KNOWN_RUNTIMES } from './types';
import { idb } from '../mpc/idb';
import { sha256 } from '../mpc/store';

export let games: Game[] = [];
const subs = new Set<() => void>();
export const onCatalog = (f: () => void) => (subs.add(f), () => subs.delete(f));
const emit = () => subs.forEach(f => f());

const ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
function sanitize(g: Partial<Game>): Game | null {
  if (!g || typeof g.id !== 'string' || !ID.test(g.id) || typeof g.title !== 'string') return null;
  // Unknown runtimes are kept (and shown as unsupported) rather than silently dropped.
  const runtime = (typeof g.runtime === 'string' ? g.runtime : 'unknown') as RuntimeKind;
  const url = typeof g.url === 'string' ? g.url : '';
  if (url && !/^(https?:|idb:|emu:local$|cloud:[a-z0-9][a-z0-9-]{0,63}$|upload:[a-f0-9]{32}$|\/|\.\/)/.test(url)) return null; // no javascript:/data: launch targets
  return {
    id: g.id, title: g.title.slice(0, 80), artwork: typeof g.artwork === 'string' ? g.artwork : 'gen:landscape',
    description: typeof g.description === 'string' ? g.description.slice(0, 600) : '', runtime,
    requirements: g.requirements ?? {}, launchConfig: g.launchConfig ?? {}, url, sha256: g.sha256, chunks: g.chunks,
    genre: g.genre, controller: g.controller ?? true, touch: g.touch, user: g.user,
    emu: g.emu && ['p1', 'p2', 'p3', 'p4'].includes(g.emu.platform) && Array.isArray(g.emu.files) && typeof g.emu.primary === 'string' ? g.emu : undefined,
  };
}

export async function loadCatalog(): Promise<Game[]> {
  const base = import.meta.env.BASE_URL;
  const [remote, local] = await Promise.all([
    fetch(`${base}games/catalog.json`).then(r => (r.ok ? r.json() : [])).catch(() => []),
    idb.all<Partial<Game>>('games').catch(() => []),
  ]);
  const map = new Map<string, Game>();
  // Bundled entries use app-root paths ("/games/…"): resolve them against the app base so the console also works
  // under a sub-path such as /mishrin-console/.
  const rebase = (u?: string) => (typeof u === 'string' && u.startsWith('/') && !u.startsWith('//') ? base + u.slice(1) : u);
  for (const g of remote as Partial<Game>[]) { const s = sanitize({ ...g, url: rebase(g.url), artwork: rebase(g.artwork) }); if (s) map.set(s.id, s); }
  for (const g of local) {
    const prev = g.id ? map.get(g.id) : undefined;
    const s = sanitize(prev ? { ...prev, ...g } : g);
    if (s) map.set(s.id, s);
  }
  games = [...map.values()];
  emit();
  return games;
}

export const byId = (id: string) => games.find(g => g.id === id);
export const isPlayable = (g: Game) => !!(g.url || g.chunks?.length);

// ---- adding games ----------------------------------------------------------------
const MAX = 1024 * 1024 * 1024;

/** Identify a package by magic bytes, never by name alone. */
export async function sniff(file: Blob, name: string): Promise<RuntimeKind> {
  const h = new Uint8Array(await file.slice(0, 512).arrayBuffer());
  if (h[0] === 0 && h[1] === 0x61 && h[2] === 0x73 && h[3] === 0x6d) {
    const bytes = await file.arrayBuffer();
    if (!WebAssembly.validate(bytes)) throw new Error('This WebAssembly file is invalid.');
    const ex = WebAssembly.Module.exports(new WebAssembly.Module(bytes)).map(e => e.name);
    if (!ex.includes('mpc_frame')) throw new Error('This .wasm is not an MPC game module (see docs: Framebuffer ABI). Package it as HTML instead.');
    return 'wasm';
  }
  if (h[0] === 0x4d && h[1] === 0x5a) return 'x64-win'; // MZ / PE executable → Windows compatibility node
  if (h[0] === 0x7f && h[1] === 0x45 && h[2] === 0x4c && h[3] === 0x46) return 'linux'; // ELF
  const text = new TextDecoder().decode(h).trimStart().toLowerCase();
  if (/\.html?$/i.test(name) && (text.startsWith('<!doctype html') || text.startsWith('<html') || text.startsWith('<'))) return 'web';
  throw new Error('Unsupported file. Use .html, MPC .wasm, or a Windows/Linux executable (cloud).');
}

function slug(t: string) { return t.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48) || 'game'; }

async function storeFile(key: string, file: Blob, type: string): Promise<string> {
  if (file.size > MAX) throw new Error('File exceeds 1 GB.');
  const bytes = await file.arrayBuffer();
  const hash = await sha256(bytes);
  await idb.put('files', key, { blob: new Blob([bytes], { type }), hash, name: (file as File).name ?? key });
  return hash;
}

export async function addFromFile(file: File, title?: string): Promise<Game> {
  const runtime = await sniff(file, file.name);
  const t = (title || file.name.replace(/\.[^.]+$/, '')).trim().slice(0, 80) || 'Untitled';
  let id = `u-${slug(t)}`;
  for (let i = 2; byId(id); i++) id = `u-${slug(t)}-${i}`;
  const sha = await storeFile(id, file, runtime === 'web' ? 'text/html' : 'application/octet-stream');
  const g: Game = { id, title: t, artwork: 'gen:landscape', description: 'Added from your device.', runtime, url: `idb:${id}`, sha256: sha, requirements: {}, launchConfig: {}, user: true, controller: true };
  await idb.put('games', id, g);
  await loadCatalog();
  return g;
}

export async function addFromUrl(url: string, title: string, runtime: RuntimeKind): Promise<Game> {
  const u = new URL(url, location.href);
  if (!/^https?:$/.test(u.protocol)) throw new Error('Use an http(s) URL.');
  if (!KNOWN_RUNTIMES.has(runtime)) throw new Error('Unknown runtime.');
  const t = title.trim().slice(0, 80) || u.hostname;
  let id = `u-${slug(t)}`;
  for (let i = 2; byId(id); i++) id = `u-${slug(t)}-${i}`;
  const g: Game = { id, title: t, artwork: 'gen:landscape', description: `Added from ${u.hostname}.`, runtime, url: u.href, requirements: {}, launchConfig: {}, user: true, controller: true };
  await idb.put('games', id, g);
  await loadCatalog();
  return g;
}

/** Attach a user-supplied file to a catalog slot (keeps title/artwork, sets package + detected runtime). */
export async function attachFile(game: Game, file: File): Promise<Game> {
  const runtime = await sniff(file, file.name);
  const sha = await storeFile(game.id, file, runtime === 'web' ? 'text/html' : 'application/octet-stream');
  const prev = (await idb.get<Partial<Game>>('games', game.id)) ?? { id: game.id };
  await idb.put('games', game.id, { ...prev, id: game.id, title: game.title, url: `idb:${game.id}`, runtime, sha256: sha });
  await loadCatalog();
  return byId(game.id)!;
}

/** Import a detected console game: files are streamed into local storage (OPFS) — never uploaded. */
export async function addEmuGame(det: import('../emu/detect').Detection, progress?: (done: number, total: number) => void): Promise<Game> {
  if (!det.ok || !det.platform || !det.primary) throw new Error(det.error || 'Unsupported file.');
  const { importFiles } = await import('../emu/storage');
  const t = (det.title && !/^(PLAYSTATION|CDROM|DISC)/i.test(det.title) ? det.title : det.primary.replace(/\.[^.]+$/, '')).replace(/_/g, ' ').trim().slice(0, 80) || 'Untitled';
  let id = `e-${slug(t)}`;
  for (let i = 2; byId(id); i++) id = `e-${slug(t)}-${i}`;
  const store = await importFiles(['games', id], det.files, progress);
  const art = { p1: 'gen:fantasy', p2: 'gen:action', p3: 'gen:scifi', p4: 'gen:racing' }[det.platform];
  const g: Game = {
    id, title: t, artwork: art, runtime: det.platform, url: 'emu:local', user: true, controller: true, touch: true, requirements: {}, launchConfig: {},
    description: `Imported from your device${det.serial ? ` (${det.serial})` : ''}. Stored only in this browser.`,
    emu: { platform: det.platform, format: det.format!, primary: det.primary, files: det.files.map(f => ({ name: f.name, size: f.size })), size: det.size, serial: det.serial, store },
  };
  await idb.put('games', id, g);
  await loadCatalog();
  return g;
}

/** A console game the player uploaded to their own cloud: the library keeps only a reference (url "upload:<id>"). */
export async function addCloudGame(r: { id: string; platform: string; title: string; serial?: string; executable?: string; files?: number }, det: { files: File[]; paths: string[]; size: number; format?: string; title?: string }): Promise<Game> {
  const runtime = ({ ps2: 'p2', ps3: 'p3', windows: 'x64-win' } as Record<string, RuntimeKind>)[r.platform];
  if (!runtime) throw new Error(`The cloud detected an unsupported platform (${r.platform}).`);
  const t = (r.title || det.title || 'Untitled').slice(0, 80);
  let id = `c-${slug(t)}`;
  for (let i = 2; byId(id); i++) id = `c-${slug(t)}-${i}`;
  const g: Game = {
    id, title: t, artwork: runtime === 'p2' ? 'gen:action' : runtime === 'p3' ? 'gen:scifi' : 'gen:landscape',
    runtime, url: `upload:${r.id}`, user: true, controller: true, touch: true, requirements: {},
    description: runtime === 'x64-win'
      ? `Uploaded by you to your cloud · ${r.files || det.files.length} files · launches ${r.executable === '__AUTO__' ? 'an automatically detected EXE' : (r.executable || 'the detected EXE')}.`
      : `Uploaded by you to your cloud${r.serial ? ` (${r.serial})` : ''}. Streams from a cloud worker.`,
  };
  await idb.put('games', id, g);
  await loadCatalog();
  return g;
}

export async function removeUserData(game: Game): Promise<void> {
  if (game.emu && game.emu.store !== 'cloud') { const s = await import('../emu/storage'); await s.removeFiles(['games', game.id]).catch(() => {}); await idb.del('files', `card:${game.id}`).catch(() => {}); }
  await idb.del('files', game.id).catch(() => {});
  await idb.del('games', game.id).catch(() => {});
  await idb.del('saves', game.id).catch(() => {});
  await loadCatalog();
}
