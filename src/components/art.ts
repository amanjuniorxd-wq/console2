/**
 * Original procedural cinematic artwork (SVG, ~1–2 KB each, generated once per title and memoized as a
 * data URL so the browser rasterizes/caches it like any image). Used for "gen:<genre>" artwork.
 */
import type { Game, Genre } from '../games/types';

function rng(seed: string) {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) h = Math.imul(h ^ seed.charCodeAt(i), 16777619);
  return () => ((h = Math.imul(h ^ (h >>> 15), 2246822507)), (h = Math.imul(h ^ (h >>> 13), 3266489909)), ((h ^= h >>> 16) >>> 0) / 4294967296);
}
const f = (n: number) => n.toFixed(0);

function ridge(r: () => number, y: number, amp: number, steps = 14): string {
  let d = `M0 900 L0 ${f(y)}`;
  for (let i = 1; i <= steps; i++) d += ` L${f((1600 / steps) * i)} ${f(y - r() * amp + amp * 0.3)}`;
  return d + ' L1600 900Z';
}
function stars(r: () => number, n: number, maxY: number) {
  let s = '';
  for (let i = 0; i < n; i++) s += `<circle cx="${f(r() * 1600)}" cy="${f(r() * maxY)}" r="${(r() * 1.8 + 0.4).toFixed(1)}" fill="#fff" opacity="${(r() * 0.7 + 0.2).toFixed(2)}"/>`;
  return s;
}

const SKY = (a: string, b: string, c: string) =>
  `<linearGradient id="s" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${a}"/><stop offset=".6" stop-color="${b}"/><stop offset="1" stop-color="${c}"/></linearGradient>`;
const GLOW = `<radialGradient id="g"><stop offset="0" stop-color="#ffb347"/><stop offset=".35" stop-color="#ff8a00" stop-opacity=".55"/><stop offset="1" stop-color="#ff8a00" stop-opacity="0"/></radialGradient>`;

