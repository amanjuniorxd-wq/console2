#!/usr/bin/env node
// Publish a Windows game to the Mishrin cloud: chunk → dedup-upload → register manifest.
//   node cloud/tools/pack.mjs <gameDir> <manifest.json> --scheduler http://host:8787 --admin-token TOKEN
// manifest.json holds everything except `files` (id, title, type, runtime, executable, requirements, …).
// Files are split into fixed 4 MiB chunks addressed by SHA-256. Chunks the cloud already has (from this game's
// previous version or any other game) are skipped, so an update uploads only what changed.
import { readFileSync, readdirSync, statSync, openSync, readSync, closeSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { createHash } from 'node:crypto';

const CHUNK = 4 << 20;
const args = process.argv.slice(2);
const [dir, mfPath] = args.filter((a, i) => !a.startsWith('--') && !args[i - 1]?.startsWith('--'));
const opt = k => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : undefined; };
const SCHED = (opt('scheduler') || process.env.MISHRIN_SCHEDULER || 'http://127.0.0.1:8787').replace(/\/$/, '');
const TOKEN = opt('admin-token') || process.env.ADMIN_TOKEN || '';
if (!dir || !mfPath) { console.error('usage: pack.mjs <gameDir> <manifest.json> --scheduler URL --admin-token TOKEN'); process.exit(2); }

const walk = d => readdirSync(d, { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(join(d, e.name)) : e.isFile() ? [join(d, e.name)] : []);
const files = walk(dir).sort();
let uploaded = 0, skipped = 0, bytesUp = 0, bytesTotal = 0;
const out = [];
for (const f of files) {
  const size = statSync(f).size;
  const fd = openSync(f, 'r');
  const chunks = [];
  for (let off = 0; off < size; off += CHUNK) {
    const buf = Buffer.alloc(Math.min(CHUNK, size - off));
    readSync(fd, buf, 0, buf.length, off);
    const sha = createHash('sha256').update(buf).digest('hex');
    chunks.push(sha);
    bytesTotal += buf.length;
    const head = await fetch(`${SCHED}/v1/packages/${sha}`, { method: 'HEAD' });
    if (head.ok) { skipped++; continue; }
    const put = await fetch(`${SCHED}/v1/packages/${sha}`, { method: 'PUT', body: buf, headers: { 'content-type': 'application/octet-stream' } });
    if (!put.ok) throw new Error(`upload failed for ${f}: ${put.status}`);
    uploaded++; bytesUp += buf.length;
  }
  closeSync(fd);
  out.push({ path: relative(dir, f).split(sep).join('/'), size, chunks });
}
const manifest = { ...JSON.parse(readFileSync(mfPath, 'utf8')), files: out };
const r = await fetch(`${SCHED}/admin/games`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` }, body: JSON.stringify(manifest) });
const body = await r.json();
if (!r.ok) { console.error('register failed:', body); process.exit(1); }
console.log(JSON.stringify({ id: body.id, manifestHash: body.manifestHash, files: out.length, chunksUploaded: uploaded, chunksDeduplicated: skipped, bytesUploaded: bytesUp, bytesTotal }));
