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
    reason: 'Local: not in this build (Play! WebAssembly needs Emscripten 4, WASM threads + cross-origin isolation). Cloud: PCSX2 worker profile exists, no real PCSX2 has been run here. See docs/universal-runtime-architecture.md.',
  },
  p3: {
    id: 'p3', name: 'Mishrin P3', status: 'research', available: false,
    formats: ['Disc folder / ISO', 'PKG'],
    summary: 'PlayStation-3-class consoles. Cloud only: architecture ready, runtime not deployed.',
    reason: 'A browser cannot run Cell PPU/SPU code at speed. The cloud path (RPCS3 on a GPU worker: scheduling, isolation, input, saves, streaming) is implemented and tested with a mock RPCS3; a real RPCS3 worker is not deployed.',
  },
  p4: {
    id: 'p4', name: 'Mishrin P4', status: 'research', available: false,
    formats: ['PKG'],
    summary: 'PlayStation-4-class consoles. Research only.',
    reason: 'Existing emulators execute x86-64 game code natively and need Vulkan-class GPU access plus decrypted system files; none of this is possible inside a browser sandbox. Not implemented.',
  },
};

export const STATUS_LABEL: Record<CoreDescriptor['status'], string> = { working: 'Working', experimental: 'Experimental', research: 'Research' };
