// Authentication: device tokens (who is playing) and session tokens (who may control a session).
//
// Device tokens are HMAC-signed, stateless: d1.<deviceId>.<expiry>.<mac>. Issuing one requires a client key when
// CLIENT_KEYS is set (invite / API keys); AUTH_REQUIRED=1 makes them mandatory for sessions, uploads and saves.
// Without AUTH_REQUIRED the legacy per-device saveKey (a bearer capability) keeps working.
// Session tokens are random 256-bit secrets returned once at session creation; every control call must present it.
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const b64u = b => Buffer.from(b).toString('base64url');
const DEVICE = /^[A-Za-z0-9_-]{16,64}$/;

export function createAuth(env = process.env) {
  const secret = env.AUTH_SECRET ? Buffer.from(env.AUTH_SECRET) : randomBytes(32); // random: tokens die with the process
  const clientKeys = (env.CLIENT_KEYS || '').split(',').map(s => s.trim()).filter(Boolean);
  const required = env.AUTH_REQUIRED === '1';
  const ttl = +(env.DEVICE_TOKEN_DAYS || 30) * 86400_000;
  const mac = s => createHmac('sha256', secret).update(s).digest('base64url');
  const eq = (a, b) => { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && timingSafeEqual(x, y); };
  const bearer = req => (req.headers.authorization || '').replace(/^Bearer\s+/i, '');

  return {
    required, clientKeysConfigured: clientKeys.length > 0,
    /** POST /api/auth/device: { deviceId? } + (Bearer client key when CLIENT_KEYS is set) */
    issue(req, deviceId) {
      if (clientKeys.length && !clientKeys.some(k => eq(k, bearer(req)))) return null;
      const id = DEVICE.test(deviceId || '') ? deviceId : b64u(randomBytes(18));
      const exp = Date.now() + ttl;
      return { deviceId: id, expires: exp, token: `d1.${id}.${exp}.${mac(`${id}.${exp}`)}` };
    },
    /** Device id from `x-device-token` (or Bearer d1.…); null when absent/invalid/expired. */
    device(req) {
      const t = req.headers['x-device-token'] || (bearer(req).startsWith('d1.') ? bearer(req) : '');
      const m = /^d1\.([A-Za-z0-9_-]{16,64})\.(\d{10,16})\.([A-Za-z0-9_-]{43})$/.exec(String(t));
      if (!m || +m[2] < Date.now() || !eq(m[3], mac(`${m[1]}.${m[2]}`))) return null;
      return m[1];
    },
    /** The owner a request acts for: verified device id, else (when auth is optional) the legacy saveKey capability. */
    owner(req, legacyKey) {
      const d = this.device(req);
      if (d) return `dev:${d}`;
      if (required) return null;
      return /^[A-Za-z0-9_-]{16,64}$/.test(legacyKey || '') ? legacyKey : null;
    },
    newSessionToken: () => b64u(randomBytes(32)),
    /** Session control: x-session-token header or ?token=, compared in constant time. Admin token also allowed. */
    sessionOk(req, url, s, adminToken) {
      const got = req.headers['x-session-token'] || url.searchParams.get('token') || '';
      if (s.token && got && eq(String(got), s.token)) return true;
      return !!adminToken && eq(bearer(req), adminToken);
    },
  };
}
