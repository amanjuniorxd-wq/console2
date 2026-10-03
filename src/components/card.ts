import type { Game } from '../games/types';
import { isPlayable } from '../games/catalog';
import { artUrl } from './art';
import { esc } from './ui';
import { ic } from './icons';
import { predict } from '../mpc';
import { enterFullscreen } from '../ui/fullscreen';

const GENRE: Record<string, string> = { fantasy: 'Fantasy', racing: 'Racing', scifi: 'Sci-Fi', action: 'Action', landscape: 'Adventure' };
const EMU: Record<string, string> = { p1: 'Mishrin P1 · Working', p2: 'Mishrin P2 · Experimental', p3: 'Mishrin P3 · Research', p4: 'Mishrin P4 · Research' };
const size = (n: number) => (n >= 1e9 ? `${(n / 1e9).toFixed(1)} GB` : `${Math.max(1, Math.round(n / 1e6))} MB`);

/** Card = artwork + title + Play. Card opens details; the Play chip launches directly. */
export function card(g: Game): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'card';
  b.dataset.id = g.id;
  const ready = isPlayable(g);
  b.setAttribute('aria-label', `${g.title}${ready ? '' : ', game file not added'}`);
  b.innerHTML = `<img class="art" src="${esc(artUrl(g))}" alt="" loading="lazy" decoding="async" width="480" height="270">
<span class="meta"><span><span class="title">${esc(g.title)}</span><span class="sub">${esc(g.emu ? `${EMU[g.emu.platform]} · ${size(g.emu.size)}` : g.user ? 'Your game' : GENRE[g.genre ?? ''] ?? 'Game')}</span></span>
<span class="chip-play${ready ? '' : ' muted'}" data-play>${ready ? ic.play + 'Play' : 'Add file'}</span></span>`;
  b.addEventListener('click', e => {
    const direct = (e.target as HTMLElement).closest('[data-play]') && ready;
    if (direct) enterFullscreen();
    location.hash = direct ? `#/play/${g.id}` : `#/game/${g.id}`;
  });
  b.addEventListener('focus', () => predict(g));
  b.addEventListener('pointerenter', () => predict(g));
  return b;
}
