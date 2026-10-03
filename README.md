# MISHRIN CONSOLE — *Games Beyond Limits*

A browser game console powered by the **Mishrin Paradoxical Computer (MPC)** orchestration layer.
`Open → choose game → Play.` Only games, controller-first, local or cloud chosen automatically.

```
files / folder → universal detector → runtime registry → resolver (browser → local emulator → cloud) → adapter → Session
                  src/runtimes/        (status from live device + cloud worker reports, never hardcoded)
LOCAL   Browser (WASM · HTML5 · WebGPU)     Mishrin P1 (PCSX-ReARMed → WASM)
CLOUD   Windows (Wine + DXVK)   PS2-class (PCSX2 profile)   PS3-class (RPCS3 profile)   → scheduler → isolated GPU workers → WebRTC
```

Architecture: [docs/universal-runtime-architecture.md](docs/universal-runtime-architecture.md) · protocol: [server/PROTOCOL.md](server/PROTOCOL.md) · deployment: [deploy/](deploy/)

## What runs where (tested)

| Content | Runs | Status |
|---|---|---|
| HTML5 / MPC WASM games | this device | **Ready** |
| PS1-class discs (CUE/BIN, ISO, CHD, EXE, M3U) — **Mishrin P1** | this device, files never leave it | **Ready** (original test program; see [docs/EMULATION.md](docs/EMULATION.md)) |
| Windows games (Win32, D3D9/11 via DXVK, 32/64-bit) | cloud worker (Wine) | **Ready** on the tested targets; availability = deployed workers ([docs/WINDOWS-CLOUD.md](docs/WINDOWS-CLOUD.md)) |
| PS2-class — Mishrin P2 | cloud worker (PCSX2 profile) | **In development**: detection, upload, scheduling and worker profile tested with a *mock* emulator; no real PCSX2 run |
| PS3-class — Mishrin P3 Cloud | cloud GPU worker (RPCS3 profile) | **Architecture ready · runtime not deployed**: full pipeline tested with a *mock* RPCS3 |
| PS4-class — Mishrin P4 | — | Research (detection only) |
| Linux titles | — | Not implemented (the console says so) |

User-provided, never shipped: games; PS1 BIOS (optional); PS2 BIOS and PS3 system software (installed on the worker by
its operator). PS2/PS3-class games are uploaded only to the player's own cloud, only after explicit consent.

**Licensing:** the Mishrin P1 core is PCSX-ReARMed (**GPL-2.0-or-later**). Its complete corresponding source, the GPL text
and a notice ship next to the core in `public/cores/p1/`. Read [emulators/p1/LICENSE-NOTICE.md](emulators/p1/LICENSE-NOTICE.md)
before distributing. Mishrin includes **no** games, BIOS, firmware or keys.

## Input: controller, keyboard, mouse, touch (all at once, no mode switch)

