"""Package the test program as a PS3-class disc game folder: MSHR00001/PS3_GAME/{PARAM.SFO, USRDIR/EBOOT.BIN, USRDIR/GAME.DAT}.
Usage: python3 mkgame.py eboot.elf outdir [--colour FF9933]"""
import argparse
import os
import shutil

ap = argparse.ArgumentParser()
ap.add_argument('elf'); ap.add_argument('out')
ap.add_argument('--colour', default='FF9933')            # saffron (R G B)
ap.add_argument('--title', default='Mishrin PS3 Test')
A = ap.parse_args()


def sfo(entries):
    keys = list(entries); idx = kt = dt = b''
    for k in keys:
        v = entries[k]
        if isinstance(v, int):
            raw, fmt, mx = v.to_bytes(4, 'little'), 0x0404, 4
        else:
            raw = v.encode() + b'\0'; fmt = 0x0204; mx = (len(raw) + 3) // 4 * 4
        idx += len(kt).to_bytes(2, 'little') + fmt.to_bytes(2, 'little') + len(raw).to_bytes(4, 'little') + mx.to_bytes(4, 'little') + len(dt).to_bytes(4, 'little')
        kt += k.encode() + b'\0'; dt += raw + b'\0' * (mx - len(raw))
    kt += b'\0' * (-len(kt) % 4)
    hdr = b'\0PSF' + (0x101).to_bytes(4, 'little') + (20 + len(idx)).to_bytes(4, 'little') + (20 + len(idx) + len(kt)).to_bytes(4, 'little') + len(keys).to_bytes(4, 'little')
    return hdr + idx + kt + dt


root = os.path.join(A.out, 'MSHR00001')
shutil.rmtree(root, ignore_errors=True)
usr = os.path.join(root, 'PS3_GAME', 'USRDIR')
os.makedirs(usr)
open(os.path.join(root, 'PS3_DISC.SFB'), 'wb').write(b'.SFB' + bytes(12))
open(os.path.join(root, 'PS3_GAME', 'PARAM.SFO'), 'wb').write(sfo({'APP_VER': '01.00', 'ATTRIBUTE': 0, 'BOOTABLE': 1, 'CATEGORY': 'DG',
    'LICENSE': 'Original Mishrin test program', 'PARENTAL_LEVEL': 0, 'PS3_SYSTEM_VER': '01.0000', 'RESOLUTION': 63, 'SOUND_FORMAT': 1,
    'TITLE': A.title, 'TITLE_ID': 'MSHR00001', 'VERSION': '01.00'}))
shutil.copy(A.elf, os.path.join(usr, 'EBOOT.BIN'))
c = bytes.fromhex(A.colour)
open(os.path.join(usr, 'GAME.DAT'), 'wb').write(b'MSHRGAME' + c + b'\0' + (1).to_bytes(4, 'big') + A.title.encode()[:32].ljust(32, b'\0'))
print(root)
