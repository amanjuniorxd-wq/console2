/**
 * Mishrin Runtime Optimizer — MPC policy for emulation workloads, tuned to ~80% intensity:
 * use most of what the device offers (cores, memory for caches, GPU for presentation) while keeping
 * headroom for the browser, the UI thread, audio and thermals. Pure functions: everything here is
 * decided from measurements, and unit-tested.
 */
export type Profile = 'auto' | 'battery' | 'balanced' | 'performance' | 'maximum';
export const PROFILES: [Profile, string][] = [['auto', 'Auto'], ['battery', 'Battery'], ['balanced', 'Balanced'], ['performance', 'Performance'], ['maximum', 'Maximum Mishrin']];

export const INTENSITY = 0.8;

export interface DeviceInfo { cores: number; memGB: number; webgpu: boolean; mobile: boolean; charging?: boolean | null; lowMemory: boolean }
export interface Plan {
  profile: Exclude<Profile, 'auto'>;
  /** Max emulation time per frame we allow before frameskipping presentation (ms). */
  budgetMs: number;
  /** Emulated frames we may run back-to-back to catch up after a hiccup. */
  maxCatchUp: number;
  /** Present every Nth emulated frame (1 = all). Game speed is unaffected. */
  presentEvery: number;
  /** Block cache for disc reads (MB). */
  diskCacheMB: number;
  presenter: 'webgpu' | 'canvas2d';
  /** Worker threads the platform may use (P1's core is single-threaded; future cores use this). */
  workers: number;
}

/** Choose the effective profile. Auto = Performance on capable plugged-in devices, Balanced otherwise. */
export function resolveProfile(p: Profile, d: DeviceInfo): Exclude<Profile, 'auto'> {
  if (p !== 'auto') return p;
  if (d.lowMemory || (d.mobile && d.charging === false)) return 'balanced';
  return d.cores >= 4 && d.memGB >= 4 && !d.mobile ? 'performance' : 'balanced';
}

export function plan(p: Profile, d: DeviceInfo, fps = 60): Plan {
  const profile = resolveProfile(p, d);
  const frame = 1000 / fps;
  const cap = { battery: 0.6, balanced: 0.75, performance: INTENSITY, maximum: 0.9 }[profile];
  const memBudgetMB = Math.max(32, d.memGB * 1024 * 0.05 * (profile === 'battery' ? 0.5 : 1)); // ≤5% of RAM for caches
  return {
    profile,
    budgetMs: +(frame * cap).toFixed(2),
    maxCatchUp: profile === 'battery' ? 2 : profile === 'maximum' ? 5 : 3,
    presentEvery: profile === 'battery' ? 2 : 1,
    diskCacheMB: Math.round(Math.min(d.lowMemory ? 8 : 64, memBudgetMB * 0.5)),
    presenter: d.webgpu && profile === 'maximum' ? 'webgpu' : 'canvas2d',
    workers: Math.max(1, Math.floor((d.cores - 1) * INTENSITY)), // leave a core for UI/audio
  };
}

/**
 * Adaptive control, called once per second with measurements. Returns an updated presentEvery:
 * skip presenting frames (never emulated frames) when emulation + presentation exceeds the budget,
 * and recover when there is headroom. Hysteresis avoids oscillation.
 */
export function adaptPresent(cur: number, p: Plan, m: { emuMs: number; presentMs: number; behind: number }): number {
  const cost = m.emuMs + m.presentMs / cur;
  if ((cost > p.budgetMs || m.behind > 0) && cur < 4) return cur + 1;
  if (cost < p.budgetMs * 0.6 && m.behind === 0 && cur > (p.profile === 'battery' ? 2 : 1)) return cur - 1;
  return cur;
}

/** Deterministic frame scheduler: how many emulated frames are due now (fixed timestep, bounded catch-up). */
export function framesDue(startMs: number, nowMs: number, framesRun: number, fps: number, maxCatchUp: number): { run: number; resync: boolean } {
  const due = Math.floor(((nowMs - startMs) * fps) / 1000) - framesRun;
  if (due > maxCatchUp * 4) return { run: 1, resync: true };   // stalled (tab hidden, debugger): don't fast-forward
  return { run: Math.max(0, Math.min(due, maxCatchUp)), resync: false };
}
