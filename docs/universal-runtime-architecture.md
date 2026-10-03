# Universal runtime architecture

```
                         MISHRIN CONSOLE (static frontend, /mishrin-console/)
   files / folder ──▶ detectAny()  ──▶ runtime registry ──▶ resolver plan()  ──▶ adapter.launch() ──▶ Session
                     src/runtimes/      src/runtimes/        src/mpc/router.ts    src/runtime/*, src/cloud/client.ts
                     detect.ts          registry.ts
                                              │ live state: device caps + GET /api/runtimes
          ┌──────────────── LOCAL ────────────┴───────────────┐            ┌────────────── CLOUD ──────────────┐
          Browser (WASM / HTML5 / WebGPU)   Mishrin P1 (WASM)              Windows (Wine)  PS2 (PCSX2)  PS3 (RPCS3)
          src/runtime/local-*.ts            src/emu/*                       scheduler server/broker.mjs ─▶ GPU workers
                                                                            cloud/worker (profiles.py)
```

## Runtime model

One `Session` interface (`src/runtime/types.ts`) for every runtime: `input/padInput/padState/rawKey/pointer/wheel`,
`save/load`, `pause`, `stats`, `dispose`, `onEnd`. The requested lifecycle maps onto it as follows:

| Requested | Where it lives |
|---|---|
| `detect()` | `src/runtimes/detect.ts` `detectAny()` (browser), `server/lib/inspect.mjs` (cloud, authoritative for uploads) |
| `validate()` | browser detector + `server/lib/manifest.mjs` + `cloud/worker/mishrin_worker/manifest.py` (same 45 shared cases) |
| `prepare()` | adapter `launch()` phase 1: package/core fetch (MPC CAS), or chunked upload + worker allocation |
| `launch()` | `RuntimeAdapter.launch(ctx) → Session` |
| `pause()/resume()` | `Session.pause(on)` |
| `stop()/destroy()` | `Session.dispose()` (cloud: `DELETE /api/session/:id` → worker tears down sandbox, mounts, cgroups) |
| `save()/load()` | `Session.save()/load()` + `src/saves/manager.ts` |
| `status()` | `Session.stats()` (+ `details`), cloud `GET /api/session/:id/status` |
| `capabilities()` | `src/runtimes/registry.ts` (static) + `liveStatus()` (live) + `GET /api/runtimes` (cloud) |

Runtime descriptors (`RUNTIMES`): `browser`, `mishrin-p1`, `ps2`, `ps3-cloud`, `windows-cloud`, `ps4`. Each declares
platform, local/cloud, engine, **maturity** (`ready` · `in-development` · `architecture-ready` · `research`), the
`Game.runtime` kinds it serves, the worker runtimes that back it, formats, and the files the user must provide.
**Adding a runtime** = one descriptor + one adapter (local) or one worker profile (cloud). The frontend needs no change:
Upload Game, Library, game detail, Emulators → Runtime status and the resolver all read the registry.

`liveStatus()` turns maturity + live facts into what the UI shows: `available`, `busy` (you will be queued),
`mock-only` (only test-double workers — never shown as available), `not-deployed`, `no-cloud`, `unsupported`.

## Detection

Bytes, not names: `\0asm` + MPC exports (browser), `<html` (browser), MZ/PE machine (Windows x64/x86), ELF (Linux —
not implemented), `PS3_GAME/PARAM.SFO` + SELF/ELF `EBOOT.BIN` (PS3-class folder), ISO 9660 + `SYSTEM.CNF`
`BOOT`/`BOOT2` (PS1/PS2-class), `PS3_DISC.SFB` (PS3-class ISO), CHD v5 CD/DVD metadata, `\x7fPKG`/`\x7fCNT` (PS3/PS4 PKG,
detection only). The cloud repeats the inspection on the bytes it actually stored and decides the platform itself.

## Resolution (cheapest viable path)

`plan()` in `src/mpc/router.ts`: browser can run it → local · local emulator (P1) → local · otherwise cloud, and only
if the cloud runtime exists. Weak devices may prefer cloud for heavy local titles. PS2/PS3-class titles run only on a
cloud worker and only after the player uploaded them to *their* cloud. Cloud resources are allocated at Play, never
for browsing.

## Scheduling (server/broker.mjs)

* Workers register capabilities (runtimes, capacity, RAM, Vulkan device, encoders, emulators + firmware presence,
  isolation) and heartbeat every 5 s. A worker advertises a runtime only if it can start a game now (emulator
  installed **and** user firmware/BIOS present).
* Selection (`server/lib/select.mjs`): hard filters (alive, runtime, free slot incl. queue holds, RAM, GPU) then score
  (cached game layer, hardware GPU/encoder, load).
