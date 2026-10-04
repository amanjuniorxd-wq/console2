#!/bin/sh
# Build PPSSPP (GPL-2.0+, https://github.com/hrydgard/ppsspp) from source and install it where every worker sandbox can
# see it read-only (/usr is bound into sessions): /usr/local/lib/mishrin-ppsspp/{PPSSPPSDL,assets}.
# Ubuntu 24.04: sudo apt install build-essential cmake ninja-build libsdl2-dev libsdl2-ttf-dev libfontconfig-dev libzip-dev libgl-dev libvulkan-dev
# Usage: sudo sh install.sh [workdir]      (pinned: v1.20.4)
set -e
V=v1.20.4
W=${1:-/var/tmp/mishrin-ppsspp-build}
mkdir -p "$W"; cd "$W"
[ -d src ] || git clone --depth 1 -b $V --recurse-submodules --shallow-submodules https://github.com/hrydgard/ppsspp src
mkdir -p build && cd build
cmake ../src -G Ninja -DCMAKE_BUILD_TYPE=Release -DHEADLESSSDL=OFF -DUSING_QT_UI=OFF -DUSE_SYSTEM_LIBZIP=ON -DUSE_DISCORD=OFF -DUSE_MINIUPNPC=OFF
ninja PPSSPPSDL
DEST=/usr/local/lib/mishrin-ppsspp
rm -rf "$DEST"; mkdir -p "$DEST"
cp PPSSPPSDL "$DEST/"; cp -r assets "$DEST/"
chmod -R a+rX "$DEST"
"$DEST/PPSSPPSDL" --version
echo "installed $DEST"
