/** Library (filterable) and Search — both render through one virtualized grid: only visible rows exist in the DOM. */
import { games, isPlayable, onCatalog, addFromFile, addFromUrl } from '../games/catalog';
import type { Game, RuntimeKind } from '../games/types';
import { CLOUD_ONLY } from '../games/types';
import { card } from '../components/card';
import { ic } from '../components/icons';
import { h, modal, chips, toast } from '../components/ui';
import { focusEl } from '../components/nav';
import { cloudReport } from '../runtimes/cloud-status';

const MIN_W = 240, GAP = 18, META = 0; // card height = width * 9/16 (meta overlays the art)

function vgrid(scroller: HTMLElement, extra?: HTMLElement) {
  const grid = h('div', 'vgrid'); grid.setAttribute('role', 'list');
  let items: Game[] = [];
  const pool = new Map<string, HTMLButtonElement>();
  let cols = 1, cw = MIN_W, ch = 135, raf = 0;

  const layout = () => {
    const w = grid.clientWidth || scroller.clientWidth;
    cols = Math.max(1, Math.floor((w + GAP) / (MIN_W + GAP)));
    cw = (w - GAP * (cols - 1)) / cols; ch = cw * 9 / 16 + META;
    const n = items.length + (extra ? 1 : 0);
    grid.style.height = `${Math.ceil(n / cols) * (ch + GAP)}px`;
    paint();
  };
  const paint = () => {
    raf = 0;
    const top = scroller.scrollTop - grid.offsetTop, vh = scroller.clientHeight;
    const r0 = Math.max(0, Math.floor(top / (ch + GAP)) - 1), r1 = Math.ceil((top + vh) / (ch + GAP)) + 1;
    const live = new Set<string>();
    const all: (Game | null)[] = extra ? [null, ...items] : items;
    for (let i = r0 * cols; i < Math.min(all.length, r1 * cols); i++) {
      const g = all[i];
      const key = g ? g.id : '__add';
      live.add(key);
      let el = pool.get(key);
      if (!el) { el = g ? card(g) : (extra as HTMLButtonElement); pool.set(key, el); }
      const x = (i % cols) * (cw + GAP), y = Math.floor(i / cols) * (ch + GAP);
      el.style.cssText = `width:${cw}px;height:${ch}px;transform:translate(${x}px,${y}px)`;
      if (el.parentNode !== grid) grid.append(el);
    }
    for (const [k, el] of pool) if (!live.has(k)) {
      if (el === document.activeElement) continue; // keep focused card alive for controller nav
      el.remove(); if (k !== '__add') pool.delete(k);
    }
  };
  const onScroll = () => { if (!raf) raf = requestAnimationFrame(paint); };
  scroller.addEventListener('scroll', onScroll, { passive: true });
  const ro = new ResizeObserver(layout); ro.observe(grid);
  return {
    el: grid,
    set(list: Game[]) { items = list; for (const [k, e] of pool) if (k !== '__add') { e.remove(); pool.delete(k); } layout(); },
    first: () => grid.querySelector<HTMLElement>('.card[data-id]'),
    dispose() { scroller.removeEventListener('scroll', onScroll); ro.disconnect(); cancelAnimationFrame(raf); },
  };
}

export function score(g: Game, q: string): number {
  if (!q) return 1;
  const t = g.title.toLowerCase();
  if (t.startsWith(q)) return 4;
  if (t.split(/\s+/).some(w => w.startsWith(q))) return 3;
  if (t.includes(q)) return 2;
  return `${g.genre ?? ''} ${g.description}`.toLowerCase().includes(q) ? 1 : 0;
}

type Filter = 'all' | 'ready' | 'nofile' | 'cloud';
const FILTERS: [Filter, string][] = [['all', 'All'], ['ready', 'Ready'], ['nofile', 'Needs file'], ['cloud', 'Cloud']];

