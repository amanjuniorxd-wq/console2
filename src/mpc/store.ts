/**
 * MPC content-addressed package store.
 *  - Packages are keyed by SHA-256: identical bytes from any URL/title are stored once (dedup).
 *  - A manifest sha256 makes repeat launches zero-request (instant runtime reuse).
 *  - Chunked manifests fetch only chunks not already stored (delta updates).
 *  - Compiled WebAssembly.Modules are kept in a byte-budgeted LRU so relaunch skips compilation.
 */
import type { Game } from '../games/types';
import { idb } from './idb';

const CAS = 'mpc-cas-v1';
const MAX_PACKAGE = 1024 * 1024 * 1024; // 1 GB hard cap per package

export interface Pkg { bytes: ArrayBuffer; hash: string; fromCache: boolean; mime: string }
export type Progress = (loaded: number, total: number) => void;

const hasCaches = typeof caches !== 'undefined';
const casKey = (h: string) => `/__mpc/cas/${h}`;
const idxKey = (u: string) => `/__mpc/idx?u=${encodeURIComponent(u)}`;

export async function sha256(b: ArrayBuffer | ArrayBufferView): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', b as BufferSource);
  return [...new Uint8Array(d)].map(x => x.toString(16).padStart(2, '0')).join('');
}

async function casGet(h: string): Promise<ArrayBuffer | null> {
  if (!hasCaches) return null;
  const r = await (await caches.open(CAS)).match(casKey(h));
  return r ? r.arrayBuffer() : null;
}
async function casPut(h: string, b: ArrayBuffer, mime: string): Promise<void> {
  if (!hasCaches) return;
  const c = await caches.open(CAS);
  if (await c.match(casKey(h))) return; // dedup
  await c.put(casKey(h), new Response(b, { headers: { 'content-type': mime, 'x-mpc-size': String(b.byteLength), 'x-mpc-time': String(Date.now()) } }));
}

async function fetchBytes(url: string, onProgress?: Progress, signal?: AbortSignal): Promise<{ bytes: ArrayBuffer; mime: string }> {
  const r = await fetch(url, { signal, cache: 'no-cache' });
  if (!r.ok) throw new Error(`Download failed (${r.status})`);
  const total = Number(r.headers.get('content-length')) || 0;
  if (total > MAX_PACKAGE) throw new Error('Package exceeds 1 GB limit');
  const mime = r.headers.get('content-type') || 'application/octet-stream';
  if (!r.body || !onProgress) return { bytes: await r.arrayBuffer(), mime };
  const reader = r.body.getReader();
  // Preallocate when size is known: one buffer, no concat copies.
  let buf = new Uint8Array(total || 1 << 20), n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (n + value.length > buf.length) { const g = new Uint8Array(Math.max(buf.length * 2, n + value.length)); g.set(buf.subarray(0, n)); buf = g; }
    buf.set(value, n); n += value.length;
    if (n > MAX_PACKAGE) throw new Error('Package exceeds 1 GB limit');
    onProgress(n, total);
  }
  return { bytes: buf.byteLength === n ? buf.buffer : buf.slice(0, n).buffer, mime };
}

