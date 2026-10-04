# Universal runtime architecture

```
                         MISHRIN CONSOLE (static frontend, /mishrin-console/)
   files / folder ──▶ detectAny()  ──▶ runtime registry ──▶ resolver plan()  ──▶ adapter.launch() ──▶ Session
                     src/runtimes/      src/runtimes/        src/mpc/router.ts    src/runtime/*, src/cloud/client.ts
                     detect.ts          registry.ts
                                              │ live state: device caps + GET /api/runtimes
          ┌──────────────── LOCAL ────────────┴───────────────┐            ┌────────────── CLOUD ──────────────┐
          Browser (WASM / HTML5 / WebGPU)   Mishrin P1 (WASM)              Windows (Wine)  PS2 (PCSX2)  PSP (PPSSPP)
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

Runtime descriptors (`RUNTIMES`): `browser`, `mishrin-p1`, `ps2`, `psp`, `windows-cloud`, `ps4`. Each declares
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
not implemented), ISO 9660 + `SYSTEM.CNF` `BOOT`/`BOOT2` (PS1/PS2-class), ISO 9660 `PSP_GAME`/`UMD_DATA.BIN` (PSP),
`CISO` (PSP CSO, blocks inflated on demand), `\0PBP` + PARAM.SFO `CATEGORY` (PSP EBOOT.PBP; `ME` = PSone classic → P1),
CHD v5 CD/DVD metadata, `\x7fPKG`/`\x7fCNT` (refused / detection only). PS3 discs and folders are recognised only to
refuse them ("PS3 games are not supported by Mishrin."). The cloud repeats the inspection on the bytes it actually stored
and decides the platform itself.

**Archives.** A ZIP / RAR (4 and 5) / 7z file is recognised by magic bytes and treated as one file: the browser lists
only its headers (ZIP central directory incl. ZIP64, RAR block headers — nothing is decompressed) to show name, size and
a likely platform, then uploads it through the normal chunked, resumable, deduplicated path. The scheduler
(`server/lib/archive.mjs`) extracts it with 7-Zip into a private temp dir: listing validated first (no absolute or `..`
paths, no symlinks/hard links, no encryption, ≤ 20 000 entries, ≤ 64 GB, compression-ratio guard), extraction walked
again with `lstat` + `realpath`, nested archives expanded to depth 2, one extraction at a time. Extracted files go into
the content store and the usual inspection decides the platform (Windows, PS2, PSP, or PS1 — handed back to the browser
for P1). Expansions are cached by the archive's content hash. Folder selection keeps only the console files that
matter (a CUE/M3U set or the disc image), so a game folder never trips the "too many files" limit.

## Resolution (cheapest viable path)

`plan()` in `src/mpc/router.ts`: browser can run it → local · local emulator (P1) → local · otherwise cloud, and only
if the cloud runtime exists. Weak devices may prefer cloud for heavy local titles. PS2-class and PSP titles run only on a
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

## Real emulator runtimes (PS2 = PCSX2, PSP = PPSSPP)

Both are ordinary emulator profiles behind the same worker, scheduler, stream, input, save and cleanup code as every
other cloud runtime; the browser never names an emulator (platform → `EMULATOR_PLATFORMS` → worker profile).

| | PS2 | PSP |
|---|---|---|
| Emulator | PCSX2 1.6.0 (`apt install pcsx2:i386`, GSdx OpenGL, SPU2-X → SDL → session PulseAudio, OnePAD keyboard) | PPSSPP 1.20.4 built from source (SDL, OpenGL, SDL audio → session PulseAudio, keyboard mapping in `controls.ini`); `cloud/worker/emulators/ppsspp/install.sh` installs it under `/usr/local/lib/mishrin-ppsspp` |
| Profile | `cloud/worker/emulators/pcsx2/` (`setup.py --bios`) | `cloud/worker/emulators/ppsspp/` (`setup.py`) |
| Firmware check | ROMDIR walk of every file in `bios/` (`RESET`, `ROMVER`); the Mishrin test ROM is recognised and never counts as a BIOS | none: PPSSPP emulates the PSP OS (HLE); no firmware is needed or shipped |
| Formats | ISO, BIN (CHD is detected but refused with a conversion hint: PCSX2 1.6 has no CHD reader) | ISO (UMD), CSO, EBOOT.PBP, game folder |
| Saves | memory cards (`.config/PCSX2/memcards`), flushed by a graceful close (Escape) before the save layer is taken | `PSP/SAVEDATA` |
| Test software | `emulators/ps2/testrom`: original EE+IOP ROM + ISO9660 test disc (CDVD read of `GAME.DAT`, GS drawing, SIO2 pad + memory card, SPU2 tone) | `emulators/psp/testapp`: original Allegrex program (clang/lld, hand-made NID import stubs): `GAME.DAT` read, framebuffer drawing, sceCtrl buttons + analog, sceAudio tone, save data; packaged as ISO, CSO and EBOOT.PBP folder |

**Worker startup self-test** (`selftest.py`): every emulator profile with a `selfTest` block is booted in a throwaway
sandbox exactly like a session; it passes only when its window appears **and the rendered picture changes** (the
program runs). The result (timings, detail, log tail on failure) is part of the worker's capabilities. A runtime is
advertised to the scheduler only when its emulator is runnable (real firmware, or a test ROM / HLE test program when the
worker runs with `--allow-test-firmware`) and the self-test did not fail. Workers also advertise detected capability
flags `{cpu, gpu, hardwareGpu, vulkan, opengl, pcsx2, ppsspp, wine}`; `select.mjs` never places PS2 without `pcsx2` or PSP
without `ppsspp`. Upload defaults: PS2 sessions use a 640x480 display (PCSX2's 4:3 window), PSP the native 480x272
(the browser's compositor scales it: Original Aspect Ratio or Stretch to Device Resolution — no re-rendering).

**Test mode is not READY for PS2.** With the Mishrin test ROM the emulator, the stream, the controller path and saves are
verified for real, but commercial games still need the user's own BIOS, so the registry reports `BIOS_REQUIRED` and the
console shows the setup screen. PSP needs no firmware: a worker whose PPSSPP self-test passes is READY. Nothing in Mishrin downloads, ships or commits BIOS or firmware.

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
(e.g. PPSSPP `PSP/SAVEDATA`), never firmware or config.

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
**Workers** (`cloud/worker`, root, one per GPU host; `--emulators` for PCSX2/PPSSPP profiles). See `deploy/`.

User-provided files (never shipped): games; PS1 BIOS (optional); PS2 BIOS (required by PCSX2). PSP needs no firmware.
The operator installs firmware/BIOS into the emulator profile's template home on the worker.

## Testing

| Area | Suite |
|---|---|
| Detection, registry, resolver, input mapping, `.msave` | `npm run test:unit` |
| PS1 boot / input / saves (real core) | `npm run test:emu`, `npm run test:emu-browser` |
| Display modes: 1080p/1440p/4K/Retina/ultrawide/4:3, resize, fullscreen, persistence | `python3 tests/emu/e2e_display.py` |
| Scheduler: queue, tokens, Windows protocol, failure, reconnection | `node tests/cloud/scheduler.test.mjs` |
| Uploads, inspection, archives (ZIP/RAR/nested/traversal/symlink/bomb), PS2/PSP protocol, auth, saves API, runtime failure | `node tests/cloud/universal.test.mjs` |
| Worker sandbox, layers, saves, emulator profiles | `npm run test:worker` (root) |
| Real workers + browser: Windows titles, PSP/PS2 via mock emulators, 16:9 display modes | `npm run test:windows` (root) |
| **REAL_EMULATOR_TEST** — real PCSX2 / PPSSPP + test software, browser decodes video/audio, full pad, saves, timings | `npm run test:real` (root; `tests/real/report-ps2.json`, `report-psp.json`) |
| Browser runtime, UI, `/mishrin-console/` sub-path | `python3 tests/e2e.py` |