* **Queue**: when every slot is busy the client gets `503 {queue:{ticket, token, position}}`, polls
  `GET /api/queue/:ticket`, and the first freed slot is *held* for the head of the line (FIFO, 30 s claim window).
* Start failure → one retry on another worker; firmware/BIOS/capacity errors are returned immediately.
* Worker loss → sessions orphaned → `reconnect` resumes on another worker from the latest save layer.
* Timeouts: client heartbeat, per-title max minutes, orphan grace, worker heartbeat.

## Storage

`server/lib/storage.mjs` — content-addressed object store (SHA-256), filesystem backend; an S3/R2/GCS backend only
implements `has/size/put/stream/read`. Uploads (`/api/uploads`): fixed 4 MiB chunks → declare file list → server lists
missing chunks (dedup across everyone) → `PUT` each chunk (hash-verified) → `complete` (sizes checked, bytes inspected,
manifest synthesised). Resume = declare again. Only metadata/references live in the app (`url: "upload:<id>"`). Games
are never in Git; test fixtures are original programs.

## Streaming

WebRTC (`webrtcbin` on the worker, browser `RTCPeerConnection`), non-trickle ICE, unordered `input` channel, reliable
`ctl` channel; HTTP `POST /api/session/:id/input` fallback. The client tracks FPS, RTT, received bitrate, packet loss,
jitter buffer and connection state (in-game Performance panel) and adapts bitrate/resolution/FPS (AIMD).

## Controller input (src/input/)

One canonical 16-button full pad in standard Gamepad layout; one shared gamepad poller (`input/gamepad.ts`) feeds UI
navigation, the player, P1 and the Controllers page. Derived per runtime: logical 7 buttons (menus, WASM/web, Windows
`controllerMap`), libretro bits (P1), full mask on the wire (`[5, mask:u16]`) for emulator workers, which map it to the
emulator's pad bindings. Keyboard, mouse (absolute/relative/wheel) and touch go through the same player.

## Saves (src/saves/)

`SaveManager`: **Local** (save states), **Emulator** (P1 memory cards), **Game Data** (HTML5 save protocol), **Cloud**
(save layers per player+game on the scheduler: `GET/DELETE /api/saves`, `/data`, `/import`). Export/import as `.msave`
(header + native payload). Cloud save layers are captured from the emulator profile's declared save scope only
(e.g. RPCS3 `dev_hdd0/home`), never firmware or config.

## Security

Untrusted games: per-session bubblewrap sandbox (uid 20000, no capabilities, no network, private PID/IPC/UTS/user
namespaces, read-only `/usr`, minimal `/dev`), cgroup RAM/CPU/pids limits, tmpfs storage limit, hang/crash detection,
time limits. Only manifest-declared executables or the worker's own emulator profile are started, as argv (no shell);
emulator profiles are validated (`argv` = `{binary}` + fixed flags + `{boot}`, paths confined). Upload validation:
path traversal, chunk counts/sizes, hashes, content inspection. **Session tokens**: every control call needs the
256-bit token returned at creation. **Authentication**: optional HMAC device tokens (`AUTH_REQUIRED=1`,
`CLIENT_KEYS`); chunks are readable only by workers; uploads and saves are owner-scoped.

## Deployment

Independent tiers: **Frontend** (static `dist/`, relative base — works at `/mishrin-console/`), **API + Broker**
(`server/broker.mjs`, stateless except `DATA_DIR`), **Storage** (`CAS_DIR` or an object-store backend),
**Workers** (`cloud/worker`, root, one per GPU host; `--emulators` for RPCS3/PCSX2 profiles). See `deploy/`.

User-provided files (never shipped): games; PS1 BIOS (optional); PS2 BIOS (required by PCSX2); PS3 system software
(required by RPCS3). The operator installs firmware/BIOS into the emulator profile's template home on the worker.

## Testing

| Area | Suite |
|---|---|
| Detection, registry, resolver, input mapping, `.msave` | `npm run test:unit` |
| PS1 boot / input / saves (real core) | `npm run test:emu`, `npm run test:emu-browser` |
| Scheduler: queue, tokens, Windows protocol, failure, reconnection | `node tests/cloud/scheduler.test.mjs` |
| Uploads, inspection, PS2/PS3 worker protocol (mock workers), auth, saves API, runtime failure | `node tests/cloud/universal.test.mjs` |
| Worker sandbox, layers, saves, emulator profiles | `npm run test:worker` (root) |
| Real workers + browser: Windows titles, PS3/PS2 via mock emulators | `npm run test:windows` (root) |
| Browser runtime, UI, `/mishrin-console/` sub-path | `python3 tests/e2e.py` |
