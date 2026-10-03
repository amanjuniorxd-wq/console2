/**
 * Universal runtime registry — the single, machine-readable source of what Mishrin can run, where, and how mature it is.
 * The UI derives every status label from here plus *live* state (device capabilities, the cloud's /api/runtimes report).
 * Nothing in the UI hardcodes availability.
 *
 * Maturity is a property of the code; availability is a property of the moment:
 *   ready               runs real software, verified by tests in this repo
 *   in-development      partially built; not usable for real games yet
 *   architecture-ready  protocol + worker integration + tests with a mock emulator; the real emulator is not deployed
 *   research            detection only
 * A runtime is *available* only when its maturity is `ready` (or a real worker reports it deployed) AND the live
 * check passes. A cloud runtime backed only by a mock worker is shown as such — never as available.
 */
import type { Game, RuntimeKind } from '../games/types';
import type { Caps } from '../mpc/probe';

export type RuntimeId = 'browser' | 'mishrin-p1' | 'ps2' | 'ps3-cloud' | 'windows-cloud' | 'ps4';
export type PlatformId = 'browser' | 'ps1' | 'ps2' | 'ps3' | 'ps4' | 'windows' | 'linux';
export type Maturity = 'ready' | 'in-development' | 'architecture-ready' | 'research';
export type Where = 'local' | 'cloud';

export interface RuntimeDescriptor {
  id: RuntimeId;
  name: string;                    // shown in the UI (neutral names; platform classes are descriptive only)
  platform: PlatformId;
  platformLabel: string;
  where: Where[];
  engine: string;
  maturity: Maturity;
  serves: RuntimeKind[];           // Game.runtime values this runtime launches
  cloudRuntimes?: string[];        // worker runtime ids advertised by cloud workers
  formats: string[];
  userFiles?: string;              // what the player must provide (never shipped by Mishrin)
  note: string;
  tests: string;                   // where the claim is verified
}

export const RUNTIMES: RuntimeDescriptor[] = [
  { id: 'browser', name: 'Browser', platform: 'browser', platformLabel: 'Browser', where: ['local'], engine: 'WASM (MPC Framebuffer ABI) · HTML5 sandbox · WebGPU',
    maturity: 'ready', serves: ['wasm', 'web', 'webgpu'], formats: ['.wasm', '.html'], note: 'Runs on this device in a sandboxed worker or iframe.', tests: 'tests/e2e.py' },
  { id: 'mishrin-p1', name: 'Mishrin P1', platform: 'ps1', platformLabel: 'PS1-class', where: ['local'], engine: 'PCSX-ReARMed → WebAssembly (GPL-2.0)',
    maturity: 'ready', serves: ['p1'], formats: ['CUE+BIN', 'BIN', 'ISO', 'CHD', 'PBP', 'EXE', 'M3U'], userFiles: 'Your own game discs; optional BIOS (an open HLE BIOS is built in).',
    note: 'Runs locally; your files never leave this device.', tests: 'tests/emu/*' },
  { id: 'ps2', name: 'Mishrin P2', platform: 'ps2', platformLabel: 'PS2-class', where: ['local', 'cloud'], engine: 'Cloud: PCSX2 worker profile · Local: not built',
    maturity: 'in-development', serves: ['p2'], cloudRuntimes: ['ps2'], formats: ['ISO', 'CHD', 'CUE+BIN'], userFiles: 'Your own discs and your own PS2 BIOS (installed on the worker by its operator).',
    note: 'Detection, upload, scheduling and the worker profile exist and are tested with a mock emulator. No real PS2 emulator has been run here.', tests: 'tests/cloud/universal.test.mjs · tests/cloud/e2e_windows.py (mock)' },
  { id: 'ps3-cloud', name: 'Mishrin P3 Cloud', platform: 'ps3', platformLabel: 'PS3-class', where: ['cloud'], engine: 'RPCS3 on a GPU worker',
    maturity: 'architecture-ready', serves: ['p3'], cloudRuntimes: ['ps3'], formats: ['Game folder (PS3_GAME)', 'ISO'], userFiles: 'Your own games and your own PS3 system software (installed on the worker by its operator).',
    note: 'Architecture ready, runtime not deployed: session API, scheduling, queueing, isolation, input, saves and streaming are implemented and tested with a mock RPCS3.', tests: 'tests/cloud/universal.test.mjs · tests/cloud/test_worker.py · tests/cloud/e2e_windows.py (mock)' },
  { id: 'windows-cloud', name: 'Windows', platform: 'windows', platformLabel: 'Windows', where: ['cloud'], engine: 'Wine 9 (WoW64) + DXVK / VKD3D-Proton on a GPU worker',
    maturity: 'ready', serves: ['x64-win', 'x86'], cloudRuntimes: ['x64-win', 'x86'], formats: ['.exe (single file)', 'registered titles'],
    note: 'Ready on the tested targets (Win32 GDI, D3D9, D3D11; 32/64-bit). Availability depends on deployed workers.', tests: 'tests/cloud/e2e_windows.py' },
  { id: 'ps4', name: 'Mishrin P4', platform: 'ps4', platformLabel: 'PS4-class', where: [], engine: '—', maturity: 'research', serves: ['p4'], formats: ['PKG'],
    note: 'Detection only.', tests: 'tests/emu/unit.test.ts' },
];

