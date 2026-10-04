"""Package the Mishrin PSP test program (original): a homebrew folder (EBOOT.PBP + GAME.DAT), a UMD-layout ISO 9660
image and the same image as CSO (CISO v1). Usage: python3 mkgame.py EBOOT.ELF outdir [--colour FF9933]"""
import argparse, os, shutil, struct, zlib

ap = argparse.ArgumentParser()
ap.add_argument('elf'); ap.add_argument('out')
ap.add_argument('--colour', default='FF9933')            # saffron (R G B)
A = ap.parse_args()
elf = open(A.elf, 'rb').read()
S = 2048
game = b'MSHRGAME' + bytes.fromhex(A.colour) + b'\0' + struct.pack('<I', 1) + b'MISHRIN PSP TEST'.ljust(32, b'\0')


def sfo(entries):
    keys = sorted(entries); idx = kt = dt = b''
    for k in keys:
        v = entries[k]
        if isinstance(v, int): raw, fmt, mx = struct.pack('<I', v), 0x0404, 4
        else: raw = v.encode() + b'\0'; fmt = 0x0204; mx = (len(raw) + 3) // 4 * 4
        idx += struct.pack('<HHIII', len(kt), fmt, len(raw), mx, len(dt))
        kt += k.encode() + b'\0'; dt += raw + b'\0' * (mx - len(raw))
    kt += b'\0' * (-len(kt) % 4)
    return b'\0PSF' + struct.pack('<IIII', 0x101, 20 + len(idx), 20 + len(idx) + len(kt), len(keys)) + idx + kt + dt


def param(cat):
    return sfo({'BOOTABLE': 1, 'CATEGORY': cat, 'DISC_ID': 'MSHR00001', 'DISC_NUMBER': 1, 'DISC_TOTAL': 1, 'DISC_VERSION': '1.00',
                'PARENTAL_LEVEL': 1, 'PSP_SYSTEM_VER': '1.00', 'REGION': 32768, 'TITLE': 'Mishrin PSP Test'})


# ---- homebrew folder: EBOOT.PBP (PARAM.SFO + plain ELF) + GAME.DAT
folder = os.path.join(A.out, 'MSHRPSP')
shutil.rmtree(folder, ignore_errors=True); os.makedirs(folder)
p = param('MG')
offs = [40, 40 + len(p)] + [40 + len(p)] * 4 + [40 + len(p)]
data_psp = offs[6]
pbp = b'\0PBP' + struct.pack('<I', 0x10000) + struct.pack('<8I', 40, *([40 + len(p)] * 5), data_psp, data_psp + len(elf)) + p + elf
open(os.path.join(folder, 'EBOOT.PBP'), 'wb').write(pbp)
open(os.path.join(folder, 'GAME.DAT'), 'wb').write(game)

# ---- UMD-layout ISO 9660
both16 = lambda v: struct.pack('<H', v) + struct.pack('>H', v)
both32 = lambda v: struct.pack('<I', v) + struct.pack('>I', v)
DATE = bytes([126, 10, 4, 12, 0, 0, 0])


def rec(name, lba, size, isdir):
    n = name if isinstance(name, bytes) else name.encode()
    r = bytes([0, 0]) + both32(lba) + both32(size) + DATE + bytes([2 if isdir else 0, 0, 0]) + both16(1) + bytes([len(n)]) + n
    if len(r) % 2: r += b'\0'
    return bytes([len(r)]) + r[1:]


ROOT, PSPG, SYSD, USRD = 22, 23, 24, 25
files = {'UMD_DATA.BIN': (26, b'MSHR-00001|0000000000000000|0001|G'), 'PARAM.SFO': (27, param('UG')),
         'GAME.DAT': (28, game), 'EBOOT.BIN': (29, elf)}
total = 29 + (len(elf) + S - 1) // S + 16
dirs = {
    ROOT: rec(b'\0', ROOT, S, True) + rec(b'\1', ROOT, S, True) + rec('PSP_GAME', PSPG, S, True) + rec('UMD_DATA.BIN;1', 26, len(files['UMD_DATA.BIN'][1]), False),
    PSPG: rec(b'\0', PSPG, S, True) + rec(b'\1', ROOT, S, True) + rec('PARAM.SFO;1', 27, len(files['PARAM.SFO'][1]), False) + rec('SYSDIR', SYSD, S, True) + rec('USRDIR', USRD, S, True),
    SYSD: rec(b'\0', SYSD, S, True) + rec(b'\1', PSPG, S, True) + rec('EBOOT.BIN;1', 29, len(elf), False),
    USRD: rec(b'\0', USRD, S, True) + rec(b'\1', PSPG, S, True) + rec('GAME.DAT;1', 28, len(game), False),
}
def ptable(le):
    pk = (lambda f, v: struct.pack('<' + f, v)) if le else (lambda f, v: struct.pack('>' + f, v))
    out = b''
    for name, lba, parent in ((b'\0', ROOT, 1), (b'PSP_GAME', PSPG, 1), (b'SYSDIR', SYSD, 2), (b'USRDIR', USRD, 2)):
        e = bytes([len(name), 0]) + pk('I', lba) + pk('H', parent) + name
        out += e + (b'\0' if len(name) % 2 else b'')
    return out
pt = ptable(True)
pvd = bytearray(S)
pvd[0:6] = b'\x01CD001'; pvd[6] = 1
pvd[8:40] = b'PSP GAME'.ljust(32); pvd[40:72] = b'MISHRIN_PSP_TEST'.ljust(32)
pvd[80:88] = both32(total); pvd[120:124] = both16(1); pvd[124:128] = both16(1); pvd[128:132] = both16(S)
pvd[132:140] = both32(len(pt)); struct.pack_into('<I', pvd, 140, 18); struct.pack_into('>I', pvd, 148, 20)
pvd[156:190] = rec(b'\0', ROOT, S, True); pvd[190:318] = b'MISHRIN'.ljust(128); pvd[881] = 1
img = bytearray(total * S)
img[16 * S:17 * S] = pvd
img[17 * S:17 * S + 7] = b'\xffCD001\x01'
img[18 * S:18 * S + len(pt)] = pt; img[20 * S:20 * S + len(pt)] = ptable(False)
for lba, d in dirs.items(): img[lba * S:lba * S + len(d)] = d
for lba, d in files.values(): img[lba * S:lba * S + len(d)] = d
open(os.path.join(A.out, 'mishrin-psp-test.iso'), 'wb').write(img)

# ---- CSO (CISO v1, raw-deflate blocks of 2048 bytes)
blocks = [bytes(img[i:i + S]) for i in range(0, len(img), S)]
index, body, pos = [], b'', 24 + (len(blocks) + 1) * 4
for b in blocks:
    c = zlib.compressobj(9, zlib.DEFLATED, -15); z = c.compress(b) + c.flush()
    index.append(pos | (0 if len(z) < S else 0x80000000)); body += z if len(z) < S else b; pos += min(len(z), S) if len(z) < S else S
index.append(pos)
cso = b'CISO' + struct.pack('<IQIBB2x', 24, len(img), S, 1, 0) + b''.join(struct.pack('<I', i) for i in index) + body
open(os.path.join(A.out, 'mishrin-psp-test.cso'), 'wb').write(cso)
print(folder, len(img), len(cso))
