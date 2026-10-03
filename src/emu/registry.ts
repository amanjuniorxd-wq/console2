/** Platform registry: static descriptors only (no core code). Cores are fetched lazily on first launch. */
import type { CoreDescriptor } from './types';
import type { Platform } from './detect';

export const CORES: Record<Platform, CoreDescriptor> = {
  p1: {
    id: 'p1', name: 'Mishrin P1', status: 'working', available: true,
    formats: ['CUE+BIN', 'BIN', 'IMG', 'ISO', 'CHD (v5)', 'PBP', 'PS-X EXE', 'M3U'],
    summary: 'PlayStation-1-class consoles. Runs locally in a WebAssembly worker; your files never leave this device.',
    license: 'PCSX-ReARMed core — GPL-2.0-or-later (source and notice: /cores/p1/)',
    coreManifest: '/cores/p1/core.json',
  },
  p2: {
    id: 'p2', name: 'Mishrin P2', status: 'experimental', available: false,
    formats: ['ISO (DVD)', 'CHD (DVD)'],
    summary: 'PlayStation-2-class consoles. Detected, not runnable in this build.',
    reason: 'Not in this build. The viable candidate (Play!, BSD-2-Clause) has an upstream experimental WebAssembly build, but it needs Emscripten 4 to compile, WebAssembly threads (SharedArrayBuffer + cross-origin isolation) and WebGL2, and its browser compatibility is limited. See docs/EMULATION.md.',
  },
  p3: {
    id: 'p3', name: 'Mishrin P3', status: 'research', available: false,
    formats: ['Disc folder / ISO', 'PKG'],
    summary: 'PlayStation-3-class consoles. Research only.',
    reason: 'Requires JIT recompilation of Cell PPU/SPU code and a modern GPU API at speeds WebAssembly cannot reach today. Not implemented.',
  },
  p4: {
    id: 'p4', name: 'Mishrin P4', status: 'research', available: false,
    formats: ['PKG'],
    summary: 'PlayStation-4-class consoles. Research only.',
    reason: 'Existing emulators execute x86-64 game code natively and need Vulkan-class GPU access plus decrypted system files; none of this is possible inside a browser sandbox. Not implemented.',
  },
};

export const STATUS_LABEL: Record<CoreDescriptor['status'], string> = { working: 'Working', experimental: 'Experimental', research: 'Research' };
