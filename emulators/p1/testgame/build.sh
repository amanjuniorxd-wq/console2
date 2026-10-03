#!/bin/sh
# Builds Saffron Pulse as PS-X EXE + bootable disc images (BIN/CUE Mode2, ISO 2048, CHD).
set -e
cd "$(dirname "$0")"
CC=mipsel-linux-gnu-gcc
$CC -march=r3000 -mabi=32 -msoft-float -mno-abicalls -fno-pic -G0 -O2 -ffreestanding -nostdlib -fno-builtin \
    -Wall -Wno-misleading-indentation -T link.ld -Wl,--build-id=none crt0.S pulse.c -o pulse.elf -lgcc
mipsel-linux-gnu-objcopy -O binary pulse.elf pulse.raw
python3 mkdisc.py pulse.elf pulse.raw out
chdman createcd -f -i out/saffron-pulse.cue -o out/saffron-pulse.chd >/dev/null
ls -l out
# Detection fixtures (structure only — not runnable): a P2-class layout (BOOT2) and a P3-class layout (PS3_GAME).
mkdir -p fixtures
python3 mkdisc.py pulse.elf pulse.raw fixtures --name p2-layout --cnf 'BOOT2 = cdrom0:\SLUS_000.01;1\nVER = 1.00\nVMODE = NTSC\n' >/dev/null
python3 mkdisc.py pulse.elf pulse.raw fixtures --name p3-layout --dir PS3_GAME >/dev/null
chdman createdvd -f -i fixtures/p2-layout.iso -o fixtures/p2-layout.chd >/dev/null
rm -f fixtures/*.exe fixtures/*.cue fixtures/p3-layout.bin fixtures/p2-layout.bin
ls -l fixtures
