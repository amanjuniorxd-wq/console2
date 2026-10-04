# Mishrin Cloud protocol (v1 + Windows extension v1.1 + universal runtimes v1.2)

Console ⇄ **broker** (HTTP/JSON, CORS) ⇄ **node** (long-poll). Media goes node → console over WebRTC; the broker only relays signaling and package bytes.

## Console → broker

| Call | Body / result |
|---|---|
| `GET /v1/config` | `{ iceServers: RTCIceServer[], runtimes: string[], sessions: number }` |
| `HEAD /v1/packages/{sha256}` | `200` if the node fleet already has the package (no upload needed) |
| `PUT /v1/packages/{sha256}` | raw bytes; rejected unless SHA-256 matches. Identical packages are stored once. |
| `POST /v1/sessions` | `{ game: { id, title, runtime, launchConfig, url? , cas? }, offer: SDP, prefs: { height, fps, kbps }, client }` → `201 { id, answer: SDP }` · `503` no node for that runtime · `504` node timeout |
| `POST /v1/sessions/{id}/heartbeat` | every 15 s; `404` = session gone. Sessions without heartbeat for 45 s are reclaimed. |
| `DELETE /v1/sessions/{id}` | end session, free the node |
| `POST /v1/sessions/{id}/reconnect` | `{ offer }` → `{ id, answer, reassigned }`. Same session on the same worker after a network drop, or **resumed on another worker from the latest save layer** if the worker died. |

### v1.1 aliases and additions (`/api/*`) — same session table

| Call | Purpose |
|---|---|
| `POST /api/session` | = `POST /v1/sessions`. Windows titles are named, never shipped as commands: `game.catalogId` (registered game) or `game.cas` (an uploaded single `.exe`, checked as a PE image). `client.saveKey` (16–64 chars) scopes cloud save data to the player. |
| `GET /api/session/:id` | `{ id, game, state, worker, reassignments, save }` |
| `GET /api/session/:id/status` | the same plus `live` from the worker heartbeat: window titles, stream (codec, encoder, hardware flag, fps, kbps, size), graphics layer (e.g. `DXVK v2.6.1 on …`), restarts, memory peak |
| `POST /api/session/:id/input` | `{ events: [...] }` (≤256), the same vocabulary as the `input` channel. An HTTP fallback when data channels are unavailable. |
| `POST /api/session/:id/save` | snapshot the save layer now → `{ ref, size, raw }` |
| `POST /api/session/:id/reconnect` | = `/v1/sessions/:id/reconnect` |
| `DELETE /api/session/:id` | = `DELETE /v1/sessions/:id` |
| `GET /v1/games` | registered cloud titles (`id`, `title`, `runtime`) |

### v1.2 — universal runtimes

| Call | Purpose |
|---|---|
| `POST /api/session` → `201 { id, token, answer, worker }` | `token` (256-bit) must accompany every later call for that session: header `x-session-token` (or `?token=`). Without it: `403`. Operators may use the admin bearer token instead. |
| `503 { error, queue: { ticket, token, position } }` | every slot for the runtime is busy (workers exist): poll `GET /api/queue/:ticket?token=` → `{ state: waiting\|ready, position }`; when `ready`, repeat `POST /api/session` with `ticket` + `ticketToken` within 30 s to claim the held slot. `DELETE /api/queue/:ticket` leaves the line. `503 { deployed:false }` = no worker for that runtime at all; `503 { fits:false }` = workers exist but none can ever host the title (RAM/GPU). |
| `GET /api/runtimes` | live capability report per worker runtime: `{ runtimes: { [rt]: { workers, capacity, active, held, free, queued, gpuWorkers, hardwareGpu, emulators:[{name,version,firmware,mock}], mock } }, sessions, auth }` |
| `POST /api/uploads` `{ files:[{path,size,chunks[]}], title }` → `{ id, missing[], chunkSize }` | chunked upload, 4 MiB chunks, SHA-256 each. Re-declaring resumes (only missing chunks are listed). Chunks already stored anywhere are not re-sent. |
| `PUT /api/uploads/:id/chunks/:sha` | raw chunk; must belong to the upload and match its hash |
| `POST /api/uploads/:id/complete` → `{ id, platform, runtime, title, serial, boot, format }` | the scheduler checks chunk sizes and inspects the bytes (PE header, EBOOT.PBP PARAM.SFO, CSO, ISO 9660 SYSTEM.CNF / UMD_DATA.BIN / PSP_GAME, CHD metadata). A single ZIP/RAR/7z file (magic bytes) is extracted server-side with 7-Zip first (no absolute or `..` paths, no links, no encryption, entry/size/ratio limits, nested archives to depth 2; cached by content) and its contents are inspected. `422` PS1-class (runs locally; for an archive the response lists `files` instead, fetched with `GET /api/uploads/:id/files/:i`), `422` PS3 (not supported), `415` unsupported, `429` too many pending uploads. Then play with `game: { runtime, upload: id }`. Uploads are owner-scoped. Requirements of uploaded console titles use platform defaults, overridable by the operator: `UPLOAD_DEFAULTS='{"psp":{"ram":1024}}'`. |
| `GET /api/saves` · `GET /api/saves/:game/data[?ref=]` · `POST /api/saves/:game/import` · `DELETE /api/saves/:game` | cloud save layers of the calling player (device token or `x-save-key`). Import accepts zstd/gzip save layers only. |
| `POST /api/auth/device` `{deviceId?}` (+ `Bearer <client key>` when `CLIENT_KEYS` is set) → `{ token, deviceId, expires }` | HMAC device token; send as `x-device-token`. With `AUTH_REQUIRED=1`, sessions, uploads, package PUTs and saves require it. |
| `GET /v1/packages/:sha` | **workers only** (worker token). Chunks may belong to other players. |

