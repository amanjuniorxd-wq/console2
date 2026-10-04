#!/usr/bin/env python3
"""Install the real RPCS3 profile on a worker.

    sudo sh install.sh /path/to/rpcs3/build/bin/rpcs3          # bundle RPCS3 + Qt under /usr/local/lib/mishrin-rpcs3
    sudo python3 setup.py /opt/mishrin/emulators/rpcs3 --pup /path/to/YOUR/PS3UPDAT.PUP

The PS3 system software must come from the operator (the update file for a console they own). Mishrin never downloads
or ships it. Without --pup the profile is installed and the worker reports "PS3: runtime installed · firmware required".
For automated tests only, --test-app installs the original Mishrin test program (emulators/ps3/testapp) for the startup
self-test and configures every system library as HLE (emulator built-in), so the test program boots without firmware.
Such a worker only advertises PS3 sessions when started with --allow-test-firmware, and never reports READY.
"""
import argparse
import os
import shutil
import subprocess
import sys
import tempfile

import yaml

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, '..', '..'))
from mishrin_worker.manifest import DEFAULT_FULL_PAD, DEFAULT_STICKS  # noqa: E402

BIN = '/usr/local/lib/mishrin-rpcs3/rpcs3'
# RPCS3 0.0.43 g_prx_list (rpcs3/Emu/Cell/lv2/sys_prx.cpp): in test mode every one is forced to HLE (no firmware loaded)
PRX = ('libaacenc libaacenc_spurs libac3dec libac3dec2 libadec libadec2 libadec_internal libad_async libad_billboard_util libad_core '
       'libapostsrc_mini libasfparser2_astd libat3dec libat3multidec libatrac3multi libatrac3plus libatxdec libatxdec2 libaudio libavcdec '
       'libavcenc libavcenc_small libavchatjpgdec libbeisobmf libbemp2sys libcamera libcelp8dec libcelp8enc libcelpdec libcelpenc libddpdec '
       'libdivxdec libdmux libdmuxpamf libdtslbrdec libfiber libfont libfontFT libfreetype libfreetypeTT libfs libfs_155 libgcm_sys libgem libgifdec libhttp libio '
       'libjpgdec libjpgenc libkey2char libl10n liblv2 liblv2coredump liblv2dbg_for_cex libm2bcdec libm4aacdec libm4aacdec2ch libm4hdenc '
       'libm4venc libmedi libmic libmp3dec libmp4 libmpl1dec libmvcdec libnet libnetctl libpamf libpngdec libpngenc libresc librtc librudp '
       'libsail libsail_avi libsail_rec libsjvtd libsmvd2 libsmvd4 libspurs_jq libsre libssl libsvc1d libsync2 libsysmodule libsysutil '
       'libusbd libusbpspcm libvdec libvoice libvpost libvpost2 libwmadec').split()
# worker key (X keysym) → Qt key name used by RPCS3's keyboard pad handler
QT_KEY = {'Up': 'Up', 'Down': 'Down', 'Left': 'Left', 'Right': 'Right', 'BackSpace': 'Backspace'}
PAD_NAMES = {'up': 'Up', 'down': 'Down', 'left': 'Left', 'right': 'Right', 'cross': 'Cross', 'circle': 'Circle', 'square': 'Square',
             'triangle': 'Triangle', 'l1': 'L1', 'r1': 'R1', 'l2': 'L2', 'r2': 'R2', 'select': 'Select', 'start': 'Start', 'l3': 'L3', 'r3': 'R3',
             'lup': 'Left Stick Up', 'ldown': 'Left Stick Down', 'lleft': 'Left Stick Left', 'lright': 'Left Stick Right',
             'rup': 'Right Stick Up', 'rdown': 'Right Stick Down', 'rleft': 'Right Stick Left', 'rright': 'Right Stick Right'}


