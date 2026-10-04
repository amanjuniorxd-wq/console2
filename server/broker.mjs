// Mishrin Cloud scheduler — zero dependencies (Node 18+).
// Matches console sessions to isolated workers (Windows/Wine, PS2-/PS3-class emulator workers, legacy WASM nodes),
// relays WebRTC signaling (media never passes through here), stores content-addressed chunks, uploads and save
// layers, queues players when every worker is busy, and recovers sessions from worker failure.
//
//   node server/broker.mjs
//   PORT=8787 ICE_SERVERS='[…]' WORKER_TOKEN=… ADMIN_TOKEN=… DATA_DIR=server/.data CAS_DIR=server/.cas
//   AUTH_SECRET=… CLIENT_KEYS=k1,k2 AUTH_REQUIRED=1   (optional: device authentication, see lib/auth.mjs)
//
// Protocol: server/PROTOCOL.md. Architecture: docs/universal-runtime-architecture.md.
import http from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, existsSync, readFileSync, writeFileSync, readdirSync, renameSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateManifest, manifestHash, peInfo, uploadManifest, runtimeOf, relPath, ManifestError, EMULATOR_PLATFORMS } from './lib/manifest.mjs';
import { selectWorker, alive, capable, WORKER_TIMEOUT } from './lib/select.mjs';
import { fsStorage, CHUNK, HASH } from './lib/storage.mjs';
import { createAuth } from './lib/auth.mjs';
import { inspectUpload, InspectError } from './lib/inspect.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const PORT = +(process.env.PORT || 8787);
const ICE = JSON.parse(process.env.ICE_SERVERS || '[]');
const DATA = process.env.DATA_DIR || join(HERE, '.data');
const GAMES_DIR = process.env.GAMES_DIR || join(HERE, 'games');
const MAX_PKG = +(process.env.MAX_PACKAGE_MB || 1024) * 1048576;
const WORKER_TOKEN = process.env.WORKER_TOKEN || '';
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';
const HB_TIMEOUT = +(process.env.CLIENT_HEARTBEAT_TIMEOUT_MS || 45_000);
const ORPHAN_GRACE = +(process.env.ORPHAN_GRACE_MS || 60_000);
const ANSWER_TIMEOUT = +(process.env.ANSWER_TIMEOUT_MS || 150_000);
const TICKET_IDLE = +(process.env.QUEUE_TICKET_IDLE_MS || 20_000);
const TICKET_CLAIM = +(process.env.QUEUE_CLAIM_MS || 30_000);
const MANIFEST_RUNTIMES = new Set(['x64-win', 'x86', ...Object.keys(EMULATOR_PLATFORMS)]);
const WINDOWS = new Set(['x64-win', 'x86']);
const NAMES = { 'x64-win': 'Windows', x86: 'Windows', linux: 'Linux', ps2: 'PS2-class', ps3: 'PS3-class', wasm: 'WASM' };
for (const d of [DATA, GAMES_DIR, join(DATA, 'uploads')]) mkdirSync(d, { recursive: true });
if (!WORKER_TOKEN) console.warn('[scheduler] WORKER_TOKEN not set: worker endpoints are open (development mode)');

const store = fsStorage(process.env.CAS_DIR || join(HERE, '.cas'));
const auth = createAuth();
/** workers (and legacy host.html nodes): id → { id, kind, name, runtimes:Set, capacity, active:Set, holds:Map, reservedRam, queue, waiter, seen, lastBeat, caps, load, status:Map } */
const hosts = new Map();
/** sessions: id → { id, token, owner, hostId, game, manifest?, manifestHash?, runtime, gameKey, saveKey?, prefs, offer, beat, created, maxMs, state, resolve?, ram, restarts, reassignments } */
const sessions = new Map();
/** registered games (Windows + emulator titles): id → validated manifest */
const games = new Map();
/** completed uploads: id → { id, owner, manifest, platform, title, created } (persisted) */
const uploads = new Map();
/** queue tickets: id → { id, token, runtime, need, created, polled, state:'waiting'|'ready', readyAt?, hostId? } */
const tickets = new Map();
/** save index: `${owner}|${gameKey}` → { latest, history: [{ref,size,raw,files,kind,ts}] } */
const SAVES_DB = join(DATA, 'saves.json');
const saves = new Map(existsSync(SAVES_DB) ? Object.entries(JSON.parse(readFileSync(SAVES_DB, 'utf8'))) : []);
const pendingSaves = new Map();
/** recently ended manifest sessions: lets the worker file the final save after the player has left */
const ended = new Map();
const persistJson = (file, obj) => { const tmp = file + '.tmp'; writeFileSync(tmp, JSON.stringify(obj)); renameSync(tmp, file); };
const persistSaves = () => persistJson(SAVES_DB, Object.fromEntries(saves));
const UPLOADS_DB = join(DATA, 'uploads.json');
for (const [k, v] of existsSync(UPLOADS_DB) ? Object.entries(JSON.parse(readFileSync(UPLOADS_DB, 'utf8'))) : []) uploads.set(k, v);
const persistUploads = () => persistJson(UPLOADS_DB, Object.fromEntries(uploads));

