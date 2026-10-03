// Mishrin Cloud scheduler (formerly the reference broker) — zero dependencies (Node 18+).
// Matches console sessions to isolated workers, relays WebRTC signaling (media never passes through here),
// stores content-addressed packages/chunks and save layers, and recovers from worker failure.
//
//   node server/broker.mjs
//   PORT=8787  ICE_SERVERS='[{"urls":"stun:stun.l.google.com:19302"}]'  WORKER_TOKEN=…  ADMIN_TOKEN=…  DATA_DIR=server/.data
//
// Protocol: server/PROTOCOL.md. v1 routes are unchanged; /api/* and /worker/* extend them for Windows workers.
import http from 'node:http';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdirSync, existsSync, readFileSync, writeFileSync, statSync, createReadStream, readdirSync, openSync, readSync, closeSync, renameSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateManifest, manifestHash, peInfo, uploadManifest, ManifestError } from './lib/manifest.mjs';
import { selectWorker, alive, WORKER_TIMEOUT } from './lib/select.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const PORT = +(process.env.PORT || 8787);
const ICE = JSON.parse(process.env.ICE_SERVERS || '[]');
const DATA = process.env.DATA_DIR || join(HERE, '.data');
const CAS_DIR = process.env.CAS_DIR || join(HERE, '.cas');
const GAMES_DIR = process.env.GAMES_DIR || join(HERE, 'games');
const MAX_PKG = +(process.env.MAX_PACKAGE_MB || 1024) * 1048576;
const WORKER_TOKEN = process.env.WORKER_TOKEN || '';
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';
const HB_TIMEOUT = +(process.env.CLIENT_HEARTBEAT_TIMEOUT_MS || 45_000);
const ORPHAN_GRACE = +(process.env.ORPHAN_GRACE_MS || 60_000);
const ANSWER_TIMEOUT = +(process.env.ANSWER_TIMEOUT_MS || 150_000);
const WINDOWS = new Set(['x64-win', 'x86']);
for (const d of [DATA, CAS_DIR, GAMES_DIR]) mkdirSync(d, { recursive: true });
if (!WORKER_TOKEN) console.warn('[scheduler] WORKER_TOKEN not set: worker endpoints are open (development mode)');

/** workers (and legacy host.html nodes): id → { id, kind, name, runtimes:Set, capacity, active:Set, reservedRam, queue, waiter, seen, lastBeat, caps, load, status:Map } */
const hosts = new Map();
/** sessions: id → { id, hostId, game, manifest?, manifestHash?, gameKey, saveKey?, prefs, offer, beat, created, maxMs, state, resolve?, ram, restarts, reassignments } */
const sessions = new Map();
/** registered Windows games: id → validated manifest */
const games = new Map();
/** save index: `${saveKey}|${gameKey}` → { latest, history: [{ref,size,raw,files,kind,ts}] } */
const SAVES_DB = join(DATA, 'saves.json');
const saves = new Map(existsSync(SAVES_DB) ? Object.entries(JSON.parse(readFileSync(SAVES_DB, 'utf8'))) : []);
const pendingSaves = new Map();
/** recently ended Windows sessions: lets the worker file the final save after the player has left */
const ended = new Map();
const persistSaves = () => { const tmp = SAVES_DB + '.tmp'; writeFileSync(tmp, JSON.stringify(Object.fromEntries(saves))); renameSync(tmp, SAVES_DB); };

for (const f of existsSync(GAMES_DIR) ? readdirSync(GAMES_DIR) : []) {
  if (!f.endsWith('.json')) continue;
  try { const m = validateManifest(JSON.parse(readFileSync(join(GAMES_DIR, f), 'utf8'))); games.set(m.id, m); }
  catch (e) { console.error(`[scheduler] skipped ${f}: ${e.message}`); }
}

