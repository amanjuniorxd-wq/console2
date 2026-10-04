// Server-side archive expansion for uploads (ZIP / RAR / 7z) with 7-Zip. The archive is one uploaded file (chunks in
// the store); it is listed first (every entry validated: no absolute paths, no "..", no links, no encryption, size and
// count limits, compression-ratio guard), extracted into a private temp dir, walked again with lstat (anything that is
// not a regular file or directory, or resolves outside the dir, aborts), nested archives are expanded (depth-limited),
// and every extracted file is put back into the content-addressed store as chunks — so the rest of the pipeline
// (inspection, manifests, worker game layers, dedup) is exactly the one used for folder uploads.
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, createWriteStream, rmSync, lstatSync, readdirSync, openSync, readSync, closeSync, realpathSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { CHUNK, sha256 } from './storage.mjs';

export class ArchiveError extends Error { constructor(msg, status = 422) { super(msg); this.status = status; } }

const LIMITS = {
  entries: +(process.env.ARCHIVE_MAX_ENTRIES || 20000),
  bytes: +(process.env.ARCHIVE_MAX_GB || 64) * 1024 ** 3,
  ratio: +(process.env.ARCHIVE_MAX_RATIO || 200),   // uncompressed / compressed (zip-bomb guard; game data compresses ~1–5x)
  depth: 2,
  seconds: +(process.env.ARCHIVE_TIMEOUT_S || 1800),
};
const TMP = process.env.ARCHIVE_TMP || tmpdir();
const SEVEN = ['7zz', '7z', '7za'].find(b => spawnSync('sh', ['-c', `command -v ${b}`]).status === 0) || null;
export const archiveSupport = () => ({ available: !!SEVEN, tool: SEVEN, limits: LIMITS });

/** Magic bytes → archive kind (never the file name). */
export function archiveKind(h) {
  if (h.length >= 4 && h[0] === 0x50 && h[1] === 0x4b && ((h[2] === 3 && h[3] === 4) || (h[2] === 5 && h[3] === 6))) return 'zip';
  if (h.length >= 7 && h.subarray(0, 6).equals(Buffer.from('Rar!\x1a\x07', 'latin1')) && (h[6] === 0 || (h[6] === 1 && h[7] === 0))) return 'rar';
  if (h.length >= 6 && h.subarray(0, 6).equals(Buffer.from([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c]))) return '7z';
  return null;
}

function run(args, cwd) {
  return new Promise((resolve, reject) => {
    const p = spawn(SEVEN, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], env: { PATH: process.env.PATH, LANG: 'C.UTF-8' } });
    let out = '', err = '';
    p.stdout.on('data', d => { if (out.length < 64 * 1024 * 1024) out += d; });
    p.stderr.on('data', d => { if (err.length < 65536) err += d; });
    const t = setTimeout(() => p.kill('SIGKILL'), LIMITS.seconds * 1000);
    p.on('error', reject);
    p.on('close', code => { clearTimeout(t); resolve({ code, out, err }); });
  });
}

const UNSAFE = p => !p || p.startsWith('/') || p.startsWith('\\') || /^[a-z]:/i.test(p) || p.replaceAll('\\', '/').split('/').some(s => s === '..');

/** 7-Zip technical listing → validated entries. Throws on anything unsafe. */
export function parseListing(text, archiveBytes) {
  const entries = [];
  let total = 0;
  for (const block of text.split(/\r?\n\r?\n/)) {
    const kv = Object.fromEntries(block.split(/\r?\n/).map(l => l.match(/^([^=]+?) = (.*)$/)).filter(Boolean).map(m => [m[1], m[2]]));
    if (!('Path' in kv) || !('Size' in kv || 'Folder' in kv)) continue;
    const path = kv.Path;
    if (UNSAFE(path)) throw new ArchiveError(`Unsafe path inside the archive: ${JSON.stringify(path.slice(0, 120))}`);
    if (kv.Encrypted === '+') throw new ArchiveError('This archive is password-protected. Upload an unencrypted archive.');
    if ((kv['Symbolic Link'] || kv['Hard Link']) || /(^| )l[rwx-]{9}/.test(kv.Attributes || '') || /\bSYMLINK\b/i.test(kv.Attributes || ''))
      throw new ArchiveError(`Links are not allowed inside uploaded archives (${path.slice(0, 120)}).`);
    const dir = kv.Folder === '+' || /^D/.test(kv.Attributes || '');
    const size = +(kv.Size || 0);
    if (!dir) { total += size; entries.push({ path: path.replaceAll('\\', '/'), size }); }
    if (entries.length > LIMITS.entries) throw new ArchiveError(`The archive has more than ${LIMITS.entries} files.`);
  }
  if (total > LIMITS.bytes) throw new ArchiveError(`The archive expands to more than ${LIMITS.bytes / 1024 ** 3} GB.`);
  if (archiveBytes && total > archiveBytes * LIMITS.ratio + 64 * 1024 * 1024) throw new ArchiveError('The archive expands suspiciously (compression ratio too high).');
  return { entries, total };
}

