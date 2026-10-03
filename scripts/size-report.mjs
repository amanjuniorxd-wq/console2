// Prints raw / gzip / brotli sizes of the production build, and writes .gz/.br siblings for static hosts.
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync, brotliCompressSync, constants } from 'node:zlib';
const out = [];
const walk = d => readdirSync(d).forEach(f => { const p = join(d, f); statSync(p).isDirectory() ? walk(p) : out.push(p); });
walk('dist');
let tot = { raw: 0, gz: 0, br: 0 };
const rows = [];
for (const p of out) {
  if (!/\.(js|css|html|json|wasm|svg|webmanifest)$/.test(p)) continue;
  const b = readFileSync(p);
  const gz = gzipSync(b, { level: 9 }), br = brotliCompressSync(b, { params: { [constants.BROTLI_PARAM_QUALITY]: 11 } });
  writeFileSync(p + '.gz', gz); writeFileSync(p + '.br', br);
  rows.push([p.replace('dist/', ''), b.length, gz.length, br.length]);
  tot.raw += b.length; tot.gz += gz.length; tot.br += br.length;
}
rows.sort((a, b) => b[1] - a[1]);
const k = n => (n / 1024).toFixed(1).padStart(7) + ' KB';
for (const r of rows) console.log(r[0].padEnd(48), k(r[1]), k(r[2]), k(r[3]));
console.log('TOTAL'.padEnd(48), k(tot.raw), k(tot.gz), k(tot.br));