for (const f of existsSync(GAMES_DIR) ? readdirSync(GAMES_DIR) : []) {
  if (!f.endsWith('.json')) continue;
  try { const m = validateManifest(JSON.parse(readFileSync(join(GAMES_DIR, f), 'utf8'))); games.set(m.id, m); }
  catch (e) { console.error(`[scheduler] skipped ${f}: ${e.message}`); }
}

const cors = { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET,POST,PUT,HEAD,DELETE,OPTIONS',
  'access-control-allow-headers': 'content-type,authorization,x-session-token,x-device-token,x-save-key', 'access-control-max-age': '600' };
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
const tokenOk = (req, expected) => {
  if (!expected) return true;
  const got = (req.headers.authorization || '').replace(/^Bearer /, '');
  return got.length === expected.length && createHash('sha256').update(got).digest().equals(createHash('sha256').update(expected).digest());
};
const workerAuthed = (req, url) => tokenOk(req, WORKER_TOKEN) || (!!WORKER_TOKEN && url.searchParams.get('token') === WORKER_TOKEN);
const log = (...a) => console.log('[scheduler]', ...a);
const ownerOf = (req, b) => auth.owner(req, b?.client?.saveKey || req.headers['x-save-key']);

function push(host, msg) {
  if (host.waiter) { const w = host.waiter; host.waiter = null; w(msg); } else host.queue.push(msg);
}
function detach(s) {
  const h = hosts.get(s.hostId);
  if (h) { h.active.delete(s.id); h.reservedRam = Math.max(0, (h.reservedRam || 0) - (s.ram || 0)); }
  setImmediate(pumpQueue);
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
  for (const t of tickets.values()) if (t.hostId === h.id) { t.state = 'waiting'; t.hostId = null; }
}
const liveHosts = () => [...hosts.values()].filter(h => alive(h));
function runtimes() { return [...new Set(liveHosts().flatMap(h => [...h.runtimes]))]; }
const saveKeyOf = (saveKey, gameKey) => `${saveKey}|${gameKey}`;
function latestSave(s) { return s.saveKey ? saves.get(saveKeyOf(s.saveKey, s.gameKey))?.latest?.ref ?? null : null; }

// ------------------------------------------------------------------ queue (fair FIFO per runtime)
const waitingFor = rt => [...tickets.values()].filter(t => t.runtime === rt && t.state === 'waiting').sort((a, b) => a.created - b.created);
function position(t) { return t.state === 'ready' ? 0 : waitingFor(t.runtime).indexOf(t) + 1; }
function release(t) { const h = t.hostId && hosts.get(t.hostId); if (h) h.holds.delete(t.id); tickets.delete(t.id); }
function pumpQueue() {
  const now = Date.now();
  for (const t of [...tickets.values()]) {
    if (now - t.polled > TICKET_IDLE || (t.state === 'ready' && now - t.readyAt > TICKET_CLAIM)) release(t);
  }
  for (const rt of new Set([...tickets.values()].map(t => t.runtime))) {
    for (const t of waitingFor(rt)) {
      const h = selectWorker(hosts.values(), t.need);
      if (!h) break;                                           // FIFO: nobody behind the head jumps ahead
      t.state = 'ready'; t.readyAt = now; t.hostId = h.id; h.holds.set(t.id, now + TICKET_CLAIM);
      log(`queue ticket ${t.id.slice(0, 8)} ready on ${h.name || h.id.slice(0, 8)} (${rt})`);
    }
  }
}
function enqueue(rt, need) {
  const t = { id: randomUUID(), token: auth.newSessionToken(), runtime: rt, need: { ...need, exclude: undefined }, created: Date.now(), polled: Date.now(), state: 'waiting' };
  tickets.set(t.id, t);
  pumpQueue();
  return t;
}

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
    for (const [tid, exp] of h.holds) if (exp < now) h.holds.delete(tid);
  }
  pumpQueue();
}, 1000).unref();

