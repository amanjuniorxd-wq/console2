/** Save-state persistence with native gzip (CompressionStream). Falls back to raw when unsupported. */
import { idb } from './idb';

export interface SaveRec { gameId: string; ts: number; raw: number; gz: boolean; data: Blob }

const hasCS = typeof CompressionStream === 'function';

async function pipe(data: BlobPart, s: CompressionStream | DecompressionStream): Promise<Blob> {
  return new Response(new Blob([data]).stream().pipeThrough(s)).blob();
}

export async function writeSave(gameId: string, state: Uint8Array): Promise<SaveRec> {
  const data = hasCS ? await pipe(state as BlobPart, new CompressionStream('gzip')) : new Blob([state as BlobPart]);
  const rec: SaveRec = { gameId, ts: Date.now(), raw: state.byteLength, gz: hasCS, data };
  await idb.put('saves', gameId, rec);
  return rec;
}

export async function readSave(gameId: string): Promise<Uint8Array | null> {
  const rec = await idb.get<SaveRec>('saves', gameId);
  if (!rec) return null;
  const blob = rec.gz ? await pipe(rec.data, new DecompressionStream('gzip')) : rec.data;
  return new Uint8Array(await blob.arrayBuffer());
}

export const saveInfo = (gameId: string) => idb.get<SaveRec>('saves', gameId);
export const allSaves = () => idb.all<SaveRec>('saves');
export const clearSaves = () => idb.clear('saves');
