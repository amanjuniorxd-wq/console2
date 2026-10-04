// Universal runtime tests for the scheduler: uploads (chunked, resumable, deduplicated, inspected server-side),
// emulator manifests, PSP/PS2 worker protocol with scripted mock workers, archive uploads (ZIP/RAR), runtime capability report, auth,
// session tokens, runtime failure, cloud saves API. No GPU/emulator needed. Run: node tests/cloud/universal.test.mjs
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { gzipSync, deflateRawSync } from 'node:zlib';
import { validateManifest, runtimeOf } from '../../server/lib/manifest.mjs';
import { parseSfo, openIso, inspectUpload } from '../../server/lib/inspect.mjs';
import { CHUNK } from '../../server/lib/storage.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
let n = 0, fails = 0;
const ok = (name, c, d = '') => { n++; if (!c) fails++; console.log(`${c ? 'PASS' : 'FAIL'} ${name}${d ? ' — ' + d : ''}`); };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const sha = b => createHash('sha256').update(b).digest('hex');
const WT = 'wt-universal', AT = 'at-universal';

// ------------------------------------------------------------------ fixtures built in memory (original, no copyrighted data)
export function makeSfo(entries) {
  const keys = Object.keys(entries);
  let keyTab = Buffer.alloc(0), dataTab = Buffer.alloc(0); const idx = [];
  for (const k of keys) {
    const v = entries[k], isInt = typeof v === 'number';
    const data = isInt ? Buffer.alloc(4) : Buffer.from(v + '\0', 'utf8');
    if (isInt) data.writeUInt32LE(v);
    const max = isInt ? 4 : Math.ceil(data.length / 4) * 4;
    const e = Buffer.alloc(16);
    e.writeUInt16LE(keyTab.length, 0); e.writeUInt16LE(isInt ? 0x0404 : 0x0204, 2); e.writeUInt32LE(data.length, 4); e.writeUInt32LE(max, 8); e.writeUInt32LE(dataTab.length, 12);
    idx.push(e);
    keyTab = Buffer.concat([keyTab, Buffer.from(k + '\0')]);
    dataTab = Buffer.concat([dataTab, data, Buffer.alloc(max - data.length)]);
  }
  while (keyTab.length % 4) keyTab = Buffer.concat([keyTab, Buffer.alloc(1)]);
  const h = Buffer.alloc(20);
  h.writeUInt32BE(0x00505346, 0); h.writeUInt32LE(0x101, 4);
  h.writeUInt32LE(20 + idx.length * 16, 8); h.writeUInt32LE(20 + idx.length * 16 + keyTab.length, 12); h.writeUInt32LE(idx.length, 16);
  return Buffer.concat([h, ...idx, keyTab, dataTab]);
}
/** Tiny ISO 9660 image: root directory with plain files (and optional directories). */
export function makeIso(files, { system = '', volume = 'MISHRIN_TEST', dirs = [] } = {}) {
  const S = 2048, rec = (name, lba, size, dir) => {
    const nb = Buffer.from(name, 'latin1'), len = 33 + nb.length + ((33 + nb.length) % 2);
    const r = Buffer.alloc(len); r[0] = len; r.writeUInt32LE(lba, 2); r.writeUInt32BE(lba, 6); r.writeUInt32LE(size, 10); r.writeUInt32BE(size, 14);
    r[25] = dir ? 2 : 0; r[32] = nb.length; nb.copy(r, 33); return r;
  };
  let next = 20; const placed = files.map(f => { const lba = next; next += Math.max(1, Math.ceil(f.data.length / S)); return { ...f, lba }; });
  const dirLba = dirs.map(() => next++);
  const root = Buffer.concat([rec('\0', 18, S, true), rec('\x01', 18, S, true), ...placed.map(f => rec(f.name + ';1', f.lba, f.data.length, false)), ...dirs.map((d, i) => rec(d, dirLba[i], S, true))]);
  const img = Buffer.alloc(next * S);
  const pvd = Buffer.alloc(S); pvd[0] = 1; pvd.write('CD001', 1, 'latin1'); pvd[6] = 1;
  pvd.write(system.padEnd(32), 8, 'latin1'); pvd.write(volume.padEnd(32), 40, 'latin1');
  rec('\0', 18, S, true).copy(pvd, 156);
  pvd.copy(img, 16 * S); root.copy(img, 18 * S);
  for (const f of placed) f.data.copy(img, f.lba * S);
  return img;
}
const chunksOf = buf => { const c = []; for (let o = 0; o < buf.length; o += CHUNK) c.push(buf.subarray(o, o + CHUNK)); return c; };
const fileEntry = (path, buf) => ({ path, size: buf.length, chunks: chunksOf(buf).map(sha) });
const memStore = parts => { const m = new Map(parts.map(b => [sha(b), b])); return { read: (h, o, l) => m.get(h).subarray(o, o + l), has: h => m.has(h), size: h => m.get(h).length }; };