| | Console UI | MPC WASM games | HTML5 games | Mishrin P1 | Windows (cloud) |
|---|---|---|---|---|---|
| **Controller** (Gamepad API, standard mapping) | ✅ D-pad/stick, A/B, LB/RB, Home | ✅ | ✅ (game's own Gamepad API) | ✅ full pad | ✅ via manifest `controllerMap` |
| **Keyboard** | ✅ arrows/WASD, Enter/Space/Z, Esc/X, Q/E | ✅ | ✅ | ✅ (Controllers page shows the map) | ✅ raw keys (allow-listed) |
| **Mouse** | ✅ click/hover | ✅ if the module exports `mpc_pointer` | ✅ (sandboxed iframe, pointer lock allowed) | ✅ virtual console mouse on port 1/2 (Settings → Controls → P1 mouse), cursor captured on first click | ✅ move, left/right/middle click, wheel |
| **Touch** | ✅ | ✅ on-screen pad | ✅ | ✅ on-screen pad | ✅ on-screen pad → `controllerMap` |

Mouse coordinates are measured against the picture itself, so clicks on letterbox bars are ignored and a click lands on the
same game pixel at any window size. Right click goes to the game, not the browser menu. Every row above has an automated
test (see below).

## Tests

| Suite | Command | Checks |
|---|---|---|
| Console logic: routing, registry, resolver, input mapping, `.msave`, detection | `npm run test:unit` | 45 |
| Console in Chromium (incl. Saves, `/mishrin-console/` sub-path, stream stats) | `python3 tests/e2e.py` (preview + a dev scheduler on :8788) | 42 |
| Emulation logic (detection, optimizer, WASI sandbox) | `npm run test:emu-unit` | 29 |
| Real P1 core (V8) | `npm run test:emu-core` | 30 |
| P1 in Chromium (incl. runtime status) | `npm run test:emu-browser` | 33 |
| Cloud scheduler: queue, session tokens, Windows protocol, failure, reconnection | `node tests/cloud/scheduler.test.mjs` | 44 |
| Universal runtimes: uploads, inspection, PS2/PS3 worker protocol (mock workers), auth, saves API | `node tests/cloud/universal.test.mjs` | 51 |
| Worker: sandbox, layers, saves, emulator profiles | `npm run test:worker` (root) | 35 |
| End-to-end, 2 real workers: Windows titles + PS3/PS2 via **mock** emulators | `npm run test:windows` (root) | 44 |

`npm run test:scheduler` runs both scheduler suites.

## Quick start

```bash
npm install
npm run build          # type-check + production build + size report (writes .gz/.br)
npm run preview        # http://localhost:4173
npm run cloud          # optional: reference cloud broker on :8787
```
Cloud node (optional): open `http://localhost:8787/host.html` in a Chromium on the node machine, then set **Settings → Cloud Gaming → Endpoint** to `http://localhost:8787`.

## Adding games

Either **Library → Add Game** (file or URL) / **Add game file** on any slot, or one line in `public/games/catalog.json`:

```json
{"id":"my-game","title":"My Game","artwork":"/art/my-game.avif","description":"…","runtime":"wasm","url":"/games/my-game.wasm","requirements":{"memMB":64},"launchConfig":{"pixelated":true}}
```

| `runtime` | Runs on | Package |
|---|---|---|
| `wasm` | this device (worker), cloud fallback | MPC Framebuffer ABI `.wasm` |
| `web` | this device (sandboxed iframe) | single `.html` or a URL |
| `webgpu` | this device if WebGPU, else cloud | `.html` / URL |
| `x86`, `x64-win`, `linux` | cloud compatibility node only | `.exe` / ELF / URL |

`artwork` may be any image URL (AVIF/WebP/SVG preferred) or `gen:fantasy|racing|scifi|action|landscape` for built-in procedural art. Optional `sha256` makes repeat launches zero-request (`npm run build:games` stamps it for bundled games); optional `chunks:[{h,url,size}]` enables delta updates (only changed chunks download).

Unsupported titles are never faked: a Windows game without a cloud node says so and points to Settings.

### MPC Framebuffer ABI v1 (`runtime: "wasm"`)
Import-free module exporting `memory`, `mpc_init(seed)`, `mpc_width()`, `mpc_height()`, `mpc_frame(dtMs) → ptr` (RGBA8), `mpc_input(button, down)`, optional `mpc_state_ptr()/mpc_state_size()` for save states, optional `mpc_pointer(x, y, buttons)` for mouse (framebuffer pixels; buttons bit 0 left, 1 right, 2 middle; called on move/press/release over the picture). See `games-src/ember-drift.c` (compiled with clang → 6 KB).

### Web package protocol (optional, `runtime: "web"`)
`parent.postMessage({mpc:'ready', caps:['save','pause']})`; answer `{mpc:'save'}` with `{mpc:'state', data}`; handle `{mpc:'load', data}` and `{mpc:'pause', on}`. See `public/games/saffron-run/index.html`.

## What MPC actually optimizes (all measurable)

| Mechanism | Where |
|---|---|
| Content-addressed package store (SHA-256): dedup, integrity, zero-request relaunch | `src/mpc/store.ts` |
| Compiled `WebAssembly.Module` LRU (byte budget; 16 MB in Low Memory Mode) | `store.ts` |
| Chunked delta updates | `store.ts` (`chunks`) |
| Cache prediction: warm the focused title after 450 ms dwell, idle-time, skipped on Data Saver | `src/mpc/index.ts` |
| Zero-copy framebuffer: `ImageData` view over WASM memory, rebuilt only on memory growth | `src/runtime/fb-loop.ts` |
| Render-scale for web/cloud; GPU compositor upscaling | `local-web.ts`, `player.ts` |
| Save states gzip-compressed (native `CompressionStream`) — e.g. 492 B → ~150 B | `src/mpc/saves.ts` |
| Adaptive local/cloud routing from device memory, cores, WebGPU, network RTT/Data Saver | `src/mpc/router.ts` (unit-tested) |
| Live AIMD bitrate/resolution/FPS adaptation from WebRTC stats | `src/cloud/client.ts` |
| Cloud package dedup: `HEAD` before upload, upload once per hash | `client.ts`, `broker.mjs` |
| Idle / background cloud shutdown + broker reaper | `client.ts`, `broker.mjs` |
| Reclamation: worker terminated, modules dropped under Low Memory / background | `player.ts`, `main.ts` |
| Code-split adapters: a title downloads only the adapter it needs | `src/mpc/index.ts` |

MPC reduces resource use; it cannot create RAM/GPU or beat compression limits.

## Security

* WASM titles: import-free modules in a dedicated worker — no DOM, network, clock or filesystem access.
* Web titles (bundled or attached): fetched through the MPC store and run in `/runner.html` inside `sandbox="allow-scripts allow-pointer-lock"` — opaque origin (no access to console storage/DOM) plus a CSP that blocks outside network (verified by e2e). Cross-origin URL titles load directly and keep their own origin.
* Packages validated by magic bytes + `WebAssembly.validate` + optional SHA-256; 1 GB cap; HTML fallback pages never cached as binaries.
* Console CSP in `index.html`; no third-party scripts, fonts or trackers.
* Cloud nodes: one disposable sandbox per session (see `server/PROTOCOL.md`).

## Deployment notes

* Serve `dist/` from any static host; prefer the pre-compressed `.br`/`.gz` siblings; cache `/assets/*` as immutable.
* Optional cross-origin isolation (`COOP: same-origin`, `COEP: credentialless`) enables SharedArrayBuffer/WASM threads for user modules; it also blocks third-party game URLs that don't send CORP headers, so it is off by default. MPC detects it at runtime.
* `npm test` = 17 unit checks + 33 Playwright e2e checks (needs `npm run preview` and `npm run cloud` running). Screenshots land in `tests/shots/`.

## Layout

```
src/ui          shell, router, views (home/detail eager; library, settings, player lazy)
src/components  nav (spatial + gamepad), cards, art, logo, icons, ui helpers
src/runtime     adapter interface, LocalWASM, Web/WebGPU, worker
src/mpc         probe, router, store, saves, idb, MPC facade
src/cloud       WebRTC cloud adapter
src/games       manifest types, catalog
src/styles      app.css      public/  sw.js, catalog, bundled demo games
server/         reference broker + node, protocol      games-src/  demo WASM game (C)
tests/          unit.test.ts, e2e.py
```