/** Walk an extracted tree: regular files only, all inside root. */
export function walk(root) {
  const real = realpathSync(root), out = [];
  const go = d => {
    for (const n of readdirSync(d)) {
      const p = join(d, n), st = lstatSync(p);
      if (st.isSymbolicLink()) throw new ArchiveError(`Links are not allowed inside uploaded archives (${relative(root, p)}).`);
      if (st.isDirectory()) go(p);
      else if (st.isFile()) { if (!realpathSync(p).startsWith(real + sep)) throw new ArchiveError('Archive entry escapes the extraction directory.'); out.push(p); }
      else throw new ArchiveError(`Unsupported entry type inside the archive (${relative(root, p)}).`);
    }
  };
  go(root);
  return out;
}

function headOf(path, n = 8) {
  const fd = openSync(path, 'r');
  try { const b = Buffer.alloc(n); return b.subarray(0, readSync(fd, b, 0, n, 0)); } finally { closeSync(fd); }
}

async function extractTo(archivePath, dest, archiveBytes, depth, budget) {
  const l = await run(['l', '-slt', '-ba', '-sccUTF-8', archivePath]);
  if (l.code !== 0) throw new ArchiveError(`The archive could not be read (${(l.err.trim().split('\n').pop() || 'corrupt or unsupported').slice(0, 160)}).`);
  const { total } = parseListing(l.out, archiveBytes);
  budget.bytes += total;
  if (budget.bytes > LIMITS.bytes) throw new ArchiveError(`The archive expands to more than ${LIMITS.bytes / 1024 ** 3} GB.`);
  const x = await run(['x', '-y', '-bd', '-bb0', '-sccUTF-8', `-o${dest}`, archivePath]);
  if (x.code !== 0) throw new ArchiveError(`Extraction failed (${(x.err.trim().split('\n').pop() || 'corrupt archive').slice(0, 160)}).`);
  const files = walk(dest);
  if (depth < LIMITS.depth) {                              // nested archives: expanded in place (archive → folder of the same name)
    for (const f of files) {
      if (!archiveKind(headOf(f))) continue;
      const sub = `${f}.d`;
      await extractTo(f, sub, statSync(f).size, depth + 1, budget);
      rmSync(f);
    }
  }
}

/** Store every file of a directory as chunks; returns the upload file list (paths relative to root, '/' separated). */
function ingest(root, store) {
  return walk(root).map(p => {
    const rel = relative(root, p).split(sep).join('/').replace(/\.d(\/|$)/g, '$1');
    const size = statSync(p).size, chunks = [], buf = Buffer.alloc(CHUNK);
    const fd = openSync(p, 'r');
    try {
      for (let off = 0; off < size; off += CHUNK) {
        const n = readSync(fd, buf, 0, Math.min(CHUNK, size - off), off);
        const part = buf.subarray(0, n), h = sha256(part);
        if (!store.has(h)) store.put(h, Buffer.from(part));
        chunks.push(h);
      }
    } finally { closeSync(fd); }
    return { path: rel, size, chunks };
  });
}

let active = 0;
const waiting = [];
const MAX_PARALLEL = +(process.env.ARCHIVE_PARALLEL || 1);   // extraction is disk/CPU heavy: bounded (backpressure)

/** Expand an uploaded archive (file = { path, size, chunks }) into a validated upload file list. */
export async function expandArchive(file, store) {
  if (!SEVEN) throw new ArchiveError('Archive uploads need 7-Zip on the cloud server (install the 7zip package).', 503);
  if (active >= MAX_PARALLEL) await new Promise(r => waiting.push(r));
  active++;
  const dir = mkdtempSync(join(TMP, 'mishrin-arc-'));
  try {
    const arc = join(dir, 'archive');
    await new Promise((resolve, reject) => {             // reassemble the chunks (streamed, never in memory)
      const w = createWriteStream(arc, { mode: 0o600 });
      w.on('error', reject);
      (async () => { for (const c of file.chunks) { const r = store.stream(c); for await (const b of r) if (!w.write(b)) await new Promise(ok => w.once('drain', ok)); } w.end(resolve); })().catch(reject);
    });
    const out = join(dir, 'x');
    await extractTo(arc, out, file.size, 1, { bytes: 0 });
    const files = ingest(out, store);
    if (!files.length) throw new ArchiveError('The archive is empty.');
    return files;
  } finally {
    rmSync(dir, { recursive: true, force: true });
    active--;
    waiting.shift()?.();
  }
}
