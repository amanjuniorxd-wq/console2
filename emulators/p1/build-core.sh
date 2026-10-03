#!/bin/sh
# Builds the Mishrin P1 core (PCSX-ReARMed, GPLv2) as a WebAssembly module with clang + WASI — no Emscripten.
# Output: public/cores/p1/mishrin-p1.wasm and public/cores/p1/core.json (size + sha256), loaded lazily by the console.
# Requires: clang/lld 18, wasi-libc, libclang-rt-18-dev-wasm32, libc++-18-dev-wasm32, libc++abi-18-dev-wasm32, git.
set -e
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$HERE/../.."
SRC="${PCSX_SRC:-$HERE/.src/pcsx_rearmed}"
COMMIT=c8816799b50388e61cfe237fe2cdbb7d8175f20a   # pinned upstream revision (libretro/pcsx_rearmed)
if [ ! -d "$SRC/.git" ]; then
  git clone https://github.com/libretro/pcsx_rearmed.git "$SRC"
fi
cd "$SRC"
git fetch --depth 1 origin "$COMMIT" 2>/dev/null || true
git checkout -q "$COMMIT" 2>/dev/null || git checkout -q FETCH_HEAD
git apply --check "$HERE/pcsx-rearmed-wasi.patch" 2>/dev/null && git apply "$HERE/pcsx-rearmed-wasi.patch" || true
# Reproducible: __DATE__/__TIME__ come from the pinned commit, so the same source always yields the same bytes.
export SOURCE_DATE_EPOCH="$(git log -1 --format=%ct "$COMMIT")"
make -f Makefile.libretro platform=mishrin-wasi CC="clang --target=wasm32-wasi" \
     CXX="clang++ --target=wasm32-wasi -fno-exceptions -fno-rtti" AR=llvm-ar-18 -j"$(nproc)"
OUT="$ROOT/public/cores/p1"
mkdir -p "$OUT"
clang --target=wasm32-wasi -O3 -msimd128 -mbulk-memory -mexec-model=reactor -Ideps/libretro-common/include \
  "$HERE/host.c" pcsx_rearmed_libretro_wasi.a -o "$OUT/mishrin-p1.wasm" \
  -lc++ -lc++abi -lwasi-emulated-signal -lwasi-emulated-mman -lwasi-emulated-process-clocks \
  -Wl,--strip-all,--gc-sections,-z,stack-size=1048576,--max-memory=536870912
# GPLv2 §3(a): ship the complete corresponding source next to the binary (pinned upstream tree + every Mishrin
# change + the build script), plus the licence text and a notice.
SRCDIR="$OUT/source"; mkdir -p "$SRCDIR"
STAGE="$(mktemp -d)"; mkdir -p "$STAGE/mishrin-p1-source/mishrin"
git archive --format=tar --prefix=mishrin-p1-source/pcsx_rearmed/ "$COMMIT" | tar -x -C "$STAGE"
cp "$HERE/host.c" "$HERE/pcsx-rearmed-wasi.patch" "$HERE/build-core.sh" "$HERE/LICENSE-NOTICE.md" "$STAGE/mishrin-p1-source/mishrin/"
tar --sort=name --mtime="@$SOURCE_DATE_EPOCH" --owner=0 --group=0 --numeric-owner -C "$STAGE" -cJf "$SRCDIR/mishrin-p1-source-$COMMIT.tar.xz" mishrin-p1-source
rm -rf "$STAGE"
cp COPYING "$OUT/COPYING"
cp "$HERE/LICENSE-NOTICE.md" "$OUT/NOTICE.md"
SRC_SHA=$(sha256sum "$SRCDIR/mishrin-p1-source-$COMMIT.tar.xz" | cut -d' ' -f1)
SHA=$(sha256sum "$OUT/mishrin-p1.wasm" | cut -d' ' -f1)
SIZE=$(stat -c %s "$OUT/mishrin-p1.wasm")
printf '{"id":"p1","core":"pcsx_rearmed","license":"GPL-2.0-or-later","upstream":"https://github.com/libretro/pcsx_rearmed","commit":"%s","url":"mishrin-p1.wasm","sha256":"%s","size":%s,"sourceArchive":"source/mishrin-p1-source-%s.tar.xz","sourceSha256":"%s","licenseText":"COPYING","notice":"NOTICE.md"}\n' "$COMMIT" "$SHA" "$SIZE" "$COMMIT" "$SRC_SHA" > "$OUT/core.json"
cat "$OUT/core.json"
