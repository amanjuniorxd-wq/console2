# Emulator worker profiles (PS2-class, PSP)

Real profiles, each with `install.sh` (installs the emulator), `emulator.json` (fixed argv, formats, save paths,
self-test) and `setup.py` (writes the template home: config, keyboard pad bindings, self-test program):

| Profile | Emulator | Firmware | Tested by |
|---|---|---|---|
| `pcsx2/` | PCSX2 1.6.0 (`pcsx2:i386`) | the operator's own PS2 BIOS (`setup.py --bios`) — never shipped | `npm run test:real-ps2` |
| `ppsspp/` | PPSSPP 1.20.4 built from source (SDL, OpenGL) | none (HLE) | `npm run test:real-psp` |

Layout on a worker (default `--emulators /opt/mishrin/emulators`): `<profile>/emulator.json`, `<profile>/home/…`
(template home), and the self-test program under `<profile>/selftest/` (original Mishrin test software only).

The worker advertises `ps2`/`psp` only when the binary exists, the files listed in `firmware.required` (if any) are
present, and the emulator self-test produced changing frames. Every session gets the template home through an overlay
(read-only lower layer, private upper layer), the emulator directory read-only at `/opt/emu`, the game layer at
`~/game`, no network, and the usual cgroup limits.

Controller: the worker turns the console's full pad into key presses using the title's `controllerMap`
(defaults in `server/lib/manifest.mjs` `DEFAULT_FULL_PAD`: D-pad = arrows, cross x, circle c, square z, triangle v,
L1 q, R1 e, L2 1, R2 3, select BackSpace, start Return, L3 f, R3 g). Configure the emulator's keyboard pad handler with
the same bindings in the template home. A virtual evdev gamepad (uinput) would be the better path; not implemented.
