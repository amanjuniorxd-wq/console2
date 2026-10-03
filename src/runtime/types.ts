import type { Game } from '../games/types';
import type { Caps } from '../mpc/probe';
import type { Backend } from '../mpc/router';
import type { Settings } from '../ui/settings-store';

/** Logical buttons shared by every adapter (MPC Framebuffer ABI v1 numbering). */
export const Btn = { Up: 0, Down: 1, Left: 2, Right: 3, A: 4, B: 5, Start: 6 } as const;
export type Btn = (typeof Btn)[keyof typeof Btn];

export interface Stats { fps: number; frameMs: number; width: number; height: number; route: string; extra?: string; details?: [string, string][] }

export interface LaunchContext {
  game: Game;
  host: HTMLElement;
  caps: Caps;
  settings: Settings;
  signal: AbortSignal;
  status: (msg: string, progress?: number) => void;
}

export interface Session {
  readonly backend: Backend;
  /** Adapter forwards logical input (keyboard/gamepad/touch) when it owns input routing. */
  input?(b: Btn, down: boolean): void;
  /** Controller/touch buttons, when the adapter distinguishes them from keyboard-derived buttons (cloud PC titles). */
  padInput?(b: Btn, down: boolean): void;
  /** Raw keyboard (KeyboardEvent.code) and normalized pointer, for PC titles on cloud nodes. */
  rawKey?(code: string, down: boolean): void;
  /** Mouse/pointer. Absolute: normalized 0..1 inside the game picture (letterbox excluded). DOM `buttons` bitmask. */
  pointer?(x: number, y: number, buttons: number): void;
  /** Relative mouse (e.g. a console mouse peripheral): raw movement in CSS px + buttons. Used when pointerMode is 'relative'. */
  pointerRel?(dx: number, dy: number, buttons: number): void;
  /** How the player should deliver mouse input (default 'absolute'). */
  readonly pointerMode?: 'absolute' | 'relative';
  /** Mouse wheel, in notches (positive = down / towards the user). */
  wheel?(steps: number): void;
  /** Whether the title supports save states through this path. */
  readonly canSave: boolean;
  save(): Promise<Uint8Array | null>;
  load(state: Uint8Array): Promise<boolean>;
  pause(on: boolean): void;
  setScale?(scale: number): void;
  /** Emulator presentation scaling (nearest / bilinear / WebGPU sharp-bilinear). */
  setScaling?(mode: 'pixel' | 'smooth' | 'sharp'): void;
  /** Hard reset of the emulated machine. */
  reset?(): Promise<void>;
  /** Optional per-adapter controls help (replaces the generic mapping in the overlay). */
  controlsHelp?: [string, string][];
  setMaxFps?(fps: number): void;
  stats(): Stats;
  /** Fires when the session ends on its own (crash, cloud disconnect, idle shutdown). */
  onEnd?: (reason: string) => void;
  /** Wants native key/pointer events delivered to its own element (iframe/web games). */
  readonly ownsInput: boolean;
  dispose(): void;
}

export interface RuntimeAdapter {
  readonly backend: Backend;
  launch(ctx: LaunchContext): Promise<Session>;
}
