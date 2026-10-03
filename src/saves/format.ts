/** .msave container: one portable file per save, whatever produced it.
 *    "MSAVE1\n" + JSON header (one line) + "\n" + payload bytes
 *  header: { provider, gameId, title, kind, ts, raw, encoding } — payload stays in its native encoding
 *  (gzip state, raw memory card, zstd/gzip cloud save layer), so export/import is lossless and cheap. */
export type Provider = 'local' | 'emulator' | 'cloud' | 'gamedata';
export interface SaveHeader { provider: Provider; gameId: string; title: string; kind: string; ts: number; raw: number; encoding: 'gzip' | 'raw' | 'layer' }
const MAGIC = 'MSAVE1\n';
const ID = /^[a-z0-9][a-z0-9-]{0,63}$/;

export function encodeSave(h: SaveHeader, payload: Uint8Array): Blob {
  return new Blob([MAGIC, JSON.stringify(h), '\n', payload as BlobPart], { type: 'application/x-mishrin-save' });
}

export async function decodeSave(file: Blob): Promise<{ header: SaveHeader; payload: Uint8Array }> {
  const buf = new Uint8Array(await file.arrayBuffer());
  if (new TextDecoder().decode(buf.subarray(0, MAGIC.length)) !== MAGIC) throw new Error('Not a Mishrin save file (.msave).');
  const nl = buf.indexOf(10, MAGIC.length);
  if (nl < 0 || nl - MAGIC.length > 4096) throw new Error('Damaged save header.');
  let h: SaveHeader;
  try { h = JSON.parse(new TextDecoder().decode(buf.subarray(MAGIC.length, nl))); } catch { throw new Error('Damaged save header.'); }
  if (!['local', 'emulator', 'cloud', 'gamedata'].includes(h.provider) || !ID.test(h.gameId) || !['gzip', 'raw', 'layer'].includes(h.encoding)) throw new Error('Unsupported save file.');
  return { header: { ...h, title: String(h.title || h.gameId).slice(0, 80), kind: String(h.kind || '').slice(0, 40), ts: +h.ts || 0, raw: +h.raw || 0 }, payload: buf.subarray(nl + 1) };
}