// ------------------------------------------------------------------ resolving what a client asked to play
/** The client only ever *names* a game (catalog id or one of its own uploads). Commands are never accepted. */
function resolveGame(g, rt, owner) {
  const want = WINDOWS.has(rt) ? 'windows' : rt;
  const check = m => {
    const got = m.type === 'emulator' ? m.platform : 'windows';
    if (got !== want) throw Object.assign(new Error(`This title is a ${NAMES[runtimeOf(m)] || got} title, not ${NAMES[rt] || rt}.`), { status: 400 });
    return m;
  };
  if (g.catalogId) {
    const m = games.get(String(g.catalogId));
    if (!m) throw Object.assign(new Error('This game is not registered on the cloud.'), { status: 404 });
    return check(m);
  }
  if (g.upload) {
    const u = uploads.get(String(g.upload));
    if (!u || (u.owner && u.owner !== owner)) throw Object.assign(new Error('Upload not found.'), { status: 404 });
    return check(u.manifest);
  }
  if (WINDOWS.has(rt) && g.cas && HASH.test(g.cas) && store.has(g.cas)) {          // legacy single-.exe package
    const pe = peInfo(store.read(g.cas, 0, 4096));
    if (!pe) throw Object.assign(new Error('The uploaded file is not a supported Windows executable.'), { status: 400 });
    return uploadManifest(g.cas, store.size(g.cas), typeof g.title === 'string' ? g.title.slice(0, 80) : '', pe.arch);
  }
  throw Object.assign(new Error(`${NAMES[rt] || rt} titles must be uploaded to or registered on the cloud.`), { status: 400 });
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

const deployed = rt => liveHosts().some(h => h.runtimes.has(rt));
/** Could any live worker host this title when idle? (Queueing for a slot that can never fit would wait forever.) */
const fitsAnywhere = need => liveHosts().some(h => h.runtimes.has(need.runtime) && capable(h, need.runtime)
  && (!need.ramMB || !h.caps.resources?.ramMB || h.caps.resources.ramMB - 1024 >= need.ramMB)
  && (!need.gpu || h.kind !== 'worker' || h.caps.resources?.gpu?.available));
/** Operator defaults for uploaded titles, e.g. UPLOAD_DEFAULTS='{"ps3":{"ram":4096}}' (falls back to platform defaults). */
const UPLOAD_DEFAULTS = JSON.parse(process.env.UPLOAD_DEFAULTS || '{}');
/** Session display per console class: PCSX2 1.6 renders a 640x480 window (4:3); RPCS3 uses the 1280x720 default. */
const PLATFORM_DISPLAY = { ps2: { width: 640, height: 480 } };

async function createSession(req, b) {
  const rt = b?.game?.runtime;
  if (!rt || typeof b.offer !== 'string' || b.offer.length > 64_000) return [400, { error: 'Bad request' }];
  if (b.game.cas && !HASH.test(b.game.cas)) return [400, { error: 'Bad package ref' }];
  const owner = ownerOf(req, b);
  if (auth.required && !owner) return [401, { error: 'Sign-in required (device token).' }];
  const s = { id: randomUUID(), token: auth.newSessionToken(), owner, game: b.game, runtime: rt, prefs: b.prefs || {}, offer: b.offer, beat: Date.now(), created: Date.now(), state: 'allocating', restarts: 0, reassignments: 0 };
  if (MANIFEST_RUNTIMES.has(rt)) {
    try { s.manifest = resolveGame(b.game, rt, owner); } catch (e) { return [e.status || 400, { error: e.message }]; }
    s.manifestHash = manifestHash(s.manifest);
    s.gameKey = s.manifest.id;
    s.ram = s.manifest.requirements.ram;
    s.maxMs = s.manifest.requirements.maxMinutes * 60_000 + 60_000;
    if (owner) s.saveKey = owner;
  } else s.gameKey = String(b.game.id || 'game').slice(0, 64);
  const need = { runtime: rt, ramMB: s.ram, gpu: s.manifest?.requirements.gpu, manifestHash: s.manifestHash };

  if (deployed(rt) && !fitsAnywhere(need)) {
    return [503, { error: `No ${NAMES[rt] || rt} worker on this cloud can host this title (needs ${need.ramMB ? `${need.ramMB} MB RAM` : 'more resources'}${need.gpu ? ' and a GPU' : ''}).`, deployed: true, fits: false }];
  }
  // Queue fairness: a request holding a ready ticket claims its reserved slot; others wait behind earlier players.
  const ticket = b.ticket && tickets.get(String(b.ticket));
  let preferred = null;
  if (ticket) {
    if (ticket.token !== b.ticketToken || ticket.runtime !== rt) return [403, { error: 'Invalid queue ticket.' }];
    if (ticket.state !== 'ready') return [409, { error: 'Not your turn yet.', queue: { ticket: ticket.id, position: position(ticket) } }];
    preferred = ticket.hostId; release(ticket);
  } else if (waitingFor(rt).length && b.queue !== false) {
    const t = enqueue(rt, need);
    return [503, { error: `All ${NAMES[rt] || rt} cloud slots are busy.`, queue: { ticket: t.id, token: t.token, position: position(t) } }];
  }

  const tried = new Set();
  for (let attempt = 0; attempt < 2; attempt++) {           // one automatic retry on a different worker
    const ph = preferred && hosts.get(preferred);
    const h = ph && attempt === 0 && selectWorker([ph], need) ? ph : selectWorker(hosts.values(), { ...need, exclude: tried });
    if (!h) break;
    sessions.set(s.id, s);
    const answer = await assign(s, h);
    if (answer?.sdp) { s.state = 'streaming'; log(`session ${s.id.slice(0, 8)} on ${h.name || h.id.slice(0, 8)} (${s.gameKey})`); return [201, { id: s.id, token: s.token, answer: answer.sdp, worker: h.name || h.id.slice(0, 8) }]; }
    detach(s); tried.add(h.id);
    if (hosts.has(h.id)) push(h, { type: 'end', id: s.id, reason: 'start failed' });
    if (answer?.error && /not registered|not a supported|capacity|firmware|BIOS/i.test(answer.error)) { sessions.delete(s.id); return [502, { error: answer.error }]; }
    s.lastError = answer?.error || 'Cloud node did not respond.';
  }
  sessions.delete(s.id);
  if (tried.size) return [s.lastError === 'Cloud node did not respond.' ? 504 : 502, { error: s.lastError }];
  if (deployed(rt) && b.queue !== false) {                  // workers exist but are all busy → take a place in line
    const t = enqueue(rt, need);
    return [503, { error: `All ${NAMES[rt] || rt} cloud slots are busy.`, queue: { ticket: t.id, token: t.token, position: position(t) } }];
  }
  return [503, { error: deployed(rt) ? `All ${NAMES[rt] || rt} cloud slots are busy.` : `No cloud worker for ${NAMES[rt] || rt} titles is deployed.`, deployed: deployed(rt) }];
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
  const nh = selectWorker(hosts.values(), { runtime: s.runtime, ramMB: s.ram, gpu: s.manifest.requirements.gpu, manifestHash: s.manifestHash, exclude: new Set([s.lostWorker].filter(Boolean)) });
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
  const out = { id: s.id, game: { id: s.gameKey, title: s.manifest?.title || s.game?.title }, runtime: s.runtime, state: s.state, created: s.created,
    worker: h ? (h.name || h.id.slice(0, 8)) : null, reassignments: s.reassignments, save: latestSave(s) };
  if (live && h?.status?.has(s.id)) out.live = h.status.get(s.id);
  return out;
}

/** Live capability registry: what each runtime can do *right now*, derived only from registered, heartbeating workers. */
function runtimeReport() {
  const out = {};
  const slot = rt => out[rt] ??= { runtime: rt, name: NAMES[rt] || rt, workers: 0, capacity: 0, active: 0, held: 0, gpuWorkers: 0, hardwareGpu: 0, emulators: [], mock: false };
  for (const h of liveHosts()) {
    for (const rt of h.runtimes) {
      const r = slot(rt);
      r.workers++; r.capacity += h.capacity; r.active += h.active.size; r.held += h.holds.size;
      if (h.caps.resources?.gpu?.available) r.gpuWorkers++;
      if (h.caps.resources?.gpu?.hardware) r.hardwareGpu++;
    }
    // every installed emulator is reported, also when it cannot take sessions (BIOS/firmware missing, self-test failed)
    for (const e of h.caps.emulators || []) if (e && typeof e.runtime === 'string') {
      const r = slot(e.runtime);
      const v = e.verified && typeof e.verified === 'object' ? e.verified : {};
      r.emulators.push({ name: String(e.name).slice(0, 40), version: String(e.version || '').slice(0, 40), firmware: !!e.firmware, mock: !!e.mock,
        status: String(e.status || (e.mock ? 'MOCK' : 'NOT_VERIFIED')).slice(0, 24), firmwareLabel: String(e.firmwareLabel || '').slice(0, 40),
        firmwareState: String(e.firmwareState || '').slice(0, 16), requires: String(e.requires || '').slice(0, 400), testMode: !!e.testMode,
        advertised: h.runtimes.has(e.runtime), worker: h.name || h.id.slice(0, 8), formats: Array.isArray(e.formats) ? e.formats.slice(0, 12).map(String) : [],
        verified: { ok: !!v.ok, firstFrameMs: +v.firstFrameMs || null, detail: String(v.detail || '').slice(0, 160) } });
      if (e.mock && h.runtimes.has(e.runtime)) r.mock = true;
    }
  }
  for (const r of Object.values(out)) { r.free = Math.max(0, r.capacity - r.active - r.held); r.queued = waitingFor(r.runtime).length; }
  return { runtimes: out, sessions: sessions.size, auth: { required: auth.required, clientKeys: auth.clientKeysConfigured } };
}

function registerHost(b, kind) {
  const id = randomUUID();
  const h = { id, kind, name: typeof b.name === 'string' ? b.name.slice(0, 64) : undefined, runtimes: new Set((b.runtimes || []).filter(r => typeof r === 'string')),
    capacity: Math.max(1, Math.min(64, +b.capacity || 1)), active: new Set(), holds: new Map(), reservedRam: 0, queue: [], waiter: null, seen: Date.now(), lastBeat: Date.now(), caps: b, load: 0, status: new Map() };
  hosts.set(id, h);
  log(`${kind} ${h.name || id.slice(0, 8)} online: ${[...h.runtimes]} · encoders ${(b.encoders || []).join(',') || 'n/a'} · gpu ${b.resources?.gpu?.device || 'n/a'}${(b.emulators || []).length ? ` · emulators ${(b.emulators || []).map(e => `${e.name}${e.mock ? ' (mock)' : ''}`).join(',')}` : ''}`);
  setImmediate(pumpQueue);
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

// ------------------------------------------------------------------ uploads (chunked, resumable, deduplicated, validated)
/** Normalise a client file list; chunk boundaries are fixed (CHUNK) so identical files dedupe across everyone. */
function uploadFiles(list) {
  if (!Array.isArray(list) || !list.length || list.length > 20000) throw new ManifestError('files must be a non-empty list');
  const seen = new Set(); let total = 0;
  return list.map(f => {
    const path = relPath(f?.path, 'file path');
    if (seen.has(path.toLowerCase())) throw new ManifestError(`duplicate file ${path}`);
    seen.add(path.toLowerCase());
    if (!Number.isInteger(f.size) || f.size < 0 || f.size > MAX_PKG * 64) throw new ManifestError(`bad size for ${path}`);
    const n = f.size ? Math.ceil(f.size / CHUNK) : 0;
    if (!Array.isArray(f.chunks) || f.chunks.length !== n || !f.chunks.every(c => HASH.test(c))) throw new ManifestError(`bad chunk list for ${path} (expected ${n} × 4 MiB)`);
    total += f.size;
    if (total > 256 * 1024 ** 3) throw new ManifestError('upload too large');
    return { path, size: f.size, chunks: [...f.chunks] };
  });
}
const uploadId = (owner, files) => createHash('sha256').update(JSON.stringify([owner || '', files.map(f => [f.path, f.size, f.chunks])])).digest('hex').slice(0, 32);
const pendingUploads = new Map(); // id → { id, owner, files, title, created }
function missingChunks(files) { return [...new Set(files.flatMap(f => f.chunks))].filter(c => !store.has(c)); }

function completeUpload(u) {
  const missing = missingChunks(u.files);
  if (missing.length) return [409, { error: 'Upload incomplete.', missing: missing.slice(0, 1000), count: missing.length }];
  for (const f of u.files) {                                // every chunk must have the size its position implies
    const sizes = f.chunks.map(c => store.size(c));
    const ok = sizes.every((sz, i) => sz === (i < f.chunks.length - 1 ? CHUNK : f.size - CHUNK * (f.chunks.length - 1)));
    if (!ok) return [422, { error: `Chunk sizes do not add up for ${f.path}.` }];
  }
  let info;
  try { info = inspectUpload(u.files, store); } catch (e) { if (e instanceof InspectError) return [e.status, { error: e.message }]; throw e; }
  const title = (u.title || info.title || 'Uploaded game').slice(0, 80);
  const mid = `up-${u.id.slice(0, 20)}`;
  const manifest = info.platform === 'windows'
    ? validateManifest({
        id: mid, title, type: 'windows', runtime: 'wine',
        executable: info.executable, files: u.files, arch: info.arch, network: false, graphics: 'auto',
        requirements: { ram: 2048, gpu: true, maxMinutes: 240 }
      })
    : validateManifest({ id: mid, title, type: 'emulator', platform: info.platform, boot: info.boot, files: u.files, network: false, ...(UPLOAD_DEFAULTS[info.platform] ? { requirements: UPLOAD_DEFAULTS[info.platform] } : {}), ...(PLATFORM_DISPLAY[info.platform] ? { display: PLATFORM_DISPLAY[info.platform] } : {}) });
  const rec = { id: u.id, owner: u.owner, manifest, platform: info.platform, runtime: runtimeOf(manifest), title, serial: info.serial || '', created: Date.now() };
  uploads.set(u.id, rec); pendingUploads.delete(u.id); persistUploads();
  log(`upload ${u.id.slice(0, 8)} complete: ${info.platform} "${title}" (${u.files.length} files)`);
  return [201, { id: u.id, platform: info.platform, runtime: rec.runtime, title, serial: rec.serial, executable: info.executable || '', files: u.files.length, manifestHash: manifestHash(manifest) }];
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  try {
    if (req.method === 'OPTIONS') return send(res, 204, '');
    // ================= client API =================
    if (p === '/v1/config' && req.method === 'GET') return send(res, 200, { iceServers: ICE, runtimes: runtimes(), sessions: sessions.size });
    if (p === '/api/runtimes' && req.method === 'GET') return send(res, 200, runtimeReport());
    if (p === '/api/auth/device' && req.method === 'POST') {
      const t = auth.issue(req, (await json(req)).deviceId);
      return t ? send(res, 201, t) : send(res, 401, { error: 'A valid client key is required.' });
    }

    let m = p.match(/^\/v1\/packages\/([a-f0-9]{64})$/);
    if (m) {
      if (req.method === 'HEAD') return send(res, store.has(m[1]) ? 200 : 404, '', store.has(m[1]) ? { 'content-length': store.size(m[1]) } : {});
      if (req.method === 'GET') {
        // Chunks may belong to other players' uploads or saves: only workers (and legacy nodes) read them.
        if (!workerAuthed(req, url)) return send(res, 401, { error: 'unauthorized' });
        if (!store.has(m[1])) return send(res, 404, '');
        res.writeHead(200, { ...cors, 'content-type': 'application/octet-stream', 'content-length': store.size(m[1]), 'cache-control': 'private, max-age=31536000, immutable' });
        return store.stream(m[1]).pipe(res);
      }
      if (req.method === 'PUT') {
        if (auth.required && !ownerOf(req) && !tokenOk(req, ADMIN_TOKEN)) return send(res, 401, { error: 'Sign-in required.' });
        if (store.has(m[1])) return send(res, 200, { stored: false, dedup: true });
        store.put(m[1], await readBody(req, MAX_PKG));
        return send(res, 201, { stored: true });
      }
    }

    // ---- uploads: POST declares the file list (→ missing chunks), PUT chunks, POST complete (server inspects the bytes)
    if (p === '/api/uploads' && req.method === 'POST') {
      const b = await json(req, 8 << 20);
      const owner = ownerOf(req, b);
      if (auth.required && !owner) return send(res, 401, { error: 'Sign-in required (device token).' });
      const files = uploadFiles(b.files);
      const id = uploadId(owner, files);
      if (uploads.has(id)) { const u = uploads.get(id); return send(res, 200, { id, state: 'complete', missing: [], platform: u.platform, runtime: u.runtime, title: u.title, executable: u.manifest?.executable || '', files: u.manifest?.files?.length || 0 }); }
      if (!pendingUploads.has(id)) pendingUploads.set(id, { id, owner, files, title: typeof b.title === 'string' ? b.title.slice(0, 80) : '', created: Date.now() });
      const missing = missingChunks(files);
      return send(res, 200, { id, state: 'pending', chunkSize: CHUNK, missing, total: new Set(files.flatMap(f => f.chunks)).size });
    }
    m = p.match(/^\/api\/uploads\/([a-f0-9]{32})(?:\/(chunks)\/([a-f0-9]{64})|\/(complete))?$/);
    if (m) {
      const u = pendingUploads.get(m[1]) || uploads.get(m[1]);
      if (!u || (u.owner && u.owner !== ownerOf(req))) return send(res, 404, { error: 'Upload not found (declare it again to resume).' });
      if (m[2] && req.method === 'PUT') {
        if (!u.files?.some(f => f.chunks.includes(m[3]))) return send(res, 400, { error: 'Chunk is not part of this upload.' });
        if (store.has(m[3])) return send(res, 200, { stored: false, dedup: true });
        store.put(m[3], await readBody(req, CHUNK + 1));
        return send(res, 201, { stored: true });
      }
      if (m[4] && req.method === 'POST') { if (uploads.has(m[1])) return send(res, 200, { id: m[1], platform: u.platform, runtime: u.runtime, title: u.title, executable: u.manifest?.executable || '', files: u.manifest?.files?.length || 0 }); const [c, body] = completeUpload(u); return send(res, c, body); }
      if (!m[2] && !m[4] && req.method === 'GET') return uploads.has(m[1]) ? send(res, 200, { id: m[1], state: 'complete', platform: u.platform, runtime: u.runtime, title: u.title }) : send(res, 200, { id: m[1], state: 'pending', missing: missingChunks(u.files) });
      return send(res, 405, { error: 'Method not allowed' });
    }

    // ---- queue tickets
    m = p.match(/^\/api\/queue\/([\w-]+)$/);
    if (m) {
      const t = tickets.get(m[1]);
      if (!t || (req.headers['x-session-token'] || url.searchParams.get('token')) !== t.token) return send(res, 404, { error: 'Ticket expired.' });
      if (req.method === 'DELETE') { release(t); return send(res, 204, ''); }
      t.polled = Date.now();
      return send(res, 200, { ticket: t.id, state: t.state, position: position(t), runtime: t.runtime });
    }

    // ---- saves (SaveManager cloud provider): owner = device token or legacy saveKey header
    if (p.startsWith('/api/saves')) {
      const owner = ownerOf(req);
      if (!owner) return send(res, 401, { error: 'No save identity.' });
      const mine = [...saves.entries()].filter(([k]) => k.startsWith(owner + '|'));
      if (p === '/api/saves' && req.method === 'GET') return send(res, 200, mine.map(([k, e]) => ({ game: k.slice(owner.length + 1), latest: e.latest, versions: e.history.length })));
      m = p.match(/^\/api\/saves\/([a-z0-9][a-z0-9-]{0,63})(?:\/(data|import))?$/);
      if (m) {
        const k = saveKeyOf(owner, m[1]), e = saves.get(k);
        if (!m[2] && req.method === 'DELETE') { saves.delete(k); persistSaves(); return send(res, 204, ''); }
        if (m[2] === 'data' && req.method === 'GET') {
          const ref = url.searchParams.get('ref') || e?.latest?.ref;
          if (!e || !e.history.some(x => x.ref === ref) || !store.has(ref)) return send(res, 404, { error: 'No such save.' });
          res.writeHead(200, { ...cors, 'content-type': 'application/octet-stream', 'content-disposition': `attachment; filename="${m[1]}.msave-layer"` });
          return store.stream(ref).pipe(res);
        }
        if (m[2] === 'import' && req.method === 'POST') {
          const body = await readBody(req, 512 << 20);
          const ref = createHash('sha256').update(body).digest('hex');
          // Only well-formed save layers (zstd or gzip tar) are accepted; the worker re-checks every member on restore.
          if (!(body.subarray(0, 4).equals(Buffer.from([0x28, 0xb5, 0x2f, 0xfd])) || body.subarray(0, 2).equals(Buffer.from([0x1f, 0x8b])))) return send(res, 415, { error: 'Not a Mishrin cloud save layer.' });
          store.put(ref, body);
          const rec = { ref, size: body.length, raw: 0, files: 0, kind: 'import', ts: Date.now() };
          const ent = e || { latest: null, history: [] };
          ent.latest = rec; ent.history = [rec, ...ent.history.filter(x => x.ref !== ref)].slice(0, 20);
          saves.set(k, ent); persistSaves();
          return send(res, 201, rec);
        }
      }
      return send(res, 404, { error: 'not found' });
    }

    if ((p === '/v1/sessions' || p === '/api/session') && req.method === 'POST') {
      const [code, body] = await createSession(req, await json(req));
      return send(res, code, body);
    }
    m = p.match(/^\/(?:v1\/sessions|api\/session)\/([\w-]+)(?:\/(heartbeat|reconnect|status|input|save))?$/);
    if (m) {
      const s = sessions.get(m[1]);
      const action = m[2];
      if (!s) return send(res, 404, { error: 'No such session.' });
      if (!auth.sessionOk(req, url, s, ADMIN_TOKEN)) return send(res, 403, { error: 'Session token required.' });
      if (!action && req.method === 'DELETE') { endSession(m[1], 'client closed'); return send(res, 204, ''); }
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
        // Emulator state changes after registration (startup self-tests, firmware installed by the operator).
        if (Array.isArray(b.emulators)) h.caps.emulators = b.emulators.slice(0, 16);
        if (b.flags && typeof b.flags === 'object') h.caps.flags = b.flags;
        if (Array.isArray(b.runtimes)) { const next = new Set(b.runtimes.filter(r => typeof r === 'string').slice(0, 16)); if ([...next].join() !== [...h.runtimes].join()) { h.runtimes = next; setImmediate(pumpQueue); } }
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
        if (!HASH.test(b.ref) || !store.has(b.ref)) return send(res, 400, { error: 'save blob missing' });
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
        if (!owned || !store.has(savesMatch[1])) return send(res, 404, { error: 'save not found' });
        res.writeHead(200, { ...cors, 'content-type': 'application/octet-stream' });
        return store.stream(savesMatch[1]).pipe(res);
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
      const missing = [...new Set(mf.files.flatMap(f => f.chunks))].filter(c => !store.has(c));
      if (missing.length) return send(res, 409, { error: 'missing chunks', missing: missing.slice(0, 100), count: missing.length });
      games.set(mf.id, mf); writeFileSync(join(GAMES_DIR, `${mf.id}.json`), JSON.stringify(mf, null, 1));
      return send(res, 201, { id: mf.id, manifestHash: manifestHash(mf), files: mf.files.length, runtime: runtimeOf(mf) });
    }
    if (p === '/admin/workers' && req.method === 'GET') {
      if (!ADMIN_TOKEN || !tokenOk(req, ADMIN_TOKEN)) return send(res, 401, { error: 'unauthorized' });
      return send(res, 200, [...hosts.values()].map(h => ({ id: h.id, name: h.name, kind: h.kind, alive: alive(h), load: h.load, capacity: h.capacity, runtimes: [...h.runtimes],
        active: [...h.active], holds: h.holds.size, reservedRamMB: h.reservedRam, encoders: h.caps.encoders, gpu: h.caps.resources?.gpu, flags: h.caps.flags || null, layers: h.caps.layers, emulators: h.caps.emulators || [],
        cachedGames: h.caps.cache?.games?.length || 0, cacheStats: h.cacheStats, isolation: h.caps.isolation, sessions: [...h.status.values()] })));
    }
    if (p === '/v1/games' && req.method === 'GET') return send(res, 200, [...games.values()].map(g => ({ id: g.id, title: g.title, runtime: runtimeOf(g), platform: g.type === 'emulator' ? g.platform : 'windows' })));
    if (p === '/host.html') return send(res, 200, readFileSync(join(HERE, 'host.html')), { 'content-type': 'text/html; charset=utf-8' });
    return send(res, 404, { error: 'not found' });
  } catch (e) {
    if (e instanceof ManifestError) return send(res, 400, { error: e.message });
    if (e.status === 400) return send(res, 400, { error: e.message });
    if (!(e.code === 413)) console.error('[scheduler]', e);
    return send(res, e.code === 413 ? 413 : 500, { error: e.code === 413 ? 'Too large' : 'Server error' });
  }
});
server.listen(PORT, () => log(`Mishrin cloud scheduler on :${PORT} · ${games.size} registered game(s) · storage ${store.kind} · auth ${auth.required ? 'required' : 'optional'}`));
