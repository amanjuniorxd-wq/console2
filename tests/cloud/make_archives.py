"""Test archives for the upload pipeline (all content original/synthetic). Usage: python3 make_archives.py <outdir>
ZIP via zipfile; RAR 4 and RAR 5 written by hand with the "store" method (no RAR encoder is needed or shipped)."""
import io, os, struct, sys, zipfile, zlib

out = sys.argv[1]
os.makedirs(out, exist_ok=True)
S = 2048
ROOT = os.path.dirname(os.path.abspath(__file__))


def iso(system, volume, files):
    """Minimal ISO 9660 (root files only, plus empty directories named with a trailing '/')."""
    rec = lambda n, lba, size, d: (lambda r: bytes([len(r)]) + r[1:])((lambda r: r + (b'\0' if len(r) % 2 else b''))(
        bytes([0, 0]) + struct.pack('<I', lba) + struct.pack('>I', lba) + struct.pack('<I', size) + struct.pack('>I', size) + bytes(7) + bytes([2 if d else 0, 0, 0]) + b'\1\0\0\1' + bytes([len(n)]) + n))
    lba, recs, data = 20, [rec(b'\0', 18, S, True), rec(b'\1', 18, S, True)], []
    for name, body in files:
        if name.endswith('/'):
            recs.append(rec(name[:-1].encode(), 19, S, True)); continue
        recs.append(rec((name + ';1').encode(), lba, len(body), False)); data.append((lba, body)); lba += max(1, -(-len(body) // S))
    img = bytearray(max(lba, 32) * S)
    pvd = bytearray(S); pvd[0:6] = b'\x01CD001'; pvd[6] = 1
    pvd[8:40] = system.encode().ljust(32); pvd[40:72] = volume.encode().ljust(32); pvd[156:190] = rec(b'\0', 18, S, True)
    img[16 * S:17 * S] = pvd; r = b''.join(recs); img[18 * S:18 * S + len(r)] = r
    for l, b in data: img[l * S:l * S + len(b)] = b
    return bytes(img)


def sfo(entries):
    keys = sorted(entries); idx = kt = dt = b''
    for k in keys:
        raw = entries[k].encode() + b'\0'; mx = (len(raw) + 3) // 4 * 4
        idx += struct.pack('<HHIII', len(kt), 0x0204, len(raw), mx, len(dt)); kt += k.encode() + b'\0'; dt += raw + b'\0' * (mx - len(raw))
    kt += b'\0' * (-len(kt) % 4)
    return b'\0PSF' + struct.pack('<IIII', 0x101, 20 + len(idx), 20 + len(idx) + len(kt), len(keys)) + idx + kt + dt


def pbp(category):
    p = sfo({'CATEGORY': category, 'DISC_ID': 'MSHR00001', 'TITLE': 'Archive Test'})
    elf = b'\x7fELF' + bytes(60)
    return b'\0PBP' + struct.pack('<I', 0x10000) + struct.pack('<8I', 40, *([40 + len(p)] * 6), 40 + len(p) + len(elf)) + p + elf


ps2 = iso('PLAYSTATION', 'ARCHIVE_PS2', [('SYSTEM.CNF', b'BOOT2 = cdrom0:\\SLUS_000.00;1\r\nVER = 1.00\r\n')])
ps1 = iso('PLAYSTATION', 'ARCHIVE_PS1', [('SYSTEM.CNF', b'BOOT = cdrom:\\SLUS_000.01;1\r\n')])
pspiso = iso('PSP GAME', 'ARCHIVE_PSP', [('UMD_DATA.BIN', b'MSHR-00001|0|0001|G'), ('PSP_GAME/', b'')])


def rar4(entries):
    """RAR 1.5–4.x archive, method 0x30 (store)."""
    def block(htype, flags, body, add=b''):
        h = bytes([htype]) + struct.pack('<HH', flags | (0x8000 if add else 0), 7 + len(body)) + body
        return struct.pack('<H', zlib.crc32(h) & 0xffff) + h + add
    outb = b'Rar!\x1a\x07\x00' + block(0x73, 0, bytes(6))
    for name, data in entries:
        n = name.replace('/', '\\').encode()
        body = struct.pack('<IIBIIBBHI', len(data), len(data), 2, zlib.crc32(data), 0x5A000000, 20, 0x30, len(n), 0x20) + n
        outb += block(0x74, 0x8000, body, data)
    return outb + block(0x7b, 0x4000, b'')


def vint(v):
    b = bytearray()
    while True:
        c = v & 0x7f; v >>= 7
        b.append(c | (0x80 if v else 0))
        if not v: return bytes(b)


def rar5(entries):
    """RAR 5.0 archive, store method (compression info 0)."""
    def header(htype, flags, body, extra_data=None):
        fields = vint(htype) + vint(flags) + (vint(len(extra_data)) if extra_data is not None and flags & 2 else b'') + body
        h = vint(len(fields)) + fields
        return struct.pack('<I', zlib.crc32(h)) + h
    outb = b'Rar!\x1a\x07\x01\x00' + header(1, 0, vint(0))
    for name, data in entries:
        n = name.encode()
        body = vint(0x0004) + vint(len(data)) + vint(0x20) + struct.pack('<I', zlib.crc32(data)) + vint(0) + vint(0) + vint(len(n)) + n
        outb += header(2, 0x0002, body, data) + data
    return outb + header(5, 0, vint(0))


def zipw(path, entries, links=()):
    with zipfile.ZipFile(path, 'w', zipfile.ZIP_DEFLATED) as z:
        for name, data in entries:
            z.writestr(name, data)
        for name, target in links:
            zi = zipfile.ZipInfo(name); zi.create_system = 3; zi.external_attr = (0o120777 << 16)
            z.writestr(zi, target)


exe = open(os.path.join(ROOT, '..', '..', 'cloud', 'test-games', 'pkg', 'gdi64', 'wintest64.exe'), 'rb').read()
zipw(f'{out}/psp-folder.zip', [('Archive Test/EBOOT.PBP', pbp('MG')), ('Archive Test/GAME.DAT', b'MSHRGAME\xff\x99\x33\0')])
open(f'{out}/ps2.rar', 'wb').write(rar5([('Game/disc.iso', ps2), ('Game/readme.txt', b'test')]))
open(f'{out}/ps1.rar', 'wb').write(rar4([('disc/game.iso', ps1)]))
inner = io.BytesIO(); zipw(inner, [('umd/game.iso', pspiso)])
zipw(f'{out}/nested.zip', [('outer/inner.zip', inner.getvalue())])
zipw(f'{out}/windows.zip', [('MyGame/bin/game.exe', exe), ('MyGame/data/level.dat', b'x' * 1000)])
zipw(f'{out}/traversal.zip', [('../../evil.txt', b'pwn')])
zipw(f'{out}/symlink.zip', [('ok.txt', b'ok')], links=[('passwd', '/etc/passwd')])
zipw(f'{out}/ps3.zip', [('G/PS3_GAME/PARAM.SFO', sfo({'TITLE': 'X'})), ('G/PS3_GAME/USRDIR/EBOOT.BIN', b'\x7fELF' + bytes(60))])
with zipfile.ZipFile(f'{out}/bomb.zip', 'w', zipfile.ZIP_DEFLATED, compresslevel=9) as z:
    with z.open('zeros.bin', 'w', force_zip64=True) as f:
        block = bytes(1 << 20)
        for _ in range(300): f.write(block)
print(' '.join(sorted(os.listdir(out))))
