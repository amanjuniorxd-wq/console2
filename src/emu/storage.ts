/**
 * Local-only storage for emulation: imported game files, optional user BIOS, memory cards.
 * Large files are streamed into the Origin Private File System (OPFS) in chunks — never read fully into RAM,
 * never uploaded. Browsers without OPFS fall back to IndexedDB blobs.
 */
import { idb } from '../mpc/idb';
import type { GameFile } from './types';

const ROOT = 'mishrin';
const hasOpfs = () => typeof navigator !== 'undefined' && !!navigator.storage?.getDirectory;

async function dir(path: string[], create = true): Promise<FileSystemDirectoryHandle> {
  let d = await navigator.storage.getDirectory();
  for (const p of [ROOT, ...path]) d = await d.getDirectoryHandle(p, { create });
  return d;
}

export async function ensureSpace(bytes: number): Promise<void> {
  const est = await navigator.storage?.estimate?.().catch(() => null);
  if (est?.quota && est.usage !== undefined && est.quota - est.usage < bytes * 1.05) {
    throw new Error(`Not enough browser storage: need ${(bytes / 1e9).toFixed(2)} GB, ${((est.quota - est.usage) / 1e9).toFixed(2)} GB free.`);
  }
}

/** Copy files into local storage with streaming (constant memory). Returns where they live. */
export async function importFiles(key: string[], files: File[], progress?: (done: number, total: number) => void): Promise<'opfs' | 'idb'> {
  const total = files.reduce((a, f) => a + f.size, 0);
  await ensureSpace(total);
  let done = 0;
  if (hasOpfs()) {
    try {
      const d = await dir(key);
      for (const f of files) {
        const fh = await d.getFileHandle(f.name, { create: true });
        const w = await (fh as FileSystemFileHandle & { createWritable(): Promise<FileSystemWritableFileStream> }).createWritable();
        const reader = f.stream().getReader();
        for (;;) {
          const { done: end, value } = await reader.read();
          if (end) break;
          await w.write(value);
          done += value.length;
          progress?.(done, total);
        }
        await w.close();
      }
      return 'opfs';
    } catch (e) {
      await removeFiles(key).catch(() => {});
      if ((e as Error).message?.includes('storage')) throw e;
      /* fall through to IndexedDB (e.g. Safari private mode) */
    }
  }
  for (const f of files) { await idb.put('files', `emu:${key.join('/')}/${f.name}`, { blob: f, name: f.name }); done += f.size; progress?.(done, total); }
  return 'idb';
}

/** Resolve stored files for the worker (OPFS path for zero-copy sync reads, or a Blob reference). */
export async function gameFiles(key: string[], names: string[], store: 'opfs' | 'idb'): Promise<GameFile[]> {
  if (store === 'opfs') return names.map(n => ({ name: n, opfs: [ROOT, ...key, n] }));
  return Promise.all(names.map(async n => {
    const r = await idb.get<{ blob: Blob }>('files', `emu:${key.join('/')}/${n}`);
    if (!r) throw new Error(`Local copy of ${n} is missing. Import the game again.`);
    return { name: n, blob: r.blob };
  }));
}

export async function removeFiles(key: string[]): Promise<void> {
  if (hasOpfs()) {
    try { const parent = await dir(key.slice(0, -1), false); await parent.removeEntry(key[key.length - 1], { recursive: true }); } catch { /* not in OPFS */ }
  }
  for (const k of await idb.keys('files')) if (k.startsWith(`emu:${key.join('/')}/`)) await idb.del('files', k);
}

// ---------- optional user BIOS (P1): validated, stored locally, never bundled ----------
export const BIOS_SIZE = 512 * 1024;
export async function validateBios(f: File): Promise<string | null> {
  if (f.size !== BIOS_SIZE) return 'A P1 BIOS image is exactly 512 KB.';
  if (!/^[\w.\- ()]{1,64}\.bin$/i.test(f.name)) return 'Use the original BIOS file name ending in .bin.';
  const head = new Uint8Array(await f.slice(0, 0x110).arrayBuffer());
  // reset vector region holds MIPS code; an all-zero/all-FF header means a bad dump
  if (head.every(b => b === 0) || head.every(b => b === 0xff)) return 'This file does not look like a BIOS dump.';
  return null;
}
export async function setBios(platform: string, f: File): Promise<void> {
  const err = await validateBios(f);
  if (err) throw new Error(err);
  await removeFiles(['bios', platform]);
  const store = await importFiles(['bios', platform], [f]);
  await idb.put('files', `biosmeta:${platform}`, { name: f.name, size: f.size, store });
}
export async function getBios(platform: string): Promise<GameFile[]> {
  const r = await idb.get<{ name: string; store: 'opfs' | 'idb' }>('files', `biosmeta:${platform}`);
  return r ? gameFiles(['bios', platform], [r.name], r.store).catch(() => []) : [];
}
export async function biosInfo(platform: string) { return idb.get<{ name: string; size: number }>('files', `biosmeta:${platform}`); }
export async function clearBios(platform: string) { await removeFiles(['bios', platform]); await idb.del('files', `biosmeta:${platform}`); }

// ---------- memory cards ----------
export const loadCard = (gameId: string) => idb.get<Uint8Array>('files', `card:${gameId}`).then(v => v ?? null);
export const storeCard = (gameId: string, data: Uint8Array) => idb.put('files', `card:${gameId}`, data);
