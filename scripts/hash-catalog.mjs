// Stamps sha256 content addresses into the catalog so repeat launches are zero-request (MPC store).
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
const path = 'public/games/catalog.json';
const cat = JSON.parse(readFileSync(path, 'utf8'));
for (const g of cat) {
  if (!g.url || !g.url.startsWith('/') || g.runtime !== 'wasm') continue;
  g.sha256 = createHash('sha256').update(readFileSync('public' + g.url)).digest('hex');
}
writeFileSync(path, '[\n' + cat.map(g => '  ' + JSON.stringify(g)).join(',\n') + '\n]\n');
console.log('catalog hashed');
