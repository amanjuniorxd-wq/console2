#!/bin/sh
# Builds out/mishrin-ps2-test.rom (4 MiB): RESET code + ROMDIR table + ROMVER, as PCSX2 expects of a boot ROM.
set -e
cd "$(dirname "$0")"
mkdir -p out
clang -target mipsel-unknown-none-elf -march=mips3 -mno-abicalls -fno-pic -nostdlib -c testrom.S -o out/testrom.o
ld.lld -m elf32ltsmip -Ttext=0xBFC00000 -e _start out/testrom.o -o out/testrom.elf 2>/dev/null || ld.lld-19 -m elf32ltsmip -Ttext=0xBFC00000 -e _start out/testrom.o -o out/testrom.elf
llvm-objcopy -O binary -j .text out/testrom.elf out/reset.bin 2>/dev/null || llvm-objcopy-19 -O binary -j .text out/testrom.elf out/reset.bin
python3 - <<'PY'
import struct
code = open('out/reset.bin', 'rb').read()
assert len(code) <= 0x2000, len(code)
reset = code.ljust(0x2000, b'\0')
romver = b'0100XD20261004'.ljust(16, b'\0')            # zone X = "Test", D = development: identifies the test ROM
ent = lambda n, size: n.encode().ljust(10, b'\0') + struct.pack('<HI', 0, size)
romdir = ent('RESET', 0x2000) + ent('ROMDIR', 0x50) + ent('EXTINFO', 0) + ent('ROMVER', 16) + b'\0' * 16
img = reset + romdir + romver
open('out/mishrin-ps2-test.rom', 'wb').write(img.ljust(4 * 1024 * 1024, b'\0'))
print('out/mishrin-ps2-test.rom', len(code), 'bytes of code')
PY
python3 mkdisc.py out/mishrin-ps2-testdisc.iso
