/**
 * Universal runtime registry — the single, machine-readable source of what Mishrin can run, where, and how mature it is.
 * The UI derives every status label from here plus *live* state (device capabilities, the cloud's /api/runtimes report).
 * Nothing in the UI hardcodes availability.
 *
 * Maturity is a property of the code; availability is a property of the moment:
 *   ready               runs real software, verified by tests in this repo
 *   in-development      partially built; not usable for real games yet
 *   architecture-ready  protocol + worker integration + tests with a mock emulator; no real emulator integrated
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
  { id: 'ps2', name: 'Mishrin P2', platform: 'ps2', platformLabel: 'PS2-class', where: ['local', 'cloud'], engine: 'Cloud: PCSX2 1.6 on a worker · Local: not built',
    maturity: 'in-development', serves: ['p2'], cloudRuntimes: ['ps2'], formats: ['ISO', 'CHD', 'CUE+BIN'], userFiles: 'Your own discs and your own PS2 BIOS (installed on the worker by its operator).',
    note: 'Real PCSX2 runs on cloud workers, verified end to end with original Mishrin test software (video, audio, full controller, memory-card saves). Games need a PS2 BIOS from your own console, installed on the worker by its operator.', tests: 'tests/real/e2e_real_ps2.py (REAL_EMULATOR_TEST) · tests/cloud/e2e_windows.py (mock)' },
  { id: 'ps3-cloud', name: 'Mishrin P3 Cloud', platform: 'ps3', platformLabel: 'PS3-class', where: ['cloud'], engine: 'RPCS3 0.0.43 on a worker (LLVM PPU · Vulkan RSX)',
    maturity: 'in-development', serves: ['p3'], cloudRuntimes: ['ps3'], formats: ['Game folder (PS3_GAME)', 'ISO (decrypted)'], userFiles: 'Download the official PS3 system software (PS3UPDAT.PUP) from PlayStation and provide your own legally dumped PS3 game ISO/game folder. Mishrin does not distribute firmware or games.',
    note: 'Cloud RPCS3 is the intended browser path. Before a session can run real games, the worker operator must install official PS3 system software and the player must provide a legally obtained game dump. Mishrin provides the emulator, cloud session, streaming and controls; it does not distribute Sony firmware or commercial games.', tests: 'tests/real/e2e_real_ps3.py (REAL_EMULATOR_TEST) · tests/cloud/e2e_windows.py (mock)' },
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
export type EmulatorState = 'READY' | 'NOT_VERIFIED' | 'INSTALLATION_REQUIRED' | 'FIRMWARE_REQUIRED' | 'BIOS_REQUIRED' | 'ERROR' | 'MOCK';
export interface CloudEmulator { name: string; version: string; firmware: boolean; mock: boolean; status?: EmulatorState; firmwareLabel?: string; requires?: string;
  testMode?: boolean; advertised?: boolean; worker?: string; formats?: string[]; verified?: { ok: boolean; firstFrameMs: number | null; detail: string } }
export interface CloudRuntimeReport { runtime: string; workers: number; capacity: number; active: number; free: number; queued: number; mock: boolean; emulators: CloudEmulator[] }
export interface CloudReport { runtimes: Record<string, CloudRuntimeReport>; sessions: number; auth: { required: boolean } }

export type LiveState = 'available' | 'busy' | 'test-mode' | 'mock-only' | 'not-deployed' | 'no-cloud' | 'unsupported' | 'unavailable'
  | 'installation-required' | 'firmware-required' | 'not-verified' | 'error';
export interface LiveStatus { state: LiveState; label: string; detail: string; ok: boolean; requires?: string }

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
  const live = reps.filter(r => r.workers > 0);
  const realEmus = reps.flatMap(r => r.emulators).filter(e => !e.mock);
  if (!live.length) {
    // installed somewhere but not taking sessions: say exactly why (never "Ready")
    const pick = (st: EmulatorState) => realEmus.find(e => e.status === st);
    const fw = pick('BIOS_REQUIRED') || pick('FIRMWARE_REQUIRED');
    if (fw) return { state: 'firmware-required', label: `Real emulator · ${fw.firmwareLabel || 'firmware'} required`, ok: false, requires: fw.requires,
      detail: `${fw.name} ${fw.version} is installed on ${fw.worker}. ${fw.requires || `The operator must install ${fw.firmwareLabel || 'firmware'} from their own console.`}` };
    const er = pick('ERROR');
    if (er) return { state: 'error', label: 'Emulator error', detail: `${er.name} failed its startup self-test on ${er.worker}: ${er.verified?.detail || 'unknown'}`, ok: false };
    const nv = pick('NOT_VERIFIED');
    if (nv) return { state: 'not-verified', label: 'Installed · not verified', detail: `${nv.name} is installed on ${nv.worker} but has not passed a real boot test.`, ok: false };
    const ins = pick('INSTALLATION_REQUIRED');
    if (ins) return { state: 'installation-required', label: 'Installation required', detail: `The ${ins.name} profile exists on ${ins.worker} but the emulator binary is not installed.`, ok: false };
    return { state: 'not-deployed', label: d.maturity === 'ready' ? 'No workers' : 'Not deployed', detail: `No ${d.platformLabel} worker is deployed on this cloud.`, ok: false };
  }
  const real = live.filter(r => r.emulators.some(e => !e.mock && e.advertised !== false) || (!r.mock && !r.emulators.length));
  const free = live.reduce((a, r) => a + r.free, 0), queued = live.reduce((a, r) => a + r.queued, 0), workers = live.reduce((a, r) => a + r.workers, 0);
  if (!real.length) return { state: 'mock-only', label: 'Mock worker', detail: `${workers} mock worker(s) for testing — no real ${d.platformLabel} emulator is deployed.`, ok: false };
  const running = realEmus.filter(e => e.advertised !== false && e.status);   // workers before the self-test protocol send no status
  const verified = running.filter(e => e.status === 'READY');
  if (running.length && !verified.length) {
    const t = running.find(e => e.testMode && e.verified?.ok);
    if (t) return { state: 'test-mode', label: `Real emulator · ${t.firmwareLabel || 'firmware'} required`, ok: true, requires: t.requires,
      detail: `${t.name} ${t.version} booted the Mishrin test ROM on ${t.worker} (first frame ${t.verified?.firstFrameMs ?? '?'} ms). Test mode: only test images run until the operator installs a ${t.firmwareLabel || 'firmware'} from their own console. ${t.requires || ''}` };
    return { state: 'not-verified', label: 'Installed · not verified', detail: `${running[0].name} has not passed a real boot test yet.`, ok: false };
  }
  if (d.maturity !== 'ready' && !verified.length) return { state: free ? 'available' : 'busy', label: `${MATURITY_LABEL[d.maturity]} · deployed`, detail: `${workers} worker(s), ${free} free. ${d.note}`, ok: true };
  return free ? { state: 'available', label: 'Ready', detail: `${workers} worker(s), ${free} free slot(s).`, ok: true }
    : { state: 'busy', label: 'Busy', detail: `All ${workers} worker(s) busy${queued ? ` · ${queued} waiting` : ''}. You will be queued.`, ok: true };
}
