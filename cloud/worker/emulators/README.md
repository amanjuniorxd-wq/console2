# Emulator worker profiles (PS2/PS3-class) — deployment templates

**Status: architecture ready, runtime not deployed.** These templates have *not* been run against real RPCS3/PCSX2
in this repository (no GPU host, no firmware). The worker side they plug into is tested with mock emulators
(`cloud/test-games/emulators/`, `tests/cloud/test_worker.py`, `tests/cloud/e2e_windows.py`).

Layout on a worker (default `--emulators /opt/mishrin/emulators`):

```
/opt/mishrin/emulators/rpcs3/
  emulator.json            ← copy of rpcs3.emulator.json, version adjusted
  rpcs3/…                  ← extracted RPCS3 AppImage (./rpcs3-*.AppImage --appimage-extract; rename squashfs-root → rpcs3)
  home/.config/rpcs3/…     ← template home: config.yml, input config (Keyboard handler bound to the keys below),
                             dev_flash/ installed from the OPERATOR'S OWN PS3UPDAT.PUP (never shipped by Mishrin)
/opt/mishrin/emulators/pcsx2/
  emulator.json            ← copy of pcsx2.emulator.json
  pcsx2/…                  ← extracted PCSX2 AppImage
  home/.config/PCSX2/bios/ ← the operator's own PS2 BIOS dump
```

The worker advertises `ps3`/`ps2` only when the binary exists **and** the files listed in `firmware.required` are
present. Every session gets the template home through an overlay (read-only lower layer, private upper layer), the
emulator directory read-only at `/opt/emu`, the game layer at `~/game`, no network, and the usual cgroup limits.

Controller: the worker turns the console's full pad into key presses using the title's `controllerMap`
(defaults in `server/lib/manifest.mjs` `DEFAULT_FULL_PAD`: D-pad = arrows, cross x, circle c, square z, triangle v,
L1 q, R1 e, L2 1, R2 3, select BackSpace, start Return, L3 f, R3 g). Configure the emulator's keyboard pad handler with
the same bindings in the template home. A virtual evdev gamepad (uinput) would be the better path; not implemented.
