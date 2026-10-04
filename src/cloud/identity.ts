/** Player identity toward the cloud: a per-device save key (legacy capability) and, when the cloud requires sign-in,
 *  an HMAC-signed device token obtained with an access key (Settings → Cloud Gaming). */
import { settings } from '../ui/settings-store';

const LS = (k: string, v?: string | null) => { try { if (v === undefined) return localStorage.getItem(k); if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch { /* storage unavailable */ } return null; };

export function saveKey(): string {
  let k = LS('mishrin.saveKey');
  if (!k) { k = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(24)))).replace(/[+/=]/g, c => (c === '+' ? '-' : c === '/' ? '_' : '')); LS('mishrin.saveKey', k); }
  return k || '';
}
const tokenKey = () => `mishrin.deviceToken:${settings.cloudEndpoint}`;
export const deviceToken = () => LS(tokenKey()) || '';
export const base = () => settings.cloudEndpoint.replace(/\/+$/, '');

/** Headers that identify this player on every cloud call. */
export function idHeaders(): Record<string, string> {
  const t = deviceToken();
  return { 'x-save-key': saveKey(), ...(t ? { 'x-device-token': t } : {}) };
}

/** Exchange an access key for a device token (only needed when the cloud runs with AUTH_REQUIRED). */
export async function signIn(accessKey: string): Promise<void> {
  const r = await fetch(`${base()}/api/auth/device`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${accessKey}` }, body: JSON.stringify({ deviceId: saveKey() }) });
  if (!r.ok) throw new Error(r.status === 401 ? 'Access key not accepted.' : `Sign-in failed (${r.status}).`);
  LS(tokenKey(), (await r.json()).token);
}
export const signOut = () => LS(tokenKey(), null);
