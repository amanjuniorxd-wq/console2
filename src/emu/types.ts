/**
 * Mishrin Emulator API — the contract every platform backend implements.
 * The console never talks to a core directly: it drives an EmulatorSession (main thread), which drives
 * a backend inside a dedicated worker. Adding a platform = adding a backend + a registry entry.
 */
import type { Platform } from './detect';

export type CoreStatus = 'working' | 'experimental' | 'research';

/** Static description of a backend (main thread, no code loaded). */
export interface CoreDescriptor {
  id: Platform;
  name: string;
  status: CoreStatus;
  available: boolean;              // can run in this build
  formats: string[];
  summary: string;
  reason?: string;                 // why not available (experimental/research)
  license?: string;
  coreManifest?: string;           // e.g. /cores/p1/core.json
}

export interface GameFile { name: string; blob?: Blob; opfs?: string[] }

export interface InitOptions {
  platform: Platform;
  module: WebAssembly.Module;      // compiled once on the main thread (MPC module cache), shared to the worker
  files: GameFile[];
  primary: string;
  bios: GameFile[];
  card: Uint8Array | null;
  options: Record<string, string>;
  presenter: 'webgpu' | 'canvas2d';
  scaling: 'sharp' | 'pixel' | 'smooth';
  /** Port devices to plug in after loading (index = port). */
  devices?: ('pad' | 'mouse')[];
  diskCacheMB: number;
  maxCatchUp: number;
  presentEvery: number;
  audio: { sab?: SharedArrayBuffer; port?: MessagePort } | null;
}

export interface CoreInfo {
  fps: number; sampleRate: number; width: number; height: number; aspect: number;
  bios: 'user' | 'open-hle'; presenter: 'webgpu' | 'canvas2d'; shaderMs?: number; loadMs: number; initMs: number; stateSize: number;
  message?: string;
  /** Set when the requested presenter failed and the session fell back (e.g. WebGPU device lost). */
  fallback?: string;
}

export interface EmuStats {
  fps: number; emuFps: number; emuMs: number; presentMs: number; utilization: number; wasmMB: number;
  behind: number; presentEvery: number; audioMs: number; diskReads: number; diskMB: number; cacheHit: number;
  width: number; height: number; frames: number;
  /** Average time from the input event (UI thread) to the first frame presented with it applied (ms); -1 = none. */
  inputMs: number;
}

/** What a backend implements inside the worker (one instance per running game). */
export interface EmulatorBackend {
  initialize(o: InitOptions, log: (s: string) => void): Promise<CoreInfo>;
  runFrame(): boolean;                         // true when a new picture was produced
  framebuffer(): { data: Uint8Array; width: number; height: number };
  audio(): Int16Array;                          // stereo PCM produced by the last runFrame
  reset(): void;
  saveState(): Uint8Array;
  loadState(s: Uint8Array): boolean;
  setControllerInput(port: number, mask: number): void;
  /** Optional: what is plugged into a port (P1: digital pad or PS1 Mouse). */
  setPortDevice?(port: number, device: 'pad' | 'mouse'): void;
  /** Optional: relative mouse movement + buttons (bit 0 left, bit 1 right) for a mouse port. */
  setPointerInput?(port: number, dx: number, dy: number, buttons: number): void;
  memoryCard(): Uint8Array | null;              // live view of the first memory card (P1)
  memoryBytes(): number;
  diskStats(): { reads: number; bytes: number; hit: number };
  shutdown(): void;
}

/** Controller bitmask (libretro joypad order, used by all Mishrin cores). */
export const PAD = {
  cross: 0, square: 1, select: 2, start: 3, up: 4, down: 5, left: 6, right: 7,
  circle: 8, triangle: 9, l1: 10, r1: 11, l2: 12, r2: 13, l3: 14, r3: 15,
} as const;
export type PadButton = keyof typeof PAD;
