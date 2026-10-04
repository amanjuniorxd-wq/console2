# Windows games in the cloud (Mishrin Cloud worker)

```
Console (unchanged UI) ─ automatic cloud routing ─▶ Scheduler (server/broker.mjs: /v1 + /api + /worker)
                                                        │  validated manifest · MPC worker selection · saves · reassignment
                                                        ▼
            GPU Game Worker (cloud/worker, Python + GStreamer, runs as root, one per machine)
            ├─ store: SHA-256 chunk CAS → immutable game layer (hard links, delta updates, LRU eviction)
            ├─ runtime layer: pre-booted Wine 9 prefix + DXVK 2.6.1 + VKD3D-Proton 2.14.1 (shared, read-only)
            ├─ per session: tmpfs (storage limit) · overlayfs (prefix + game) · cgroup (RAM/CPU/pids/freezer)
            │    · Xorg dummy display @60 Hz · PulseAudio · bubblewrap sandbox (uid 20000, no net, no caps)
            │    └─ wine C:\Game\<declared exe>   (argv only, never a shell)
            ├─ stream: ximagesrc → encoder (HW: NVENC/VA/VA-API/QSV, else x264/OpenH264/VP8/VP9) + Opus → webrtcbin
            └─ input: data channel → XTest (allow-listed keys, pointer + buttons + wheel, controller → controllerMap)
```

## Session profiles: Windows and emulator workers

The worker runs one *profile* per session (`cloud/worker/mishrin_worker/profiles.py`): **Windows** (Wine prefix layer,
game at `C:\Game`) or an **emulator** described by an `emulator.json` (RPCS3 for PS3-class, PCSX2 for PS2-class; the
binary is bound read-only, the template home with the operator's firmware/BIOS is the overlay's lower layer, the game is
mounted at `~/game`). Isolation, display, audio, streaming, input, save layers, watchdog and cleanup are shared.
A worker advertises `ps3`/`ps2` only when the emulator **and** its firmware are installed. Real RPCS3/PCSX2 have not been
run here; the profile path is tested end-to-end with mock emulators (`cloud/test-games/emulators/`). Templates and
installation notes: `cloud/worker/emulators/`.

## Compatibility targets (controlled, all tested end-to-end)

| Target | Test title | Result |
|---|---|---|
| Simple Win32 (GDI), 64-bit | `mishrin-gdi64` | ✅ launches, streams, input, saves |
| Simple Win32 (GDI), 32-bit (WoW64) | `mishrin-gdi32` | ✅ |
| Direct3D 11, 64-bit, via DXVK → Vulkan | `mishrin-d3d11` | ✅ `DXVK v2.6.1` confirmed from the game's own log |
| Direct3D 9, 32-bit, via DXVK → Vulkan | `mishrin-d3d9` | ✅ |
| Controller input | D-pad/A via `controllerMap` | ✅ |
| Keyboard input | raw keys (allow-listed) | ✅ |
| Mouse input | click at picture position (letterbox-aware), right click, wheel | ✅ |
| Save data | `%APPDATA%` save restored in the next session and after reassignment | ✅ |
| GPU rendering | Vulkan on **llvmpipe (software)** | ⚠️ no physical GPU was available. The DXVK/VKD3D path is real, but hardware GPU and hardware encoders are untested. |
| Direct3D 12 via VKD3D-Proton | installed and selected by `graphics: vkd3d` | ⚠️ **not tested** (no D3D12 test title) |

The test titles are original programs (`cloud/test-games/mishrin_test.c`, built with MinGW). **No commercial Windows game
was tested.** Real-world compatibility is Wine 9 + DXVK's, which is good for many DirectX 9–11 games and poor for titles
with anti-cheat or DRM, kernel drivers, or online-only launchers. Those are out of scope by design (no network for games).

## Security model

* Browsers never send commands: they name a registered game (`catalogId`), or upload one `.exe` that is checked as a PE
  x86/x64 image and launched as `C:\Game\game.exe` with no arguments.
* The manifest is validated twice (scheduler and worker, with identical rules: 29 shared test cases).
* Sandbox (tested): uid 20000, `CapEff=0`, own PID/net/IPC/UTS/user/cgroup namespaces, **no network interfaces**,
  read-only `/usr`, no host `/home`, `/root`, `/etc/shadow` or worker data, minimal `/dev` (+ GPU render nodes only), RAM
  limit (OOM-killed), pids limit (fork bomb contained), storage limit (tmpfs), rlimits, `no_new_privs`, no `Z:` drive.
