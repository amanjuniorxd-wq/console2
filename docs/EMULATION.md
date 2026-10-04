# Mishrin console emulation (Mishrin P1–P4)

Mishrin runs **games the user owns**, from files on the user's own device, **inside the browser**. Nothing is uploaded.
Mishrin ships **no** games, BIOS, firmware or keys, and does not download them from anywhere.
P1 boots with PCSX-ReARMed's open HLE BIOS replacement; a user may add their own BIOS dump, which stays on their device.

## Status (tested, not claimed)

| Core | Platform class | Status | What was verified |
|---|---|---|---|
| **Mishrin P1** | PlayStation-1-class | **Working** | Boots EXE / CUE+BIN / BIN / ISO / CHD / M3U in Chromium and in V8 (Node); 60 fps; keyboard, gamepad, touch and mouse (virtual console mouse on port 1 or 2) input; save/load state (bit-exact replay); memory card persists across sessions; fullscreen; Canvas 2D and WebGPU scaling; AudioWorklet audio with no steady-state underruns. Verified with an **original homebrew test program** (`emulators/p1/testgame`). Commercial games were not tested: none can be included. |
| **Mishrin P2** | PlayStation-2-class | **In development** | Discs and CHDs are detected. No local core ships. A cloud path (upload with consent → PCSX2 worker profile) exists and is tested with a *mock* emulator only. |
| **Mishrin PSP** | PSP | **Ready (cloud)** | ISO, CSO, EBOOT.PBP and PSP game folders are detected in the browser (CSO blocks inflated on demand). No local WASM core; the cloud path runs real PPSSPP 1.20.4 on a worker (no firmware needed), verified with an original test program (`emulators/psp/testapp`, `npm run test:real-psp`). |
| **Mishrin P4** | PlayStation-4-class | **Research** | PKG files are detected. No emulator. Feasibility notes below. |

Every disabled button says **Experimental — coming soon** or **Research — not available**. Nothing pretends to run.

## Architecture

```
Console UI ── Upload Game · Library · Emulators · Controllers · Settings          (main thread: input + UI only)
   │
   ▼  Mishrin Emulator API  (src/emu/session.ts — identical for every platform)
   detectFormat() → initialize() → loadGame() → runFrame() / pause() / reset() / saveState() / loadState()
   → setControllerInput() → shutdown()
   │                                          Mishrin Runtime Optimizer (src/mpc/optimizer.ts, ~80% intensity)
   ▼  dedicated Worker per game (src/emu/worker.ts)   profile → budget, catch-up, presentation, caches, presenter
   ├─ deterministic fixed-timestep scheduler (bounded catch-up, resync after stalls, per-frame input latch)
   ├─ EmulatorBackend (src/emu/types.ts)  ← one per platform, lazily imported:  backends/p1.ts  [p2/p3/p4 slots]
   │     └─ core: public/cores/p1/mishrin-p1.wasm (PCSX-ReARMed, clang → WASI, SIMD) — imports WASI only
   │           └─ read-only WASI (src/emu/wasi.ts): /game, /bios, /save; block-cached positional reads
   │                 from OPFS sync handles or File/Blob (memory-mapped style; a 700 MB disc ≠ 700 MB RAM)
   ├─ presenter: Canvas 2D (zero-copy ImageData over core memory) or WebGPU (sharp-bilinear shader)
   └─ audio → AudioWorklet (SharedArrayBuffer ring when cross-origin isolated, else a direct MessagePort)
```

**Adding a platform** means adding a `CoreDescriptor` to `src/emu/registry.ts` and a backend that implements
`EmulatorBackend` to the worker's `BACKENDS` map. The console, player, storage, input, optimizer and tests do not change.

**Lazy loading:** the first console load does not include any emulator code. The Upload/Emulators/Controllers pages
(7 KB), the emulator adapter (18 KB), the worker (5 KB), the P1 backend (8 KB) and the 1.22 MB core (325 KB gzip,
261 KB brotli) download only when used. The core is content-addressed (SHA-256) in the MPC store, so a second launch makes
no network request, and its compiled `WebAssembly.Module` is reused in-page.

## Supported formats (P1)

| Format | Notes |
|---|---|
| `.cue` + `.bin` | Select the CUE together with every BIN it lists. Modes MODE1/2048, MODE1/2352, MODE2/2352, MODE2/2336, AUDIO. |
| `.bin` / `.img` | A single raw data track (a CUE is synthesised by the core). |
| `.iso` | 2048-byte-sector images. |
| `.chd` | CHD v5 (CD). Decompressed on the fly by libchdr inside the core. |
| `.pbp` | Accepted and passed to the core, which supports it natively. **Not tested here** (no PBP test image could be produced). |
| PS-X `.exe` | Homebrew executables. |
| `.m3u` | Multi-disc playlists (every listed file must be selected). Tested with a one-entry playlist. Disc swapping inside a game is not exposed yet. |