const scenes: Record<Genre, (r: () => number) => string> = {
  landscape: r => `<defs>${SKY('#05030a', '#3a1404', '#ff8a00')}${GLOW}</defs><rect width="1600" height="900" fill="url(#s)"/>${stars(r, 40, 300)}
    <circle cx="${f(500 + r() * 600)}" cy="560" r="420" fill="url(#g)"/><circle cx="800" cy="560" r="90" fill="#ffcf7a" opacity=".9"/>
    <path d="${ridge(r, 560, 160)}" fill="#2a0f06"/><path d="${ridge(r, 660, 140)}" fill="#170805"/><path d="${ridge(r, 760, 110, 20)}" fill="#0a0403"/>
    <rect y="600" width="1600" height="80" fill="#ff8a00" opacity=".06"/>`,
  fantasy: r => `<defs>${SKY('#030208', '#1c0a14', '#5a2203')}${GLOW}</defs><rect width="1600" height="900" fill="url(#s)"/>${stars(r, 90, 500)}
    <circle cx="1180" cy="230" r="300" fill="url(#g)" opacity=".7"/><circle cx="1180" cy="230" r="74" fill="#ffe2a8"/><circle cx="1150" cy="215" r="70" fill="#1c0a14" opacity=".35"/>
    <path d="${ridge(r, 640, 220, 10)}" fill="#1a0c10"/>
    <path d="M520 700V430l30-60 30 60v-90l40-80 40 80v140h40V350l35-70 35 70v350z" fill="#0b0508"/><rect x="600" y="470" width="10" height="22" fill="#ff8a00"/><rect x="700" y="420" width="10" height="22" fill="#ffb347"/>
    <path d="${ridge(r, 760, 90, 24)}" fill="#050203"/>`,
  racing: r => `<defs>${SKY('#040204', '#2b0c02', '#ff7a00')}${GLOW}<linearGradient id="rd" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#1a0b05"/><stop offset="1" stop-color="#000"/></linearGradient></defs>
    <rect width="1600" height="900" fill="url(#s)"/><circle cx="800" cy="470" r="520" fill="url(#g)"/><circle cx="800" cy="470" r="130" fill="#ffc46b"/>
    <path d="${ridge(r, 470, 80, 30)}" fill="#120604"/><path d="M0 900L760 470h80L1600 900z" fill="url(#rd)"/>
    <path d="M790 470L560 900M810 470L1040 900" stroke="#ff8a00" stroke-width="4" opacity=".8"/>
    ${Array.from({ length: 7 }, (_, i) => `<path d="M${f(797 - i * 6)} ${f(480 + i * i * 9)}h${f(6 + i * 4)}" stroke="#d4af37" stroke-width="${1 + i}"/>`).join('')}
    ${Array.from({ length: 14 }, () => { const y = 480 + r() * 400, x = r() < 0.5 ? r() * 500 : 1100 + r() * 500; return `<path d="M${f(x)} ${f(y)}h${f(80 + r() * 200)}" stroke="#ff8a00" stroke-width="2" opacity=".35"/>`; }).join('')}`,
  scifi: r => `<defs>${SKY('#010104', '#0a0610', '#1e0a03')}${GLOW}<radialGradient id="p" cx=".35" cy=".35"><stop offset="0" stop-color="#ffb347"/><stop offset=".5" stop-color="#8a3200"/><stop offset="1" stop-color="#120502"/></radialGradient></defs>
    <rect width="1600" height="900" fill="url(#s)"/>${stars(r, 160, 900)}
    <circle cx="1050" cy="420" r="420" fill="url(#g)" opacity=".5"/><circle cx="1050" cy="420" r="230" fill="url(#p)"/>
    <ellipse cx="1050" cy="420" rx="400" ry="70" fill="none" stroke="#d4af37" stroke-width="5" opacity=".7" transform="rotate(-14 1050 420)"/>
    <path d="M200 520l140-26 40 26-40 26z" fill="#ff8a00"/><path d="M60 520h140" stroke="#ff8a00" stroke-width="3" opacity=".6"/>
    <path d="${ridge(r, 820, 60, 30)}" fill="#050203"/>`,
  action: r => `<defs>${SKY('#060203', '#3d1003', '#ff6a00')}${GLOW}</defs><rect width="1600" height="900" fill="url(#s)"/>
    <circle cx="${f(300 + r() * 1000)}" cy="640" r="520" fill="url(#g)"/>
    ${Array.from({ length: 22 }, (_, i) => { const w = 50 + r() * 70, h = 160 + r() * 380, x = i * 74 - 20; return `<rect x="${f(x)}" y="${f(900 - h)}" width="${f(w)}" height="${f(h)}" fill="${i % 2 ? '#120504' : '#0a0302'}"/>` + (r() < 0.6 ? `<rect x="${f(x + 12)}" y="${f(920 - h)}" width="6" height="10" fill="#ffb347" opacity=".8"/>` : ''); }).join('')}
    ${Array.from({ length: 40 }, () => `<circle cx="${f(r() * 1600)}" cy="${f(r() * 700)}" r="${(r() * 2.5 + 0.5).toFixed(1)}" fill="#ffb347" opacity="${(r() * 0.8).toFixed(2)}"/>`).join('')}`,
};

const memo = new Map<string, string>();
export function artUrl(g: Pick<Game, 'id' | 'artwork' | 'genre'>): string {
  if (!g.artwork.startsWith('gen:')) return g.artwork;
  const key = g.id + g.artwork;
  let u = memo.get(key);
  if (!u) {
    const genre = (g.artwork.slice(4) || g.genre || 'landscape') as Genre;
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1600 900" preserveAspectRatio="xMidYMid slice">${(scenes[genre] ?? scenes.landscape)(rng(g.id))}</svg>`;
    u = 'data:image/svg+xml,' + encodeURIComponent(svg.replace(/\s{2,}/g, ' '));
    memo.set(key, u);
  }
  return u;
}
