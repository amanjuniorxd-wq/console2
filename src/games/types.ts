/** Compact game manifest. Add a game = add one object to public/games/catalog.json (or use Library → Add Game). */
export type RuntimeKind =
  | 'wasm' // MPC Framebuffer ABI v1 module (.wasm) — runs locally in a sandboxed worker
  | 'web' // HTML5 package (single .html or URL) — runs in a sandboxed iframe
  | 'webgpu' // HTML5 package that requires WebGPU
  | 'x86' // DOS / 32-bit x86 binaries — cloud compatibility node
  | 'x64-win' // Windows x64 — cloud Wine/Proton node
  | 'linux' // Linux x64 — cloud node
  | 'p1' // Mishrin P1 — PlayStation-1-class console image, emulated locally (src/emu)
  | 'p2' // Mishrin P2 — PlayStation-2-class (not available: see docs/EMULATION.md)
  | 'p3' // Mishrin P3 — research only
  | 'p4'; // Mishrin P4 — research only

export type Genre = 'fantasy' | 'racing' | 'scifi' | 'action' | 'landscape';

export interface Requirements {
  /** Approximate working-set in MB. Used by MPC to decide local vs cloud. */
  memMB?: number;
  cores?: number;
  gpu?: 'none' | 'any' | 'webgpu';
}

export interface Chunk { h: string; url: string; size?: number }

export interface Game {
  id: string;
  title: string;
  /** Image URL (AVIF/WebP/SVG preferred) or "gen:<genre>" for built-in procedural art. */
  artwork: string;
  description: string;
  runtime: RuntimeKind;
  requirements?: Requirements;
  launchConfig?: { abi?: 'mpc-fb-1'; pixelated?: boolean; args?: string[]; [k: string]: unknown };
  /** http(s)/relative URL, "idb:<key>" for a user-attached file, "cloud:<id>" for a title registered on the cloud,
   *  or "" when the file has not been supplied yet. */
  url: string;
  /** Optional integrity + content address of the package. */
  sha256?: string;
  /** Optional chunked package for delta updates: unchanged chunks are reused from the MPC store. */
  chunks?: Chunk[];
  genre?: Genre;
  /** Console-emulation titles imported by the user (never uploaded anywhere). */
  emu?: EmuInfo;
  controller?: boolean;
  touch?: boolean;
  user?: boolean;
}

export const CLOUD_ONLY: ReadonlySet<RuntimeKind> = new Set(['x86', 'x64-win', 'linux']);
export const KNOWN_RUNTIMES: ReadonlySet<string> = new Set(['wasm', 'web', 'webgpu', 'x86', 'x64-win', 'linux', 'p1', 'p2', 'p3', 'p4']);
export const EMU_RUNTIMES: ReadonlySet<RuntimeKind> = new Set(['p1', 'p2', 'p3', 'p4']);

export interface EmuInfo {
  platform: 'p1' | 'p2' | 'p3' | 'p4';
  format: string;           // cue+bin, chd, iso, bin, img, exe, pbp, m3u
  primary: string;          // file the core opens (e.g. the .cue)
  files: { name: string; size: number }[];
  size: number;             // total bytes
  serial?: string;          // e.g. SLUS_123.45 from SYSTEM.CNF (if present)
  store: 'opfs' | 'idb';    // where the local copy lives
}