Detected and routed to the cloud: P2 DVD ISO/CHD (`BOOT2` in `SYSTEM.CNF`, or DVD metadata in a CHD), PSP ISO/CSO/
EBOOT.PBP (PSone-classic PBPs, `CATEGORY=ME`, stay on P1). Refused with a clear message: PS3 discs and folders
(`PS3_GAME`) — PS3 is not supported — and PKG files. P4 PKG (`\x7FCNT`): research only.

Display (PS1, PS2, PSP): **Original Aspect Ratio** (default; letter/pillarbox) or **Stretch to Device Resolution**
(fills the screen, intentional distortion), in Settings → Display and in the in-game Resolution panel. Both are GPU
compositor scaling of the game's native framebuffer/stream (`object-fit: contain | fill`); the internal resolution is
never raised. Tested at 1080p, 1440p, 4K, Retina (DPR 2), ultrawide, 4:3, live resize and fullscreen
(`tests/emu/e2e_display.py`).

## Validation and security

* **Detection reads headers only** (`Blob.slice`): about 0.2 ms per detection in Node. A 700 MB disc is never read into memory.
* Rejected: unsafe or duplicate file names; CUE/M3U entries with paths or `..`, or that reference files not selected;
  unknown track modes; oversized CUE/M3U; a single CD track over 1 GB; total selection over 64 GB; CHD versions other than v5;
  files with no recognisable filesystem. Damaged images that pass detection fail cleanly at load with a clear message,
  and the worker keeps running (tested).
* **Imports are streamed** into the Origin Private File System in chunks (constant memory), after a quota check.
  The browser falls back to IndexedDB when OPFS is unavailable.
* **Core sandbox:** the core module may import nothing but WASI (checked before instantiation). The WASI layer is
  read-only: no create, truncate or write, no `..`, no nested paths, no sockets (`ENOSYS`), and only the user's selected
  files are visible. The core runs in a dedicated worker with no DOM. A watchdog ends a hung core.
* No arbitrary JavaScript or HTML from game files is executed. Game data is only ever passed to the emulator as bytes.
* User BIOS: exactly 512 KB, `.bin` name, and not blank. It is stored locally and never bundled or uploaded.

## Mishrin Runtime Optimizer (~80% intensity)

`src/mpc/optimizer.ts` contains pure, unit-tested policy functions.

* **Profiles:** Battery · Balanced · Performance · Maximum Mishrin. **Auto** (the default) picks Performance on capable,
  plugged-in desktops and Balanced otherwise.
* **Frame budget:** 80% of a frame (13.33 ms at 60 Hz) in Performance. Battery 60%, Balanced 75%, Maximum 90%.
* **Threads:** `floor((cores − 1) × 0.8)` workers may be used; one core is always left for the UI and audio.
  The P1 core is single-threaded, so P1 uses one emulation worker plus the audio thread.
* **Adaptive presentation:** when emulation plus presentation exceeds the budget, *presentation* frames are skipped
  (never emulated frames, so game speed is unchanged), with hysteresis. Battery presents every 2nd frame.
* **Deterministic scheduling:** fixed timestep at the core's rate, bounded catch-up (2–5 frames by profile), and a resync
  instead of fast-forwarding after a stall (for example a hidden tab).
* **Caches:** disc block cache capped at 5% of RAM (8 MB in low-memory mode); content-addressed core cache;
  compiled-module reuse; a WebGPU pipeline compiled once per worker.
* **Audio:** a 50 ms jitter buffer with refill hysteresis and ±0.5% resampling drift correction.
* **Input:** a press shorter than one frame is latched, so the game still sees it for one frame (taps and quick presses never vanish).

## Measured performance (this environment)

