#!/bin/sh
# Builds the original Windows compatibility test titles (MinGW) into pkg/<target>/ for cloud/tools/pack.mjs.
set -e
cd "$(dirname "$0")"
O="-O2 -s -mwindows -Wall -Wno-misleading-indentation -Wno-stringop-truncation"
x86_64-w64-mingw32-gcc $O -DRENDER_GDI mishrin_test.c -o wintest64.exe -lgdi32 -lshell32
i686-w64-mingw32-gcc $O -DRENDER_GDI mishrin_test.c -o wintest32.exe -lgdi32 -lshell32
x86_64-w64-mingw32-gcc $O -DRENDER_D3D11 mishrin_test.c -o d3d11test64.exe -ld3d11 -ldxgi -lshell32
i686-w64-mingw32-gcc $O -DRENDER_D3D9 mishrin_test.c -o d3d9test32.exe -ld3d9 -lshell32
cp wintest64.exe pkg/gdi64/; cp wintest32.exe pkg/gdi32/; cp d3d11test64.exe pkg/d3d11/; cp d3d9test32.exe pkg/d3d9/
