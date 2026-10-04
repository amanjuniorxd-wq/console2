import type { Game } from '../games/types';
import { isPlayable } from '../games/catalog';
import { artUrl } from './art';
import { esc } from './ui';
import { ic } from './icons';
import { predict } from '../mpc';
import { enterFullscreen } from '../ui/fullscreen';
import { descriptorFor, liveStatus } from '../runtimes/registry';
import { cachedReport } from '../runtimes/cloud-status';
import { settings } from '../ui/settings-store';
import { probeSync, type Caps } from '../mpc/probe';
let capsCache: Caps | null = null;

/** Universal library line: platform · LOCAL/CLOUD · status — derived from the runtime registry + live state. */
export function runtimeLine(g: Game): { text: string; state: string } {
  const d = descriptorFor(g);
  if (!d) return { text: `${g.runtime} · Unsupported`, state: 'unsupported' };
  const where = d.where.includes('local') && (d.maturity === 'ready' || !d.cloudRuntimes) ? 'Local' : 'Cloud';
  const caps = (capsCache ??= probeSync());
  const live = liveStatus(d, caps, cachedReport() ?? null, !!settings.cloudEndpoint);
  const label = !isPlayable(g) ? 'Needs file' : live.label;
  return { text: `${d.platformLabel} · ${where} · ${label}`, state: live.state };
}

const size = (n: number) => (n >= 1e9 ? `${(n / 1e9).toFixed(1)} GB` : `${Math.max(1, Math.round(n / 1e6))} MB`);

/** Card = artwork + title + Play. Card opens details; the Play chip launches directly. */
export function card(g: Game): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'card';
  b.dataset.id = g.id;
  const ready = isPlayable(g);
  const rl = runtimeLine(g);
  b.setAttribute('aria-label', `${g.title}${ready ? '' : ', game file not added'}`);
  b.innerHTML = `<img class="art" src="${esc(artUrl(g))}" alt="" loading="lazy" decoding="async" width="480" height="270">
<span class="meta"><span><span class="title">${esc(g.title)}</span><span class="sub" data-rt-state="${rl.state}">${esc(`${rl.text}${g.emu ? ` · ${size(g.emu.size)}` : ''}`)}</span></span>
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