export const MATURITY_LABEL: Record<Maturity, string> = { ready: 'Ready', 'in-development': 'In development', 'architecture-ready': 'Architecture ready', research: 'Research' };
export const byRuntimeId = (id: RuntimeId) => RUNTIMES.find(r => r.id === id)!;
export function descriptorFor(g: Pick<Game, 'runtime'>): RuntimeDescriptor | null {
  return RUNTIMES.find(r => r.serves.includes(g.runtime)) ?? null;
}

// ------------------------------------------------------------------ live state
export interface CloudRuntimeReport { runtime: string; workers: number; capacity: number; active: number; free: number; queued: number; mock: boolean; emulators: { name: string; version: string; firmware: boolean; mock: boolean }[] }
export interface CloudReport { runtimes: Record<string, CloudRuntimeReport>; sessions: number; auth: { required: boolean } }

export type LiveState = 'available' | 'busy' | 'mock-only' | 'not-deployed' | 'no-cloud' | 'unsupported' | 'unavailable';
export interface LiveStatus { state: LiveState; label: string; detail: string; ok: boolean }

/** Combine maturity + live checks into what the UI shows. `cloud` is null when no endpoint is configured or reachable. */
export function liveStatus(d: RuntimeDescriptor, caps: Pick<Caps, 'wasm' | 'webgpu'>, cloud: CloudReport | null | undefined, cloudConfigured: boolean, p1Core = true): LiveStatus {
  if (d.maturity === 'research') return { state: 'unsupported', label: 'Research', detail: d.note, ok: false };
  if (d.where.includes('local') && d.maturity === 'ready') {
    if (!caps.wasm) return { state: 'unsupported', label: 'Unavailable', detail: 'This browser lacks WebAssembly.', ok: false };
    if (d.id === 'mishrin-p1' && !p1Core) return { state: 'unavailable', label: 'Core missing', detail: 'The P1 core is not installed on this server.', ok: false };
    return { state: 'available', label: 'Ready', detail: d.note, ok: true };
  }
  if (!d.cloudRuntimes?.length) return { state: 'unavailable', label: MATURITY_LABEL[d.maturity], detail: d.note, ok: false };
  if (!cloudConfigured) return { state: 'no-cloud', label: 'No cloud', detail: 'Add your cloud endpoint in Settings → Cloud Gaming.', ok: false };
  if (!cloud) return { state: 'unavailable', label: 'Cloud unreachable', detail: 'The cloud endpoint did not answer.', ok: false };
  const reps = d.cloudRuntimes.map(r => cloud.runtimes[r]).filter(Boolean) as CloudRuntimeReport[];
  if (!reps.length) return { state: 'not-deployed', label: d.maturity === 'ready' ? 'No workers' : 'Not deployed', detail: `No ${d.platformLabel} worker is deployed on this cloud.`, ok: false };
  const real = reps.filter(r => r.emulators.some(e => !e.mock) || (!r.mock && !r.emulators.length));
  const free = reps.reduce((a, r) => a + r.free, 0), queued = reps.reduce((a, r) => a + r.queued, 0), workers = reps.reduce((a, r) => a + r.workers, 0);
  if (!real.length) return { state: 'mock-only', label: 'Mock worker', detail: `${workers} mock worker(s) for testing — no real ${d.platformLabel} emulator is deployed.`, ok: false };
  if (d.maturity !== 'ready') return { state: free ? 'available' : 'busy', label: `${MATURITY_LABEL[d.maturity]} · deployed`, detail: `${workers} worker(s), ${free} free. ${d.note}`, ok: true };
  return free ? { state: 'available', label: 'Ready', detail: `${workers} worker(s), ${free} free slot(s).`, ok: true }
    : { state: 'busy', label: 'Busy', detail: `All ${workers} worker(s) busy${queued ? ` · ${queued} waiting` : ''}. You will be queued.`, ok: true };
}