Hardware: a 2-vCPU cloud VM, no GPU (WebGPU on Chromium's software adapter), headless Chromium (Playwright build).
Expect a typical desktop or laptop to have more headroom.

| Metric | Value |
|---|---|
| WASM time per emulated frame (V8, 600 frames) | avg **7.8 ms**, p95 10.4 ms, p99 11.6 ms → ~129 fps capacity |
| In Chromium worker | **60 fps shown / 60 emulated**, 7.4–7.6 ms core + 0.2 ms present, worker busy ~45% |
| Battery profile | 30 fps shown / 60 emulated, worker busy ~42% |
| Core download / compile | 1.22 MB (325 KB gzip) · fetch 58 ms local · compile 5–8 ms |
| Launch → first frame | ~370 ms (first launch) · ~150–260 ms (cached core) |
| Import (copy into OPFS) | ~110 ms for a 1.4 MB CUE+BIN |
| Input → next presented frame | 25–41 ms across runs (includes waiting for the next 60 Hz frame) |
| Memory | core 10.6 MB linear memory · UI-thread JS heap ~3.5 MB while playing |
| Save state | 4.25 MB raw → 67 KB gzip (stored locally) |
| Disc streaming | 16 reads for the boot; 91% block-cache hit rate; 0 physical reads in steady state |
| Audio | 52 ms buffered, 0 underruns in a 3 s steady-state window |
| WebGPU (software adapter) | pipeline compile 12.6 ms; 1280×720 sharp-bilinear pass 82 ms on the software adapter (a real GPU is far faster; Canvas 2D is the default) |

Sources: `tests/emu/core.test.ts` and `tests/emu/e2e_emu.py` print these values on every run.

## Browser compatibility

| Browser | Status |
|---|---|
| Chromium / Chrome (desktop) | **Tested** (all P1 checks pass, including a mobile viewport with touch) |
| Firefox, Safari, Chrome on Android/iOS | **Not tested here.** The required features exist in current versions (WASM SIMD, OffscreenCanvas 2D in workers, FileReaderSync, OPFS sync access handles, AudioWorklet). The console falls back to IndexedDB storage, Canvas 2D presentation and MessagePort audio when a feature is missing, but these paths are verified only in Chromium. |

## P2 / P4 feasibility (why they are not running)

**P2 (PS2-class): Experimental.** The only realistic browser candidate is **Play!** (BSD-2-Clause, github.com/jpd002/Play-).
Its upstream web build (commit `83700b2`) requires:
* **Emscripten 4.0.1** (its CI pins it). This environment cannot install it: emsdk's binaries come from Google storage,
  which is blocked, and Ubuntu only packages 3.1.6.
* **WebAssembly threads** (`-sPTHREAD_POOL_SIZE=2`), which require a cross-origin-isolated page (COOP/COEP). Mishrin
  keeps isolation off by default because it breaks third-party game URLs. P2 would need its own isolated page.
* **WebGL2** for the GS renderer, plus runtime generation of WebAssembly for its MIPS JIT (Mishrin's CSP already allows `wasm-unsafe-eval`).

Upstream describes its browser compatibility as limited. **To add it:** build Play! with Emscripten 4.0.1, wrap it as
`backends/p2.ts` (`EmulatorBackend`), serve it from a COOP/COEP-isolated route, set `CORES.p2.available = true`,
then run the same test suites with an original P2-class test program.

**P4 (PS4-class): Research.** Existing PS4 emulators (shadPS4, fpPS4) run the game's x86-64 code natively on the host CPU
and translate GPU work to Vulkan. A browser cannot execute native x86-64. A WebAssembly x86-64 emulator plus AMD GCN GPU
emulation would be orders of magnitude too slow, and titles also require decrypted system files. Not feasible. What exists:
detection, UI slot, registry entry.

## Known limitations

* Commercial P1 game compatibility is PCSX-ReARMed's (very broad on native platforms), but **only the original test
  program was run here**. Use the optional user BIOS for titles that need it.
* The P1 build uses the interpreter (no dynarec in WebAssembly) and the `gpu_unai` software renderer: native 320×240-class
  resolution, upscaled by the presenter. There is no internal-resolution enhancement.
* One emulation thread per game (the core is single-threaded).
* Analog sticks map to the D-pad (digital pad). DualShock analog mode and rumble are not exposed yet.
* Mouse: the virtual console mouse is plugged in at launch from Settings → Controls → P1 mouse. It is relative (like the
  real peripheral), so the cursor is captured with pointer lock on the first click; Esc releases it. 1 CSS pixel of
  movement = 1 mouse count, clamped to ±127 per frame. Changing the port mid-game emulates a real re-plug (the port reads
  empty for ~0.5 s). Light guns (GunCon/Justifier) are not exposed.
* SharedArrayBuffer audio needs cross-origin isolation, which is off by default; the MessagePort path is used and measured instead.

## Commands

```bash
npm install
npm run build               # type-check + production build (+ .gz/.br)
npm run preview             # http://localhost:4173 → Upload Game
npm run build:p1            # rebuild the P1 core from the pinned source (reproducible, byte-identical)
npm run test:emu            # unit + real-core tests (Node)
npm run test:emu-browser    # Chromium end-to-end (needs `npm run preview` running)
sh emulators/p1/testgame/build.sh   # rebuild the original test disc (needs mipsel-linux-gnu-gcc, chdman)
```
