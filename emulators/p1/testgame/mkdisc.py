"""Package a PS1 program as PS-X EXE and as a bootable ISO9660 disc: Mode2/2352 BIN+CUE (with EDC/ECC) and 2048 ISO.
Usage: python3 mkdisc.py program.elf program.raw outdir"""
import os, struct, subprocess, sys

import argparse
ap = argparse.ArgumentParser()
ap.add_argument('elf'); ap.add_argument('raw'); ap.add_argument('out')
ap.add_argument('--name', default='saffron-pulse')
ap.add_argument('--cnf', default=None, help='override SYSTEM.CNF (detection fixtures)')
ap.add_argument('--dir', default=None, help='add an empty top-level directory (detection fixtures)')
A = ap.parse_args()
elf, raw, out = A.elf, A.raw, A.out
os.makedirs(out, exist_ok=True)
syms = {l.split()[2]: int(l.split()[0], 16) for l in subprocess.run(['mipsel-linux-gnu-nm', elf], capture_output=True, text=True).stdout.splitlines() if len(l.split()) == 3}
body = open(raw, 'rb').read()
body += b'\0' * (-len(body) % 2048)
hdr = bytearray(2048)
hdr[0:8] = b'PS-X EXE'
struct.pack_into('<IIII', hdr, 0x10, syms['_start'], syms['_gp'], 0x80010000, len(body))
struct.pack_into('<II', hdr, 0x30, 0x801FFF00, 0)
hdr[0x4C:0x4C + 20] = b'Mishrin test program'
exe = bytes(hdr) + body
open(f'{out}/{A.name}.exe', 'wb').write(exe)

# ---------------- ISO9660 ----------------
S = 2048
def both16(v): return struct.pack('<H', v) + struct.pack('>H', v)
def both32(v): return struct.pack('<I', v) + struct.pack('>I', v)
DATE7 = bytes([126, 10, 3, 12, 0, 0, 0])  # 2026-10-03
def dirrec(name, lba, size, isdir):
    n = name if isinstance(name, bytes) else name.encode()
    r = bytes([0, 0]) + both32(lba) + both32(size) + DATE7 + bytes([2 if isdir else 0, 0, 0]) + both16(1) + bytes([len(n)]) + n
    if len(r) % 2: r += b'\0'
    return bytes([len(r)]) + r[1:]
cnf = A.cnf.encode().replace(b'\\n', b'\r\n') if A.cnf else b'BOOT = cdrom:\\MAIN.EXE;1\r\nTCB = 4\r\nEVENT = 16\r\nSTACK = 801FFF00\r\n'
ROOT, CNF, EXE = 20, 21, 22
exe_sectors = len(exe) // S
total = max(EXE + exe_sectors + 16, 600)  # realistic minimum size (very short images are rejected/hang in some readers)
root = dirrec(b'\0', ROOT, S, True) + dirrec(b'\1', ROOT, S, True) + dirrec('MAIN.EXE;1', EXE, len(exe), False) + (dirrec(A.dir, ROOT, S, True) if A.dir else b'') + dirrec('SYSTEM.CNF;1', CNF, len(cnf), False)
pt_l = bytes([1, 0]) + struct.pack('<I', ROOT) + struct.pack('<H', 1) + b'\0\0'
pt_m = bytes([1, 0]) + struct.pack('>I', ROOT) + struct.pack('>H', 1) + b'\0\0'
pvd = bytearray(S)
pvd[0:7] = b'\x01CD001\x01'
pvd[8:40] = b'PLAYSTATION'.ljust(32)
pvd[40:72] = b'SAFFRON_PULSE'.ljust(32)
pvd[80:88] = both32(total)
pvd[120:124] = both16(1); pvd[124:128] = both16(1); pvd[128:132] = both16(S)
pvd[132:140] = both32(len(pt_l))
struct.pack_into('<I', pvd, 140, 18); struct.pack_into('>I', pvd, 148, 19)
r = dirrec(b'\0', ROOT, S, True); pvd[156:156 + len(r)] = r
pvd[190:318] = b'MISHRIN'.ljust(128); pvd[318:446] = b'MISHRIN CONSOLE'.ljust(128)
pvd[446:574] = b'MISHRIN CONSOLE'.ljust(128); pvd[574:702] = b'SAFFRON PULSE TEST PROGRAM'.ljust(128)
for off in (813, 830, 847, 864): pvd[off:off + 17] = b'2026100312000000\0'
pvd[881] = 1
term = bytearray(S); term[0:7] = b'\xffCD001\x01'
sectors = [bytes(S)] * 16 + [bytes(pvd), bytes(term), pt_l.ljust(S, b'\0'), pt_m.ljust(S, b'\0'), root.ljust(S, b'\0'), cnf.ljust(S, b'\0')]
sectors += [exe[i:i + S] for i in range(0, len(exe), S)]
sectors += [bytes(S)] * (total - len(sectors))
iso = b''.join(sectors)
open(f'{out}/{A.name}.iso', 'wb').write(iso)

# ---------------- Mode 2 Form 1 raw sectors with EDC/ECC ----------------
ecc_f, ecc_b, edc_lut = [0] * 256, [0] * 256, [0] * 256
for i in range(256):
    j = ((i << 1) ^ (0x11D if i & 0x80 else 0)) & 0xFF
    ecc_f[i] = j; ecc_b[i ^ j] = i
    e = i
    for _ in range(8): e = (e >> 1) ^ (0xD8018001 if e & 1 else 0)
    edc_lut[i] = e
def edc(data):
    e = 0
    for b in data: e = (e >> 8) ^ edc_lut[(e ^ b) & 0xFF]
    return e
def ecc_block(sec, major_count, minor_count, major_mult, minor_inc, dest):
    src = 0xC; size = major_count * minor_count
    for major in range(major_count):
        index = (major >> 1) * major_mult + (major & 1); a = b = 0
        for _ in range(minor_count):
            t = sec[src + index]; index += minor_inc
            if index >= size: index -= size
            a ^= t; b ^= t; a = ecc_f[a]
        a = ecc_b[ecc_f[a] ^ b]
        sec[dest + major] = a; sec[dest + major + major_count] = a ^ b
def msf(lba):
    l = lba + 150; bcd = lambda v: ((v // 10) << 4) | (v % 10)
    return bytes([bcd(l // 4500), bcd((l // 75) % 60), bcd(l % 75)])
out_bin = bytearray()
for lba, data in enumerate(sectors):
    sec = bytearray(2352)
    sec[0:12] = b'\x00' + b'\xff' * 10 + b'\x00'
    sec[12:15] = msf(lba); sec[15] = 2
    sub = bytes([0, 0, 0x08 if lba < len(sectors) - 1 else 0x89, 0]) * 2  # data; last sector EOF|EOR
    sec[16:24] = sub; sec[24:24 + S] = data
    struct.pack_into('<I', sec, 0x818, edc(sec[16:0x818]))
    addr = bytes(sec[12:16]); sec[12:16] = b'\0\0\0\0'          # Mode 2: address excluded from ECC
    ecc_block(sec, 86, 24, 2, 86, 0x81C); ecc_block(sec, 52, 43, 86, 88, 0x8C8)
    sec[12:16] = addr
    out_bin += sec
open(f'{out}/{A.name}.bin', 'wb').write(out_bin)
open(f'{out}/{A.name}.cue', 'w').write(f'FILE "{A.name}.bin" BINARY\n  TRACK 01 MODE2/2352\n    INDEX 01 00:00:00\n')
print(f'exe {len(exe)} B, disc {len(sectors)} sectors')