// ------------------------------------------------------------------ pure: manifests + inspection
const pspFiles = [{ path: 'Game/EBOOT.PBP', size: 4, chunks: ['a'.repeat(64)] }, { path: 'Game/GAME.DAT', size: 4, chunks: ['b'.repeat(64)] }];
const em = validateManifest({ id: 'psp-test', type: 'emulator', platform: 'psp', boot: 'Game/EBOOT.PBP', files: pspFiles });
ok('emulator manifest: PSP title normalised (emulator fixed, defaults, full pad map)', em.emulator === 'ppsspp' && em.requirements.ram === 1536 && em.controllerMap.triangle === 'v' && runtimeOf(em) === 'psp');
ok('PS3 is not a platform any more (manifest refused)', (() => { try { validateManifest({ id: 'x', type: 'emulator', platform: 'ps3', boot: 'G/EBOOT.BIN', files: [{ path: 'G/EBOOT.BIN', size: 1, chunks: ['a'.repeat(64)] }] }); return false; } catch { return true; } })());
const bad = [
  ['client picks the emulator binary', { emulator: '/bin/sh' }], ['boot outside the files', { boot: 'other/EBOOT.PBP' }], ['boot not a PSP boot file', { boot: 'Game/GAME.DAT' }],
  ['args for emulator titles', { args: ['--no-gui'] }], ['network', { network: true }], ['unknown platform', { platform: 'ps5' }], ['traversal', { files: [{ path: '../x/EBOOT.PBP', size: 1, chunks: ['a'.repeat(64)] }], boot: '../x/EBOOT.PBP' }],
  ['controller map to arbitrary keys', { controllerMap: { cross: 'Super_L' } }],
];
const accepted = bad.filter(([, o]) => { try { validateManifest({ id: 'x', type: 'emulator', platform: 'psp', boot: 'Game/EBOOT.PBP', files: pspFiles, ...o }); return true; } catch { return false; } });
ok(`emulator manifest rejects ${bad.length} unsafe variants`, !accepted.length, accepted.map(x => x[0]).join(', '));
ok('PS2 manifest: ISO boot accepted, EBOOT rejected', validateManifest({ id: 'p2', type: 'emulator', platform: 'ps2', boot: 'g.iso', files: [{ path: 'g.iso', size: 1, chunks: ['a'.repeat(64)] }] }).emulator === 'pcsx2'
  && (() => { try { validateManifest({ id: 'p2', type: 'emulator', platform: 'ps2', boot: 'EBOOT.BIN', files: [{ path: 'EBOOT.BIN', size: 1, chunks: ['a'.repeat(64)] }] }); return false; } catch { return true; } })());

const sfo = makeSfo({ TITLE: 'Saffron Orbit', TITLE_ID: 'MSHR00001', CATEGORY: 'HG', PARENTAL_LEVEL: 1 });
const sfoP = parseSfo(sfo);
ok('PARAM.SFO parser (strings + integers)', sfoP.TITLE === 'Saffron Orbit' && sfoP.TITLE_ID === 'MSHR00001' && sfoP.PARENTAL_LEVEL === 1);
const eboot = Buffer.concat([Buffer.from([0x7f, 0x45, 0x4c, 0x46]), Buffer.alloc(60)]);
const ps2Iso = makeIso([{ name: 'SYSTEM.CNF', data: Buffer.from('BOOT2 = cdrom0:\\SLUS_000.00;1\r\nVER = 1.00\r\n') }], { system: 'PLAYSTATION' });
const ps1Iso = makeIso([{ name: 'SYSTEM.CNF', data: Buffer.from('BOOT = cdrom:\\SLUS_000.01;1\r\n') }], { system: 'PLAYSTATION' });
const ps3Iso = makeIso([{ name: 'PS3_DISC.SFB', data: Buffer.from('.SFB') }], { system: 'PS3VOLUME' });
const pspIso = makeIso([{ name: 'UMD_DATA.BIN', data: Buffer.from('ULUS-10000|0000000000000000|0001|G') }], { system: 'PSP GAME', volume: 'PSP_TEST', dirs: ['PSP_GAME'] });
const pbpOf = (cat, title) => { const p = makeSfo({ CATEGORY: cat, DISC_ID: 'MSHR00001', TITLE: title }); const h = Buffer.alloc(40); h.write('\0PBP', 0, 'latin1'); h.writeUInt32LE(0x10000, 4); h.writeUInt32LE(40, 8); for (let i = 1; i < 8; i++) h.writeUInt32LE(40 + p.length, 8 + i * 4); return Buffer.concat([h, p, eboot]); };
/** CSO (CISO v1, raw-deflate 2048-byte blocks) — the same container PSP dumps use. */
const toCso = img => { const S = 2048, n = Math.ceil(img.length / S), idx = Buffer.alloc((n + 1) * 4), parts = []; let pos = 24 + idx.length;
  for (let i = 0; i < n; i++) { const z = deflateRawSync(img.subarray(i * S, i * S + S)); idx.writeUInt32LE(pos, i * 4); parts.push(z); pos += z.length; }
  idx.writeUInt32LE(pos, n * 4); const h = Buffer.alloc(24); h.write('CISO', 0, 'latin1'); h.writeUInt32LE(24, 4); h.writeBigUInt64LE(BigInt(img.length), 8); h.writeUInt32LE(S, 16); h[20] = 1;
  return Buffer.concat([h, idx, ...parts]); };
