/** Live cloud capability report (GET /api/runtimes), cached briefly and broadcast as `mishrin:runtimes`. */
import { settings } from '../ui/settings-store';
import type { CloudReport } from './registry';

let cache: { ep: string; at: number; report: CloudReport | null } | null = null;
let inflight: Promise<CloudReport | null> | null = null;

export const cachedReport = (): CloudReport | null | undefined => (cache && cache.ep === settings.cloudEndpoint ? cache.report : undefined);

export function cloudReport(maxAgeMs = 10_000): Promise<CloudReport | null> {
  const ep = settings.cloudEndpoint.replace(/\/+$/, '');
  if (!ep) return Promise.resolve(null);
  if (cache && cache.ep === settings.cloudEndpoint && Date.now() - cache.at < maxAgeMs) return Promise.resolve(cache.report);
  inflight ??= fetch(`${ep}/api/runtimes`, { signal: AbortSignal.timeout(4000) })
    .then(r => (r.ok ? r.json() as Promise<CloudReport> : null)).catch(() => null)
    .then(report => { cache = { ep: settings.cloudEndpoint, at: Date.now(), report }; inflight = null; dispatchEvent(new Event('mishrin:runtimes')); return report; });
  return inflight;
}
