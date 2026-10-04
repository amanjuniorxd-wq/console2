import './styles/app.css';
import { loadCatalog } from './games/catalog';
import { mountShell } from './ui/app';
import { initNav, setPadEnabled } from './components/nav';
import { settings, onSettings } from './ui/settings-store';
import { applyMemoryMode, reclaimAll } from './mpc';
import { probe } from './mpc/probe';

const t0 = performance.now();
const boot = document.getElementById('boot')!;
// First visit in a session shows the full brand sequence; reloads skip straight in.
let firstRun = true;
try { firstRun = !sessionStorage.getItem('mishrin.booted'); sessionStorage.setItem('mishrin.booted', '1'); } catch { /* private mode */ }
const MIN_SPLASH = firstRun ? 1100 : 0;

document.documentElement.classList.toggle('lite', settings.reduceEffects);
applyMemoryMode();
initNav();
setPadEnabled(settings.controller);
onSettings(s => setPadEnabled(s.controller));

async function start() {
  await loadCatalog();
  mountShell();
  const wait = MIN_SPLASH - (performance.now() - t0);
  if (wait > 0) await new Promise(r => setTimeout(r, wait));
  boot.classList.add('out');
  setTimeout(() => boot.remove(), 400);
  (window as unknown as { __mishrin: object }).__mishrin = { readyMs: Math.round(performance.now() - t0) };
  // Off the critical path: capability probe (WebGPU adapter) and the offline/runtime-cache worker.
  const idle = (window as Window & { requestIdleCallback?: (f: () => void) => void }).requestIdleCallback ?? ((f: () => void) => setTimeout(f, 200));
  idle(() => { void probe(); });
  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1')) {
    idle(() => navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`).catch(() => {}));
  }
}

// Memory pressure: drop compiled runtimes when the console goes to the background on low-memory devices.
document.addEventListener('visibilitychange', () => { if (document.hidden && settings.lowMemory) reclaimAll(); });

start().catch(e => {
  boot.querySelector('p')!.textContent = 'Could not start. ' + ((e as Error).message || '');
  const b = document.createElement('button');
  b.textContent = 'RETRY'; b.style.cssText = 'background:#ff8a00;color:#140800;border:0;border-radius:99px;padding:12px 26px;font-weight:800;letter-spacing:.2em;cursor:pointer';
  b.onclick = () => location.reload();
  boot.append(b); b.focus();
});
