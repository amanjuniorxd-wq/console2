/**
 * MPC — Mishrin Paradoxical Computer: orchestration layer between the console UI and runtime adapters.
 * Game → MPC (probe, plan, store, prefetch, reclaim) → RuntimeAdapter (LocalWASM | Web | WebGPU | Cloud | future engines).
 */
import type { Game } from '../games/types';
import type { RuntimeAdapter, Session } from '../runtime/types';
import { settings } from '../ui/settings-store';
import { probe, refreshNet, type Caps } from './probe';
import { plan, type Backend, type Plan } from './router';
import { reclaim, setModuleBudget, warm } from './store';

/** Adapters are code-split: only the one a title needs is ever downloaded. Register future engines here. */
const registry: Record<Backend, () => Promise<RuntimeAdapter>> = {
  'local-wasm': () => import('../runtime/local-wasm').then(m => m.localWasm),
  'local-web': () => import('../runtime/local-web').then(m => m.localWeb),
  'local-webgpu': () => import('../runtime/local-web').then(m => m.localWebGpu),
  'local-emu': () => import('../runtime/local-emu').then(m => m.localEmu),
  cloud: () => import('../cloud/client').then(m => m.cloud),
};
export function registerAdapter(b: Backend, load: () => Promise<RuntimeAdapter>) { registry[b] = load; }

export async function caps(): Promise<Caps> { return refreshNet(await probe()); }
export async function planFor(game: Game): Promise<Plan> { return plan(game, await caps(), settings); }

export interface LaunchHooks {
  status(msg: string, progress?: number): void;
  signal: AbortSignal;
}
export interface Launched { session: Session; plan: Plan; fellBack: boolean; ms: number }

/** Try each planned route in order; transparently fall back (e.g. local → cloud) on failure. */
export async function launch(game: Game, host: HTMLElement, h: LaunchHooks): Promise<Launched> {
  const t0 = performance.now();
  const c = await caps();
  const p = plan(game, c, settings);
  if (p.blocked || !p.routes.length) throw Object.assign(new Error(p.blocked?.message ?? 'Cannot run this title.'), { code: p.blocked?.code });
  let lastErr: unknown;
  for (let i = 0; i < p.routes.length; i++) {
    const route = p.routes[i];
    h.signal.throwIfAborted();
    if (i > 0) h.status(route.backend === 'cloud' ? 'Switching to cloud' : 'Switching to local', 0);
    try {
      const adapter = await registry[route.backend]();
      const session = await adapter.launch({ game, host, caps: c, settings, signal: h.signal, status: h.status });
      return { session, plan: p, fellBack: i > 0, ms: Math.round(performance.now() - t0) };
    } catch (e) {
      if (h.signal.aborted) throw e;
      lastErr = e;
      console.warn(`[MPC] ${route.backend} failed:`, e);
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error('Launch failed.');
}

// ---- cache prediction: warm the package of a title the user lingers on ----
let warmTimer = 0;
const warmed = new Set<string>();
export function predict(game: Game | null): void {
  clearTimeout(warmTimer);
  if (!game || !settings.prefetch || warmed.has(game.id) || game.runtime !== 'wasm' || !game.url || game.url.startsWith('idb:')) return;
  warmTimer = window.setTimeout(async () => {
    const c = await caps();
    if (c.net.saveData || !c.net.online || settings.lowMemory) return;
    warmed.add(game.id);
    const idle = (window as Window & { requestIdleCallback?: (f: () => void) => void }).requestIdleCallback ?? ((f: () => void) => setTimeout(f, 1));
    idle(() => void warm(game));
  }, 450);
}

// ---- resource reclamation ----
export function applyMemoryMode(): void { setModuleBudget(settings.lowMemory ? 16 << 20 : 256 << 20); }
export function reclaimAll(): void { reclaim(); warmed.clear(); }