Worker runtimes on the wire: `x64-win`, `x86` (Wine), `ps2` (PCSX2 profile), `psp` (PPSSPP profile), `wasm` (legacy node).
The console maps its kinds `p2 → ps2`, `psp → psp`.

ICE is non-trickle: both sides finish gathering before sending SDP (one round-trip, simpler NAT story; use TURN in `ICE_SERVERS` for restrictive networks).

## Data channels (created by the console)

* `input` — `ordered:false, maxRetransmits:0` (latest input wins, never head-of-line blocked)
  * `[1, button, down]` — logical button derived from the **keyboard** (0 up 1 down 2 left 3 right 4 A 5 B 6 start). PC workers ignore it because raw keys carry the same press.
  * `[3, button, down]` — logical button from a **controller or touch** control. PC workers map it to keys through the manifest's `controllerMap`; WASM nodes treat it like type 1.
  * `[2, buttons, x:u16, y:u16]` — pointer, normalized 0–65535 over the game picture (letterbox excluded). Buttons are the DOM bitmask (1 left, 2 right, 4 middle). PC workers move the X pointer and press X buttons; WASM nodes call the optional `mpc_pointer(x, y, buttons)` export in framebuffer pixels.
  * `[4, steps:i8]` — mouse wheel, in notches (positive = down). PC workers click X buttons 4/5.
  * `[5, mask:u16]` — full controller state, 16 buttons in this bit order: up, down, left, right, cross, circle, square, triangle, l1, r1, l2, r2, select, start, l3, r3 (big-endian u16). Sent instead of type 3 when the worker announced `caps.pad = 'full'` (emulator workers); mapped to keys through the manifest's full-pad `controllerMap`.
  * text `k1KeyW` / `k0KeyW` — raw key down/up (`KeyboardEvent.code`) for PC titles
* `ctl` — reliable JSON
  * node → console: `{t:'caps', save:bool, pad?:'full'|'logical'}`, `{t:'saved', id, data:base64}`, `{t:'loaded', id, ok}`, `{t:'notice', text}` (e.g. crash restart), `{t:'end', reason}`
  * On Windows workers, `saved.data` is a reference to the cloud save layer (`{ref,size,raw,…}`), not the data itself. `load` restarts the game from that layer. The scheduler only lets a worker read saves that belong to the player and game of a session it runs.
  * console → node: `{t:'quality', height, fps, kbps}` (sent by live AIMD adaptation), `{t:'pause', on}`, `{t:'save', id}`, `{t:'load', id, data}`

## Worker API (`/worker/*`, `Authorization: Bearer $WORKER_TOKEN`)

