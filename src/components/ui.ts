import { pushBack, focusFirst } from './nav';

export const esc = (s: string) => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', html = ''): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html) e.innerHTML = html;
  return e;
}

let toastT = 0;
export function toast(msg: string, ms = 2600): void {
  document.querySelector('.toast')?.remove();
  const t = h('div', 'toast'); t.setAttribute('role', 'status'); t.textContent = msg;
  document.body.append(t);
  clearTimeout(toastT); toastT = window.setTimeout(() => t.remove(), ms);
}

/** Modal sheet: traps controller/keyboard focus via [data-modal]; B / Esc closes. */
export function modal(build: (sheet: HTMLElement, close: () => void) => void): () => void {
  const prevFocus = document.activeElement as HTMLElement | null;
  const wrap = h('div', 'modal'); wrap.dataset.modal = '';
  wrap.setAttribute('role', 'dialog'); wrap.setAttribute('aria-modal', 'true');
  const sheet = h('div', 'sheet'); wrap.append(sheet);
  document.getElementById('app')!.inert = true;
  let done = false;
  const close = () => {
    if (done) return; done = true; popBack();
    wrap.remove(); document.getElementById('app')!.inert = false; prevFocus?.focus({ preventScroll: true });
  };
  const popBack = pushBack(close);
  wrap.addEventListener('pointerdown', e => { if (e.target === wrap) close(); });
  build(sheet, close);
  document.body.append(wrap);
  focusFirst(sheet);
  return close;
}

export function chips<T extends string | number>(opts: [T, string][], cur: T, onPick: (v: T) => void): HTMLElement {
  const g = h('div', 'chips'); g.setAttribute('role', 'radiogroup');
  for (const [v, label] of opts) {
    const b = h('button', 'chip'); b.textContent = label; b.type = 'button';
    b.setAttribute('aria-pressed', String(v === cur));
    b.onclick = () => { g.querySelectorAll('.chip').forEach(c => c.setAttribute('aria-pressed', 'false')); b.setAttribute('aria-pressed', 'true'); onPick(v); };
    g.append(b);
  }
  return g;
}

export function toggle(on: boolean, label: string, onChange: (v: boolean) => void): HTMLButtonElement {
  const b = h('button', 'toggle'); b.type = 'button';
  b.setAttribute('role', 'switch'); b.setAttribute('aria-checked', String(on)); b.setAttribute('aria-label', label);
  b.onclick = () => { const v = b.getAttribute('aria-checked') !== 'true'; b.setAttribute('aria-checked', String(v)); onChange(v); };
  return b;
}

export const fmtBytes = (n: number) => n < 1024 ? `${n} B` : n < 1 << 20 ? `${(n / 1024).toFixed(1)} KB` : n < 1 << 30 ? `${(n / 1048576).toFixed(1)} MB` : `${(n / 1073741824).toFixed(2)} GB`;