* One X server, X cookie and PulseAudio per session; the worker holds all cookies, each sandbox only its own.
* Save layers are stored by hash and served back only to a worker running a session of the same player and game.
  Restore rejects traversal, absolute paths, links and devices.
* Limits: per-session time limit, client-heartbeat timeout, idle/background shutdown in the console, hang detection
  (no window for 15–20 s), crash restart (2×) and then a clean end.

## Performance (2-vCPU VM, software Vulkan, software VP8)

| Metric | Value |
|---|---|
| Library → Play → first frame (cached layers) | 6.6–8.2 s, mostly the Wine start |
| Stream | VP8 640×360 at 25–30 fps, ~6 Mbps. H.264 (x264) ranks first when the browser offers it; the test Chromium build has no H.264, so that path is untested. |
| Worker loss → resumed on another worker | ~20 s (failure detection + new Wine start + save restore) |
| Re-publishing an unchanged game | 0 chunks uploaded |
| Second session of a game | 0 chunks downloaded (game layer reused) |
| Save layer for the test title | ~140 B compressed |

## Run a worker

```bash
# once per machine (Ubuntu 24.04)
sudo dpkg --add-architecture i386 && sudo apt update
sudo apt install wine64 wine32:i386 bubblewrap xserver-xorg-core xserver-xorg-video-dummy xauth pulseaudio \
  gstreamer1.0-plugins-{base,good,bad,ugly} gstreamer1.0-nice gstreamer1.0-x gstreamer1.0-pulseaudio \
  7zip \
  python3-gi gir1.2-gst-plugins-bad-1.0 python3-xlib mesa-vulkan-drivers mesa-vulkan-drivers:i386 vulkan-tools zstd
# DXVK + VKD3D-Proton releases unpacked to /opt/mishrin/layers/{dxvk-2.6.1,vkd3d-proton-2.14.1}
sudo useradd -r -u 20000 -M -s /usr/sbin/nologin mishrin-game

# scheduler
WORKER_TOKEN=… ADMIN_TOKEN=… node server/broker.mjs
# worker (root: it creates mounts and cgroups, then drops each game to uid 20000)
cd cloud/worker && sudo /usr/bin/python3.12 -m mishrin_worker --scheduler http://SCHEDULER:8787 --token "$WORKER_TOKEN" --capacity 2
# publish a game
node cloud/tools/pack.mjs ./MyGame ./my-game.json --scheduler http://SCHEDULER:8787 --admin-token "$ADMIN_TOKEN"
```

Then add a catalog entry with `"runtime": "x64-win", "url": "cloud:<id>"` and set Settings → Cloud Gaming → Endpoint.

## Windows archive uploads

Large Windows games should preferably be uploaded as one `.zip` or `.rar` archive. The browser uploads the archive as a single content-addressed file, avoiding browser file-count limits. The worker uses 7-Zip to extract it into the per-session game layer and recursively scans the extracted tree for supported x86/x64 PE `.exe` files, selecting the most likely launcher automatically. Current archive extraction requires an unencrypted ZIP/RAR and `7z` installed on every Windows worker. 7-Zip supports unpacking ZIP and RAR, including RAR5 in current releases. citeturn1search0turn1search5

## Known limitations

* No hardware GPU or hardware encoder was available, so those paths were not tested. Encoder selection prefers them
  automatically when GStreamer can initialise them.
* AV1 needs `rtpav1pay` (gst-plugins-rs), which is not packaged on Ubuntu 24.04; the worker then offers H.264/VP8/VP9 only.
* Controllers are mapped to keyboard keys (`controllerMap`; emulator titles get the full 16-button pad). Native XInput / evdev (a virtual gamepad through `/dev/uinput`) is not implemented.
* Save *state* on Windows titles means the game's save data (files and registry), not a RAM snapshot. Load restarts the game.
* `saveKey` is a per-device capability, not an account system. Production use needs real user authentication.
* Linux titles have no worker yet; the console says so.
* Package storage has no per-user quota yet.
