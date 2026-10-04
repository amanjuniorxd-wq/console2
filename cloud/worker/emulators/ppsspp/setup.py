#!/usr/bin/env python3
"""Install the real PPSSPP profile on a worker (PSP games need no firmware: PPSSPP implements the system software).

    sudo sh install.sh                                   # build + install PPSSPP under /usr/local/lib/mishrin-ppsspp
    sudo python3 setup.py /opt/mishrin/emulators/ppsspp [--test-app emulators/psp/testapp/out/mishrin-psp-test.iso]

--test-app installs the original Mishrin PSP test image used by the worker's startup self-test.
"""
import argparse, os, shutil, sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, '..', '..'))
from mishrin_worker.manifest import DEFAULT_FULL_PAD, DEFAULT_STICKS  # noqa: E402

BIN = '/usr/local/lib/mishrin-ppsspp/PPSSPPSDL'
# X keysym (the key the worker presses) → PPSSPP/Android key code (Common/Input/KeyCodes.h)
NK = {**{chr(c): 29 + c - ord('a') for c in range(ord('a'), ord('z') + 1)}, **{str(d): 7 + d for d in range(10)},
      'Up': 19, 'Down': 20, 'Left': 21, 'Right': 22, 'Return': 66, 'BackSpace': 67}
PSP = {'up': 'Up', 'down': 'Down', 'left': 'Left', 'right': 'Right', 'cross': 'Cross', 'circle': 'Circle', 'square': 'Square',
       'triangle': 'Triangle', 'l1': 'L', 'r1': 'R', 'select': 'Select', 'start': 'Start',
       'lup': 'An.Up', 'ldown': 'An.Down', 'lleft': 'An.Left', 'lright': 'An.Right'}
INI = """[General]
FirstRun = False
CheckForNewVersion = False
DiscordRichPresence = False
AutoRun = True
UISound = False
ShowSaveLoadIndicator = False
[CPU]
CPUCore = 1
[Graphics]
GraphicsBackend = 0 (OPENGL)
InternalResolution = 1
FrameSkip = 0
AutoFrameSkip = False
iShowStatusFlags = 0
[Sound]
Enable = True
AutoAudioDevice = True
[SystemParam]
NickName = Mishrin
"""


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('dest')
    ap.add_argument('--test-app', help='Mishrin PSP test image (emulators/psp/testapp/out/mishrin-psp-test.iso)')
    a = ap.parse_args()
    if not os.path.exists(BIN):
        raise SystemExit(f'PPSSPP is not installed at {BIN} (see install.sh)')
    sysdir = os.path.join(a.dest, 'home', '.config', 'ppsspp', 'PSP', 'SYSTEM')
    os.makedirs(sysdir, exist_ok=True)
    os.makedirs(os.path.join(a.dest, 'home', '.config', 'ppsspp', 'PSP', 'SAVEDATA'), exist_ok=True)
    shutil.copy(os.path.join(HERE, 'emulator.json'), os.path.join(a.dest, 'emulator.json'))
    open(os.path.join(sysdir, 'ppsspp.ini'), 'w').write(INI)
    binds = {**DEFAULT_FULL_PAD, **DEFAULT_STICKS}       # the same keys the worker presses for each controller input
    lines = ['[ControlMapping]'] + [f'{name} = 1-{NK[binds[b]]}' for b, name in PSP.items()]
    open(os.path.join(sysdir, 'controls.ini'), 'w').write('\n'.join(lines) + '\n')
    if a.test_app:
        os.makedirs(os.path.join(a.dest, 'selftest'), exist_ok=True)
        shutil.copy(a.test_app, os.path.join(a.dest, 'selftest', 'mishrin-psp-test.iso'))
    for root, dirs, files in os.walk(a.dest):
        os.chmod(root, 0o755)
        for n in files:
            os.chmod(os.path.join(root, n), 0o644)
    print(f'PPSSPP profile installed in {a.dest}')


if __name__ == '__main__':
    main()
