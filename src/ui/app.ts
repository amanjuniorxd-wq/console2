/** Console shell: sidebar / mobile bars, hash router, Home and Game Detail views (eager — first paint). */
import { games, byId, isPlayable, onCatalog, attachFile } from '../games/catalog';
import type { Game } from '../games/types';
import { artUrl } from '../components/art';
import { card } from '../components/card';
import { logo } from '../components/logo';
import { ic } from '../components/icons';
import { esc, h, toast } from '../components/ui';
import { focusFirst, onSection, padConnected } from '../components/nav';
import { planFor } from '../mpc';
import { settings, onSettings } from './settings-store';
import { enterFullscreen } from './fullscreen';

type Cleanup = void | (() => void);
type View = (el: HTMLElement, arg: string) => Cleanup | Promise<Cleanup>;

const SECTIONS = [['home', 'Home', ic.home], ['library', 'Library', ic.library], ['search', 'Search', ic.search], ['upload', 'Upload Game', ic.upload], ['emulators', 'Emulators', ic.chip], ['controllers', 'Controllers', ic.pad], ['settings', 'Settings', ic.settings]] as const;
/** Bottom bar on phones: five large targets. Search and Controllers stay reachable from Library and Settings. */
const MOBILE = new Set(['home', 'library', 'upload', 'emulators', 'settings']);

const views: Record<string, () => Promise<View>> = {
  home: async () => home,
  game: async () => detail,
  library: () => import('./library').then(m => m.library),
  search: () => import('./library').then(m => m.search),
  settings: () => import('./settings').then(m => m.settingsView),
  upload: () => import('./emulation').then(m => m.upload),
  emulators: () => import('./emulation').then(m => m.emulators),
  controllers: () => import('./emulation').then(m => m.controllers),
  play: () => import('./player').then(m => m.player),
};

let viewEl: HTMLElement;
let cleanup: Cleanup;
let navSeq = 0;

