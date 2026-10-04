// Scheduler tests with scripted fake workers (no Wine needed). Run: node tests/cloud/scheduler.test.mjs
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { validateManifest, manifestHash } from '../../server/lib/manifest.mjs';
import { selectWorker } from '../../server/lib/select.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const PORT = 18787, URL_ = `http://127.0.0.1:${PORT}`, WT = 'worker-token-test', AT = 'admin-token-test';
let n = 0, fails = 0;
const ok = (name, c, d = '') => { n++; if (!c) fails++; console.log(`${c ? 'PASS' : 'FAIL'} ${name}${d ? ' — ' + d : ''}`); };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const sha = b => createHash('sha256').update(b).digest('hex');

// ---------------------------------------------------------------- pure: manifest validation + selection
const cases = JSON.parse(readFileSync(join(HERE, 'manifest-cases.json'), 'utf8'));
let mismatch = [];
for (const c of cases) { let valid = true; try { validateManifest(c.manifest); } catch { valid = false; } if (valid !== c.valid) mismatch.push(c.name); }
ok(`manifest validation: ${cases.length} cases (accept good, reject unsafe)`, !mismatch.length, mismatch.join('; '));
const vm = validateManifest(cases[0].manifest);
ok('manifest normalisation: workingDirectory, defaults, controller map', vm.workingDirectory === 'bin' && vm.requirements.maxMinutes === 240 && vm.controllerMap.a === 'Return' && vm.args.length === 0);
ok('manifest hash ignores title/limits, tracks files', manifestHash(vm) === manifestHash({ ...vm, title: 'X', requirements: {} }) && manifestHash(vm) !== manifestHash({ ...vm, files: [{ ...vm.files[0], size: 11 }, vm.files[1]] }));

const mk = (id, o = {}) => ({ id, kind: 'worker', lastBeat: Date.now(), runtimes: new Set(['x64-win']), capacity: 2, active: new Set(), load: 0, caps: { resources: { ramMB: 32000, gpu: { available: true, hardware: false } }, cache: { games: [] }, hardwareEncoders: [] }, ...o });
const H = 'c'.repeat(64);
ok('selection: cache affinity wins', selectWorker([mk('a'), mk('b', { caps: { ...mk('b').caps, cache: { games: [H] } } })], { runtime: 'x64-win', manifestHash: H })?.id === 'b');
ok('selection: hardware GPU preferred for GPU titles', selectWorker([mk('a'), mk('b', { caps: { ...mk('b').caps, resources: { ramMB: 32000, gpu: { available: true, hardware: true } } } })], { runtime: 'x64-win', gpu: true })?.id === 'b');
ok('selection: full / dead / low-RAM / no-Vulkan / excluded workers skipped', selectWorker([
  mk('full', { capacity: 1, active: new Set(['x']) }), mk('dead', { lastBeat: 0 }), mk('lowram', { caps: { resources: { ramMB: 2000, gpu: { available: true } } } }),
  mk('novk', { caps: { resources: { ramMB: 32000, gpu: { available: false } } } }), mk('excluded')], { runtime: 'x64-win', ramMB: 4096, gpu: true, exclude: new Set(['excluded']) }) === null);
const fl = (rt, flags) => mk(`${rt}-${JSON.stringify(flags)}`, { runtimes: new Set([rt]), caps: { ...mk('x').caps, flags } });
ok('selection: PSP only on a worker with a detected PPSSPP; PS2 needs PCSX2 (real detection flags)',
  selectWorker([fl('psp', { cpu: true, ppsspp: false, vulkan: true })], { runtime: 'psp' }) === null
  && selectWorker([fl('psp', { ppsspp: false, vulkan: true }), fl('psp', { ppsspp: true, opengl: true })], { runtime: 'psp' })?.caps.flags.ppsspp === true
  && selectWorker([fl('ps2', { pcsx2: false })], { runtime: 'ps2' }) === null && selectWorker([fl('ps2', { pcsx2: false, mockRuntimes: ['ps2'] })], { runtime: 'ps2' }) !== null);
