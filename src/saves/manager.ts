/**
 * SaveManager — one interface over every place progress lives:
 *   local     save states of local runtimes (MPC WASM, Mishrin P1) — IndexedDB, gzip
 *   emulator  emulator memory cards (Mishrin P1 128 KB card) — IndexedDB
 *   gamedata  HTML5 games' own state (save protocol) — IndexedDB
 *   cloud     cloud save layers (Windows / emulator workers) — scheduler /api/saves, per player
 * Operations: list · export (.msave) · import · delete. Loading a save is done by the game/runtime that owns it.
 */
import { idb } from '../mpc/idb';
import { byId, games } from '../games/catalog';
import { settings } from '../ui/settings-store';
import { base, idHeaders } from '../cloud/identity';
import { encodeSave, decodeSave, type Provider, type SaveHeader } from './format';
import type { SaveRec } from '../mpc/saves';

export interface SaveEntry { provider: Provider; gameId: string; title: string; size: number; ts: number; kind: string; ref?: string }
export const PROVIDER_LABEL: Record<Provider, string> = { local: 'Local', emulator: 'Emulator', cloud: 'Cloud', gamedata: 'Game Data' };

const titleOf = (id: string) => byId(id)?.title ?? id;
const isWeb = (id: string) => ['web', 'webgpu'].includes(byId(id)?.runtime ?? '');

export async function listSaves(): Promise<SaveEntry[]> {
  const out: SaveEntry[] = [];
  for (const r of await idb.all<SaveRec>('saves').catch(() => [] as SaveRec[])) {
    out.push({ provider: isWeb(r.gameId) ? 'gamedata' : 'local', gameId: r.gameId, title: titleOf(r.gameId), size: r.data.size, ts: r.ts, kind: r.gz ? 'save state (gzip)' : 'save state' });
  }
  for (const k of await idb.keys('files').catch(() => [] as string[])) {
    if (!k.startsWith('card:')) continue;
    const id = k.slice(5), card = await idb.get<Uint8Array>('files', k);
    if (card) out.push({ provider: 'emulator', gameId: id, title: titleOf(id), size: card.byteLength, ts: 0, kind: 'memory card' });
  }
  if (settings.cloudEndpoint) {
    try {
      const r = await fetch(`${base()}/api/saves`, { headers: idHeaders(), signal: AbortSignal.timeout(4000) });
      if (r.ok) for (const e of await r.json() as { game: string; latest: { ref: string; size: number; ts: number; kind: string } }[]) {
        out.push({ provider: 'cloud', gameId: e.game, title: games.find(g => g.id === e.game || g.url === `cloud:${e.game}`)?.title ?? e.game, size: e.latest.size, ts: e.latest.ts, kind: `cloud save layer (${e.latest.kind})`, ref: e.latest.ref });
      }
    } catch { /* cloud unreachable: local saves still listed */ }
  }
  return out.sort((a, b) => b.ts - a.ts);
}

export async function exportSave(e: SaveEntry): Promise<Blob> {
  const h: SaveHeader = { provider: e.provider, gameId: e.gameId, title: e.title, kind: e.kind, ts: e.ts || Date.now(), raw: 0, encoding: 'raw' };
  if (e.provider === 'local' || e.provider === 'gamedata') {
    const r = await idb.get<SaveRec>('saves', e.gameId);
    if (!r) throw new Error('Save not found.');
    return encodeSave({ ...h, raw: r.raw, encoding: r.gz ? 'gzip' : 'raw' }, new Uint8Array(await r.data.arrayBuffer()));
  }
  if (e.provider === 'emulator') {
    const c = await idb.get<Uint8Array>('files', `card:${e.gameId}`);
    if (!c) throw new Error('Memory card not found.');
    return encodeSave({ ...h, raw: c.byteLength }, c);
  }
  const r = await fetch(`${base()}/api/saves/${e.gameId}/data`, { headers: idHeaders() });
  if (!r.ok) throw new Error(`Cloud save not available (${r.status}).`);
  return encodeSave({ ...h, encoding: 'layer' }, new Uint8Array(await r.arrayBuffer()));
}

export async function importSave(file: Blob): Promise<SaveEntry> {
  const { header: h, payload } = await decodeSave(file);
  if (h.provider === 'local' || h.provider === 'gamedata') {
    const rec: SaveRec = { gameId: h.gameId, ts: Date.now(), raw: h.raw || payload.byteLength, gz: h.encoding === 'gzip', data: new Blob([payload as BlobPart]) };
    await idb.put('saves', h.gameId, rec);
  } else if (h.provider === 'emulator') {
    if (payload.byteLength !== 131072) throw new Error('Memory card images must be 128 KB.');
    await idb.put('files', `card:${h.gameId}`, payload.slice());
  } else {
    if (!settings.cloudEndpoint) throw new Error('Cloud saves need your cloud endpoint (Settings → Cloud Gaming).');
    const r = await fetch(`${base()}/api/saves/${h.gameId}/import`, { method: 'POST', body: payload as BlobPart, headers: { 'content-type': 'application/octet-stream', ...idHeaders() } });
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `Cloud refused the save (${r.status}).`);
  }
  return { provider: h.provider, gameId: h.gameId, title: h.title, size: payload.byteLength, ts: Date.now(), kind: h.kind };
}

export async function deleteSave(e: SaveEntry): Promise<void> {
  if (e.provider === 'local' || e.provider === 'gamedata') return idb.del('saves', e.gameId);
  if (e.provider === 'emulator') return idb.del('files', `card:${e.gameId}`);
  const r = await fetch(`${base()}/api/saves/${e.gameId}`, { method: 'DELETE', headers: idHeaders() });
  if (!r.ok && r.status !== 404) throw new Error(`Cloud delete failed (${r.status}).`);
}
