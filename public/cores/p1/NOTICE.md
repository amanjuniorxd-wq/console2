# Mishrin P1 core — licence notice (GPL-2.0-or-later)

`public/cores/p1/mishrin-p1.wasm` is a build of **PCSX-ReARMed** (https://github.com/libretro/pcsx_rearmed),
pinned to commit `c8816799b50388e61cfe237fe2cdbb7d8175f20a`, compiled to WebAssembly together with
`emulators/p1/host.c` (a minimal libretro frontend) and the build changes in `emulators/p1/pcsx-rearmed-wasi.patch`.

PCSX-ReARMed is free software licensed under the **GNU General Public License, version 2 or (at your option) any later
version**. The combined core module (`mishrin-p1.wasm`) is therefore distributed under the GPL as well. The GPL text is
in `public/cores/p1/COPYING`.

## What this means for anyone distributing Mishrin Console with the P1 core

1. **Corresponding source must be available.** Every build places the complete corresponding source next to the binary:
   `public/cores/p1/source/mishrin-p1-source-<commit>.tar.xz` (the pinned upstream tree, `host.c`, the patch, and the
   build script). It is served from the same place as the core, which satisfies GPLv2 §3(a). If you remove that archive
   from your deployment you must provide the source another way (a written offer valid for 3 years, GPLv2 §3(b)).
2. **Keep the notices.** Do not remove `COPYING`, this notice, or the copyright notices in the source.
3. **Your changes to the core are GPL too.** Modifications to the core, `host.c`, or the patch must be released under
   the GPL when you distribute the result.
4. **Build reproducibility.** `emulators/p1/build-core.sh` pins the upstream commit and `SOURCE_DATE_EPOCH`, so the same
   source produces a byte-identical `mishrin-p1.wasm` (its SHA-256 is recorded in `public/cores/p1/core.json`).

## Scope of the GPL in Mishrin Console

The core runs as a separate WebAssembly module, loaded lazily into its own worker and driven only through a small
message/ABI boundary (`src/emu/backends/p1.ts`). The rest of Mishrin Console (UI, scheduler, cloud backend) is not
linked into the core. Whether a combined distribution counts as one work under the GPL is ultimately a legal question:
if your distribution model depends on it, get advice from a lawyer. This notice is not legal advice.

## What is NOT included

No Sony BIOS, firmware, keys, or games are included in the core, the source archive, or Mishrin Console. The core boots
with PCSX-ReARMed's built-in open HLE BIOS replacement. Users may supply their own BIOS dump, which is stored only in their
browser and never uploaded.