def qt(k):
    return QT_KEY.get(k, k.upper() if len(k) == 1 else k)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('dest')
    ap.add_argument('--pup', help='PS3UPDAT.PUP for a console you own (installed with rpcs3 --installfw)')
    ap.add_argument('--test-app', help='Mishrin test game folder (emulators/ps3/testapp/out/MSHR00001) — tests only')
    ap.add_argument('--renderer', default='Vulkan', choices=['Vulkan', 'OpenGL'])
    a = ap.parse_args()
    if not os.path.exists(BIN):
        raise SystemExit(f'RPCS3 is not installed at {BIN} (see install.sh)')
    cfg = os.path.join(a.dest, 'home', '.config', 'rpcs3')
    os.makedirs(os.path.join(cfg, 'input_configs', 'global'), exist_ok=True)
    shutil.copy(os.path.join(HERE, 'emulator.json'), os.path.join(a.dest, 'emulator.json'))
    if a.pup:
        env = dict(os.environ, HOME=os.path.join(a.dest, 'home'), XDG_CONFIG_HOME=os.path.join(a.dest, 'home', '.config'), QT_QPA_PLATFORM='offscreen')
        r = subprocess.run([BIN, '--headless', '--installfw', os.path.abspath(a.pup)], env=env, capture_output=True, text=True, timeout=1800)
        print(r.stdout[-400:], r.stderr[-400:])
    firmware = os.path.isfile(os.path.join(cfg, 'dev_flash', 'sys', 'external', 'liblv2.sprx'))
    conf = {
        'Core': {'PPU Decoder': 'Recompiler (LLVM)', 'SPU Decoder': 'Recompiler (LLVM)'},
        'Video': {'Renderer': a.renderer, 'Resolution': '1280x720', 'Frame limit': '60', 'Shader Mode': 'Async Recompiler (multi-threaded)'},
        'Audio': {'Renderer': 'Cubeb', 'Audio Device': '@@@default@@@'},
        'Miscellaneous': {'Automatically start games after boot': True, 'Exit RPCS3 when process finishes': True,
                          'Start games in fullscreen mode': True, 'Show trophy popups': False, 'Show PPU compilation hint': False,
                          'Show shader compilation hint': False, 'Prevent display sleep while running games': False,
                          'Pause emulation on RPCS3 focus loss': False},
    }
    if not firmware:      # test mode: no firmware to load → every system library is the emulator's HLE implementation
        conf['Core']['Libraries Control'] = [f'{n}.sprx:hle' for n in PRX]
    yaml.safe_dump(conf, open(os.path.join(cfg, 'config.yml'), 'w'), sort_keys=False, allow_unicode=True)
    binds = {**DEFAULT_FULL_PAD, **DEFAULT_STICKS}       # the same keys the worker presses for each controller input
    pad = {PAD_NAMES[b]: qt(k) for b, k in binds.items()}
    pad['PS Button'] = ''
    yaml.safe_dump({'Player 1 Input': {'Handler': 'Keyboard', 'Device': 'Keyboard', 'Config': pad, 'Buddy Device': 'Keyboard'}},
                   open(os.path.join(cfg, 'input_configs', 'global', 'Default.yml'), 'w'), sort_keys=False)
    # headless operation: no welcome / update / confirmation dialogs over the game window
    os.makedirs(os.path.join(cfg, 'GuiConfigs'), exist_ok=True)
    open(os.path.join(cfg, 'GuiConfigs', 'CurrentSettings.ini'), 'w').write(
        '[Meta]\ncheckUpdateStart=false\nuseRichPresence=false\nattachCommandLine=false\n'
        '[main_window]\ninfoBoxEnabledWelcome=false\nconfirmationBoxExitGame=false\nconfirmationBoxBootGame=false\n'
        'confirmationObsoleteCfg=false\nconfirmationRestart=false\ninfoBoxEnabledInstallPUP=false\ninfoBoxEnabledInstallPKG=false\n')
    if a.test_app:
        st = os.path.join(a.dest, 'selftest')
        shutil.rmtree(st, ignore_errors=True)
        shutil.copytree(a.test_app, os.path.join(st, os.path.basename(a.test_app.rstrip('/'))))
    for root, dirs, files in os.walk(a.dest):
        os.chmod(root, 0o755)
        for n in files:
            os.chmod(os.path.join(root, n), 0o644)
    print(f'RPCS3 profile installed in {a.dest} — ' + ('PS3 system software installed' if firmware else
          'no PS3 system software: the worker will report "firmware required"' + (' (test program installed for test mode)' if a.test_app else '')))


if __name__ == '__main__':
    main()