const pspCso = toCso(pspIso), pspPbp = pbpOf('MG', 'Pbp Game'), ps1Pbp = pbpOf('ME', 'Classic');
ok('ISO 9660 reader finds SYSTEM.CNF', /BOOT2/.test(openIso({ size: ps2Iso.length, read: (o, l) => ps2Iso.subarray(o, o + l) }).text('SYSTEM.CNF')));
const insp = (files, parts) => { try { return inspectUpload(files, memStore(parts)); } catch (e) { return { error: e.message, status: e.status }; } };
ok('inspect: PS3 game folder → refused ("PS3 games are not supported"), never routed', (r => r.status === 422 && /PS3 games are not supported/.test(r.error))(insp([fileEntry('G/PS3_GAME/PARAM.SFO', sfo), fileEntry('G/PS3_GAME/USRDIR/EBOOT.BIN', eboot)], [sfo, eboot])));
ok('inspect: PSP UMD ISO (PSP_GAME + UMD_DATA.BIN) → psp with serial', (r => r.platform === 'psp' && r.serial === 'ULUS-10000' && r.format === 'iso')(insp([fileEntry('g.iso', pspIso)], chunksOf(pspIso))));
ok('inspect: PSP CSO → psp (blocks inflated on demand)', (r => r.platform === 'psp' && r.format === 'cso')(insp([fileEntry('g.cso', pspCso)], chunksOf(pspCso))));
ok('inspect: PSP homebrew folder (EBOOT.PBP) → psp; PSone PBP (CATEGORY ME) → PS1 local', (r => r.platform === 'psp' && r.boot === 'Hb/EBOOT.PBP' && r.title === 'Pbp Game')(insp([fileEntry('Hb/EBOOT.PBP', pspPbp), fileEntry('Hb/GAME.DAT', sfo)], [pspPbp, sfo]))
  && insp([fileEntry('x.pbp', ps1Pbp)], [ps1Pbp]).status === 422);
ok('inspect: PS2 DVD ISO (SYSTEM.CNF BOOT2) → ps2', (r => r.platform === 'ps2' && r.serial === 'SLUS_000.00')(insp([fileEntry('disc.iso', ps2Iso)], chunksOf(ps2Iso))));
ok('inspect: PS3 ISO (PS3_DISC.SFB) → refused, not routed', /PS3 games are not supported/.test(insp([fileEntry('disc.iso', ps3Iso)], chunksOf(ps3Iso)).error || ''));
ok('inspect: PS1 disc → told to play locally (422)', insp([fileEntry('disc.iso', ps1Iso)], chunksOf(ps1Iso)).status === 422);
ok('inspect: random bytes → unsupported (415)', insp([fileEntry('x.bin', Buffer.alloc(5000, 7))], [Buffer.alloc(5000, 7)]).status === 415);
const pkg = Buffer.concat([Buffer.from([0x7f, 0x50, 0x4b, 0x47]), Buffer.alloc(100)]);
ok('inspect: PKG → explained, not accepted', /PKG/.test(insp([fileEntry('x.pkg', pkg)], [pkg]).error || ''));
const exe = readFileSync(join(HERE, '../../cloud/test-games/pkg/gdi64/wintest64.exe'));
ok('inspect: Windows PE → windows x64', (r => r.platform === 'windows' && r.arch === 'x64')(insp([fileEntry('anything.bin', exe)], chunksOf(exe))));

