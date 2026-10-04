// Content-addressed object storage for game chunks, single-file packages and save layers.
// One interface, filesystem backend: an S3/R2/GCS backend only has to implement these six calls
// (has/size/put/stream/read/path-less range reads) — the scheduler never touches files directly.
import { createHash } from 'node:crypto';
import { existsSync, statSync, writeFileSync, renameSync, createReadStream, openSync, readSync, closeSync, mkdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

export const CHUNK = 4 * 1024 * 1024;            // fixed chunk size (cloud/tools/pack.mjs and the console uploader use the same)
export const HASH = /^[a-f0-9]{64}$/;
export const sha256 = b => createHash('sha256').update(b).digest('hex');

export function fsStorage(dir) {
  mkdirSync(dir, { recursive: true });
  const file = sha => { if (!HASH.test(sha)) throw new Error('bad hash'); return join(dir, sha); };
  return {
    kind: 'fs',
    has: sha => HASH.test(sha) && existsSync(file(sha)),
    size: sha => statSync(file(sha)).size,
    /** Store bytes under their SHA-256. Rejects a body whose hash differs (integrity on every write). Returns false on dedup. */
    put(sha, buf) {
      if (sha256(buf) !== sha) throw Object.assign(new Error('Hash mismatch'), { status: 400 });
      if (existsSync(file(sha))) return false;
      const tmp = `${file(sha)}.${process.pid}.${Date.now()}.tmp`;
      writeFileSync(tmp, buf); renameSync(tmp, file(sha));
      return true;
    },
    stream: sha => createReadStream(file(sha)),
    read(sha, off, len) {
      const fd = openSync(file(sha), 'r');
      try { const b = Buffer.alloc(len); const n = readSync(fd, b, 0, len, off); return b.subarray(0, n); } finally { closeSync(fd); }
    },
    remove(sha) { try { unlinkSync(file(sha)); } catch { /* already gone */ } },
  };
}

/** Random access over a file described as a chunk list (every chunk except the last is CHUNK bytes). */
export function chunkedReader(store, f) {
  return {
    size: f.size,
    read(off, len) {
      if (off >= f.size) return Buffer.alloc(0);
      len = Math.min(len, f.size - off);
      const parts = [];
      while (len > 0) {
        const i = Math.floor(off / CHUNK), o = off % CHUNK, n = Math.min(len, CHUNK - o);
        parts.push(store.read(f.chunks[i], o, n)); off += n; len -= n;
      }
      return Buffer.concat(parts);
    },
  };
}