const cors = { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET,POST,PUT,HEAD,DELETE,OPTIONS', 'access-control-allow-headers': 'content-type', 'access-control-max-age': '600' };
const send = (res, code, body, headers = {}) => {
  const isJson = body !== undefined && typeof body !== 'string' && !Buffer.isBuffer(body);
  res.writeHead(code, { ...cors, ...(isJson ? { 'content-type': 'application/json' } : {}), ...headers });
  res.end(isJson ? JSON.stringify(body) : body);
};
const readBody = (req, limit = 1 << 20) => new Promise((res, rej) => {
  const chunks = []; let n = 0;
  req.on('data', c => { n += c.length; if (n > limit) { rej(Object.assign(new Error('too large'), { code: 413 })); req.destroy(); } else chunks.push(c); });
  req.on('end', () => res(Buffer.concat(chunks)));
  req.on('error', rej);
});
const json = async (req, limit) => JSON.parse((await readBody(req, limit)).toString() || '{}');
const HASH = /^[a-f0-9]{64}$/;
const SAVE_KEY = /^[A-Za-z0-9_-]{16,64}$/;
const tokenOk = (req, expected) => {
  if (!expected) return true;
  const got = Buffer.from((req.headers.authorization || '').replace(/^Bearer /, ''));
  const exp = Buffer.from(expected);
  return got.length === exp.length && timingSafeEqual(got, exp);
};
const casFile = sha => join(CAS_DIR, sha);
const log = (...a) => console.log('[scheduler]', ...a);

function push(host, msg) {
  if (host.waiter) { const w = host.waiter; host.waiter = null; w(msg); } else host.queue.push(msg);
}
function detach(s) {
  const h = hosts.get(s.hostId);
  if (h) { h.active.delete(s.id); h.reservedRam = Math.max(0, (h.reservedRam || 0) - (s.ram || 0)); }
}
function endSession(id, reason, { tellWorker = true } = {}) {
  const s = sessions.get(id); if (!s) return;
  sessions.delete(id);
  const h = hosts.get(s.hostId);
  detach(s);
  if (s.manifest) ended.set(id, { id, hostId: s.hostId, saveKey: s.saveKey, gameKey: s.gameKey, manifest: true, endedAt: Date.now(), ephemeralSaves: s.ephemeralSaves });
  if (h && tellWorker) push(h, { type: 'end', id, reason });
  s.resolve?.(null);
  log(`session ${id.slice(0, 8)} ended: ${reason}`);
}
function workerLost(h, why) {
  if (h.dead) return;
  h.dead = true;
  hosts.delete(h.id);
  log(`worker ${h.name || h.id.slice(0, 8)} lost (${why}); ${h.active.size} session(s) orphaned`);
  for (const sid of h.active) {
    const s = sessions.get(sid);
    if (s) { s.state = 'orphaned'; s.orphanedAt = Date.now(); s.lostWorker = h.id; s.hostId = null; s.resolve?.({ error: 'Cloud node failed.' }); s.resolve = null; }
  }
}
function runtimes() { return [...new Set([...hosts.values()].filter(h => alive(h)).flatMap(h => [...h.runtimes]))]; }
const saveKeyOf = (saveKey, gameKey) => `${saveKey}|${gameKey}`;
function latestSave(s) { return s.saveKey ? saves.get(saveKeyOf(s.saveKey, s.gameKey))?.latest?.ref ?? null : null; }

setInterval(() => {
  const now = Date.now();
  for (const [id, s] of sessions) {
    const starting = s.state === 'allocating' || s.state === 'reassigning';                // player can't heartbeat before it has an answer
    if (!starting && now - s.beat > HB_TIMEOUT) endSession(id, 'client idle');            // abandoned by the player
    else if (s.maxMs && now - s.created > s.maxMs) endSession(id, 'time limit');           // hard session limit
    else if (s.state === 'orphaned' && now - s.orphanedAt > ORPHAN_GRACE) endSession(id, 'not reclaimed after worker failure', { tellWorker: false });
  }
  for (const [id, e] of ended) if (now - e.endedAt > 120_000) ended.delete(id);
  for (const h of [...hosts.values()]) {
    if (h.kind === 'worker' && now - h.lastBeat > WORKER_TIMEOUT) workerLost(h, 'missed heartbeats');
    else if (h.kind !== 'worker' && now - h.seen > 60_000) workerLost(h, 'stopped polling');
  }
}, 2000).unref();

/** Resolve what a client asked to play into a validated Windows manifest. The client never supplies commands. */
function resolveWindowsGame(g) {
  if (g.catalogId) {
    const m = games.get(String(g.catalogId));
    if (!m) throw Object.assign(new Error('This game is not registered on the cloud.'), { status: 404 });
    return m;
  }
  if (g.cas && HASH.test(g.cas) && existsSync(casFile(g.cas))) {
    const fd = openSync(casFile(g.cas), 'r'); const head = Buffer.alloc(4096); const n = readSync(fd, head, 0, 4096, 0); closeSync(fd);
    const pe = peInfo(head.subarray(0, n));
    if (!pe) throw Object.assign(new Error('The uploaded file is not a supported Windows executable.'), { status: 400 });
    return uploadManifest(g.cas, statSync(casFile(g.cas)).size, typeof g.title === 'string' ? g.title.slice(0, 80) : '', pe.arch);
  }
  throw Object.assign(new Error('Windows titles must be uploaded to or registered on the cloud.'), { status: 400 });
}

/** Ask a worker to run (or resume) a session; resolves with { sdp } or { error }. */
function assign(s, h, extra = {}) {
  s.hostId = h.id; h.active.add(s.id); h.reservedRam = (h.reservedRam || 0) + (s.ram || 0);
  return new Promise(resolve => {
    s.resolve = resolve;
    const msg = s.manifest
      ? { type: 'session', id: s.id, manifest: s.manifest, manifestHash: s.manifestHash, offer: s.offer, prefs: s.prefs, iceServers: ICE, restore: latestSave(s), ...extra }
      : { type: 'session', id: s.id, game: s.game, offer: s.offer, prefs: s.prefs, iceServers: ICE };
    push(h, msg);
    setTimeout(() => { if (s.resolve === resolve) { s.resolve = null; resolve(null); } }, s.manifest ? ANSWER_TIMEOUT : 15000);
  });
}

async function createSession(b) {
  const rt = b?.game?.runtime;
  if (!rt || typeof b.offer !== 'string' || b.offer.length > 64_000) return [400, { error: 'Bad request' }];
  if (b.game.cas && !HASH.test(b.game.cas)) return [400, { error: 'Bad package ref' }];
  const s = { id: randomUUID(), game: b.game, prefs: b.prefs || {}, offer: b.offer, beat: Date.now(), created: Date.now(), state: 'allocating', restarts: 0, reassignments: 0 };
  if (WINDOWS.has(rt)) {
    try { s.manifest = resolveWindowsGame(b.game); } catch (e) { return [e.status || 400, { error: e.message }]; }
    s.manifestHash = manifestHash(s.manifest);
    s.gameKey = s.manifest.id;
    s.ram = s.manifest.requirements.ram;
    s.maxMs = s.manifest.requirements.maxMinutes * 60_000 + 60_000;
    if (SAVE_KEY.test(b.client?.saveKey || '')) s.saveKey = b.client.saveKey;
  } else s.gameKey = String(b.game.id || 'game').slice(0, 64);
  const need = { runtime: rt, ramMB: s.ram, gpu: s.manifest?.requirements.gpu, manifestHash: s.manifestHash };
  const tried = new Set();
  for (let attempt = 0; attempt < 2; attempt++) {           // one automatic retry on a different worker
    const h = selectWorker(hosts.values(), { ...need, exclude: tried });
    if (!h) break;
    sessions.set(s.id, s);
    const answer = await assign(s, h);
    if (answer?.sdp) { s.state = 'streaming'; log(`session ${s.id.slice(0, 8)} on ${h.name || h.id.slice(0, 8)} (${s.gameKey})`); return [201, { id: s.id, answer: answer.sdp, worker: h.name || h.id.slice(0, 8) }]; }
    detach(s); tried.add(h.id);
    if (hosts.has(h.id)) push(h, { type: 'end', id: s.id, reason: 'start failed' });
    if (answer?.error && /not registered|not a supported|capacity/.test(answer.error)) { sessions.delete(s.id); return [502, { error: answer.error }]; }
    s.lastError = answer?.error || 'Cloud node did not respond.';
  }
  sessions.delete(s.id);
  if (tried.size) return [s.lastError === 'Cloud node did not respond.' ? 504 : 502, { error: s.lastError }];
  return [503, { error: `No cloud node available for ${rt === 'x64-win' || rt === 'x86' ? 'Windows' : rt === 'linux' ? 'Linux' : rt} titles right now.` }];
}

/** Reconnect after a network drop, or move the session to a new worker when its worker died. */
async function reconnect(s, offer) {
  if (typeof offer !== 'string' || offer.length > 64_000) return [400, { error: 'Bad request' }];
  s.offer = offer; s.beat = Date.now();
  const h = s.hostId && hosts.get(s.hostId);
  if (h && alive(h)) {
    const answer = await new Promise(resolve => {
      s.resolve = resolve;
      push(h, { type: 'reconnect', id: s.id, offer });
      setTimeout(() => { if (s.resolve === resolve) { s.resolve = null; resolve(null); } }, 20000);
    });
    if (answer?.sdp) { s.state = 'streaming'; return [200, { id: s.id, answer: answer.sdp, reassigned: false }]; }
    if (!s.manifest) return [502, { error: answer?.error || 'Reconnect failed.' }];
    detach(s); s.lostWorker = h.id;
  }
  if (!s.manifest) { endSession(s.id, 'node lost'); return [410, { error: 'Session ended.' }]; }
  const nh = selectWorker(hosts.values(), { runtime: s.game.runtime, ramMB: s.ram, gpu: s.manifest.requirements.gpu, manifestHash: s.manifestHash, exclude: new Set([s.lostWorker].filter(Boolean)) });
  if (!nh) return [503, { error: 'No cloud node available to resume this session.' }];
  s.state = 'reassigning';
  const answer = await assign(s, nh);
  if (!answer?.sdp) { detach(s); return [502, { error: answer?.error || 'Could not resume on another node.' }]; }
  s.reassignments++; s.state = 'streaming'; s.orphanedAt = null;
  log(`session ${s.id.slice(0, 8)} reassigned to ${nh.name || nh.id.slice(0, 8)} (restored ${latestSave(s)?.slice(0, 12) || 'no save'})`);
  return [200, { id: s.id, answer: answer.sdp, reassigned: true, worker: nh.name || nh.id.slice(0, 8) }];
}

function publicSession(s, live = false) {
  const h = hosts.get(s.hostId);
  const out = { id: s.id, game: { id: s.gameKey, title: s.manifest?.title || s.game?.title }, state: s.state, created: s.created,
    worker: h ? (h.name || h.id.slice(0, 8)) : null, reassignments: s.reassignments, save: latestSave(s) };
  if (live && h?.status?.has(s.id)) out.live = h.status.get(s.id);
  return out;
}

function registerHost(b, kind) {
  const id = randomUUID();
  const h = { id, kind, name: typeof b.name === 'string' ? b.name.slice(0, 64) : undefined, runtimes: new Set((b.runtimes || []).filter(r => typeof r === 'string')),
    capacity: Math.max(1, Math.min(64, +b.capacity || 1)), active: new Set(), reservedRam: 0, queue: [], waiter: null, seen: Date.now(), lastBeat: Date.now(), caps: b, load: 0, status: new Map() };
  hosts.set(id, h);
  log(`${kind} ${h.name || id.slice(0, 8)} online: ${[...h.runtimes]} · encoders ${(b.encoders || []).join(',') || 'n/a'} · gpu ${b.resources?.gpu?.device || 'n/a'}`);
  return h;
}

async function poll(h, res) {
  h.seen = Date.now();
  if (h.queue.length) return send(res, 200, h.queue.shift());
  const msg = await new Promise(r => { h.waiter = r; setTimeout(() => { if (h.waiter === r) { h.waiter = null; r(null); } }, 25000); });
  return msg ? send(res, 200, msg) : send(res, 204, '');
}

function answered(b) {
  const s = sessions.get(b.id);
  if (s?.resolve) { s.beat = Date.now(); s.resolve(b.error ? { error: String(b.error).slice(0, 300) } : { sdp: String(b.sdp) }); s.resolve = null; }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  try {
    if (req.method === 'OPTIONS') return send(res, 204, '');
    // ================= client API (v1, unchanged) =================
    if (p === '/v1/config' && req.method === 'GET') return send(res, 200, { iceServers: ICE, runtimes: runtimes(), sessions: sessions.size });

    let m = p.match(/^\/v1\/packages\/([a-f0-9]{64})$/);
    if (m) {
      const file = casFile(m[1]);
      if (req.method === 'HEAD') return send(res, existsSync(file) ? 200 : 404, '', existsSync(file) ? { 'content-length': statSync(file).size } : {});
      if (req.method === 'GET') { if (!existsSync(file)) return send(res, 404, ''); res.writeHead(200, { ...cors, 'content-type': 'application/octet-stream', 'content-length': statSync(file).size, 'cache-control': 'public, max-age=31536000, immutable' }); return createReadStream(file).pipe(res); }
      if (req.method === 'PUT') {
        if (existsSync(file)) return send(res, 200, { stored: false, dedup: true });
        const body = await readBody(req, MAX_PKG);
        if (createHash('sha256').update(body).digest('hex') !== m[1]) return send(res, 400, { error: 'Hash mismatch' });
        writeFileSync(file + '.tmp', body); renameSync(file + '.tmp', file); return send(res, 201, { stored: true });
      }
    }

    if ((p === '/v1/sessions' || p === '/api/session') && req.method === 'POST') {
      const [code, body] = await createSession(await json(req));
      return send(res, code, body);
    }
    m = p.match(/^\/(?:v1\/sessions|api\/session)\/([\w-]+)(?:\/(heartbeat|reconnect|status|input|save))?$/);
    if (m) {
      const s = sessions.get(m[1]);
      const action = m[2];
      if (!action && req.method === 'DELETE') { endSession(m[1], 'client closed'); return send(res, 204, ''); }
      if (!s) return send(res, 404, { error: 'No such session.' });
      if (action === 'heartbeat' && req.method === 'POST') { s.beat = Date.now(); return send(res, 204, ''); }
      if (action === 'reconnect' && req.method === 'POST') { const [c, b] = await reconnect(s, (await json(req)).offer); return send(res, c, b); }
      if (!action && req.method === 'GET') return send(res, 200, publicSession(s));
      if (action === 'status' && req.method === 'GET') return send(res, 200, publicSession(s, true));
      if (action === 'input' && req.method === 'POST') {
        const b = await json(req, 64 << 10);
        const events = Array.isArray(b.events) ? b.events.slice(0, 256) : [];
        const h = hosts.get(s.hostId); if (!h) return send(res, 409, { error: 'Session is not running.' });
        s.beat = Date.now(); push(h, { type: 'input', id: s.id, events });
        return send(res, 202, { queued: events.length });
      }
      if (action === 'save' && req.method === 'POST') {
        const h = hosts.get(s.hostId); if (!h || !s.manifest) return send(res, 409, { error: 'Save is not available for this session.' });
        const reqId = randomUUID();
        const result = await new Promise(r => { pendingSaves.set(reqId, r); push(h, { type: 'save', id: s.id, req: reqId }); setTimeout(() => { if (pendingSaves.delete(reqId)) r(null); }, 60000); });
        return result?.ok ? send(res, 200, { ref: result.ref, size: result.size, raw: result.raw, kind: 'manual' }) : send(res, 502, { error: result?.error || 'Save timed out.' });
      }
      return send(res, 405, { error: 'Method not allowed' });
    }

    // ================= worker API =================
    if (p.startsWith('/worker/') || p.startsWith('/v1/hosts/')) {
      if (!tokenOk(req, WORKER_TOKEN) && !(p.startsWith('/v1/hosts/') && url.searchParams.get('token') === WORKER_TOKEN)) return send(res, 401, { error: 'unauthorized' });
    }
    if (p === '/worker/register' && req.method === 'POST') return send(res, 201, { id: registerHost(await json(req, 256 << 10), 'worker').id });
    if (p.startsWith('/worker/')) {
      const sub = p.slice(8);
      const savesMatch = sub.match(/^saves\/([a-f0-9]{64})$/);
      const b = req.method === 'POST' ? await json(req, 4 << 20) : {};
      const h = hosts.get(b.worker || url.searchParams.get('worker'));
      if (!h) return send(res, 404, { error: 'unknown worker' });
      h.seen = Date.now();
      if (sub === 'heartbeat') {
        h.lastBeat = Date.now(); h.load = +b.load || 0;
        if (b.cache?.games) h.caps.cache = { games: b.cache.games.filter(x => HASH.test(x)).slice(0, 5000) };
        if (b.cache?.stats && typeof b.cache.stats === 'object') h.cacheStats = b.cache.stats;
        h.status = new Map((b.sessions || []).filter(x => x && typeof x.id === 'string').map(x => [x.id, x]));
        const unknown = [...h.status.keys()].filter(sid => sessions.get(sid)?.hostId !== h.id);
        for (const [sid, st] of h.status) { const s = sessions.get(sid); if (s && s.hostId === h.id && st.restarts > s.restarts) s.restarts = st.restarts; }
        return send(res, 200, { unknown });
      }
      if (sub === 'allocate') return poll(h, res); // liveness comes only from heartbeats
      if (sub === 'answer') { answered(b); return send(res, 204, ''); }
      if (sub === 'release') {
        if (b.bye) { workerLost(h, 'shut down'); return send(res, 204, ''); }
        const s = sessions.get(b.sessionId);
        if (s && s.hostId === h.id) endSession(s.id, b.reason || 'ended on worker', { tellWorker: false });
        return send(res, 204, '');
      }
      if (sub === 'save') {
        const s = sessions.get(b.sessionId) || ended.get(b.sessionId);
        if (!s || s.hostId !== h.id || !s.manifest) return send(res, 404, { error: 'unknown session' });
        if (!HASH.test(b.ref) || !existsSync(casFile(b.ref))) return send(res, 400, { error: 'save blob missing' });
        const rec = { ref: b.ref, size: +b.size || 0, raw: +b.raw || 0, files: +b.files || 0, kind: b.kind === 'manual' ? 'manual' : 'auto', ts: Date.now() };
        if (s.saveKey) {
          const k = saveKeyOf(s.saveKey, s.gameKey);
          const e = saves.get(k) || { latest: null, history: [] };
          e.latest = rec; e.history = [rec, ...e.history.filter(x => x.ref !== rec.ref)].slice(0, 20);
          saves.set(k, e); persistSaves();
        } else { s.ephemeralSaves = [rec, ...(s.ephemeralSaves || [])].slice(0, 20); }
        return send(res, 200, rec);
      }
      if (sub === 'save-result') { const r = pendingSaves.get(b.req); if (r) { pendingSaves.delete(b.req); r(b); } return send(res, 204, ''); }
      if (savesMatch && req.method === 'GET') {
        // A worker may only read a save that belongs to the player+game of a session it is running.
        const s = sessions.get(url.searchParams.get('session'));
        if (!s || s.hostId !== h.id) return send(res, 403, { error: 'not your session' });
        const owned = s.saveKey ? saves.get(saveKeyOf(s.saveKey, s.gameKey))?.history.some(x => x.ref === savesMatch[1]) : s.ephemeralSaves?.some(x => x.ref === savesMatch[1]);
        if (!owned || !existsSync(casFile(savesMatch[1]))) return send(res, 404, { error: 'save not found' });
        res.writeHead(200, { ...cors, 'content-type': 'application/octet-stream' });
        return createReadStream(casFile(savesMatch[1])).pipe(res);
      }
      return send(res, 404, { error: 'not found' });
    }

    // ================= legacy node API (server/host.html) =================
    if (p === '/v1/hosts/register' && req.method === 'POST') return send(res, 201, { id: registerHost(await json(req), 'node').id });
    m = p.match(/^\/v1\/hosts\/([\w-]+)\/(poll|answer|ended|bye)$/);
    if (m) {
      const h = hosts.get(m[1]); if (!h) return send(res, 404, { error: 'unknown node' });
      h.seen = Date.now();
      if (m[2] === 'bye') { workerLost(h, 'signed off'); for (const sid of [...h.active]) endSession(sid, 'node offline', { tellWorker: false }); return send(res, 204, ''); }
      if (m[2] === 'poll') return poll(h, res);
      const b = await json(req);
      if (m[2] === 'answer') { answered(b); return send(res, 204, ''); }
      if (m[2] === 'ended') { const s = sessions.get(b.id); if (s && s.hostId === h.id) endSession(b.id, 'ended on node', { tellWorker: false }); return send(res, 204, ''); }
    }

    // ================= admin: register games (manifests are validated; chunks must already be uploaded) =================
    if (p === '/admin/games' && req.method === 'POST') {
      if (!ADMIN_TOKEN || !tokenOk(req, ADMIN_TOKEN)) return send(res, 401, { error: 'unauthorized' });
      let mf;
      try { mf = validateManifest(await json(req, 64 << 20)); } catch (e) { return send(res, 400, { error: e.message }); }
      const missing = [...new Set(mf.files.flatMap(f => f.chunks))].filter(c => !existsSync(casFile(c)));
      if (missing.length) return send(res, 409, { error: 'missing chunks', missing: missing.slice(0, 100), count: missing.length });
      games.set(mf.id, mf); writeFileSync(join(GAMES_DIR, `${mf.id}.json`), JSON.stringify(mf, null, 1));
      return send(res, 201, { id: mf.id, manifestHash: manifestHash(mf), files: mf.files.length });
    }
    if (p === '/admin/workers' && req.method === 'GET') {
      if (!ADMIN_TOKEN || !tokenOk(req, ADMIN_TOKEN)) return send(res, 401, { error: 'unauthorized' });
      return send(res, 200, [...hosts.values()].map(h => ({ id: h.id, name: h.name, kind: h.kind, alive: alive(h), load: h.load, capacity: h.capacity,
        active: [...h.active], reservedRamMB: h.reservedRam, encoders: h.caps.encoders, gpu: h.caps.resources?.gpu, layers: h.caps.layers,
        cachedGames: h.caps.cache?.games?.length || 0, cacheStats: h.cacheStats, isolation: h.caps.isolation, sessions: [...h.status.values()] })));
    }
    if (p === '/v1/games' && req.method === 'GET') return send(res, 200, [...games.values()].map(g => ({ id: g.id, title: g.title, runtime: g.arch === 'x86' ? 'x86' : 'x64-win' })));
    if (p === '/host.html') return send(res, 200, readFileSync(join(HERE, 'host.html')), { 'content-type': 'text/html; charset=utf-8' });
    return send(res, 404, { error: 'not found' });
  } catch (e) {
    if (e instanceof ManifestError) return send(res, 400, { error: e.message });
    if (!(e.code === 413)) console.error('[scheduler]', e);
    return send(res, e.code === 413 ? 413 : 500, { error: e.code === 413 ? 'Too large' : 'Server error' });
  }
});
server.listen(PORT, () => log(`Mishrin cloud scheduler on :${PORT} · ${games.size} registered Windows game(s)`));
