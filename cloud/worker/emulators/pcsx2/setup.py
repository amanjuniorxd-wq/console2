#!/usr/bin/env python3
"""Install the real PCSX2 profile on a worker.

    sudo apt install pcsx2:i386                       # Ubuntu 24.04 universe: PCSX2 1.6.0 (32-bit)
    sudo python3 setup.py /opt/mishrin/emulators/pcsx2 --bios /path/to/YOUR-ps2-bios.bin

The BIOS must be dumped from a console you own. Mishrin never downloads or ships one. Without --bios the profile is
installed and the worker reports "PS2: runtime installed · BIOS required". For automated tests only, the original
Mishrin test ROM (emulators/ps2/testrom) can be installed instead; the worker then reports it as a test ROM and only
advertises PS2 sessions when started with --allow-test-firmware.
"""
import argparse
import json
import os
import shutil
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, '..', '..'))
from mishrin_worker.profiles import ps2_rom_info  # noqa: E402
from mishrin_worker.manifest import DEFAULT_FULL_PAD, DEFAULT_STICKS  # noqa: E402

HOME = '/home/player/prefix'                         # the session's HOME inside the sandbox
# OnePAD button indices (plugins/onepad/onepad.h gamePadValues)
ONEPAD = {'l2': 0, 'r2': 1, 'l1': 2, 'r1': 3, 'triangle': 4, 'circle': 5, 'cross': 6, 'square': 7, 'select': 8, 'l3': 9, 'r3': 10,
          'start': 11, 'up': 12, 'right': 13, 'down': 14, 'left': 15, 'lup': 16, 'lright': 17, 'ldown': 18, 'lleft': 19,
          'rup': 20, 'rright': 21, 'rdown': 22, 'rleft': 23}


def keysym(name):
    from Xlib import XK
    k = XK.string_to_keysym(name)
    if not k:
        raise SystemExit(f'unknown key {name}')
    return k


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('dest')
    ap.add_argument('--bios', help='your own PS2 BIOS dump (or the Mishrin test ROM, for tests)')
    a = ap.parse_args()
    if not os.path.exists('/usr/games/PCSX2'):
        raise SystemExit('PCSX2 is not installed: sudo apt install pcsx2:i386')
    cfg = os.path.join(a.dest, 'home', '.config', 'PCSX2')
    for d in ('inis', 'bios', 'memcards'):
        os.makedirs(os.path.join(cfg, d), exist_ok=True)
    shutil.copy(os.path.join(HERE, 'emulator.json'), os.path.join(a.dest, 'emulator.json'))
    bios = ''
    if a.bios:
        info = ps2_rom_info(a.bios)
        if not info:
            raise SystemExit(f'{a.bios} is not a PS2 boot ROM (no ROMDIR/ROMVER)')
        bios = os.path.basename(a.bios)
        shutil.copy(a.bios, os.path.join(cfg, 'bios', bios))
        print(f"BIOS: {bios} — {info['desc']}{' (Mishrin test ROM: tests only, cannot boot games)' if info['test'] else ''}")
    with open(os.path.join(cfg, 'PCSX2-reg.ini'), 'w') as f:
        f.write(f'DocumentsFolderMode=User\nCustomDocumentsFolder={HOME}/.config/PCSX2\nUseDefaultSettingsFolder=enabled\n'
                f'SettingsFolder={HOME}/.config/PCSX2/inis\nInstall_Dir=/usr/games\nRunWizard=0\n')
    ui = open(os.path.join(HERE, 'PCSX2_ui.ini.template')).read().replace('@BIOS@', bios or 'Please Configure')
    open(os.path.join(cfg, 'inis', 'PCSX2_ui.ini'), 'w').write(ui)
    binds = {**DEFAULT_FULL_PAD, **DEFAULT_STICKS}       # the same keys the worker presses for each controller input
    lines = ['first_time_wizard = 0', 'log = 0', 'options = 0', 'mouse_sensibility = 500', 'ff_intensity = 32767', 'uid[0] = 0', 'uid[1] = 0']
    lines += [f'PAD 0:KEYSYM 0x{keysym(k):x} = {ONEPAD[b]}' for b, k in binds.items()]
    open(os.path.join(cfg, 'inis', 'OnePAD2.ini'), 'w').write('\n'.join(lines) + '\n')
    # sound: SDL → PulseAudio, i.e. the session's own pulse server, which the worker's encoder captures (Opus)
    open(os.path.join(cfg, 'inis', 'spu2-x.ini'), 'w').write('[OUTPUT]\nOutput_Module=SDLAudio\nLatency=100\nSynch_Mode=0\n[SDL]\nHostApi=pulseaudio\n'
                                                            '[MIXING]\nInterpolation=4\nFinalVolume=100\n')
    for root, dirs, files in os.walk(a.dest):
        os.chmod(root, 0o755)
        for n in files:
            os.chmod(os.path.join(root, n), 0o644)
    print(f'PCSX2 profile installed in {a.dest}' + ('' if bios else ' — no BIOS: the worker will report "BIOS required"'))


if __name__ == '__main__':
    main()