| Call | Purpose |
|---|---|
| `POST /worker/register` | capabilities: runtimes, capacity, RAM/CPUs, Vulkan device (+ hardware flag), usable encoders (+ hardware ones), codecs, runtime layer versions, cached game layers, isolation features → `{ id }` |
| `POST /worker/heartbeat` | every 5 s: load, per-session status, cache contents and stats → `{ unknown: [sessionIds] }` (sessions to clean up). A missed heartbeat for 15 s marks the worker dead; its sessions become *orphaned* until a client reconnects (reassigned) or a grace period ends. |
| `POST /worker/allocate` | long-poll (25 s) for the next assignment: `session` (validated manifest + manifestHash + offer + prefs + iceServers + restore ref), `reconnect`, `end`, `save`, `input` |
| `POST /worker/answer` | `{ id, sdp }` or `{ id, error }` |
| `POST /worker/release` | `{ sessionId, reason }`, or `{ bye: true }` on shutdown |
| `POST /worker/save` | register an uploaded save layer `{ sessionId, ref, size, raw, files, kind }` (accepted for 2 minutes after a session ends, for the final save) |
| `POST /worker/save-result` | result of an `/api/session/:id/save` request |
| `GET /worker/saves/:ref?session=&worker=` | download a save layer (ownership checked) |

**Worker selection (MPC).** Hard filters: alive, runtime, free slot, free RAM, Vulkan for GPU titles, not excluded.
Score: cached game layer +50, hardware GPU (GPU titles) +30, hardware encoder +15, minus load and occupancy.
A start failure is retried once on another worker.

## Emulator game manifest (PS2-class / PSP; same validators)

```json
{ "id": "my-psp-title", "title": "…", "type": "emulator", "platform": "psp", "emulator": "ppsspp",
  "boot": "GAME/EBOOT.PBP", "files": [ … ], "network": false,
  "requirements": { "ram": 1536, "cpus": 2 }, "display": { "width": 480, "height": 272 },
  "controllerMap": { "cross": "x", "circle": "c", … } }
```

`emulator` is fixed per platform (`ps2 → pcsx2`, `psp → ppsspp`); clients never choose a binary. `boot` must be a file of
the game (`.iso`, `.cso` or `EBOOT.PBP` for psp; `.iso/.chd/.cue` for ps2). No arguments. The worker builds the command line
from its own `emulator.json` profile (`{binary}` + fixed flags + `{boot}`), see `cloud/worker/mishrin_worker/profiles.py`.

## Windows game manifest (validated by the scheduler *and* the worker)

```json
{ "id": "my-game", "title": "My Game", "type": "windows", "runtime": "wine",
  "executable": "bin/Game.exe", "workingDirectory": "bin", "args": ["-windowed"],
  "network": false, "graphics": "auto|dxvk|vkd3d|wined3d|gdi", "arch": "auto|x64|x86",
  "requirements": { "ram": 4096, "gpu": true, "cpus": 2, "storageMB": 4096, "maxMinutes": 240 },
  "display": { "width": 1280, "height": 720 },
  "controllerMap": { "a": "Return", "b": "Escape", "start": "Escape" },
  "files": [{ "path": "bin/Game.exe", "size": 123, "chunks": ["<sha256>", "…"] }] }
```

The executable must be a `.exe` listed in `files`. Paths are relative with no `..`, drive letters, reserved names or
shell metacharacters. `args` are plain strings (argv, never a shell). `network` must be `false`. Publish with
`node cloud/tools/pack.mjs <dir> <manifest.json> --scheduler URL --admin-token T`: 4 MiB SHA-256 chunks, only missing
chunks uploaded, then `POST /admin/games`.

## Legacy node API (`server/host.html`)


`POST /v1/hosts/register {runtimes, capacity}` → `{id}` · `GET /v1/hosts/{id}/poll` (25 s long-poll; `{type:'session', id, game, offer, prefs, iceServers}` or `{type:'end', id}`) · `POST /v1/hosts/{id}/answer {id, sdp | error}` · `POST /v1/hosts/{id}/ended {id}` · `POST /v1/hosts/{id}/bye`.

## Node implementations

* `server/host.html` — reference node for `wasm` (MPC Framebuffer ABI) titles. Run it in a GPU-backed headless Chromium on the node machine: `chromium --headless=new --use-gl=egl "http://BROKER/host.html?broker=http://BROKER&capacity=4"`.
* `cloud/worker` — the Windows GPU game worker (`x64-win`, `x86`): Wine 9 (WoW64) + DXVK + VKD3D-Proton, one bubblewrap sandbox per session, GStreamer `webrtcbin` streaming, XTest input. See `docs/WINDOWS-CLOUD.md`. Linux titles are not implemented yet; the console says so.

## Isolation requirements for nodes

One disposable sandbox per session (container or microVM), no host filesystem mounts, no privileges, egress firewall (allow only TURN/STUN + broker), package verified by SHA-256 before launch, sandbox destroyed on `end`.