// ------------------------------------------------------------------ live scheduler (auth optional)
const start = (port, env = {}) => {
  const dir = mkdtempSync(join(tmpdir(), 'mishrin-univ-'));
  for (const d of ['cas', 'games', 'data']) mkdirSync(join(dir, d));
  const p = spawn(process.execPath, [join(HERE, '../../server/broker.mjs')], {
    env: { ...process.env, PORT: String(port), WORKER_TOKEN: WT, ADMIN_TOKEN: AT, CAS_DIR: join(dir, 'cas'), GAMES_DIR: join(dir, 'games'), DATA_DIR: join(dir, 'data'),
      WORKER_TIMEOUT_MS: '3000', CLIENT_HEARTBEAT_TIMEOUT_MS: '8000', ANSWER_TIMEOUT_MS: '3000', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  p.logs = ''; p.stdout.on('data', d => (p.logs += d)); p.stderr.on('data', d => (p.logs += d));
  return { p, dir, base: `http://127.0.0.1:${port}` };
};
const A = start(18797), B = start(18798, { AUTH_REQUIRED: '1', CLIENT_KEYS: 'invite-key-1', AUTH_SECRET: 'x'.repeat(32) });
const tokens = new Map();
const req = async (base, method, path, body, headers = {}) => {
  const sid = path.match(/^\/api\/session\/([\w-]+)/)?.[1];
  const r = await fetch(base + path, { method, headers: { 'content-type': body instanceof Uint8Array ? 'application/octet-stream' : 'application/json', ...(sid && tokens.get(sid) ? { 'x-session-token': tokens.get(sid) } : {}), ...headers },
    body: body === undefined ? undefined : body instanceof Uint8Array ? body : JSON.stringify(body) });
  const t = await r.text(); let j; try { j = t ? JSON.parse(t) : null; } catch { j = t; }
  if (r.status === 201 && j?.token && j?.id) tokens.set(j.id, j.token);
  return { status: r.status, body: j };
};
for (const s of [A, B]) for (let i = 0; i < 50; i++) { try { await fetch(s.base + '/v1/config'); break; } catch { await sleep(100); } }

class MockWorker {
  constructor(name, runtimes, emulators, answer, ramMB = 32000) { Object.assign(this, { name, runtimes, emulators, ramMB, msgs: [], polling: true, answer: answer || (() => ({ sdp: `v=0 ${name}` })) }); }
  async start(base = A.base) {
    const h = { authorization: `Bearer ${WT}` };
    this.base = base;
    this.id = (await req(base, 'POST', '/worker/register', { name: this.name, runtimes: this.runtimes, capacity: 1, emulators: this.emulators, resources: { ramMB: this.ramMB, gpu: { available: true, hardware: false, device: 'llvmpipe' } }, encoders: ['vp8enc'] }, h)).body.id;
    this.hb = setInterval(() => req(base, 'POST', '/worker/heartbeat', { worker: this.id, load: 0, sessions: [], cache: { games: this.cache || [] } }, h), 600);
    (async () => {
      while (this.polling) {
        const r = await req(base, 'POST', '/worker/allocate', { worker: this.id }, h).catch(() => ({ status: 0 }));
        if (r.status !== 200) { await sleep(50); continue; }
        this.msgs.push(r.body);
        if (r.body.type === 'session') await req(base, 'POST', '/worker/answer', { worker: this.id, id: r.body.id, ...this.answer(r.body) }, h);
      }
    })();
    await sleep(100);
    return this;
  }
  stop() { this.polling = false; clearInterval(this.hb); }
}
const offer = 'v=0 offer';
const KEY = 'device-save-key-0123456789';
const uploadAll = async (base, files, parts, headers = {}, title = '') => {
  const d = await req(base, 'POST', '/api/uploads', { files, title }, headers);
  for (const part of parts) if (d.body?.missing?.includes(sha(part))) await req(base, 'PUT', `/api/uploads/${d.body.id}/chunks/${sha(part)}`, part, headers);
  return [d, await req(base, 'POST', `/api/uploads/${d.body?.id}/complete`, {}, headers)];
};
const workers = [];
try {
  // ---- capability report before any emulator worker exists
  let rep = await req(A.base, 'GET', '/api/runtimes');
  ok('runtime report: nothing deployed → empty (UI must not show PSP as available)', rep.status === 200 && !rep.body.runtimes.psp && !rep.body.runtimes['x64-win'] && rep.body.uploads.archives === true);

  // ---- uploads: declare → missing → chunks → resume → complete
  const big = Buffer.concat([ps2Iso, Buffer.alloc(CHUNK + 1000, 3)]);      // > 1 chunk, real ISO at the front
  const files = [fileEntry('My Game/disc.iso', big)];
  const parts = chunksOf(big);
  let d = await req(A.base, 'POST', '/api/uploads', { files, title: 'Disc Test' }, { 'x-save-key': KEY });
  ok('upload declared: every chunk reported missing', d.status === 200 && d.body.missing.length === 2 && d.body.chunkSize === CHUNK, JSON.stringify(d.body).slice(0, 120));
  ok('upload rejects a chunk that is not part of it', (await req(A.base, 'PUT', `/api/uploads/${d.body.id}/chunks/${sha(Buffer.from('zz'))}`, Buffer.from('zz'), { 'x-save-key': KEY })).status === 400);
  ok('upload rejects a corrupted chunk (hash verified)', (await req(A.base, 'PUT', `/api/uploads/${d.body.id}/chunks/${sha(parts[0])}`, Buffer.from(parts[1]), { 'x-save-key': KEY })).status === 400);
  await req(A.base, 'PUT', `/api/uploads/${d.body.id}/chunks/${sha(parts[0])}`, parts[0], { 'x-save-key': KEY });
  ok('incomplete upload cannot be completed', (await req(A.base, 'POST', `/api/uploads/${d.body.id}/complete`, {}, { 'x-save-key': KEY })).status === 409);
  const again = await req(A.base, 'POST', '/api/uploads', { files, title: 'Disc Test' }, { 'x-save-key': KEY });
  ok('resume: re-declaring returns the same id and only the remaining chunk', again.body.id === d.body.id && again.body.missing.length === 1 && again.body.missing[0] === sha(parts[1]));
  ok('another player cannot touch this upload', (await req(A.base, 'GET', `/api/uploads/${d.body.id}`, undefined, { 'x-save-key': 'someone-else-key-0123456' })).status === 404);
  await req(A.base, 'PUT', `/api/uploads/${d.body.id}/chunks/${sha(parts[1])}`, parts[1], { 'x-save-key': KEY });
  let c = await req(A.base, 'POST', `/api/uploads/${d.body.id}/complete`, {}, { 'x-save-key': KEY });
  ok('complete: server inspects the bytes → PS2-class, runtime ps2', c.status === 201 && c.body.platform === 'ps2' && c.body.runtime === 'ps2' && c.body.title === 'Disc Test', JSON.stringify(c.body));
  const ps2Upload = c.body.id;
  const other = await req(A.base, 'POST', '/api/uploads', { files }, { 'x-save-key': 'second-player-key-0123456' });
  ok('deduplication: same content from another player needs 0 chunks', other.body.missing.length === 0 && other.body.id !== d.body.id);
  ok('upload rejects traversal paths and wrong chunk counts', (await req(A.base, 'POST', '/api/uploads', { files: [{ path: '../etc/passwd', size: 1, chunks: [sha(Buffer.from('a'))] }] })).status === 400
    && (await req(A.base, 'POST', '/api/uploads', { files: [{ path: 'a.iso', size: CHUNK + 1, chunks: [sha(Buffer.from('a'))] }] })).status === 400);
  const [, ps1c] = await uploadAll(A.base, [fileEntry('p1.iso', ps1Iso)], chunksOf(ps1Iso), { 'x-save-key': KEY });
  ok('PS1-class upload refused with a pointer to local play', ps1c.status === 422 && /locally/.test(ps1c.body.error));
  const [, junk] = await uploadAll(A.base, [fileEntry('x.dat', Buffer.alloc(3000, 9))], [Buffer.alloc(3000, 9)], { 'x-save-key': KEY });
  ok('unknown content refused (415)', junk.status === 415);
  const sfoBuf = sfo, folder = [fileEntry('Orbit/EBOOT.PBP', pspPbp), fileEntry('Orbit/GAME.DAT', sfoBuf)];
  const [, pp] = await uploadAll(A.base, folder, [pspPbp, sfoBuf], { 'x-save-key': KEY });
  ok('PSP game folder upload → psp (title from the PBP\'s PARAM.SFO)', pp.status === 201 && pp.body.platform === 'psp' && pp.body.title === 'Pbp Game' && pp.body.serial === 'MSHR00001', JSON.stringify(pp.body));
  const [, ps3u] = await uploadAll(A.base, [fileEntry('G/PS3_GAME/PARAM.SFO', sfoBuf), fileEntry('G/PS3_GAME/USRDIR/EBOOT.BIN', eboot)], [sfoBuf, eboot], { 'x-save-key': KEY });
  ok('PS3 game folder upload → refused (PS3 removed)', ps3u.status === 422 && /PS3 games are not supported/.test(ps3u.body.error));

  // ---- no PSP worker deployed → honest 503 without a queue
  let s = await req(A.base, 'POST', '/api/session', { game: { runtime: 'psp', upload: pp.body.id }, offer, client: { saveKey: KEY } });
  ok('PSP session with no PSP worker → 503 "not deployed" (no fake queue)', s.status === 503 && s.body.deployed === false && !s.body.queue && /deployed/.test(s.body.error), JSON.stringify(s.body));
  ok('PS3 runtime requests refused', (await req(A.base, 'POST', '/api/session', { game: { runtime: 'ps3', upload: pp.body.id }, offer, client: { saveKey: KEY } })).status >= 400);

  // ---- mock PSP workers: protocol, runtime failure, setup error, ownership
  const crash = new MockWorker('psp-crashy', ['psp'], [{ name: 'ppsspp', runtime: 'psp', version: 'mock', firmware: true, mock: true }], () => ({ error: 'emulator exited during startup (code 139)' }));
  const good = new MockWorker('psp-good', ['psp'], [{ name: 'ppsspp', runtime: 'psp', version: 'mock', firmware: true, mock: true }]);
  crash.cache = [pp.body.manifestHash];   // cache affinity makes the crashing worker the first choice
  workers.push(await crash.start(), await good.start());
  await sleep(700);
  rep = await req(A.base, 'GET', '/api/runtimes');
  const rp = rep.body.runtimes.psp;
  ok('runtime report: PSP from live workers, flagged mock', rp && rp.workers === 2 && rp.capacity === 2 && rp.free === 2 && rp.mock === true && rp.emulators.every(e => e.name === 'ppsspp' && e.mock), JSON.stringify(rp));
  ok('wrong-platform request refused (PS2 upload on PSP runtime)', (await req(A.base, 'POST', '/api/session', { game: { runtime: 'psp', upload: ps2Upload }, offer, client: { saveKey: KEY } })).status === 400);
  ok("another player's upload cannot be played", (await req(A.base, 'POST', '/api/session', { game: { runtime: 'psp', upload: pp.body.id }, offer, client: { saveKey: 'intruder-key-0123456789' } })).status === 404);
  s = await req(A.base, 'POST', '/api/session', { game: { runtime: 'psp', upload: pp.body.id, executable: '/bin/sh' }, offer, client: { saveKey: KEY } });
  const tried = [...crash.msgs, ...good.msgs].filter(m => m.type === 'session' && m.id === s.body.id);
  const gm = good.msgs.find(m => m.type === 'session' && m.id === s.body.id);
  ok('runtime failure on one worker → retried on another', s.status === 201 && s.body.worker === 'psp-good' && tried.length === 2 && crash.msgs.some(m => m.id === s.body.id), `${s.status} ${JSON.stringify(s.body).slice(0, 100)}`);
  ok('PSP worker gets a validated emulator manifest (boot from the upload, no client fields)', gm && gm.manifest.type === 'emulator' && gm.manifest.emulator === 'ppsspp' && gm.manifest.boot === 'Orbit/EBOOT.PBP' && !JSON.stringify(gm).includes('/bin/sh'));
  ok('session token issued for the PSP session', typeof s.body.token === 'string' && s.body.token.length >= 40);
  rep = await req(A.base, 'GET', '/api/runtimes');
  ok('runtime report tracks active sessions', rep.body.runtimes.psp.active === 1);
  const fw = new MockWorker('psp-broken', ['psp'], [{ name: 'ppsspp', runtime: 'psp', firmware: true, mock: true }], () => ({ error: 'ppsspp is not installed on this worker' }));
  // make the broken worker the only free one: stop psp-crashy, keep psp-good busy
  crash.stop(); await sleep(3600);
  workers.push(await fw.start());
  const s2 = await req(A.base, 'POST', '/api/session', { game: { runtime: 'psp', upload: pp.body.id }, offer, client: { saveKey: KEY }, queue: false });
  ok('worker setup error (emulator missing) → clear 502, not retried blindly', s2.status === 502 && /not installed/i.test(s2.body.error), JSON.stringify(s2.body));
  await req(A.base, 'DELETE', `/api/session/${s.body.id}`);
  ok('session destruction frees the slot', (await req(A.base, 'GET', '/api/runtimes')).body.runtimes.psp.active === 0);

  // ---- PS2 via the same protocol
  const p2w = new MockWorker('ps2-mock', ['ps2'], [{ name: 'pcsx2', runtime: 'ps2', firmware: true, mock: true }]);
  workers.push(await p2w.start());
  s = await req(A.base, 'POST', '/api/session', { game: { runtime: 'ps2', upload: ps2Upload }, offer, client: { saveKey: KEY } });
  const pm = p2w.msgs.find(m => m.type === 'session');
  ok('PS2 session → pcsx2 manifest with the ISO as boot', s.status === 201 && pm?.manifest.emulator === 'pcsx2' && pm.manifest.boot === 'My Game/disc.iso');
  await req(A.base, 'DELETE', `/api/session/${s.body.id}`);
  p2w.stop(); await sleep(3600);
  const tiny = new MockWorker('ps2-tiny', ['ps2'], [{ name: 'pcsx2', runtime: 'ps2', firmware: true, mock: true }], undefined, 3000);
  workers.push(await tiny.start());
  s = await req(A.base, 'POST', '/api/session', { game: { runtime: 'ps2', upload: ps2Upload }, offer, client: { saveKey: KEY } });
  ok('title too large for every deployed worker → immediate 503 (no endless queue)', s.status === 503 && s.body.fits === false && !s.body.queue && /4096 MB/.test(s.body.error), JSON.stringify(s.body));

  // ---- archives (ZIP / RAR4 / RAR5, nested): one uploaded file, extracted by the cloud, routed by the extracted contents
  const arcDir = mkdtempSync(join(tmpdir(), 'mishrin-arc-'));
  spawnSync('python3', [join(HERE, 'make_archives.py'), arcDir]);
  const upArc = async (name, key = KEY) => { const b = readFileSync(join(arcDir, name)); return (await uploadAll(A.base, [fileEntry(name, b)], chunksOf(b), { 'x-save-key': key }))[1]; };
  let a = await upArc('psp-folder.zip');
  ok('ZIP → PSP homebrew folder found inside → psp (not forced to Windows)', a.status === 201 && a.body.platform === 'psp' && a.body.boot === 'Archive Test/EBOOT.PBP', JSON.stringify(a.body));
  a = await upArc('ps2.rar');
  ok('RAR 5 → PS2 disc image inside → ps2', a.status === 201 && a.body.platform === 'ps2' && a.body.boot === 'Game/disc.iso', JSON.stringify(a.body));
  const ps1a = await upArc('ps1.rar');
  ok('RAR 4 → PS1 disc inside → ps1, returned to the browser for local play', ps1a.status === 201 && ps1a.body.platform === 'ps1' && ps1a.body.files?.[0]?.path === 'disc/game.iso', JSON.stringify(ps1a.body));
  const back = await fetch(`${A.base}/api/uploads/${ps1a.body.id}/files/0`, { headers: { 'x-save-key': KEY } });
  const backBuf = Buffer.from(await back.arrayBuffer());
  ok('extracted PS1 file downloads intact for its owner only', back.status === 200 && backBuf.length === 65536 && backBuf.subarray(16 * 2048 + 1, 16 * 2048 + 6).toString() === 'CD001'
    && (await fetch(`${A.base}/api/uploads/${ps1a.body.id}/files/0`, { headers: { 'x-save-key': 'intruder-key-0123456789' } })).status === 404);
  a = await upArc('nested.zip');
  ok('nested archive (zip in zip) → PSP UMD image inside → psp', a.status === 201 && a.body.platform === 'psp' && /umd\/game\.iso$/.test(a.body.boot), JSON.stringify(a.body));
  a = await upArc('windows.zip');
  ok('ZIP → Windows game folder → windows (shallowest PE as executable)', a.status === 201 && a.body.platform === 'windows' && a.body.boot === 'MyGame/bin/game.exe', JSON.stringify(a.body));
  a = await upArc('traversal.zip');
  ok('malicious path traversal inside an archive → refused before extraction', a.status === 422 && /Unsafe path/.test(a.body.error), JSON.stringify(a.body));
  a = await upArc('symlink.zip');
  ok('symlink inside an archive → refused', a.status === 422 && /Links are not allowed/.test(a.body.error), JSON.stringify(a.body));
  a = await upArc('bomb.zip');
  ok('zip bomb (300 MB of zeros) → refused by the ratio guard, nothing extracted', a.status === 422 && /ratio/.test(a.body.error), JSON.stringify(a.body));
  a = await upArc('ps3.zip');
  ok('ZIP with a PS3 game → refused (PS3 removed)', a.status === 422 && /PS3 games are not supported/.test(a.body.error), JSON.stringify(a.body));
  const t0 = Date.now(); a = await upArc('ps2.rar', 'second-player-key-0123456');
  ok('same archive from another player: deduplicated chunks + cached extraction', a.status === 201 && a.body.platform === 'ps2' && /from rar/.test(A.p.logs) && Date.now() - t0 < 3000);

  // ---- packages are private: only workers read chunks
  ok('chunks are not publicly downloadable', (await req(A.base, 'GET', `/v1/packages/${sha(sfoBuf)}`)).status === 401
    && (await fetch(`${A.base}/v1/packages/${sha(sfoBuf)}`, { headers: { authorization: `Bearer ${WT}` } })).status === 200);

  // ---- cloud saves API (SaveManager cloud provider)
  const layer = gzipSync(Buffer.from('save-layer'));
  let sv = await req(A.base, 'POST', '/api/saves/my-game/import', new Uint8Array(layer), { 'x-save-key': KEY });
  ok('save import: gzip/zstd layer stored under the player', sv.status === 201 && sv.body.ref === sha(layer));
  ok('save import rejects non-save data', (await req(A.base, 'POST', '/api/saves/my-game/import', new Uint8Array(Buffer.from('#!/bin/sh')), { 'x-save-key': KEY })).status === 415);
  let list = await req(A.base, 'GET', '/api/saves', undefined, { 'x-save-key': KEY });
  ok('save list per player', list.status === 200 && list.body.some(x => x.game === 'my-game' && x.latest.ref === sha(layer)));
  ok('save export returns the exact layer', Buffer.from(await (await fetch(`${A.base}/api/saves/my-game/data`, { headers: { 'x-save-key': KEY } })).arrayBuffer()).equals(layer));
  ok("other players can't see or read it", !(await req(A.base, 'GET', '/api/saves', undefined, { 'x-save-key': 'intruder-key-0123456789' })).body.length
    && (await fetch(`${A.base}/api/saves/my-game/data`, { headers: { 'x-save-key': 'intruder-key-0123456789' } })).status === 404);
  await req(A.base, 'DELETE', '/api/saves/my-game', undefined, { 'x-save-key': KEY });
  ok('save delete', !(await req(A.base, 'GET', '/api/saves', undefined, { 'x-save-key': KEY })).body.some(x => x.game === 'my-game'));

  // ---- authentication required mode (second scheduler)
  ok('auth: device token needs a client key', (await req(B.base, 'POST', '/api/auth/device', {})).status === 401
    && (await req(B.base, 'POST', '/api/auth/device', {}, { authorization: 'Bearer wrong' })).status === 401);
  const dt = await req(B.base, 'POST', '/api/auth/device', {}, { authorization: 'Bearer invite-key-1' });
  ok('auth: device token issued with a client key', dt.status === 201 && dt.body.token.startsWith('d1.'));
  ok('auth: sessions/uploads/saves refused without a device token (legacy saveKey not enough)', (await req(B.base, 'POST', '/api/session', { game: { runtime: 'psp', upload: 'x' }, offer, client: { saveKey: KEY } })).status === 401
    && (await req(B.base, 'POST', '/api/uploads', { files }, { 'x-save-key': KEY })).status === 401 && (await req(B.base, 'GET', '/api/saves', undefined, { 'x-save-key': KEY })).status === 401);
  const forged = dt.body.token.replace(/.$/, c => (c === 'A' ? 'B' : 'A'));
  ok('auth: tampered device token refused', (await req(B.base, 'GET', '/api/saves', undefined, { 'x-device-token': forged })).status === 401);
  const dh = { 'x-device-token': dt.body.token };
  const [, bu] = await uploadAll(B.base, folder, [pspPbp, sfoBuf], dh);
  ok('auth: authenticated upload + saves work', bu.status === 201 && (await req(B.base, 'GET', '/api/saves', undefined, dh)).status === 200);
  const bw = new MockWorker('psp-b', ['psp'], [{ name: 'ppsspp', runtime: 'psp', firmware: true, mock: true }]);
  workers.push(await bw.start(B.base));
  s = await req(B.base, 'POST', '/api/session', { game: { runtime: 'psp', upload: bu.body.id }, offer }, dh);
  ok('auth: authenticated player starts a session; saves keyed to the device', s.status === 201);
} catch (e) {
  ok('universal test harness', false, e.stack);
} finally {
  for (const w of workers) w.stop();
  A.p.kill(); B.p.kill();
}
if (fails) console.log(A.p.logs.split('\n').slice(-30).join('\n'));
console.log(`\n${n - fails}/${n} universal runtime checks passed`);
process.exit(fails ? 1 : 0);
