#!/bin/sh
# Builds out/ (Mishrin PSP test program, original): EBOOT.PBP (homebrew PBP with a plain ELF), mishrin-psp-test.iso
# (UMD layout: PSP_GAME/SYSDIR/EBOOT.BIN, PARAM.SFO, USRDIR/GAME.DAT) and mishrin-psp-test.cso — clang + lld only.
set -e
cd "$(dirname "$0")"
mkdir -p out
python3 gen_imports.py out/imports.S
CF="-target mipsel-unknown-none-elf -march=mips2 -msoft-float -mno-abicalls -fno-pic -G0 -O2 -ffreestanding -fno-builtin -nostdlib -fno-stack-protector"
clang $CF -c main.c -o out/main.o
clang $CF -c start.S -o out/start.o
clang $CF -c out/imports.S -o out/imports.o
ld.lld -m elf32ltsmip -T link.ld --no-pie -static out/start.o out/main.o out/imports.o -o out/EBOOT.ELF
python3 mkgame.py out/EBOOT.ELF out