ok('selection: least loaded among equals', selectWorker([mk('busy', { load: 0.9 }), mk('idle', { load: 0.1 })], { runtime: 'x64-win' })?.id === 'idle');

// ---------------------------------------------------------------- live scheduler
const dir = mkdtempSync(join(tmpdir(), 'mishrin-sched-'));
for (const d of ['cas', 'games', 'data']) mkdirSync(join(dir, d));
const sched = spawn(process.execPath, [join(HERE, '../../server/broker.mjs')], {
  env: { ...process.env, PORT: String(PORT), WORKER_TOKEN: WT, ADMIN_TOKEN: AT, CAS_DIR: join(dir, 'cas'), GAMES_DIR: join(dir, 'games'), DATA_DIR: join(dir, 'data'),
    WORKER_TIMEOUT_MS: '3000', CLIENT_HEARTBEAT_TIMEOUT_MS: '5000', ORPHAN_GRACE_MS: '6000', ANSWER_TIMEOUT_MS: '4000' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let schedLog = ''; sched.stdout.on('data', d => (schedLog += d)); sched.stderr.on('data', d => (schedLog += d));
const sessionTokens = new Map();   // the console keeps the token it got at creation; the helper does the same
const req = async (method, path, body, token, extra = {}, base = URL_) => {
  const sid = path.match(/^\/(?:api\/session|v1\/sessions)\/([\w-]+)/)?.[1];
  const st = sid && sessionTokens.get(sid);
  const r = await fetch(base + path, { method, headers: { 'content-type': body instanceof Uint8Array ? 'application/octet-stream' : 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...(st && !extra.noSessionToken ? { 'x-session-token': st } : {}), ...(extra.headers || {}) }, body: body === undefined ? undefined : body instanceof Uint8Array ? body : JSON.stringify(body) });
  const t = await r.text(); let j; try { j = t ? JSON.parse(t) : null; } catch { j = t; }
  if (r.status === 201 && j?.id && j?.token) sessionTokens.set(j.id, j.token);
  return { status: r.status, body: j };
};
for (let i = 0; i < 50; i++) { try { await fetch(URL_ + '/v1/config'); break; } catch { await sleep(100); } }

class FakeWorker {
  constructor(name, caps = {}) { this.name = name; this.caps = caps; this.msgs = []; this.sessions = new Map(); this.beating = true; this.polling = true; this.answer = m => ({ sdp: `v=0 answer-from-${name}` }); }
  async start() {
    const r = await req('POST', '/worker/register', { name: this.name, runtimes: ['x64-win', 'x86'], capacity: 2, resources: { ramMB: 16000, cpus: 8, gpu: { available: true, hardware: false, device: 'llvmpipe' } }, encoders: ['x264enc'], hardwareEncoders: [], cache: { games: [] }, ...this.caps }, WT);
    this.id = r.body.id;
    this.hb = setInterval(() => this.beating && req('POST', '/worker/heartbeat', { worker: this.id, load: 0.1, sessions: [...this.sessions.values()], cache: { games: this.cache || [] } }, WT).then(r => (this.lastHb = r)), 700);
    (async () => {
      while (this.polling) {
        const r = await req('POST', '/worker/allocate', { worker: this.id }, WT).catch(() => ({ status: 0 }));
        if (r.status !== 200) { if (r.status !== 204) await sleep(200); continue; }
        const m = r.body; this.msgs.push(m);
        if (m.type === 'session' || m.type === 'reconnect') {
          const a = await this.answer(m);
          if (a) { if (!a.error) this.sessions.set(m.id, { id: m.id, state: 'streaming', restarts: 0, windows: ['MISHRIN-TEST fake'] }); await req('POST', '/worker/answer', { worker: this.id, id: m.id, ...a }, WT); }
        }
        if (m.type === 'end') this.sessions.delete(m.id);
        if (m.type === 'save') await req('POST', '/worker/save-result', { worker: this.id, req: m.req, ok: true, ref: this.lastSaveRef, size: 3 }, WT);
      }
    })();
    return this;
  }
  stop() { this.polling = false; this.beating = false; clearInterval(this.hb); }
}
const offer = 'v=0 fake-offer';
const saveKey = 'player-key-0123456789abcdef';
try {
  // registration + auth
  ok('worker registration requires token', (await req('POST', '/worker/register', { name: 'x' })).status === 401);
  ok('legacy node API requires token when configured', (await req('POST', '/v1/hosts/register', { runtimes: ['wasm'] })).status === 401
    && (await req('POST', `/v1/hosts/register?token=${WT}`, { runtimes: ['wasm'] })).status === 201);
  const A = await new FakeWorker('A').start();
  const workers = (await req('GET', '/admin/workers', undefined, AT)).body;
  ok('worker registration records capabilities', workers.some(w => w.name === 'A' && w.alive && w.encoders[0] === 'x264enc' && w.gpu.device === 'llvmpipe'));
  ok('admin endpoints require admin token', (await req('GET', '/admin/workers')).status === 401);

  // game publishing
  const exe = new Uint8Array(Buffer.concat([Buffer.from('MZ'), Buffer.alloc(0x3a), Buffer.from([0x40, 0, 0, 0]), Buffer.from('PE\0\0'), Buffer.from([0x64, 0x86]), Buffer.alloc(64)]));
  const exeSha = sha(exe);
  const manifest = { id: 'fake-game', title: 'Fake', type: 'windows', runtime: 'wine', executable: 'Game.exe', network: false, requirements: { ram: 2048, gpu: true }, files: [{ path: 'Game.exe', size: exe.length, chunks: [exeSha] }] };
  ok('publishing rejects missing chunks', (await req('POST', '/admin/games', manifest, AT)).status === 409);
  ok('chunk upload is content-verified', (await req('PUT', `/v1/packages/${'0'.repeat(64)}`, exe)).status === 400 && (await req('PUT', `/v1/packages/${exeSha}`, exe)).status === 201
    && (await req('PUT', `/v1/packages/${exeSha}`, exe)).body.dedup === true);
  ok('publishing rejects unsafe manifests', (await req('POST', '/admin/games', { ...manifest, executable: '../cmd.exe' }, AT)).status === 400);
  ok('publishing a valid game', (await req('POST', '/admin/games', manifest, AT)).status === 201);

  // allocation: the client names a game; any command-like fields it sends are ignored
  let r = await req('POST', '/api/session', { game: { id: 'fake-game', runtime: 'x64-win', catalogId: 'fake-game', executable: 'cmd.exe', args: ['/c', 'calc'] }, offer, prefs: { height: 720 }, client: { saveKey } });
  const sid = r.body.id;
  const sm = A.msgs.find(m => m.type === 'session' && m.id === sid);
  ok('session allocation: answer relayed from worker', r.status === 201 && r.body.answer === 'v=0 answer-from-A', JSON.stringify(r.body).slice(0, 80));
  ok('worker receives validated manifest only (client fields ignored)', sm && sm.manifest.executable === 'Game.exe' && sm.manifest.args.length === 0 && !JSON.stringify(sm).includes('calc') && sm.manifestHash.length === 64);
  ok('unknown game → 404', (await req('POST', '/api/session', { game: { runtime: 'x64-win', catalogId: 'nope' }, offer })).status === 404);
  const junk = new Uint8Array(Buffer.from('#!/bin/sh\nrm -rf /\n')); await req('PUT', `/v1/packages/${sha(junk)}`, junk);
  ok('uploaded non-PE file rejected', (await req('POST', '/api/session', { game: { runtime: 'x64-win', cas: sha(junk) }, offer })).status === 400);
  r = await req('POST', '/api/session', { game: { runtime: 'x64-win', cas: exeSha, title: 'Mine' }, offer });
  const up = A.msgs.find(m => m.id === r.body.id);
  ok('uploaded PE → fixed one-file manifest (executable chosen by the cloud)', r.status === 201 && up.manifest.executable === 'game.exe' && up.manifest.id.startsWith('upload-') && up.manifest.arch === 'x64');
  await req('DELETE', `/api/session/${r.body.id}`);
  {
    const s2 = await req('POST', '/api/session', { game: { runtime: 'x64-win', catalogId: 'fake-game' }, offer });
    const s3 = await req('POST', '/api/session', { game: { runtime: 'x64-win', catalogId: 'fake-game' }, offer });
    ok('worker at capacity → 503 with a queue ticket (position 1)', s2.status === 201 && s3.status === 503 && s3.body.queue?.position === 1 && s3.body.queue.token, JSON.stringify(s3.body));
    const q = s3.body.queue;
    const s4 = await req('POST', '/api/session', { game: { runtime: 'x64-win', catalogId: 'fake-game' }, offer });
    ok('queue is FIFO: a later player queues behind (position 2)', s4.status === 503 && s4.body.queue?.position === 2);
    ok('queue ticket needs its token', (await req('GET', `/api/queue/${q.ticket}`)).status === 404);
    const early = await req('POST', '/api/session', { game: { runtime: 'x64-win', catalogId: 'fake-game' }, offer, ticket: q.ticket, ticketToken: q.token });
    ok('claiming before your turn → 409', early.status === 409);
    await req('DELETE', `/api/session/${s2.body.id}`);
    await sleep(300);
    const t1 = await req('GET', `/api/queue/${q.ticket}?token=${q.token}`);
    const t2 = await req('GET', `/api/queue/${s4.body.queue.ticket}?token=${s4.body.queue.token}`);
    ok('freed slot is held for the head of the queue', t1.body?.state === 'ready' && t1.body.position === 0 && t2.body?.state === 'waiting' && t2.body.position === 1, `${JSON.stringify(t1.body)} ${JSON.stringify(t2.body)}`);
    const jump = await req('POST', '/api/session', { game: { runtime: 'x64-win', catalogId: 'fake-game' }, offer, queue: false });
    ok('held slot cannot be taken by someone else', jump.status === 503 && !jump.body.queue);
    const claim = await req('POST', '/api/session', { game: { runtime: 'x64-win', catalogId: 'fake-game' }, offer, ticket: q.ticket, ticketToken: q.token });
    ok('ready ticket claims its reserved slot', claim.status === 201 && claim.body.worker === 'A', JSON.stringify(claim.body).slice(0, 120));
    await req('DELETE', `/api/queue/${s4.body.queue.ticket}?token=${s4.body.queue.token}`);
    await req('DELETE', `/api/session/${claim.body.id}`);
    // session tokens: control endpoints need the token returned at creation
    ok('session control requires the session token', (await req('GET', `/api/session/${sid}/status`, undefined, undefined, { noSessionToken: true })).status === 403
      && (await req('POST', `/api/session/${sid}/input`, { events: [] }, undefined, { noSessionToken: true, headers: { 'x-session-token': 'forged' } })).status === 403
      && (await req('DELETE', `/api/session/${sid}`, undefined, undefined, { noSessionToken: true })).status === 403
      && (await req('GET', `/api/session/${sid}`, undefined, AT, { noSessionToken: true })).status === 200);
  }

  // status / input / save
  await sleep(900);
  let st = await req('GET', `/api/session/${sid}/status`);
  ok('status includes live worker state', st.status === 200 && st.body.worker === 'A' && st.body.live?.windows?.[0] === 'MISHRIN-TEST fake');
  ok('session info', (await req('GET', `/api/session/${sid}`)).body.game.id === 'fake-game');
  r = await req('POST', `/api/session/${sid}/input`, { events: ['k1ArrowRight', [3, 4, 1], 'x'.repeat(10)] });
  await sleep(300);
  ok('HTTP input relayed to the worker', r.status === 202 && A.msgs.some(m => m.type === 'input' && m.id === sid && m.events.length === 3));
  const blob = new Uint8Array(Buffer.from('save-layer-v1')); const ref = sha(blob);
  await req('PUT', `/v1/packages/${ref}`, blob);
  r = await req('POST', '/worker/save', { worker: A.id, sessionId: sid, ref, size: blob.length, raw: 100, files: 1, kind: 'manual' }, WT);
  ok('worker save recorded for player+game', r.status === 200 && r.body.ref === ref);
  A.lastSaveRef = ref;
  r = await req('POST', `/api/session/${sid}/save`);
  ok('POST /api/session/:id/save relays to worker', r.status === 200 && r.body.ref === ref);
  ok('save readable by owning worker', (await fetch(`${URL_}/worker/saves/${ref}?session=${sid}&worker=${A.id}`, { headers: { authorization: `Bearer ${WT}` } }).then(x => x.text())) === 'save-layer-v1');
  ok('save not readable for a foreign blob', (await fetch(`${URL_}/worker/saves/${exeSha}?session=${sid}&worker=${A.id}`, { headers: { authorization: `Bearer ${WT}` } })).status === 404);

  // worker failure → orphan → reconnect reassigns to a healthy worker, restoring the latest save
  const B = await new FakeWorker('B').start();
  ok('cross-worker save access denied', (await fetch(`${URL_}/worker/saves/${ref}?session=${sid}&worker=${B.id}`, { headers: { authorization: `Bearer ${WT}` } })).status === 403);
  A.stop();
  await sleep(4000);
  st = await req('GET', `/api/session/${sid}`);
  ok('missed heartbeats → worker marked dead, session orphaned', st.body.state === 'orphaned' && st.body.worker === null, st.body.state);
  r = await req('POST', `/api/session/${sid}/reconnect`, { offer });
  const bm = B.msgs.find(m => m.type === 'session' && m.id === sid);
  ok('reconnect reassigns to another worker with the latest save', r.status === 200 && r.body.reassigned === true && r.body.worker === 'B' && bm?.restore === ref);
  r = await req('POST', `/api/session/${sid}/reconnect`, { offer });
  ok('reconnect on a healthy worker keeps the session in place', r.status === 200 && r.body.reassigned === false && B.msgs.some(m => m.type === 'reconnect'));

  // start failure on one worker → automatic retry on another
  const C = await new FakeWorker('C').start(); C.answer = () => ({ error: 'wine failed to start' });
  r = await req('POST', '/api/session', { game: { runtime: 'x64-win', catalogId: 'fake-game' }, offer });
  ok('failed start retried on another worker', r.status === 201 && r.body.worker === 'B' && C.msgs.some(m => m.type === 'session' && m.id === r.body.id), `tried C first: ${C.msgs.some(m => m.id === r.body.id)}`);
  await req('DELETE', `/api/session/${r.body.id}`);
  C.stop();

  // heartbeat reports a session the scheduler doesn't know → worker told to clean up
  B.sessions.set('ghost-session', { id: 'ghost-session', state: 'streaming' });
  await sleep(1500);
  ok('heartbeat flags unknown sessions for cleanup', B.lastHb?.body?.unknown?.includes('ghost-session'));
  B.sessions.delete('ghost-session');

  // timeout cleanup: the player vanishes (no heartbeats) → session ended, worker told
  r = await req('POST', '/api/session', { game: { runtime: 'x64-win', catalogId: 'fake-game' }, offer });
  const idle = r.body.id;
  await sleep(7500);
  ok('client heartbeat timeout ends the session and frees the worker', (await req('GET', `/api/session/${idle}`)).status === 404 && B.msgs.some(m => m.type === 'end' && m.id === idle));

  // orphan never reclaimed → ended
  r = await req('POST', '/api/session', { game: { runtime: 'x64-win', catalogId: 'fake-game' }, offer });
  const orphan = r.body.id;
  const keep = setInterval(() => req('POST', `/v1/sessions/${orphan}/heartbeat`), 1000);
  B.stop();
  await sleep(10500);
  clearInterval(keep);
  ok('orphaned session ended after grace period', (await req('GET', `/api/session/${orphan}`)).status === 404);
  ok('save index persisted to disk', JSON.parse(readFileSync(join(dir, 'data', 'saves.json'), 'utf8'))[`${saveKey}|fake-game`]?.latest?.ref === ref);
} catch (e) {
  ok('scheduler test harness', false, e.stack);
} finally {
  sched.kill();
}
if (fails) console.log(schedLog.split('\n').slice(-25).join('\n'));
console.log(`\n${n - fails}/${n} scheduler checks passed`);
process.exit(fails ? 1 : 0);
