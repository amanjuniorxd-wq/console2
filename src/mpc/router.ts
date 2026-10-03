import type { Caps } from './probe';
import type { Game } from '../games/types';
import { CLOUD_ONLY, KNOWN_RUNTIMES, EMU_RUNTIMES } from '../games/types';

const EMU_UNAVAILABLE: Record<string, string> = {
  p2: 'Mishrin P2 is experimental and not available in this build.',
  p3: 'Mishrin P3 is a research target; it cannot run in a browser today.',
  p4: 'Mishrin P4 is a research target; it cannot run in a browser today.',
};
import type { Settings } from '../ui/settings-store';

export type Backend = 'local-wasm' | 'local-web' | 'local-webgpu' | 'local-emu' | 'cloud';
export interface Route { backend: Backend; reason: string }
export interface Plan { routes: Route[]; blocked?: { code: 'no-file' | 'unsupported' | 'needs-cloud' | 'offline'; message: string } }

/** Memory budget MPC allows a local title, in MB. Leaves headroom for the browser + console. */
export function localBudgetMB(caps: Caps, s: Pick<Settings, 'lowMemory'>): number {
  const total = caps.memGB * 1024;
  const share = s.lowMemory ? 0.15 : caps.mobile ? 0.25 : 0.4;
  return Math.max(128, Math.round(total * share));
}

function cloudUsable(caps: Caps, s: Settings): boolean {
  return !!s.cloudEndpoint && caps.webrtc && caps.net.online;
}

/** Device is "weak" for this title: local would likely stutter or OOM. */
function weakFor(game: Game, caps: Caps, s: Settings): string | null {
  const r = game.requirements ?? {};
  if (r.memMB && r.memMB > localBudgetMB(caps, s)) return `needs ~${r.memMB} MB, local budget ${localBudgetMB(caps, s)} MB`;
  if (r.cores && r.cores > caps.cores) return `needs ${r.cores} cores, device has ${caps.cores}`;
  if (r.gpu === 'webgpu' && !caps.webgpu) return 'needs WebGPU';
  if (r.gpu === 'any' && caps.gpuTier === 'none' && caps.mobile) return 'no usable GPU';
  return null;
}

/**
 * Pure routing decision. Returns routes in the order MPC should try them; the launcher falls
 * through on failure (local → cloud). Never returns a backend that cannot run the runtime kind.
 */
export function plan(game: Game, caps: Caps, s: Settings): Plan {
  if (!KNOWN_RUNTIMES.has(game.runtime)) return { routes: [], blocked: { code: 'unsupported', message: `This title's runtime "${game.runtime}" is not supported.` } };
  if (!game.url && !game.chunks?.length) return { routes: [], blocked: { code: 'no-file', message: 'Game file not added yet.' } };
  // Console emulation runs only on this device (the user's files are never uploaded); unavailable cores say so.
  if (EMU_RUNTIMES.has(game.runtime)) {
    if (game.runtime !== 'p1') return { routes: [], blocked: { code: 'unsupported', message: EMU_UNAVAILABLE[game.runtime] } };
    return caps.wasm ? { routes: [{ backend: 'local-emu', reason: 'Mishrin P1 · WebAssembly' }] } : { routes: [], blocked: { code: 'unsupported', message: 'This browser lacks WebAssembly.' } };
  }

  const cloud = cloudUsable(caps, s);
  const isUserFile = game.url.startsWith('idb:');
  const local: Route[] = [];

  if (game.runtime === 'wasm' && caps.wasm) local.push({ backend: 'local-wasm', reason: caps.simd ? 'WASM SIMD' : 'WASM' });
  else if (game.runtime === 'web') local.push({ backend: 'local-web', reason: 'HTML5 sandbox' });
  else if (game.runtime === 'webgpu' && caps.webgpu) local.push({ backend: 'local-webgpu', reason: 'WebGPU' });

  // Cloud nodes can run every runtime kind (subject to node availability, checked at launch).
  // Web packages are rendered in the client's own browser engine, so cloud never helps them.
  const cloudRoute: Route[] = cloud && game.runtime !== 'web'
    ? [{ backend: 'cloud', reason: CLOUD_ONLY.has(game.runtime) ? `${game.runtime} compatibility node` : 'cloud acceleration' }]
    : [];

  if (CLOUD_ONLY.has(game.runtime)) {
    if (cloudRoute.length) return { routes: cloudRoute };
    if (!caps.net.online) return { routes: [], blocked: { code: 'offline', message: 'This title streams from the cloud. You are offline.' } };
    return { routes: [], blocked: { code: 'needs-cloud', message: 'This title runs on a cloud compatibility node. Add your cloud endpoint in Settings → Cloud Gaming.' } };
  }

  if (s.runtime === 'local') return local.length ? { routes: local } : { routes: cloudRoute, ...(!cloudRoute.length && { blocked: { code: 'unsupported', message: 'This device cannot run this title locally.' } }) };
  if (s.runtime === 'cloud' && cloudRoute.length) return { routes: [...cloudRoute, ...local] };

  // Auto: local first unless the device is weak for this title and the network can carry a stream.
  const weak = weakFor(game, caps, s);
  const goodNet = caps.net.rttMs === 0 || caps.net.rttMs < 150;
  const preferCloud = !!weak && cloudRoute.length > 0 && goodNet && !caps.net.saveData && !isUserFile;
  const routes = preferCloud ? [...cloudRoute, ...local] : [...local, ...cloudRoute];
  if (weak && routes[0]) routes[0] = { ...routes[0], reason: `${routes[0].reason}; ${weak}` };
  if (!routes.length) return { routes, blocked: { code: cloud ? 'unsupported' : 'needs-cloud', message: cloud ? 'This device and cloud cannot run this title.' : 'This device cannot run this title locally. Add a cloud endpoint in Settings → Cloud Gaming.' } };
  return { routes };
}
