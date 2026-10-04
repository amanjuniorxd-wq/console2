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
`test-mode` (real emulator verified with Mishrin test software, console firmware/BIOS still required),
`firmware-required` (real emulator installed, setup screen says exactly what the operator must provide),
`not-verified`, `installation-required`, `error` (self-test failed), `mock-only` (test doubles — never available),
`not-deployed`, `no-cloud`, `unsupported`. Each worker emulator reports a registry state computed on the worker:
`READY` (only after the startup self-test booted it **with real user firmware/BIOS**) · `NOT_VERIFIED` ·
`BIOS_REQUIRED` / `FIRMWARE_REQUIRED` · `INSTALLATION_REQUIRED` · `ERROR` · `MOCK`; `BUSY` comes from slot accounting.

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

## Real emulator runtimes (PS2 = PCSX2, PS3 = RPCS3)

Both are ordinary emulator profiles behind the same worker, scheduler, stream, input, save and cleanup code as every
other cloud runtime; the browser never names an emulator (platform → `EMULATOR_PLATFORMS` → worker profile).

| | PS2 | PS3 |
|---|---|---|
| Emulator | PCSX2 1.6.0 (`apt install pcsx2:i386`, GSdx OpenGL, SPU2-X → SDL → session PulseAudio, OnePAD keyboard) | RPCS3 0.0.43 built from source (LLVM 19 PPU recompiler, Vulkan RSX, Cubeb → PulseAudio, keyboard pad handler); `cloud/worker/emulators/rpcs3/install.sh` bundles it + Qt 6.8 under `/usr/local/lib/mishrin-rpcs3`, `patches/` = Ubuntu 24.04 compat |
| Profile | `cloud/worker/emulators/pcsx2/` (`setup.py --bios`) | `cloud/worker/emulators/rpcs3/` (`setup.py --pup`) |
| Firmware check | ROMDIR walk of every file in `bios/` (`RESET`, `ROMVER`); the Mishrin test ROM is recognised and never counts as a BIOS | `dev_flash/sys/external/liblv2.sprx` present (installed with `rpcs3 --installfw` from the operator's own `PS3UPDAT.PUP`) |
| Formats | ISO, BIN (CHD is detected but refused with a conversion hint: PCSX2 1.6 has no CHD reader) | disc game folder (`PS3_GAME/USRDIR/EBOOT.BIN`), decrypted ISO; PKG not wired yet |
| Saves | memory cards (`.config/PCSX2/memcards`), flushed by a graceful close (Escape) before the save layer is taken | `dev_hdd0/home` (save data, trophies) |
| Test software | `emulators/ps2/testrom`: original EE+IOP ROM + ISO9660 test disc (CDVD read of `GAME.DAT`, GS drawing, SIO2 pad + memory card, SPU2 tone) | `emulators/ps3/testapp`: original PPU64 LV2 executable (clang/lld, hand-made import stubs): cellFs `GAME.DAT`, RSX clears, cellPad, cellAudio tone, cellFs save |

**Worker startup self-test** (`selftest.py`): every emulator profile with a `selfTest` block is booted in a throwaway
sandbox exactly like a session; it passes only when its window appears **and the rendered picture changes** (the
program runs). The result (timings, detail, log tail on failure) is part of the worker's capabilities. A runtime is
advertised to the scheduler only when its emulator is runnable (real firmware, or a test ROM / HLE test program when the
worker runs with `--allow-test-firmware`) and the self-test did not fail. Workers also advertise detected capability
flags `{cpu, gpu, hardwareGpu, vulkan, opengl, pcsx2, rpcs3, wine}`; `select.mjs` never places PS2 without `pcsx2` or PS3
without `rpcs3` + Vulkan/OpenGL. Upload defaults: PS2 sessions use a 640x480 display (PCSX2's 4:3 window).

**Test mode is not READY.** With the Mishrin test ROM (PS2) or with RPCS3's built-in HLE libraries and no system
software (PS3) the emulator, the stream, the controller path and saves are verified for real, but commercial games still
need the user's own BIOS / system software, so the registry reports `BIOS_REQUIRED` / `FIRMWARE_REQUIRED` and the console
shows the setup screen. Nothing in Mishrin downloads, ships or commits BIOS or firmware.

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
emulator's pad bindings. Analog sticks travel as `[5, maskHi, maskLo, lx, ly, rx, ry]` (int8); the worker turns each
deflection beyond ±64 into the stick-direction keys of the profile (`lup … rright`), which the emulator's pad config binds
to full deflection. Emulator sessions run with X key autorepeat off (a held button is one press). Keyboard, mouse
(absolute/relative/wheel) and touch go through the same player.

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
| **REAL_EMULATOR_TEST** — real PCSX2 / RPCS3 + test software, browser decodes video/audio, full pad, saves, timings | `npm run test:real` (root; `tests/real/report-ps{2,3}.json`) |
| Browser runtime, UI, `/mishrin-console/` sub-path | `python3 tests/e2e.py` |
