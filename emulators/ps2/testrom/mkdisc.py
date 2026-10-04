"""Build the Mishrin PS2-class test disc (original content): an ISO9660 DVD image with SYSTEM.CNF (BOOT2, so detectors and
PCSX2 identify it as a PS2-class disc) and GAME.DAT, the "game data" the test ROM loads from the disc through the CDVD:
    'MSHR' 'GAME' <box colour, GS RGBA LE> <level> <title, 32 bytes>
Usage: python3 mkdisc.py out/mishrin-ps2-testdisc.iso [--colour 0x803399FF] [--title ...]"""
import argparse
import struct

ap = argparse.ArgumentParser()
ap.add_argument('out')
ap.add_argument('--colour', default='0x803399FF')          # saffron (R FF, G 99, B 33)
ap.add_argument('--title', default='MISHRIN PS2 TEST DISC')
ap.add_argument('--serial', default='MSHR_000.01')
A = ap.parse_args()
S = 2048
both16 = lambda v: struct.pack('<H', v) + struct.pack('>H', v)
both32 = lambda v: struct.pack('<I', v) + struct.pack('>I', v)
DATE7 = bytes([126, 10, 4, 12, 0, 0, 0])


def dirrec(name, lba, size, isdir):
    n = name if isinstance(name, bytes) else name.encode()
    r = bytes([0, 0]) + both32(lba) + both32(size) + DATE7 + bytes([2 if isdir else 0, 0, 0]) + both16(1) + bytes([len(n)]) + n
    if len(r) % 2:
        r += b'\0'
    return bytes([len(r)]) + r[1:]


cnf = f'BOOT2 = cdrom0:\\{A.serial};1\r\nVER = 1.00\r\nVMODE = NTSC\r\n'.encode()
game = b'MSHRGAME' + struct.pack('<II', int(A.colour, 16), 1) + A.title.encode()[:32].ljust(32, b'\0')
readme = b'Mishrin PS2-class test disc. Original test data for automated emulator tests; not a game, not executable.\n'
ROOT, CNF, GAME, BOOT = 20, 21, 22, 23
total = 2048                                                # 4 MiB image
files = [(A.serial + ';1', BOOT, readme), ('GAME.DAT;1', GAME, game), ('SYSTEM.CNF;1', CNF, cnf)]
root = dirrec(b'\0', ROOT, S, True) + dirrec(b'\1', ROOT, S, True) + b''.join(dirrec(n, l, len(d), False) for n, l, d in sorted(files))
pvd = bytearray(S)
pvd[0:6] = b'\x01CD001'; pvd[6] = 1
pvd[8:40] = b'PLAYSTATION'.ljust(32)                        # system identifier PS2 discs carry (detectors key on it)
pvd[40:72] = b'MISHRIN_PS2_TEST'.ljust(32)
pvd[80:88] = both32(total)
pvd[120:124] = both16(1); pvd[124:128] = both16(1); pvd[128:132] = both16(S)
pvd[132:140] = both32(10)
struct.pack_into('<I', pvd, 140, 18); struct.pack_into('>I', pvd, 148, 19)
pvd[156:156 + 34] = dirrec(b'\0', ROOT, S, True)
pvd[190:318] = b'MISHRIN'.ljust(128)
pvd[881] = 1
term = bytearray(S); term[0:7] = b'\xffCD001\x01'
img = bytearray(total * S)
img[16 * S:17 * S] = pvd
img[17 * S:18 * S] = term
img[18 * S:18 * S + 10] = bytes([1, 0]) + struct.pack('<I', ROOT) + struct.pack('<H', 1) + b'\0\0'
img[19 * S:19 * S + 10] = bytes([1, 0]) + struct.pack('>I', ROOT) + struct.pack('>H', 1) + b'\0\0'
img[ROOT * S:ROOT * S + len(root)] = root
for _, lba, data in files:
    img[lba * S:lba * S + len(data)] = data
open(A.out, 'wb').write(img)
print(A.out, len(img), 'bytes')