export function library(el: HTMLElement) {
  let q = '', f: Filter = 'all';
  const bar = h('div', 'toolbar');
  bar.innerHTML = `<h1>Library</h1><label class="field">${ic.search}<input type="search" placeholder="Filter games" aria-label="Filter games" autocomplete="off"></label>`;
  const input = bar.querySelector('input')!;
  bar.append(chips(FILTERS, f, v => { f = v; apply(); }));
  const addBtn = h('button', 'card card-add', `${ic.plus}<span>Add Game</span>`); addBtn.type = 'button';
  addBtn.onclick = () => addGameDialog();
  el.append(bar);
  const grid = vgrid(el, addBtn);
  el.append(grid.el);
  const apply = () => {
    const list = games.filter(g => (f === 'all' || (f === 'ready' ? isPlayable(g) : f === 'nofile' ? !isPlayable(g) : CLOUD_ONLY.has(g.runtime) || g.url.startsWith('upload:'))) && score(g, q) > 0);
    grid.set(list);
  };
  let t = 0;
  input.oninput = () => { clearTimeout(t); t = window.setTimeout(() => { q = input.value.trim().toLowerCase(); apply(); }, 60); };
  apply();
  grid.first()?.setAttribute('data-autofocus', ''); // controller-first: land on a game, not the text field
  const off = onCatalog(apply);
  // Live runtime status (cloud workers) feeds every card's "platform · LOCAL/CLOUD · status" line.
  addEventListener('mishrin:runtimes', apply);
  cloudReport().catch(() => {});
  return () => { off(); removeEventListener('mishrin:runtimes', apply); grid.dispose(); };
}

export function search(el: HTMLElement) {
  const bar = h('div', 'toolbar search-big');
  bar.innerHTML = `<h1>Search</h1><label class="field">${ic.search}<input type="search" placeholder="Search your games" aria-label="Search your games" autocomplete="off" data-autofocus></label>`;
  const input = bar.querySelector('input')!;
  const empty = h('div', 'empty'); empty.hidden = true;
  el.append(bar, empty);
  const grid = vgrid(el);
  el.append(grid.el);
  const apply = () => {
    const q = input.value.trim().toLowerCase();
    const list = games.map(g => [g, score(g, q)] as const).filter(x => x[1] > 0).sort((a, b) => b[1] - a[1]).map(x => x[0]);
    empty.hidden = list.length > 0; empty.textContent = `No games match "${input.value.trim()}".`;
    grid.set(list);
  };
  input.oninput = apply;
  input.onkeydown = e => { if (e.key === 'Enter') { const c = grid.first(); if (c) focusEl(c); } };
  apply();
  const off = onCatalog(apply);
  return () => { off(); grid.dispose(); };
}

const RUNTIMES: [RuntimeKind, string][] = [['web', 'HTML5'], ['wasm', 'MPC WASM'], ['x64-win', 'Windows (cloud)'], ['linux', 'Linux (cloud)']];

export function addGameDialog(): void {
  modal((sheet, close) => {
    sheet.innerHTML = `<h2>Add Game</h2><div class="stack">
<p class="note" style="margin:0">Only add games you own or are licensed to play. Files stay on this device.</p>
<label class="field"><input data-k="title" placeholder="Title (optional)" aria-label="Title"></label>
<button class="btn btn-play" data-k="file" data-autofocus>${ic.file}Choose game file</button>
<input type="file" hidden accept=".html,.htm,.wasm,.exe,application/wasm,text/html">
<div style="text-align:center;color:var(--dim);font-size:12px;letter-spacing:.2em">OR FROM URL</div>
<label class="field"><input data-k="url" type="url" placeholder="https://… game URL" aria-label="Game URL"></label>
<div data-k="rt"></div>
<button class="btn" data-k="addurl">Add URL</button>
<p class="err" role="alert"></p>
<button class="btn btn-sm" data-k="cancel">Cancel</button></div>`;
    const $ = (k: string) => sheet.querySelector<HTMLElement>(`[data-k=${k}]`)!;
    const title = $('title') as HTMLInputElement, url = $('url') as HTMLInputElement, err = sheet.querySelector('.err')!;
    const file = sheet.querySelector<HTMLInputElement>('input[type=file]')!;
    let rt: RuntimeKind = 'web';
    $('rt').append(chips(RUNTIMES, rt, v => (rt = v)));
    const busy = (b: boolean) => sheet.querySelectorAll('button').forEach(x => (x.disabled = b));
    const done = (g: Game) => { close(); toast(`${g.title} added`); location.hash = `#/game/${g.id}`; };
    $('file').onclick = () => file.click();
    file.onchange = async () => {
      const f = file.files?.[0]; if (!f) return;
      busy(true); err.textContent = '';
      try { done(await addFromFile(f, title.value)); } catch (e) { err.textContent = (e as Error).message; busy(false); }
    };
    $('addurl').onclick = async () => {
      err.textContent = '';
      if (!url.value.trim()) { err.textContent = 'Enter a game URL.'; url.focus(); return; }
      busy(true);
      try { done(await addFromUrl(url.value.trim(), title.value, rt)); } catch (e) { err.textContent = (e as Error).message; busy(false); }
    };
    $('cancel').onclick = close;
  });
}
