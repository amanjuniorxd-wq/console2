/** Platform registry: static descriptors only (no core code). Cores are fetched lazily on first launch. */
import type { CoreDescriptor } from './types';
import type { Platform } from './detect';

export const CORES: Record<Platform, CoreDescriptor> = {
  p1: {
    id: 'p1', name: 'Mishrin P1', status: 'working', available: true,
    formats: ['CUE+BIN', 'BIN', 'IMG', 'ISO', 'CHD (v5)', 'PBP', 'PS-X EXE', 'M3U'],
    summary: 'PlayStation-1-class consoles. Runs locally in a WebAssembly worker; your files never leave this device.',
    license: 'PCSX-ReARMed core — GPL-2.0-or-later (source and notice: /cores/p1/)',
    coreManifest: `${import.meta.env?.BASE_URL ?? "./"}cores/p1/core.json`, // env is absent when bundled for Node tests
  },
  p2: {
    id: 'p2', name: 'Mishrin P2', status: 'experimental', available: false,
    formats: ['ISO (DVD)', 'CHD (DVD)'],
    summary: 'PlayStation-2-class consoles. In development: cloud worker profile (PCSX2) built and tested with a mock emulator; no local core.',
    reason: 'Local: not in this build (Play! WebAssembly needs Emscripten 4, WASM threads + cross-origin isolation). Cloud: real PCSX2 1.6 on a worker (verified with the Mishrin test ROM + test disc); games need your own PS2 BIOS on the worker. See docs/universal-runtime-architecture.md.',
  },
  psp: {
    id: 'psp', name: 'Mishrin PSP', status: 'experimental', available: false,
    formats: ['ISO (UMD)', 'CSO', 'EBOOT.PBP', 'Game folder (EBOOT.PBP)'],
    summary: 'PSP games. Cloud: real PPSSPP on a worker, streamed to this browser. No firmware needed (PPSSPP emulates the system software).',
    reason: 'Local: no PSP WebAssembly core in this build. Cloud: PPSSPP 1.20.4 on a worker (verified with the Mishrin PSP test program: video, audio, controller, saves).',
  },
  p4: {
    id: 'p4', name: 'Mishrin P4', status: 'research', available: false,
    formats: ['PKG'],
    summary: 'PlayStation-4-class consoles. Research only.',
    reason: 'Existing emulators execute x86-64 game code natively and need Vulkan-class GPU access plus decrypted system files; none of this is possible inside a browser sandbox. Not implemented.',
  },
};

export const STATUS_LABEL: Record<CoreDescriptor['status'], string> = { working: 'Working', experimental: 'Experimental', research: 'Research' };
