/**
 * Web adapter (HTML5 / WebGPU packages) in a sandboxed iframe.
 *  - Same-origin and user-attached packages go through the MPC store (cached by content hash) and run inside
 *    /runner.html: opaque origin (no allow-same-origin) + a CSP that keeps the game off the network.
 *  - Cross-origin URL titles load directly and keep their own origin.
 *  - Optional postMessage protocol: {mpc:'ready',caps}, {mpc:'save'}→{mpc:'state',data}, {mpc:'load',data}, {mpc:'pause',on}.
 */
import type { LaunchContext, RuntimeAdapter, Session, Stats } from './types';
import type { Backend } from '../mpc/router';
import { getPackage } from '../mpc/store';

function make(backend: Backend): RuntimeAdapter {
  return {
    backend,
    async launch({ game, host, signal, status }: LaunchContext): Promise<Session> {
      const target = game.url.startsWith('idb:') ? null : new URL(game.url, location.href);
      const crossOrigin = !!target && target.origin !== location.origin;
      status('Loading', 0);
      let html: string | null = null;
      if (!crossOrigin) {
        const pkg = await getPackage(game, (l, t) => status('Loading', t ? l / t : 0), signal);
        html = new TextDecoder().decode(pkg.bytes);
        if (!/^\s*</.test(html)) throw new Error('This file is not a web game.');
        // Keep the package's relative asset URLs working inside the runner document.
        if (target) { const base = `<base href="${target.href}">`; html = /<head[^>]*>/i.test(html) ? html.replace(/<head[^>]*>/i, m => m + base) : base + html; }
      }
      const src = crossOrigin ? target!.href : `${import.meta.env.BASE_URL}runner.html`;

      const frame = document.createElement('iframe');
      frame.className = 'game-surface game-frame';
      frame.title = game.title;
      // Cross-origin titles keep their own origin (and storage); same-origin packages get an opaque origin.
      frame.setAttribute('sandbox', `allow-scripts allow-pointer-lock${crossOrigin ? ' allow-same-origin' : ''}`);
      frame.allow = 'gamepad; fullscreen; autoplay; cross-origin-isolated';
      frame.referrerPolicy = 'no-referrer';
      frame.src = src;

      const caps = new Set<string>();
      let stateWaiter: ((d: string | null) => void) | null = null;
      let stats: Stats = { fps: 0, frameMs: 0, width: 0, height: 0, route: backend === 'local-webgpu' ? 'Local · WebGPU' : 'Local · HTML5' };
      const onMsg = (e: MessageEvent) => {
        if (e.source !== frame.contentWindow) return;
        const m = e.data;
        if (!m || typeof m !== 'object' || typeof m.mpc !== 'string') return;
        if (m.mpc === 'runner' && html !== null) { frame.contentWindow!.postMessage({ mpcPackage: html }, '*'); html = null; runnerFed?.(); }
        else if (m.mpc === 'ready' && Array.isArray(m.caps)) m.caps.forEach((c: unknown) => typeof c === 'string' && caps.add(c));
        else if (m.mpc === 'state' && stateWaiter) { stateWaiter(typeof m.data === 'string' && m.data.length < 32 << 20 ? m.data : null); stateWaiter = null; }
        else if (m.mpc === 'stats' && typeof m.fps === 'number') { stats.fps = m.fps; stats.frameMs = +m.frameMs || 0; }
      };
      let runnerFed: (() => void) | null = null;
      const fed = crossOrigin ? Promise.resolve() : new Promise<void>(r => (runnerFed = r));
      addEventListener('message', onMsg);

      await new Promise<void>((res, rej) => {
        const t = setTimeout(() => rej(new Error('Game did not load in time. Check the URL or file.')), 20000);
        frame.onload = () => { fed.then(() => { clearTimeout(t); res(); }); };
        frame.onerror = () => { clearTimeout(t); rej(new Error('Game failed to load.')); };
        signal.addEventListener('abort', () => { clearTimeout(t); rej(signal.reason); }, { once: true });
        host.append(frame);
      }).catch(e => { removeEventListener('message', onMsg); frame.remove(); throw e; });
      status('Ready', 1);
      const resize = () => { const r = frame.getBoundingClientRect(); stats.width = Math.round(r.width * devicePixelRatio); stats.height = Math.round(r.height * devicePixelRatio); };
      resize();
      frame.focus();
      const send = (m: object) => frame.contentWindow?.postMessage(m, '*');
      const enc = new TextEncoder(), dec = new TextDecoder();

      return {
        backend,
        get canSave() { return caps.has('save'); },
        ownsInput: true,
        async save() {
          if (!caps.has('save')) return null;
          const d = await new Promise<string | null>(res => { stateWaiter = res; send({ mpc: 'save' }); setTimeout(() => { if (stateWaiter === res) { stateWaiter = null; res(null); } }, 3000); });
          return d == null ? null : enc.encode(d);
        },
        async load(d) { if (!caps.has('save')) return false; send({ mpc: 'load', data: dec.decode(d) }); return true; },
        pause(on) { if (caps.has('pause')) send({ mpc: 'pause', on }); },
        setScale(s) {
          // Render at a lower internal resolution, upscale with the compositor (GPU), saving fill-rate.
          const k = Math.max(0.25, Math.min(1, s));
          frame.style.width = `${100 * k}%`; frame.style.height = `${100 * k}%`;
          frame.style.transform = k === 1 ? '' : `scale(${1 / k})`; frame.style.transformOrigin = '0 0';
          requestAnimationFrame(resize);
        },
        stats: () => stats,
        dispose() { removeEventListener('message', onMsg); frame.src = 'about:blank'; frame.remove(); },
      };
    },
  };
}

export const localWeb = make('local-web');
export const localWebGpu = make('local-webgpu');
