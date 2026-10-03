import { settings, setSetting, resetSettings, type Settings } from './settings-store';
import { h, chips, toggle, toast, fmtBytes, esc } from '../components/ui';
import { focusEl, padConnected } from '../components/nav';
import { caps, applyMemoryMode, reclaimAll } from '../mpc';
import { localBudgetMB } from '../mpc/router';
import { storeStats, clearStore } from '../mpc/store';
import { allSaves, clearSaves } from '../mpc/saves';
import { games, removeUserData } from '../games/catalog';
import { ic } from '../components/icons';

const TABS = [['general', 'General'], ['performance', 'Performance'], ['cloud', 'Cloud Gaming'], ['controls', 'Controls'], ['display', 'Display'], ['storage', 'Storage'], ['saves', 'Saves'], ['about', 'About']] as const;
type Tab = (typeof TABS)[number][0];

function row(label: string, hint: string, control: HTMLElement | string): HTMLElement {
  const r = h('div', 'setrow');
  r.innerHTML = `<div><span class="lbl">${label}</span>${hint ? `<span class="hint">${hint}</span>` : ''}</div>`;
  typeof control === 'string' ? r.insertAdjacentHTML('beforeend', control) : r.append(control);
  return r;
}
const pick = <K extends keyof Settings>(k: K, opts: [Settings[K], string][]) => chips(opts as [string | number, string][], settings[k] as string | number, v => setSetting(k, v as Settings[K]));
const flag = (k: { [P in keyof Settings]: Settings[P] extends boolean ? P : never }[keyof Settings], label: string, after?: () => void) =>
  toggle(settings[k] as boolean, label, v => { setSetting(k, v as never); after?.(); });

