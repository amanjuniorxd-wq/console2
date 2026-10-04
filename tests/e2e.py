"""
Mishrin Console end-to-end verification (Playwright + Chromium).
Prereqs:  npm run build && npx vite preview --port 4173   and   node server/broker.mjs   (port 8787)
Run:      python3 tests/e2e.py            Screenshots → tests/shots/
"""
import asyncio, json, os, re, sys, time
from playwright.async_api import async_playwright

BASE = os.environ.get('BASE', 'http://localhost:4173')
BROKER = os.environ.get('BROKER', 'http://localhost:8787')
EXE = os.environ.get('CHROMIUM', '/opt/pw-browsers/chromium')
SHOTS = os.path.join(os.path.dirname(__file__), 'shots')
os.makedirs(SHOTS, exist_ok=True)
results = []

def check(name, ok, detail=''):
    results.append((name, bool(ok), detail))
    print(('PASS ' if ok else 'FAIL ') + name + (f' — {detail}' if detail else ''), flush=True)

GAMEPAD_SHIM = """
(() => {
  const pad = { id: 'Test Pad', index: 0, connected: true, mapping: 'standard', axes: [0,0,0,0],
    buttons: Array.from({length: 17}, () => ({ pressed: false, value: 0 })) };
  window.__pad = pad;
  navigator.getGamepads = () => [window.__padOn ? pad : null];
  window.__press = (i, on) => { pad.buttons[i] = { pressed: on, value: on ? 1 : 0 }; };
  // Spy on what the console sends to game workers (real messages; nothing is stubbed).
  window.__toWorker = [];
  const pm = Worker.prototype.postMessage;
  Worker.prototype.postMessage = function (m, ...r) { if (m && (m.t === 'pointer' || m.t === 'input')) window.__toWorker.push(m); return pm.call(this, m, ...r); };
})();
"""

async def tap_pad(page, i, hold=90):
    await page.evaluate(f'window.__press({i}, true)'); await page.wait_for_timeout(hold)
    await page.evaluate(f'window.__press({i}, false)'); await page.wait_for_timeout(hold)

async def boot(page, hash_=''):
    await page.goto(BASE + '/' + hash_)
    await page.wait_for_selector('#boot', state='detached', timeout=10000)