export function mountShell(): void {
  const app = document.getElementById('app')!;
  const navBtns = (cls: string, only?: Set<string>) => SECTIONS.filter(([k]) => !only || only.has(k)).map(([k, label, icon]) => `<a class="navbtn ${cls}" href="#/${k}" data-sec="${k}">${icon}<span>${only && k === 'upload' ? 'Upload' : label}</span></a>`).join('');
  app.innerHTML = `
<aside class="rail" aria-label="Console">
  <div class="brand">${logo()}<div class="wordmark">MISHRIN<small>CONSOLE</small></div></div>
  <nav>${navBtns('')}</nav>
  <div class="status" data-status></div>
</aside>
<header class="topbar">${logo()}<div class="wordmark">MISHRIN</div><div class="status" data-status></div></header>
<main id="view" tabindex="-1"></main>
<nav class="tabbar" aria-label="Console">${navBtns('', MOBILE)}</nav>`;
  viewEl = app.querySelector('#view')!;
  app.hidden = false;
  addEventListener('hashchange', route);
  onSection(d => {
    const cur = SECTIONS.findIndex(s => s[0] === (location.hash.match(/^#\/(\w+)/)?.[1] ?? 'home'));
    location.hash = `#/${SECTIONS[(cur + d + SECTIONS.length) % SECTIONS.length][0]}`;
  });
  status();
  for (const ev of ['online', 'offline', 'gamepadconnected', 'mishrin:pad']) addEventListener(ev, status);
  onSettings(status);
  setInterval(status, 30000);
  route();
}

function status(): void {
  const online = navigator.onLine;
  const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const html = `<span title="${online ? 'Online' : 'Offline'}" class="${online ? 'on' : ''}">${online ? '●' : '○'}</span>${padConnected() ? `<span class="on" title="Controller connected">${ic.pad}</span>` : ''}${settings.cloudEndpoint ? `<span class="${online ? 'on' : ''}" title="Cloud ready">${ic.cloud}</span>` : ''}<span>${time}</span>`;
  document.querySelectorAll('[data-status]').forEach(e => { if (e.innerHTML !== html) e.innerHTML = html; });
}

async function route(): Promise<void> {
  const m = location.hash.match(/^#\/(\w+)(?:\/([\w-]+))?/);
  const name = m && views[m[1]] ? m[1] : 'home';
  const arg = m?.[2] ?? '';
  const seq = ++navSeq;
  document.querySelectorAll<HTMLElement>('[data-sec]').forEach(a => a.dataset.sec === (name === 'game' ? '' : name) ? a.setAttribute('aria-current', 'page') : a.removeAttribute('aria-current'));
  const view = await views[name]().catch(() => null);
  if (seq !== navSeq) return;
  if (!view) { viewEl.innerHTML = `<div class="empty">Could not load this screen. <button class="btn btn-sm" onclick="location.reload()">Retry</button></div>`; return; }
  if (typeof cleanup === 'function') cleanup();
  cleanup = undefined;
  if (name !== 'play') { viewEl.replaceChildren(); viewEl.scrollTop = 0; }
  cleanup = await view(viewEl, arg);
  // Controller/keyboard-first focus; skipped on touch-only devices so no focus ring or keyboard pops up.
  if (seq === navSeq && name !== 'play' && autoFocusOk()) focusFirst(viewEl);
}

const autoFocusOk = () => !matchMedia('(pointer: coarse)').matches || padConnected();

// ---------------------------------------------------------------- Home
const home: View = el => {
  const render = () => {
    const featured = games.find(isPlayable) ?? games[0];
    el.replaceChildren();
    if (!featured) { el.innerHTML = `<div class="empty">No games yet. <a class="btn btn-sm" href="#/library">Add a game</a></div>`; return; }
    const hero = h('section', 'hero');
    hero.innerHTML = `<div class="hero-art"><img src="${esc(artUrl(featured))}" alt="" fetchpriority="high" decoding="async"></div>
<div><p class="tagline">Games Beyond Limits</p><h1>${esc(featured.title)}</h1><p>${esc(featured.description)}</p>
<div class="actions"><button class="btn btn-play btn-xl" data-autofocus data-act="play">${ic.play}Play</button><a class="btn" href="#/game/${featured.id}">Details</a></div></div>`;
    hero.querySelector<HTMLButtonElement>('[data-act=play]')!.onclick = () => playGame(featured);
    const sec = h('section', 'section'); sec.innerHTML = '<h2>Featured Games</h2>';
    const row = h('div', 'row'); row.setAttribute('role', 'list');
    for (const g of games) row.append(card(g));
    sec.append(row);
    el.append(hero, sec);
  };
  render();
  const off = onCatalog(() => { render(); if (autoFocusOk()) focusFirst(el); });
  return () => { off(); };
};

/** Launch from a user gesture: fullscreen must be requested synchronously here. */
export function playGame(g: Game): void {
  if (!isPlayable(g)) { location.hash = `#/game/${g.id}`; return; }
  enterFullscreen();
  location.hash = `#/play/${g.id}`;
}

// ---------------------------------------------------------------- Game detail
const EMU_NAME: Record<string, string> = { p1: 'Mishrin P1', p2: 'Mishrin P2', p3: 'Mishrin P3', p4: 'Mishrin P4' };
const EMU_COMPAT: Record<string, string> = { p1: 'Compatibility: Working', p2: 'Compatibility: Experimental', p3: 'Compatibility: Research', p4: 'Compatibility: Research' };
const fmtSize = (n: number) => (n >= 1e9 ? `${(n / 1e9).toFixed(2)} GB` : `${(n / 1e6).toFixed(1)} MB`);
const detail: View = async (el, id) => {
  const g = byId(id);
  if (!g) { el.innerHTML = `<div class="empty">Game not found. <a class="btn btn-sm" href="#/library">Open Library</a></div>`; return; }
  const p = await planFor(g);
  const ready = !p.blocked;
  el.innerHTML = `<section class="detail">
<div class="hero-art"><img src="${esc(artUrl(g))}" alt="" decoding="async"></div>
<a class="btn btn-sm backbtn" href="#/home" data-act="back">${ic.back}Back</a>
<div>
  <p class="tagline">${g.user ? 'Your Library' : 'Mishrin Console'}</p>
  <h1>${esc(g.title)}</h1>
  <p class="desc">${esc(g.description)}</p>
  <div class="badges">
    ${g.controller !== false ? `<span class="badge">${ic.pad}Controller Support</span>` : ''}
    ${g.emu ? `<span class="badge">${ic.chip}${EMU_NAME[g.emu.platform]}</span><span class="badge">${ic.file}${g.emu.format.toUpperCase()} · ${fmtSize(g.emu.size)}</span><span class="badge">${EMU_COMPAT[g.emu.platform]}</span>`
      : `<span class="badge">${ic.cloud}Local / Cloud Auto</span><span class="badge">${ic.anywhere}Play Anywhere</span>`}
  </div>
  <div class="actions" data-actions></div>
  ${p.blocked && p.blocked.code !== 'no-file' ? `<p class="note warn">${esc(p.blocked.message)}</p>` : ''}
  ${p.blocked?.code === 'no-file' ? `<p class="note">Attach your legally owned game file (.html, MPC .wasm, or a Windows/Linux executable for cloud). It is stored only on this device.</p>` : ''}
</div></section>`;
  el.querySelector<HTMLAnchorElement>('[data-act=back]')!.onclick = e => { e.preventDefault(); history.length > 1 ? history.back() : (location.hash = '#/home'); };
  const acts = el.querySelector('[data-actions]')!;
  if (ready) {
    const b = h('button', 'btn btn-play btn-xl', `${ic.play}Play`); b.dataset.autofocus = '';
    b.onclick = () => playGame(g);
    acts.append(b);
  } else if (p.blocked?.code === 'needs-cloud') {
    const b = h('a', 'btn btn-play btn-xl', `${ic.cloud}Set up cloud`); b.href = '#/settings/cloud'; b.dataset.autofocus = '';
    acts.append(b);
  }
  if (!g.emu && (p.blocked?.code === 'no-file' || g.user || g.url.startsWith('idb:'))) {
    const input = h('input'); input.type = 'file'; input.hidden = true;
    input.accept = '.html,.htm,.wasm,.exe,application/wasm,text/html';
    const b = h('button', `btn${p.blocked?.code === 'no-file' ? ' btn-play btn-xl' : ''}`, `${ic.file}${g.url ? 'Replace file' : 'Add game file'}`);
    if (p.blocked?.code === 'no-file') b.dataset.autofocus = '';
    b.onclick = () => input.click();
    input.onchange = async () => {
      const f = input.files?.[0]; if (!f) return;
      b.disabled = true;
      try { await attachFile(g, f); toast('Game file added'); route(); }
      catch (e) { toast((e as Error).message, 4200); b.disabled = false; }
    };
    acts.append(b, input);
  }
};

export { route as rerender };