/** Resolve a game's package bytes through the store. */
export async function getPackage(game: Game, onProgress?: Progress, signal?: AbortSignal): Promise<Pkg> {
  if (game.url.startsWith('idb:')) {
    const f = await idb.get<{ blob: Blob; hash: string }>('files', game.url.slice(4));
    if (!f) throw new Error('Attached game file is missing. Re-add it in Library.');
    return { bytes: await f.blob.arrayBuffer(), hash: f.hash, fromCache: true, mime: f.blob.type };
  }

  if (game.chunks?.length) {
    const parts: ArrayBuffer[] = [];
    let loaded = 0, fetched = 0;
    const total = game.chunks.reduce((a, c) => a + (c.size ?? 0), 0);
    for (const c of game.chunks) {
      let b = await casGet(c.h);
      if (!b) {
        b = (await fetchBytes(new URL(c.url, location.href).href, undefined, signal)).bytes;
        if ((await sha256(b)) !== c.h) throw new Error('Chunk integrity check failed');
        await casPut(c.h, b, 'application/octet-stream');
        fetched++;
      }
      parts.push(b); loaded += b.byteLength; onProgress?.(loaded, total || loaded);
    }
    const out = new Uint8Array(loaded); let o = 0;
    for (const p of parts) { out.set(new Uint8Array(p), o); o += p.byteLength; }
    const hash = game.sha256 ?? (await sha256(out));
    return { bytes: out.buffer, hash, fromCache: fetched === 0, mime: 'application/octet-stream' };
  }

  const url = new URL(game.url, location.href).href;
  // 1) Known content address → zero network.
  const known = game.sha256 ?? (hasCaches ? await (await (await caches.open(CAS)).match(idxKey(url)))?.text() : undefined);
  if (known) {
    const b = await casGet(known);
    if (b) { onProgress?.(b.byteLength, b.byteLength); return { bytes: b, hash: known, fromCache: true, mime: 'application/octet-stream' }; }
  }
  // 2) Download, verify, store by content.
  const { bytes, mime } = await fetchBytes(url, onProgress, signal);
  // Never store an error/SPA fallback page as a binary package.
  if (/^text\/html/i.test(mime) && game.runtime !== 'web' && game.runtime !== 'webgpu') throw new Error('The game URL returned a web page instead of a game file. Check the URL.');
  const hash = await sha256(bytes);
  if (game.sha256 && game.sha256 !== hash) throw new Error('Integrity check failed: package does not match its manifest.');
  await casPut(hash, bytes, mime);
  if (hasCaches) await (await caches.open(CAS)).put(idxKey(url), new Response(hash));
  return { bytes, hash, fromCache: false, mime };
}

/** Warm the store ahead of launch (cache prediction). Silent on failure. */
export async function warm(game: Game): Promise<void> {
  if (!game.url || game.url.startsWith('idb:')) return;
  try { await getPackage(game); } catch { /* prediction only */ }
}

// ---- compiled module LRU -------------------------------------------------------------
const modules = new Map<string, { m: WebAssembly.Module; size: number }>();
let moduleBytes = 0;
export let moduleBudget = 256 * 1024 * 1024;
export function setModuleBudget(b: number) { moduleBudget = b; evict(); }
function evict() {
  for (const [k, v] of modules) { if (moduleBytes <= moduleBudget) break; modules.delete(k); moduleBytes -= v.size; }
}
export async function compiled(pkg: Pkg): Promise<{ module: WebAssembly.Module; reused: boolean }> {
  const hit = modules.get(pkg.hash);
  if (hit) { modules.delete(pkg.hash); modules.set(pkg.hash, hit); return { module: hit.m, reused: true }; }
  const m = await WebAssembly.compile(pkg.bytes);
  modules.set(pkg.hash, { m, size: pkg.bytes.byteLength }); moduleBytes += pkg.bytes.byteLength; evict();
  return { module: m, reused: false };
}
/** Resource reclamation: drop compiled modules (called under memory pressure / low-memory mode). */
export function reclaim(): void { modules.clear(); moduleBytes = 0; }

// ---- stats / maintenance ----------------------------------------------------------------
export async function storeStats(): Promise<{ packages: number; bytes: number }> {
  if (!hasCaches) return { packages: 0, bytes: 0 };
  const c = await caches.open(CAS); let packages = 0, bytes = 0;
  for (const req of await c.keys()) {
    if (!req.url.includes('/__mpc/cas/')) continue;
    const r = await c.match(req); packages++; bytes += Number(r?.headers.get('x-mpc-size')) || 0;
  }
  return { packages, bytes };
}
export async function clearStore(): Promise<void> { reclaim(); if (hasCaches) await caches.delete(CAS); }