async def main():
    async with async_playwright() as p:
        browser = await p.chromium.launch(executable_path=EXE, args=['--disable-features=WebRtcHideLocalIpsWithMdns', '--autoplay-policy=no-user-gesture-required', '--enable-unsafe-webgpu'])
        ctx = await browser.new_context(viewport={'width': 1440, 'height': 900})
        await ctx.add_init_script(GAMEPAD_SHIM)
        page = await ctx.new_page()
        errors = []
        page.on('pageerror', lambda e: errors.append(str(e)))
        page.on('console', lambda m: errors.append(m.text) if m.type == 'error' else None)

        # ---------- 1. startup sequence + timing ----------
        await page.goto(BASE + '/')
        boot_txt = await page.text_content('#boot')
        check('startup: Om mark, title, loader, MPC credit', 'MISHRIN CONSOLE' in boot_txt and 'POWERED BY MISHRIN PARADOXICAL COMPUTER' in boot_txt and await page.locator('#boot svg').count() == 1)
        await page.wait_for_selector('#boot', state='detached', timeout=10000)
        nav = await page.evaluate("JSON.stringify({fcp: performance.getEntriesByName('first-contentful-paint')[0]?.startTime, dcl: performance.getEntriesByType('navigation')[0].domContentLoadedEventEnd, ready: window.__mishrin.readyMs, reqs: performance.getEntriesByType('resource').length, bytes: performance.getEntriesByType('resource').reduce((a,r)=>a+r.transferSize,0)})")
        m = json.loads(nav)
        check('startup metrics recorded', m['fcp'] is not None, f"FCP {m['fcp']:.0f} ms · DCL {m['dcl']:.0f} ms · app ready {m['ready']} ms (incl. 1.1 s brand splash) · {m['reqs']} requests")
        # warm reload (no splash) is the real startup cost
        await page.reload(); await page.wait_for_selector('#boot', state='detached', timeout=10000)
        warm = await page.evaluate('window.__mishrin.readyMs')
        check('warm start < 300 ms to interactive', warm < 300, f'{warm} ms')
        cdp = await ctx.new_cdp_session(page)
        await cdp.send('Performance.enable')
        mets = {x['name']: x['value'] for x in (await cdp.send('Performance.getMetrics'))['metrics']}
        check('memory: JS heap at idle < 8 MB', mets['JSHeapUsedSize'] < 8e6, f"{mets['JSHeapUsedSize']/1e6:.2f} MB used · {int(mets['Nodes'])} DOM nodes")
        await page.screenshot(path=f'{SHOTS}/desktop-home.png')

        # ---------- 2. keyboard navigation ----------
        f0 = await page.evaluate('document.activeElement.textContent.trim()')
        await page.keyboard.press('ArrowDown'); await page.keyboard.press('ArrowRight')
        f1 = await page.evaluate('document.activeElement.dataset.id || document.activeElement.textContent.trim()')
        check('keyboard: autofocus Play, arrows move focus', 'Play' in f0 and f1 != f0, f'{f0!r} → {f1!r}')
        await page.keyboard.press('Enter'); await page.wait_for_timeout(300)
        check('keyboard: Enter opens game detail', '#/game/' in page.url, page.url)
        await page.keyboard.press('Escape'); await page.wait_for_timeout(300)
        check('keyboard: Esc goes back', '#/game/' not in page.url, page.url)

        # ---------- 3. controller navigation ----------
        await boot(page, '#/library')
        await page.evaluate("window.__padOn = true; dispatchEvent(new Event('gamepadconnected'))")
        await page.wait_for_timeout(100)
        a = await page.evaluate('document.activeElement.dataset.id')
        await tap_pad(page, 15)   # D-pad right
        b = await page.evaluate('document.activeElement.dataset.id')
        await tap_pad(page, 0)    # A
        await page.wait_for_timeout(300)
        url_after_a = page.url
        await tap_pad(page, 1)    # B
        await page.wait_for_timeout(300)
        check('controller: D-pad moves, A selects, B backs', a and b and a != b and '#/game/' in url_after_a and '#/library' in page.url, f'{a} → {b}; A→{url_after_a.split("#")[1]}; B→{page.url.split("#")[1]}')
        await tap_pad(page, 5); await page.wait_for_timeout(250)
        check('controller: RB switches section', '#/search' in page.url, page.url.split('#')[1])
        await page.evaluate("window.__padOn = false")

        # ---------- 4. local WASM play, fullscreen, input, save state, runtime reuse ----------
        await boot(page, '#/game/ember-drift')
        wasm_reqs = []
        page.on('request', lambda r: wasm_reqs.append(r.url) if r.url.endswith('.wasm') else None)
        await page.click('button.btn-play')
        await page.wait_for_selector('#player .ovl-btn', state='visible', timeout=10000)
        await page.wait_for_timeout(1300)
        fs = await page.evaluate('!!document.fullscreenElement')
        check('fullscreen on Play', fs)
        await page.keyboard.down('ArrowRight'); await page.wait_for_timeout(400); await page.keyboard.up('ArrowRight')
        await page.screenshot(path=f'{SHOTS}/ingame-wasm.png')
        kb = await page.evaluate("window.__toWorker.filter(m => m.t === 'input').map(m => m.b + ':' + m.down)")
        check('in-game keyboard → game (ArrowRight press/release)', '3:true' in kb and '3:false' in kb, ','.join(kb[-4:]))
        # controller in game: D-pad right (button 15) via the real Gamepad polling path
        await page.evaluate("window.__toWorker.length = 0; window.__padOn = true; dispatchEvent(new Event('gamepadconnected'))")
        await page.evaluate('__press(15, true)'); await page.wait_for_timeout(250); await page.evaluate('__press(15, false)'); await page.wait_for_timeout(250)
        pad_in = await page.evaluate("window.__toWorker.filter(m => m.t === 'input').map(m => m.b + ':' + m.down)")
        check('in-game controller → game (D-pad right press/release)', '3:true' in pad_in and '3:false' in pad_in, ','.join(pad_in[-4:]))
        await page.evaluate('window.__padOn = false')
        # mouse in game: picture rect (letterbox excluded) → framebuffer pixels
        geo = await page.evaluate('''(() => { const c = document.querySelector('#player canvas.game-surface'); const r = c.getBoundingClientRect();
          const w = c.width, h = c.height, k = Math.min(r.width / w, r.height / h);
          return { l: r.left + (r.width - w * k) / 2, t: r.top + (r.height - h * k) / 2, pw: w * k, ph: h * k, w, h, rw: r.width, rh: r.height, rl: r.left, rt: r.top }; })()''')
        await page.evaluate('window.__toWorker.length = 0')
        cx, cy = geo['l'] + geo['pw'] * 0.75, geo['t'] + geo['ph'] * 0.25
        await page.mouse.move(cx, cy); await page.mouse.down(); await page.wait_for_timeout(500); await page.mouse.up(); await page.wait_for_timeout(100)
        ptr = await page.evaluate("window.__toWorker.filter(m => m.t === 'pointer')")
        dn = [m for m in ptr if m['b'] & 1]
        exp_x, exp_y = 0.75 * (geo['w'] - 1), 0.25 * (geo['h'] - 1)
        check('in-game mouse → game (click maps to framebuffer pixels, letterbox-aware)', dn and abs(dn[0]['x'] - exp_x) < 2 and abs(dn[0]['y'] - exp_y) < 2 and ptr[-1]['b'] == 0,
              f"click → ({dn[0]['x']:.1f},{dn[0]['y']:.1f}) expected ({exp_x:.1f},{exp_y:.1f}) in {geo['w']}x{geo['h']} · {len(ptr)} pointer msgs" if dn else str(ptr[:3]))
        bar = None
        if geo['l'] - geo['rl'] > 4: bar = (geo['rl'] + 2, geo['rt'] + geo['rh'] / 2)
        elif geo['t'] - geo['rt'] > 4: bar = (geo['rl'] + geo['rw'] / 2, geo['rt'] + 2)
        if bar:
            await page.evaluate('window.__toWorker.length = 0')
            await page.mouse.click(*bar); await page.wait_for_timeout(100)
            n_bar = await page.evaluate("window.__toWorker.filter(m => m.t === 'pointer' && (m.b & 1)).length")
            check('mouse: clicks on the letterbox bars are ignored', n_bar == 0, f'{n_bar} presses forwarded')
        await page.keyboard.press('Escape'); await page.wait_for_timeout(200)
        ovl = await page.is_visible('#player .overlay')
        btns = await page.locator('#player .overlay .bar-top button').all_text_contents()
        check('in-game overlay: Performance / Resolution / Controls / Save State / Exit', ovl and [x.strip() for x in btns] == ['Performance', 'Resolution', 'Controls', 'Save State', 'Exit'], ', '.join(btns))
        await page.click('#player [data-p=perf]'); await page.wait_for_timeout(1200)
        perf = await page.text_content('#player .ovl-panel')
        check('performance panel shows live path/FPS', 'Local' in perf and 'FPS' in perf, perf.replace('\n', ' ')[:140])
        await page.screenshot(path=f'{SHOTS}/ingame-overlay.png')
        await page.click('#player [data-p=save]'); await page.wait_for_timeout(200)
        await page.click('#player .ovl-panel .btn-play'); await page.wait_for_timeout(400)
        toast = await page.text_content('.toast')
        check('save state written (gzip)', toast and 'Saved' in toast, toast)
        await page.click('#player .ovl-panel .btn:not(.btn-play)'); await page.wait_for_timeout(300)
        check('save state loads', 'loaded' in (await page.text_content('.toast') or ''), await page.text_content('.toast'))
        await page.click('#player .ovl-btn'); await page.click('#player [data-p=exit]'); await page.wait_for_timeout(300)
        check('exit returns to detail, leaves fullscreen', '#/game/ember-drift' in page.url and not await page.evaluate('!!document.fullscreenElement') and await page.is_hidden('#player'))
        n_before = len(wasm_reqs)
        t = time.time()
        await page.click('button.btn-play')
        await page.wait_for_selector('#player .ovl-btn', state='visible', timeout=10000)
        relaunch = (time.time() - t) * 1000
        await page.keyboard.press('Escape'); await page.click('#player [data-p=perf]'); await page.wait_for_timeout(1100)
        perf2 = await page.text_content('#player .ovl-panel')
        check('cached runtime reuse: zero package requests, compiled module reused', len(wasm_reqs) == n_before and 'reused' in perf2, f'relaunch {relaunch:.0f} ms, wasm requests on relaunch: {len(wasm_reqs) - n_before}')
        await page.click('#player [data-p=exit]'); await page.wait_for_timeout(200)

        # ---------- 5. HTML5 package in sandbox ----------
        await boot(page, '#/game/saffron-run')
        await page.click('button.btn-play')
        await page.wait_for_selector('#player .ovl-btn', state='visible', timeout=10000)
        await page.wait_for_timeout(800)
        sb = await page.get_attribute('#player iframe', 'sandbox')
        check('HTML5 game runs sandboxed (opaque origin)', sb and 'allow-same-origin' not in sb, sb)
        await page.screenshot(path=f'{SHOTS}/ingame-web.png')
        txt = await page.frames[-1].evaluate('document.title')
        check('bundled HTML5 game rendered via MPC runner', txt == 'Saffron Run', txt)
        # input into the sandboxed HTML5 game: record the game's own move() calls (the real handlers run unchanged)
        gf = page.frames[-1]
        await gf.evaluate("window.__moves = []; const m0 = move; move = d => (window.__moves.push(d), m0(d)); 0")
        await page.keyboard.press('ArrowRight'); await page.wait_for_timeout(150)
        box = await page.evaluate("(() => { const r = document.querySelector('#player iframe').getBoundingClientRect(); return [r.x, r.y, r.width, r.height]; })()")
        await page.mouse.click(box[0] + box[2] * 0.2, box[1] + box[3] * 0.5); await page.wait_for_timeout(150)
        await gf.evaluate("window.__padOn = true; __press(15, true)"); await page.wait_for_timeout(200)
        await gf.evaluate("__press(15, false); window.__padOn = false"); await page.wait_for_timeout(100)
        mv = await gf.evaluate('window.__moves')
        check('HTML5 game gets keyboard, mouse and controller (inside the sandbox)', mv[:1] == [1] and -1 in mv and mv.count(1) >= 2, f'moves {mv} (key →, click left half, D-pad →)')
        await page.click('#player .ovl-btn'); await page.click('#player [data-p=exit]'); await page.wait_for_timeout(200)
        # user-attached HTML file: stored locally, runs sandboxed with outbound network blocked
        tmp = os.path.join(SHOTS, '_attached.html')
        open(tmp, 'w').write('<!doctype html><html><head><title>t</title></head><body><h1 id=t>attached ok</h1><script>parent.postMessage({mpc:"ready",caps:[]},"*");fetch("https://example.com/").then(()=>document.title="NET-OK",()=>document.title="NET-BLOCKED")</script></body></html>')
        await boot(page, '#/library')
        await page.click('.card-add'); await page.set_input_files('[data-modal] input[type=file]', tmp)
        await page.wait_for_url('**/#/game/u-attached')
        await page.click('button.btn-play'); await page.wait_for_selector('#player .ovl-btn', state='visible', timeout=10000)
        await page.wait_for_timeout(800)
        fr = page.frames[-1]
        check('attached HTML runs locally with network blocked', (await fr.text_content('#t')) == 'attached ok' and (await fr.evaluate('document.title')) == 'NET-BLOCKED', await fr.evaluate('document.title'))
        os.remove(tmp)
        await page.click('#player .ovl-btn'); await page.click('#player [data-p=exit]'); await page.wait_for_timeout(200)

        # ---------- 6. error + retry states ----------
        await boot(page, '#/library')
        await page.click('.card-add'); await page.wait_for_selector('[data-modal]')
        await page.fill('[data-k=url]', BASE + '/games/missing.wasm'); await page.fill('[data-k=title]', 'Broken Test')
        await page.click('[data-k=rt] .chip:has-text("MPC WASM")'); await page.click('[data-k=addurl]')
        await page.wait_for_url('**/#/game/u-broken-test')
        await page.click('button.btn-play')
        await page.wait_for_selector('#player .loading.error', timeout=10000)
        msg = await page.text_content('#player .loading .msg')
        acts = await page.locator('#player [data-err] button').all_text_contents()
        check('error state with Retry/Back', 'Retry' in acts and 'Back' in acts, f'{msg} | {acts}')
        await page.click('#player [data-err] button:has-text("Retry")')
        await page.wait_for_selector('#player .loading.error', timeout=10000)
        check('retry re-runs launch', True)
        await page.screenshot(path=f'{SHOTS}/error-retry.png')
        await page.keyboard.press('Escape'); await page.wait_for_timeout(300)
        check('Esc on error screen exits player', await page.is_hidden('#player'))
        # cloud-only title without endpoint → clear guidance, no dead end
        await boot(page, '#/game/throne-of-embers')
        b = await page.locator('#view .btn-play').text_content()
        check('cloud-only slot without file prompts to add file', 'Add game file' in b, b)

        # ---------- 7. settings persistence ----------
        await boot(page, '#/settings/performance')
        await page.click('[aria-label="Low Memory Mode"]')
        await page.click('.chip:has-text("30")')
        await page.reload(); await page.wait_for_selector('#boot', state='detached')
        lm = await page.get_attribute('[aria-label="Low Memory Mode"]', 'aria-checked')
        fps = await page.get_attribute('.chip:has-text("30")', 'aria-pressed')
        check('settings persist across reload', lm == 'true' and fps == 'true')
        await page.click('[aria-label="Low Memory Mode"]'); await page.click('.chip:has-text("60")')

        # ---------- 8. local → cloud fallback (real WebRTC stream from reference node) ----------
        host = await ctx.new_page()
        await host.goto(f'{BROKER}/host.html?broker={BROKER}')
        await host.wait_for_function('window.__nodeReady === true', timeout=10000)
        await boot(page, '#/settings/cloud')
        await page.fill('input[aria-label="Cloud endpoint"]', BROKER); await page.press('input[aria-label="Cloud endpoint"]', 'Tab')
        await page.click('.setrow .btn-sm:has-text("Test")'); await page.wait_for_timeout(600)
        test_out = await page.text_content('.setrow .hint[role=status]')
        check('cloud endpoint test', 'Connected' in test_out, test_out)
        fb = await ctx.new_page()
        await fb.add_init_script("window.Worker = function(){ throw new Error('simulated local failure'); }; Object.defineProperty(window,'OffscreenCanvas',{value: undefined}); WebAssembly.instantiate = () => Promise.reject(new Error('simulated local failure'));")
        await fb.goto(BASE + '/#/game/ember-drift'); await fb.wait_for_selector('#boot', state='detached')
        await fb.click('button.btn-play')
        await fb.wait_for_selector('#player .ovl-btn', state='visible', timeout=25000)
        await fb.wait_for_timeout(2500)
        vid = await fb.evaluate("(() => { const v = document.querySelector('#player video'); return v ? {w: v.videoWidth, h: v.videoHeight, t: v.currentTime} : null })()")
        await fb.keyboard.down('ArrowLeft'); await fb.wait_for_timeout(300); await fb.keyboard.up('ArrowLeft')
        await fb.keyboard.press('Escape'); await fb.click('#player [data-p=perf]'); await fb.wait_for_timeout(2300)
        cperf = await fb.text_content('#player .ovl-panel')
        check('local failure falls back to cloud stream', vid and vid['w'] > 0 and 'Cloud' in cperf, f'video {vid} | {cperf[:120]}')
        mb = re.search(r'Bitrate([\d.]+) Mbps received', cperf or '')
        check('cloud stream stats: connection state, RTT, bitrate, packet loss, FPS', all(k in cperf for k in ('Connectionconnected', 'Latency (RTT)', 'Packet loss', 'FPS')) and mb and float(mb.group(1)) > 0,
              re.sub(r'\s+', ' ', cperf)[:220])
        await fb.screenshot(path=f'{SHOTS}/cloud-fallback.png')
        await fb.click('#player [data-p=save]'); await fb.wait_for_timeout(300)
        await fb.click('#player .ovl-panel .btn-play'); await fb.wait_for_timeout(800)
        check('cloud save state round-trip', 'Saved' in (await fb.text_content('.toast') or ''), await fb.text_content('.toast'))
        await fb.click('#player [data-p=exit]'); await fb.wait_for_timeout(500)
        cfg = json.loads(await page.evaluate(f"fetch('{BROKER}/v1/config').then(r=>r.text())"))
        check('cloud session released on exit (node freed)', cfg['sessions'] == 0, f"active sessions {cfg['sessions']}")
        await fb.close(); await host.close()
        await page.goto(BASE + '/#/settings/cloud'); await page.wait_for_selector('#boot', state='detached')
        await page.fill('input[aria-label="Cloud endpoint"]', ''); await page.press('input[aria-label="Cloud endpoint"]', 'Tab')

        # ---------- 8b. Saves (SaveManager): list · export · delete · import ----------
        await boot(page, '#/settings/saves')
        row = page.locator('[data-save="local:ember-drift"]')
        await row.wait_for(timeout=5000)
        async with page.expect_download() as dl:
            await row.locator('[data-act=export]').click()
        path = await (await dl.value).path()
        head = open(path, 'rb').read(7)
        await row.locator('[data-act=delete]').click(); await page.wait_for_timeout(500)
        gone = await page.locator('[data-save="local:ember-drift"]').count() == 0
        await page.set_input_files('.panel input[type=file][accept=".msave"]', path); await page.wait_for_timeout(800)
        back = await page.locator('[data-save="local:ember-drift"]').count() == 1
        check('Saves: export .msave → delete → import restores it', head == b'MSAVE1\n' and gone and back, f'header {head!r}, deleted {gone}, re-imported {back}')
        await boot(page, '#/game/ember-drift'); await page.click('button.btn-play')
        await page.wait_for_selector('#player .ovl-btn', state='visible', timeout=10000); await page.wait_for_timeout(500)
        await page.keyboard.press('Escape'); await page.click('#player [data-p=save]'); await page.wait_for_timeout(200)
        await page.click('#player .ovl-panel .btn:not(.btn-play)'); await page.wait_for_timeout(400)
        check('imported save loads in the game', 'loaded' in (await page.text_content('.toast') or ''), await page.text_content('.toast'))
        if not await page.is_visible('#player [data-p=exit]'): await page.click('#player .ovl-btn')
        await page.click('#player [data-p=exit]'); await page.wait_for_timeout(300)

        # ---------- 8c. deployment under a sub-path (/mishrin-console/, Gyanagi) ----------
        import http.server, threading, functools, tempfile
        sub = tempfile.mkdtemp(prefix='mishrin-sub-')
        os.symlink(os.path.abspath(os.path.join(os.path.dirname(__file__), '..', 'dist')), os.path.join(sub, 'mishrin-console'))
        class Quiet(http.server.SimpleHTTPRequestHandler):
            def log_message(self, *a): pass
        httpd = http.server.ThreadingHTTPServer(('127.0.0.1', 4180), functools.partial(Quiet, directory=sub))
        threading.Thread(target=httpd.serve_forever, daemon=True).start()
        sp = await ctx.new_page()
        sp_err = []
        sp.on('pageerror', lambda e: sp_err.append(str(e)))
        sp_404 = []
        sp.on('response', lambda r: sp_404.append(r.url) if r.status == 404 else None)
        await sp.goto('http://127.0.0.1:4180/mishrin-console/#/library'); await sp.wait_for_selector('#boot', state='detached', timeout=15000)
        await sp.wait_for_selector('.card[data-id="ember-drift"]', timeout=10000)
        await sp.goto('http://127.0.0.1:4180/mishrin-console/#/game/ember-drift'); await sp.click('button.btn-play')
        await sp.wait_for_selector('#player canvas.game-surface', timeout=10000); await sp.wait_for_timeout(800)
        sub_stats = await sp.evaluate("document.querySelector('#player').innerText")
        await sp.goto('http://127.0.0.1:4180/mishrin-console/#/emulators'); await sp.wait_for_selector('.rt-row[data-rt="mishrin-p1"]', timeout=10000)
        p1_state = await sp.get_attribute('.rt-row[data-rt="mishrin-p1"]', 'data-state')
        sw = await sp.evaluate("navigator.serviceWorker.getRegistration().then(r => r ? r.scope : null)")
        check('works under /mishrin-console/ (assets, catalog, game, P1 core, service-worker scope)', p1_state == 'available' and not sp_err and not [u for u in sp_404 if 'mishrin-console' in u] and (sw is None or sw.endswith('/mishrin-console/')),
              f'P1 {p1_state}, SW scope {sw}, 404s {sp_404[:3]}, errors {sp_err[:2]}')
        await sp.close(); httpd.shutdown()

        # ---------- 9. no dead buttons / links ----------
        dead = []
        for h in ['#/home', '#/library', '#/search', '#/settings/general', '#/settings/performance', '#/settings/cloud', '#/settings/controls', '#/settings/display', '#/settings/storage', '#/settings/saves', '#/settings/about', '#/emulators', '#/upload', '#/game/ember-drift', '#/game/valley-of-dawn']:
            await boot(page, h); await page.wait_for_timeout(250)
            n = await page.evaluate("document.querySelectorAll('#app button, #app a').length")
            for i in range(n):
                info = await page.evaluate(f"(() => {{ const e = document.querySelectorAll('#app button, #app a')[{i}]; const r = e.getBoundingClientRect(); return {{ vis: r.width > 0 && r.height > 0 && !e.closest('[hidden]') && !e.disabled, tag: e.tagName, href: e.getAttribute('href'), label: (e.textContent || e.getAttribute('aria-label') || '').trim().slice(0, 30) }} }})()")
                if not info['vis']: continue
                if info['tag'] == 'A':
                    if not info['href'] or info['href'] == '#': dead.append((h, info['label']))
                    continue
                ref = await cdp.send('Runtime.evaluate', {'expression': f"document.querySelectorAll('#app button, #app a')[{i}]"})
                lst = await cdp.send('DOMDebugger.getEventListeners', {'objectId': ref['result']['objectId']})
                if not any(l['type'] in ('click', 'pointerdown') for l in lst['listeners']):
                    dead.append((h, info['label']))
        check('no dead buttons or links', not dead, str(dead[:8]))

        # ---------- 10. mobile / touch layout ----------
        mctx = await browser.new_context(viewport={'width': 390, 'height': 844}, is_mobile=True, has_touch=True, device_scale_factor=2)
        mp = await mctx.new_page()
        await mp.goto(BASE + '/'); await mp.wait_for_selector('#boot', state='detached', timeout=10000)
        tab = await mp.is_visible('.tabbar'); rail = await mp.is_visible('.rail'); top = await mp.is_visible('.topbar')
        sizes = await mp.evaluate("[...document.querySelectorAll('.tabbar .navbtn')].map(e => Math.round(e.getBoundingClientRect().height))")
        hscroll = await mp.evaluate('document.documentElement.scrollWidth > innerWidth')
        check('mobile: top bar + bottom Home/Library/Search/Settings, no sidebar', tab and top and not rail and min(sizes) >= 48 and not hscroll, f'tab heights {sizes}')
        await mp.screenshot(path=f'{SHOTS}/mobile-home.png')
        await mp.tap('.tabbar [data-sec=library]'); await mp.wait_for_timeout(300)
        await mp.screenshot(path=f'{SHOTS}/mobile-library.png')
        await mp.goto(BASE + '/#/game/ember-drift'); await mp.wait_for_timeout(400)
        await mp.screenshot(path=f'{SHOTS}/mobile-detail.png')
        await mp.tap('button.btn-play')
        await mp.wait_for_selector('#player .ovl-btn', state='visible', timeout=10000)
        tp = await mp.is_visible('#player .touchpad')
        await mp.dispatch_event('#player .abtns [data-b="4"]', 'pointerdown', {'pointerId': 1, 'pointerType': 'touch', 'isPrimary': True})
        on = await mp.evaluate("document.querySelector('#player .abtns [data-b=\"4\"]').classList.contains('on')")
        await mp.dispatch_event('#player .abtns [data-b="4"]', 'pointerup', {'pointerId': 1, 'pointerType': 'touch'})
        check('touch controls shown and respond', tp and on)
        await mp.screenshot(path=f'{SHOTS}/mobile-ingame.png')
        tab_ctx = await browser.new_context(viewport={'width': 1024, 'height': 1366}, is_mobile=True, has_touch=True)
        tp2 = await tab_ctx.new_page(); await tp2.goto(BASE + '/'); await tp2.wait_for_selector('#boot', state='detached')
        await tp2.screenshot(path=f'{SHOTS}/tablet-home.png')
        check('tablet portrait uses touch layout', await tp2.is_visible('.tabbar'))
        await mctx.close(); await tab_ctx.close()

        check('no uncaught errors', not [e for e in errors if 'simulated' not in e and 'missing.wasm' not in e and '404' not in e and 'example.com' not in e], str(errors[:5]))
        await browser.close()

    failed = [r for r in results if not r[1]]
    print(f"\n{len(results) - len(failed)}/{len(results)} checks passed")
    sys.exit(1 if failed else 0)

asyncio.run(main())