const panels: Record<Tab, (p: HTMLElement) => void | Promise<void>> = {
  general(p) {
    const pref = row('Preferred path', 'Used only when Auto Best Runtime is off.', pick('runtime', [['local', 'This device'], ['cloud', 'Cloud']]));
    pref.hidden = settings.runtime === 'auto';
    p.append(
      row('Auto Best Runtime', 'MPC picks the fastest way to run each game on this device.', toggle(settings.runtime === 'auto', 'Auto Best Runtime', v => { setSetting('runtime', v ? 'auto' : 'local'); pref.hidden = v; if (!v) pref.querySelectorAll('.chip').forEach((c, i) => c.setAttribute('aria-pressed', String(i === 0))); })),
      pref,
      row('Auto Fullscreen', 'Games open fullscreen where the browser allows it.', flag('autoFullscreen', 'Auto Fullscreen')),
      row('Predictive Preload', 'Prepares the game you are looking at so it starts instantly. Skipped on Data Saver.', flag('prefetch', 'Predictive Preload')),
    );
  },
  performance(p) {
    p.append(
      row('Max FPS', 'Caps frame rate to save battery and heat.', pick('maxFps', [[30, '30'], [60, '60'], [120, '120'], [0, 'Unlimited']])),
      row('Low Memory Mode', 'Releases cached runtimes aggressively and prefers cloud for heavy titles.', flag('lowMemory', 'Low Memory Mode', () => { applyMemoryMode(); if (settings.lowMemory) reclaimAll(); })),
      row('Emulation profile', 'Mishrin Runtime Optimizer (~80% intensity). Auto picks Performance on capable plugged-in devices, Balanced otherwise.', pick('emuProfile', [['auto', 'Auto'], ['battery', 'Battery'], ['balanced', 'Balanced'], ['performance', 'Performance'], ['maximum', 'Maximum Mishrin']])),
      row('Reduce Effects', 'Turns off glass blur and glow for weaker GPUs.', flag('reduceEffects', 'Reduce Effects', () => document.documentElement.classList.toggle('lite', settings.reduceEffects))),
    );
  },
  cloud(p) {
    const f = h('div', 'actions'); f.style.flex = '1 1 320px';
    f.innerHTML = `<label class="field"><input type="url" placeholder="https://cloud.example.com" aria-label="Cloud endpoint" value="${esc(settings.cloudEndpoint)}"></label><button class="btn btn-sm">Test</button><span class="hint" role="status"></span>`;
    const input = f.querySelector('input')!, out = f.querySelector('span')!;
    input.onchange = () => {
      const v = input.value.trim();
      if (v && !/^https?:\/\//.test(v)) { out.textContent = 'Use an http(s) URL.'; return; }
      setSetting('cloudEndpoint', v.replace(/\/+$/, '')); out.textContent = v ? 'Saved.' : 'Cloud disabled.';
    };
    f.querySelector('button')!.onclick = async () => {
      input.onchange?.(new Event('change'));
      if (!settings.cloudEndpoint) { out.textContent = 'Enter an endpoint first.'; return; }
      out.textContent = 'Testing…';
      const t0 = performance.now();
      try {
        const r = await fetch(`${settings.cloudEndpoint}/v1/config`, { cache: 'no-store' });
        const j = r.ok ? await r.json() : null;
        out.textContent = r.ok ? `Connected · ${Math.round(performance.now() - t0)} ms · nodes: ${(j?.runtimes ?? []).join(', ') || 'none online'}` : `Error ${r.status}`;
      } catch { out.textContent = 'Unreachable.'; }
    };
    p.append(
      row('Cloud Endpoint', 'Your Mishrin cloud broker. Leave empty to play only on this device.', f),
      (() => {
        // Sign-in is only needed when the cloud runs with AUTH_REQUIRED (device tokens issued for an access key).
        const a = h('div', 'actions'); a.style.flex = '1 1 320px';
        a.innerHTML = `<label class="field"><input type="password" placeholder="Access key" aria-label="Cloud access key" autocomplete="off"></label><button class="btn btn-sm">Sign in</button><span class="hint" role="status"></span>`;
        const key = a.querySelector('input')!, st = a.querySelector('span')!;
        import('../cloud/identity').then(({ deviceToken }) => { st.textContent = deviceToken() ? 'Signed in on this device.' : 'Not signed in (only needed if your cloud requires it).'; });
        a.querySelector('button')!.onclick = async () => {
          const { signIn } = await import('../cloud/identity');
          if (!settings.cloudEndpoint) { st.textContent = 'Enter an endpoint first.'; return; }
          try { await signIn(key.value.trim()); key.value = ''; st.textContent = 'Signed in on this device.'; } catch (e) { st.textContent = (e as Error).message; }
        };
        return row('Cloud Sign-in', 'Your cloud may require an access key. Saves and uploads are then tied to this signed-in device.', a);
      })(),
      row('Cloud Quality', 'Auto adapts resolution and bitrate to your network in real time.', pick('cloudQuality', [['auto', 'Auto'], ['performance', 'Performance'], ['balanced', 'Balanced'], ['quality', 'Quality']])),
      row('Idle Shutdown', 'Ends cloud sessions after inactivity to free resources.', pick('idleShutdownMin', [[5, '5 min'], [10, '10 min'], [20, '20 min'], [30, '30 min']])),
    );
  },
  controls(p) {
    p.append(
      row('Controller Support', padConnected() ? 'Controller connected.' : 'Connect any standard gamepad; it works immediately.', flag('controller', 'Controller Support')),
      row('Touch Controls', 'On-screen D-pad and buttons for touch screens.', pick('touchControls', [['auto', 'Auto'], ['on', 'On'], ['off', 'Off']])),
      row('Mouse', 'Web, WASM and Windows games that use a mouse get it automatically: click inside the picture (black bars are ignored). Mouse-driven emulator games capture the cursor on first click; press Esc to release it.', '<span class="lbl">Always on</span>'),
      row('P1 mouse', 'Plug a virtual console mouse into a controller port for P1 games that support one. Off keeps both ports as gamepads.', pick('emuMouse', [['off', 'Off'], ['port1', 'Port 1'], ['port2', 'Port 2']])),
      row('Button map', '', `<div class="kv"><span>Move</span><b>D-pad · Stick · Arrows · WASD</b><span>Select / A</span><b>A · Enter · Space · Z</b><span>Back / B</span><b>B · Esc · X</b><span>Sections</span><b>LB / RB · Q / E</b><span>In-game menu</span><b>Home · Start+Select · Esc</b></div>`),
    );
  },
  display(p) {
    p.append(
      row('Resolution', 'Stream resolution for cloud play. Local games render at native size and scale on the GPU.', pick('resolution', [['auto', 'Auto'], ['720', '720p'], ['1080', '1080p'], ['1440', '1440p'], ['native', 'Native']])),
      row('Emulator scaling', 'Pixel: nearest-neighbour (default). Smooth: bilinear. Sharp: WebGPU sharp-bilinear — crisp at any size, where WebGPU is available.', pick('emuScaling', [['pixel', 'Pixel'], ['smooth', 'Smooth'], ['sharp', 'Sharp (WebGPU)']])),
      row('Performance Stats', 'Small FPS / frame-time readout during play.', flag('showStats', 'Performance Stats')),
    );
  },
  async storage(p) {
    const [est, st, saves] = await Promise.all([navigator.storage?.estimate?.().catch(() => null) ?? null, storeStats(), allSaves().catch(() => [])]);
    const persisted = await navigator.storage?.persisted?.().catch(() => false);
    const usage = row('Storage used', est ? `${fmtBytes(est.usage ?? 0)} of ${fmtBytes(est.quota ?? 0)} available to the console` : 'Unavailable in this browser.', '');
    const cache = row('Game cache', `${st.packages} package(s), ${fmtBytes(st.bytes)} — identical files are stored once.`, '');
    const cb = h('button', 'btn btn-sm', 'Clear cache'); cb.onclick = async () => { await clearStore(); toast('Game cache cleared'); render('storage'); };
    cache.append(cb);
    const sv = row('Save states', `${saves.length} save(s), ${fmtBytes(saves.reduce((a, s) => a + s.data.size, 0))} compressed (${fmtBytes(saves.reduce((a, s) => a + s.raw, 0))} raw)`, '');
    const sb = h('button', 'btn btn-sm', 'Delete saves'); sb.disabled = !saves.length;
    sb.onclick = async () => { await clearSaves(); toast('Save states deleted'); render('storage'); };
    sv.append(sb);
    const ps = row('Keep data', persisted ? 'Storage is persistent: the browser will not evict your games.' : 'Ask the browser not to evict your games and saves.', '');
    if (!persisted && navigator.storage?.persist) { const b = h('button', 'btn btn-sm', 'Keep'); b.onclick = async () => { toast((await navigator.storage.persist()) ? 'Storage is now persistent' : 'The browser declined'); render('storage'); }; ps.append(b); }
    p.append(usage, cache, sv, ps);
    for (const g of games.filter(g => g.user || g.url.startsWith('idb:'))) {
      const b = h('button', 'btn btn-sm', g.user ? 'Remove' : 'Remove file');
      b.onclick = async () => { await removeUserData(g); toast(`${g.title} removed`); render('storage'); };
      p.append(row(esc(g.title), g.user ? 'Added by you' : 'Your attached file', b));
    }
  },
  async saves(p) {
    const { listSaves, exportSave, importSave, deleteSave, PROVIDER_LABEL } = await import('../saves/manager');
    const imp = h('input'); imp.type = 'file'; imp.accept = '.msave'; imp.hidden = true;
    const ib = h('button', 'btn btn-sm', `${ic.upload}Import save`); ib.onclick = () => imp.click();
    imp.onchange = async () => {
      const f = imp.files?.[0]; if (!f) return;
      try { const e = await importSave(f); toast(`Imported ${PROVIDER_LABEL[e.provider]} save for ${e.title}`); render('saves'); } catch (e) { toast((e as Error).message, 5000); }
    };
    p.append(row('Saves', 'Save states, memory cards, game data and cloud saves in one place. Export makes a portable .msave file.', ib), imp);
    const list = await listSaves();
    if (!list.length) p.append(row('No saves yet', 'Use Save State in the in-game menu, or save inside a game.', ''));
    for (const e of list) {
      const acts = h('div', 'actions');
      const ex = h('button', 'btn btn-sm', 'Export'); ex.dataset.act = 'export';
      ex.onclick = async () => {
        try {
          const blob = await exportSave(e);
          const a = h('a'); a.href = URL.createObjectURL(blob); a.download = `${e.gameId}-${e.provider}.msave`; a.click();
          setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
        } catch (err) { toast((err as Error).message, 5000); }
      };
      const del = h('button', 'btn btn-sm', 'Delete'); del.dataset.act = 'delete';
      del.onclick = async () => { await deleteSave(e).catch(err => toast((err as Error).message)); toast('Save deleted'); render('saves'); };
      acts.append(ex, del);
      const r = row(`${esc(e.title)} <small class="badge">${PROVIDER_LABEL[e.provider]}</small>`, `${esc(e.kind)} · ${fmtBytes(e.size)}${e.ts ? ` · ${new Date(e.ts).toLocaleString()}` : ''}`, acts);
      r.dataset.save = `${e.provider}:${e.gameId}`;
      p.append(r);
    }
  },
  async about(p) {
    const c = await caps();
    p.append(
      row('MISHRIN CONSOLE', 'Games Beyond Limits · Powered by Mishrin Paradoxical Computer', `<span class="hint">v${__APP_VERSION__}</span>`),
      row('This device', '', `<div class="kv"><span>System</span><b>${esc(c.os)}${c.mobile ? ' · mobile' : ''}</b><span>CPU threads</span><b>${c.cores}</b><span>Memory</span><b>~${c.memGB} GB · local budget ${localBudgetMB(c, settings)} MB</b><span>Graphics</span><b>${c.webgpu ? `WebGPU (${c.gpuTier})` : 'Canvas'}</b><span>WebAssembly</span><b>${c.wasm ? ['yes', c.simd && 'SIMD', c.threads && 'threads'].filter(Boolean).join(' · ') : 'no'}</b><span>Network</span><b>${c.net.online ? esc(c.net.type) : 'offline'}${c.net.rttMs ? ` · ${c.net.rttMs} ms` : ''}${c.net.saveData ? ' · data saver' : ''}</b></div>`),
    );
    const rb = h('button', 'btn btn-sm', 'Reset settings'); rb.onclick = () => { resetSettings(); applyMemoryMode(); document.documentElement.classList.remove('lite'); toast('Settings reset'); render('about'); };
    p.append(row('Reset', 'Restore all settings to defaults.', rb));
  },
};

let root: HTMLElement | null = null;
async function render(tab: Tab, focusPanel = false) {
  if (!root) return;
  root.querySelectorAll<HTMLElement>('.tabs [data-tab]').forEach(b => b.dataset.tab === tab ? b.setAttribute('aria-current', 'page') : b.removeAttribute('aria-current'));
  const p = root.querySelector<HTMLElement>('.panel')!;
  const fresh = h('div', 'panel'); fresh.setAttribute('role', 'tabpanel');
  await panels[tab](fresh);
  p.replaceWith(fresh);
  if (focusPanel) { const f = fresh.querySelector<HTMLElement>('button,input'); if (f) focusEl(f); }
}

export function settingsView(el: HTMLElement, arg: string) {
  const tab = (TABS.some(t => t[0] === arg) ? arg : 'general') as Tab;
  root = h('div', 'settings');
  root.innerHTML = `<h1>Settings</h1><nav class="tabs" role="tablist">${TABS.map(([k, l]) => `<button class="navbtn" data-tab="${k}" role="tab"${k === tab ? ' data-autofocus' : ''}>${l}</button>`).join('')}</nav><div class="panel"></div>`;
  root.querySelectorAll<HTMLButtonElement>('[data-tab]').forEach(b => {
    b.onclick = () => { history.replaceState(null, '', `#/settings/${b.dataset.tab}`); render(b.dataset.tab as Tab); };
  });
  el.append(root);
  render(tab);
  return () => { root = null; };
}
