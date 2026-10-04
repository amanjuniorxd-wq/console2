#!/bin/sh
# Builds out/MSHR00001/ (a PS3-class game folder: PS3_GAME/PARAM.SFO, USRDIR/EBOOT.BIN = the test program as a plain
# LV2 ELF, USRDIR/GAME.DAT) with clang + lld only (big-endian PowerPC64, ELFv2 code, LV2 entry descriptor).
set -e
cd "$(dirname "$0")"
mkdir -p out
python3 gen_imports.py out/imports.S
CF="-target powerpc64-unknown-freebsd -mcpu=970 -mno-altivec -O2 -ffreestanding -fno-builtin -nostdlib -fno-pic -fno-stack-protector -fno-asynchronous-unwind-tables"
clang $CF -c main.c -o out/main.o
clang $CF -c start.S -o out/start.o
clang $CF -c out/imports.S -o out/imports.o
ld.lld -m elf64ppc --no-pie -static -T link.ld out/start.o out/main.o out/imports.o -o out/eboot.elf
python3 mkgame.py out/eboot.elf out
