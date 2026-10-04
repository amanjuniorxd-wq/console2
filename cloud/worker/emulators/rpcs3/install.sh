#!/bin/sh
# Bundle a source-built RPCS3 (+ the Qt it was built against) under /usr/local/lib/mishrin-rpcs3, where every worker
# sandbox can see it read-only (/usr is bound into sessions). Build recipe used for this repo's verification:
#   Qt 6.8.3 (qtbase, qtshadertools, qtsvg, qtmultimedia -no-feature-ffmpeg) → /opt/qt6
#   RPCS3 46aee28 + patches/*.patch (Ubuntu 24.04: LLVM 19, FFmpeg 6.1, Qt 6.8):
#     cmake -G Ninja -DCMAKE_PREFIX_PATH=/opt/qt6 -DLLVM_DIR=/usr/lib/llvm-19/lib/cmake/llvm -DUSE_SYSTEM_FFMPEG=ON \
#       -DUSE_SDL=OFF -DUSE_FAUDIO=OFF -DUSE_LTO=OFF -DUSE_NATIVE_INSTRUCTIONS=OFF -DUSE_SYSTEM_OPENCV=OFF \
#       -DCMAKE_CXX_STANDARD_LIBRARIES=-lxkbcommon && ninja
# Usage: sudo sh install.sh /path/to/rpcs3/build/bin/rpcs3 [/opt/qt6]
set -e
BIN=${1:?path to the built rpcs3 binary}
QT=${2:-/opt/qt6}
DEST=/usr/local/lib/mishrin-rpcs3
rm -rf "$DEST"; mkdir -p "$DEST/lib" "$DEST/plugins"
cp "$BIN" "$DEST/rpcs3"
cp -r "$(dirname "$BIN")/GuiConfigs" "$DEST/" 2>/dev/null || true
# Qt libraries the binary (and the xcb platform plugin) resolve from $QT
for l in $(ldd "$BIN" | awk '/\/opt\/qt6|'"$(echo $QT | sed 's#/#\\/#g')"'/ {print $3}'); do cp -L "$l" "$DEST/lib/"; done
for p in platforms xcbglintegrations imageformats iconengines multimedia; do [ -d "$QT/plugins/$p" ] && cp -r "$QT/plugins/$p" "$DEST/plugins/"; done
for l in $(ldd "$QT/plugins/platforms/libqxcb.so" "$QT"/plugins/xcbglintegrations/*.so | awk '/qt6/ {print $3}' | sort -u); do cp --update=none -L "$l" "$DEST/lib/"; done
patchelf --set-rpath '$ORIGIN/lib' "$DEST/rpcs3"
for f in "$DEST"/lib/*.so*; do patchelf --set-rpath '$ORIGIN' "$f" 2>/dev/null || true; done
for f in "$DEST"/plugins/*/*.so; do patchelf --set-rpath '$ORIGIN/../../lib' "$f" 2>/dev/null || true; done
printf '[Paths]\nPrefix = .\nPlugins = plugins\n' > "$DEST/qt.conf"
chmod -R a+rX "$DEST"
"$DEST/rpcs3" --version 2>/dev/null | grep -m1 RPCS3 || true
ldd "$DEST/rpcs3" | grep -E "not found|qt6" || true
echo "installed $DEST"
