export interface Settings {
  runtime: 'auto' | 'local' | 'cloud';
  cloudQuality: 'auto' | 'performance' | 'balanced' | 'quality';
  resolution: 'auto' | '720' | '1080' | '1440' | 'native';
  maxFps: 30 | 60 | 120 | 0;
  controller: boolean;
  lowMemory: boolean;
  cloudEndpoint: string;
  autoFullscreen: boolean;
  idleShutdownMin: number;
  prefetch: boolean;
  reduceEffects: boolean;
  showStats: boolean;
  touchControls: 'auto' | 'on' | 'off';
  emuProfile: 'auto' | 'battery' | 'balanced' | 'performance' | 'maximum';
  emuScaling: 'sharp' | 'pixel' | 'smooth';
  /** Mishrin P1: plug a PlayStation Mouse into a port (games that support the mouse peripheral). */
  emuMouse: 'off' | 'port1' | 'port2';
}

const KEY = 'mishrin.settings.v1';
export const DEFAULTS: Settings = {
  runtime: 'auto', cloudQuality: 'auto', resolution: 'auto', maxFps: 60, controller: true, lowMemory: false,
  cloudEndpoint: '', autoFullscreen: true, idleShutdownMin: 10, prefetch: true, reduceEffects: false,
  showStats: false, touchControls: 'auto', emuProfile: 'auto', emuScaling: 'pixel', emuMouse: 'off',
};

function load(): Settings {
  try { return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(KEY) || '{}') }; } catch { return { ...DEFAULTS }; }
}

export const settings: Settings = load();
const subs = new Set<(s: Settings) => void>();

export function setSetting<K extends keyof Settings>(k: K, v: Settings[K]): void {
  settings[k] = v;
  try { localStorage.setItem(KEY, JSON.stringify(settings)); } catch { /* storage unavailable: keep in memory */ }
  subs.forEach(f => f(settings));
}
export function resetSettings(): void {
  Object.assign(settings, DEFAULTS);
  try { localStorage.removeItem(KEY); } catch { /* ignore */ }
  subs.forEach(f => f(settings));
}
export const onSettings = (f: (s: Settings) => void) => (subs.add(f), () => subs.delete(f));
