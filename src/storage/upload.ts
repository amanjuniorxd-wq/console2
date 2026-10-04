/**
 * Chunked, resumable, deduplicated upload to the cloud's object storage (server: /api/uploads).
 *   1. hash every file in fixed 4 MiB chunks (hashes cached per file, so a retry does not re-hash)
 *   2. declare the file list → the server answers with the chunks it does not have yet (dedup across everyone)
 *   3. PUT the missing chunks, 3 in parallel, each verified by SHA-256 on the server
 *   4. complete → the server inspects the actual bytes and decides the platform (never the file name)
 * Resume is free: declaring the same files again returns only what is still missing.
 * Only ever called after the player explicitly chose to upload (Upload Game → "Upload to your cloud").
 */
import { idb } from '../mpc/idb';
import { base, idHeaders } from '../cloud/identity';

export const CHUNK = 4 * 1024 * 1024;
export interface UploadFile { path: string; blob: Blob }
export interface UploadResult { id: string; platform: string; runtime: string; title: string; serial?: string; boot?: string; format?: string; files?: { path: string; size: number }[] }
export interface Progress { phase: 'hashing' | 'uploading' | 'checking'; done: number; total: number; dedupBytes?: number }

const hex = (b: ArrayBuffer) => [...new Uint8Array(b)].map(x => x.toString(16).padStart(2, '0')).join('');

export async function chunkHashes(blob: Blob, cacheKey?: string, onBytes?: (n: number) => void): Promise<string[]> {
  if (cacheKey) { const hit = await idb.get<string[]>('files', cacheKey).catch(() => undefined); if (hit) { onBytes?.(blob.size); return hit; } }
  const out: string[] = [];
  for (let o = 0; o < blob.size; o += CHUNK) {
    const part = await blob.slice(o, Math.min(blob.size, o + CHUNK)).arrayBuffer();
    out.push(hex(await crypto.subtle.digest('SHA-256', part)));
    onBytes?.(part.byteLength);
  }
  if (cacheKey) await idb.put('files', cacheKey, out).catch(() => {});
  return out;
}

async function call(path: string, init: RequestInit = {}) {
  const r = await fetch(base() + path, { ...init, headers: { 'content-type': 'application/json', ...idHeaders(), ...(init.headers || {}) } });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(j.error || `Upload failed (${r.status}).`), { status: r.status });
  return j;
}

export async function upload(files: UploadFile[], opts: { title?: string; signal?: AbortSignal; onProgress?: (p: Progress) => void } = {}): Promise<UploadResult> {
  const total = files.reduce((a, f) => a + f.blob.size, 0);
  let hashed = 0;
  const decl = [];
  for (const f of files) {
    const file = f.blob as File;
    const key = `upl:${f.path}|${f.blob.size}|${file.lastModified ?? 0}`;
    decl.push({ path: f.path, size: f.blob.size, chunks: await chunkHashes(f.blob, key, n => { hashed += n; opts.onProgress?.({ phase: 'hashing', done: hashed, total }); }) });
    opts.signal?.throwIfAborted();
  }
  const d = await call('/api/uploads', { method: 'POST', body: JSON.stringify({ files: decl, title: opts.title }), signal: opts.signal });
  if (d.state === 'complete') return { id: d.id, platform: d.platform, runtime: d.runtime, title: d.title, boot: d.boot, format: d.format, files: d.files };
  // Map each missing hash to one place it can be read from.
  const where = new Map<string, { blob: Blob; off: number }>();
  decl.forEach((f, i) => f.chunks.forEach((h, k) => { if (!where.has(h)) where.set(h, { blob: files[i].blob, off: k * CHUNK }); }));
  const missing: string[] = d.missing;
  const need = missing.reduce((a, h) => a + Math.min(CHUNK, where.get(h)!.blob.size - where.get(h)!.off), 0);
  let sent = 0;
  const queue = [...missing];
  const worker = async () => {
    for (let h = queue.shift(); h; h = queue.shift()) {
      const { blob, off } = where.get(h)!;
      const body = blob.slice(off, Math.min(blob.size, off + CHUNK));
      for (let attempt = 0; ; attempt++) {
        try {
          const r = await fetch(`${base()}/api/uploads/${d.id}/chunks/${h}`, { method: 'PUT', body, headers: { 'content-type': 'application/octet-stream', ...idHeaders() }, signal: opts.signal });
          if (!r.ok) throw new Error(`chunk rejected (${r.status})`);
          break;
        } catch (e) { if (opts.signal?.aborted || attempt >= 3) throw e; await new Promise(r => setTimeout(r, 500 * 2 ** attempt)); }
      }
      sent += body.size;
      opts.onProgress?.({ phase: 'uploading', done: sent, total: need, dedupBytes: total - need });
    }
  };
  await Promise.all([worker(), worker(), worker()]);
  opts.onProgress?.({ phase: 'checking', done: 1, total: 1 });
  const c = await call(`/api/uploads/${d.id}/complete`, { method: 'POST', body: '{}', signal: opts.signal });
  return { id: c.id, platform: c.platform, runtime: c.runtime, title: c.title, serial: c.serial, boot: c.boot, format: c.format, files: c.files };
}

/** Files the cloud extracted from an archive (owner-only), as local File objects — used when the game runs locally (PS1). */
export async function fetchExtracted(r: UploadResult, onProgress?: (done: number, total: number) => void): Promise<File[]> {
  const list = r.files || [];
  const total = list.reduce((a, f) => a + f.size, 0);
  let done = 0;
  const out: File[] = [];
  for (let i = 0; i < list.length; i++) {
    const res = await fetch(`${base()}/api/uploads/${r.id}/files/${i}`, { headers: idHeaders() });
    if (!res.ok) throw new Error(`Download of ${list[i].path} failed (${res.status}).`);
    const blob = await res.blob();
    done += blob.size; onProgress?.(done, total);
    out.push(new File([blob], list[i].path.split('/').pop()!));
  }
  return out;
}
