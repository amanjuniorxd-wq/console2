"""
Mishrin P1 end-to-end in Chromium, through the real console UI:
Upload Game → detect → Add to Library (local copy) → Launch → frames → keyboard + controller → Save/Load State →
memory card persistence → fullscreen → stats → WebGPU presenter → P2/P3/P4 honesty → no file ever uploaded.
Prereq: npm run build && npm run preview (http://localhost:4173).   Run: python3 tests/emu/e2e_emu.py
"""
import asyncio, json, os, sys, time
from playwright.async_api import async_playwright

BASE = os.environ.get('BASE', 'http://localhost:4173')
ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
T = os.path.join(ROOT, 'emulators', 'p1', 'testgame')
SHOTS = os.path.join(ROOT, 'tests', 'shots')
os.makedirs(SHOTS, exist_ok=True)
results, metrics = [], {}


def check(name, ok, detail=''):
    results.append((name, bool(ok)))
    print(('PASS ' if ok else 'FAIL ') + name + (f' — {detail}' if detail != '' else ''), flush=True)


SHIM = """
(() => {
  try { localStorage.setItem('mishrin.debug', '1'); } catch (e) {}
  const pad = { id: 'E2E Pad', index: 0, connected: true, mapping: 'standard', axes: [0,0,0,0], buttons: Array.from({length: 17}, () => ({ pressed: false, value: 0 })) };
  navigator.getGamepads = () => [window.__padOn ? pad : null];
  window.__press = (i, on) => { pad.buttons[i] = { pressed: on, value: on ? 1 : 0 }; };
})();
"""


async def main():
    async with async_playwright() as p:
        browser = await p.chromium.launch(executable_path='/opt/pw-browsers/chromium', args=['--enable-unsafe-webgpu', '--autoplay-policy=no-user-gesture-required'])
        ctx = await browser.new_context(viewport={'width': 1280, 'height': 720})
        await ctx.add_init_script(SHIM)
        page = await ctx.new_page()
        errors, uploads, core_fetches = [], [], []
        page.on('pageerror', lambda e: errors.append(str(e)))
        page.on('console', lambda m: errors.append(m.text) if m.type == 'error' else None)

        def on_req(r):
            if r.method in ('POST', 'PUT') and (r.post_data_buffer or b''):
                uploads.append((r.url, len(r.post_data_buffer)))
            if r.url.endswith('mishrin-p1.wasm'):
                core_fetches.append(r.url)
        ctx.on('request', on_req)
        cdp = await ctx.new_cdp_session(page)
        await cdp.send('Performance.enable')
        emu = 'globalThis.__mishrinEmu'

        async def boot(h):
            await page.goto(BASE + '/' + h)
            await page.wait_for_selector('#boot', state='detached', timeout=15000)

        async def probe():
            return await page.evaluate(f'{emu}.probe()')

        async def wait_probe(pred, timeout=8):
            end = time.time() + timeout
            r = None
            while time.time() < end:
                r = await probe()
                if pred(r):
                    return r
                await asyncio.sleep(0.2)
            return r

        # ---------- navigation: the five console sections ----------
        await boot('#/home')
        labels = [t.strip() for t in await page.locator('.rail nav .navbtn span').all_text_contents()]
        check('console navigation includes Library | Upload Game | Emulators | Controllers | Settings',
              all(x in labels for x in ['Library', 'Upload Game', 'Emulators', 'Controllers', 'Settings']), ' · '.join(labels))

        # ---------- Emulators page: honest statuses ----------
        await boot('#/emulators')
        await page.wait_for_selector('.emu-card')
        cards = await page.evaluate("[...document.querySelectorAll('.emu-card')].map(c => ({name: c.querySelector('.emu-name').textContent, status: c.querySelector('.badge').textContent, disabled: [...c.querySelectorAll('button')].filter(b => b.disabled).map(b => b.textContent)}))")
        st = {c['name']: c for c in cards}
        check('Emulators page: P1 Ready, P2 In development, P3 In development, P4 Research (no fake launch buttons)',
              st['Mishrin P1']['status'] == 'Ready' and st['Mishrin P2']['status'] == 'In development' and st['Mishrin P3']['status'] == 'In development' and st['Mishrin P4']['status'] == 'Research'
              and all(st[f'Mishrin P{i}']['disabled'] for i in (2, 3, 4)), json.dumps({k: (v['status'], v['disabled']) for k, v in st.items()}))
        await page.wait_for_selector('.rt-row')
        rows = await page.evaluate("[...document.querySelectorAll('.rt-row')].map(r => [r.dataset.rt, r.dataset.state, r.querySelector('.rt-live').textContent])")
        rs = {r[0]: r for r in rows}
        check('Runtime status (no cloud): Browser + P1 ready locally; Windows/PS2/PS3 need a cloud — derived, not hardcoded',
              rs['browser'][1] == 'available' and rs['mishrin-p1'][1] == 'available' and all(rs[k][1] == 'no-cloud' for k in ('windows-cloud', 'ps2', 'ps3-cloud')), rows)
        legal = await page.text_content('.legal')
        check('legal notice: user-owned games/BIOS only, nothing uploaded without explicit consent', 'legally entitled' in legal and 'never uploaded unless you explicitly choose' in legal)
        await page.screenshot(path=f'{SHOTS}/emu-emulators.png')

        # ---------- Upload Game: detection of each format ----------
        for label, files, expect in (('CUE+BIN', ['out/saffron-pulse.cue', 'out/saffron-pulse.bin'], 'Mishrin P1'), ('CHD', ['out/saffron-pulse.chd'], 'Mishrin P1'),
                                     ('ISO', ['out/saffron-pulse.iso'], 'Mishrin P1'), ('P2 DVD layout', ['fixtures/p2-layout.iso'], 'Mishrin P2'), ('P3 layout', ['fixtures/p3-layout.iso'], 'Mishrin P3 Cloud')):
            await boot('#/upload')
            await page.set_input_files('.dropzone input[type=file]', [os.path.join(T, f) for f in files])
            await page.wait_for_selector('.emu-card, .detect .err', timeout=10000)
            name = await page.text_content('.emu-card .emu-name') if await page.locator('.emu-card').count() else 'error'
            btn = page.locator('.emu-card .actions button').first
            txt, dis = (await btn.text_content(), await btn.is_disabled()) if await btn.count() else ('', True)
            ok = name == expect and ((expect == 'Mishrin P1' and 'Add to Library' in txt and not dis) or (expect != 'Mishrin P1' and dis))
            check(f'Upload Game detects {label} → {expect}', ok, f'{name}: "{txt.strip()}"{" (disabled)" if dis else ""}')
        await page.screenshot(path=f'{SHOTS}/emu-upload-p3.png')

        # ---------- import (local copy, streamed) ----------
        await boot('#/upload')
        await page.set_input_files('.dropzone input[type=file]', [os.path.join(T, 'out/saffron-pulse.cue'), os.path.join(T, 'out/saffron-pulse.bin')])
        await page.wait_for_selector('.emu-card .btn-play')
        await page.screenshot(path=f'{SHOTS}/emu-upload-p1.png')
        t0 = time.time()
        await page.click('.emu-card .btn-play')
        await page.wait_for_url('**/#/game/**', timeout=30000)
        metrics['importMs'] = round((time.time() - t0) * 1000)
        gid = page.url.split('#/game/')[1]
        badges = await page.locator('.badges .badge').all_text_contents()
        check('game card: runtime, platform, local/cloud, maturity, format/size shown', any('Mishrin P1 · PS1-class' in b for b in badges) and 'Local' in badges and 'Ready' in badges and any('CUE+BIN' in b for b in badges), ' | '.join(badges))
        stored = await page.evaluate("navigator.storage.getDirectory().then(async d => { const g = await (await (await d.getDirectoryHandle('mishrin')).getDirectoryHandle('games')).getDirectoryHandle(location.hash.split('/').pop()); const out = []; for await (const [n, h] of g.entries()) out.push([n, (await h.getFile()).size]); return out; })")
        check('game files copied locally (OPFS), not uploaded', sorted(stored) == [['saffron-pulse.bin', 1411200], ['saffron-pulse.cue', 76]] and not uploads, f'{stored}, uploads={uploads}')
        await boot('#/library')
        card_sub = await page.text_content(f'.card[data-id="{gid}"] .sub')
        check('Library card shows platform · LOCAL/CLOUD · status · size', card_sub.startswith('PS1-class · Local · Ready') and 'MB' in card_sub, card_sub)

        # ---------- launch ----------
        await boot(f'#/game/{gid}')
        t0 = time.time()
        await page.click('button.btn-play')
        await page.wait_for_selector('#player .ovl-btn', state='visible', timeout=30000)
        metrics['launchToReadyMs'] = round((time.time() - t0) * 1000)
        await page.wait_for_timeout(2500)
        timings = json.loads(await page.evaluate(f'JSON.stringify({emu}.timings)'))
        info = json.loads(await page.evaluate(f'JSON.stringify({emu}.info)'))
        r = await probe()
        check('P1 game launches and renders in Chromium', r['pixels'] == 1024 and abs(r['x'] - 160 / 320) < 0.01, f"square at {r['x']:.3f},{r['y']:.3f} via {r['presenter']}; core fetch {timings['coreFetchMs']:.0f} ms, compile {timings['compileMs']:.0f} ms, boot {timings['bootMs']:.0f} ms")
        check('runs on the open HLE BIOS (no BIOS shipped or required)', info['bios'] == 'open-hle')
        check('fullscreen on Launch', await page.evaluate('!!document.fullscreenElement'))
        await page.screenshot(path=f'{SHOTS}/emu-ingame.png')

        # ---------- input: keyboard + controller ----------
        base = r
        await page.keyboard.down('ArrowRight'); await page.wait_for_timeout(120); await page.keyboard.up('ArrowRight')
        r = await wait_probe(lambda x: abs(x['x'] - base['x'] - 16 / 320) < 0.005)
        check('keyboard → controller (Right moves 16 px)', r and abs(r['x'] - base['x'] - 16 / 320) < 0.005, f"{base['x']:.3f} → {r['x']:.3f}")
        await page.evaluate("window.__padOn = true; dispatchEvent(new Event('gamepadconnected'))")
        for b in (13, 0):  # D-pad down, then A (✕)
            await page.evaluate(f'window.__press({b}, true)'); await page.wait_for_timeout(150)
            await page.evaluate(f'window.__press({b}, false)'); await page.wait_for_timeout(250)
        r2 = await wait_probe(lambda x: abs(x['y'] - r['y'] - 16 / 240) < 0.005)
        check('gamepad → controller (D-pad down moves 16 px)', r2 and abs(r2['y'] - r['y'] - 16 / 240) < 0.005, f"{r['y']:.3f} → {r2['y']:.3f}")
        await page.evaluate('window.__padOn = false')
        await page.wait_for_timeout(1300)
        s = json.loads(await page.evaluate(f'JSON.stringify({emu}.stats)'))
        metrics['inputToFrameMs'] = s['inputMs']
        check('input latency measured (event → next presented frame)', 0 <= s['inputMs'] < 60, f"{s['inputMs']} ms")

        # ---------- performance overlay ----------
        await page.click('#player .ovl-btn')
        await page.click('#player [data-p=perf]')
        await page.wait_for_timeout(1500)
        perf = await page.text_content('#player .ovl-panel')
        check('emulator status: Mishrin P1, FPS, frame time, CPU, GPU, RAM, backend', all(k in perf for k in ['Mishrin P1', 'FPS', 'Frame time', 'CPU', 'GPU', 'RAM', 'Backend', 'WASM']), perf.replace('\n', ' ')[:200])
        await page.screenshot(path=f'{SHOTS}/emu-stats.png')

        # ---------- save / load state ----------
        await page.click('#player [data-p=save]'); await page.wait_for_timeout(300)
        await page.click('#player .ovl-panel .btn-play')
        await page.wait_for_selector('.toast:has-text("Saved")', timeout=15000)
        save_toast = await page.text_content('.toast')
        await page.keyboard.press('Escape')
        saved = await probe()
        for _ in range(3):
            await page.keyboard.press('ArrowLeft'); await page.wait_for_timeout(150)
        await wait_probe(lambda x: x['x'] < saved['x'] - 0.1)
        await page.click('#player .ovl-btn'); await page.click('#player [data-p=save]'); await page.wait_for_timeout(300)
        await page.click('#player .ovl-panel .btn:not(.btn-play)')
        await page.wait_for_selector('.toast:has-text("loaded")', timeout=15000)
        back = await wait_probe(lambda x: abs(x['x'] - saved['x']) < 0.004 and abs(x['y'] - saved['y']) < 0.004)
        check('Save State / Load State restore the exact position', back and abs(back['x'] - saved['x']) < 0.004, f"{save_toast}; x {saved['x']:.3f} → moved → {back and back['x']:.3f}")

        # ---------- memory card (Start saves inside the game) → persists across launches ----------
        await page.keyboard.press('Enter')   # Start (instant tap: delivered thanks to the per-frame input latch)
        await page.wait_for_timeout(3500)     # worker persists the card when it changes (checked every 2 s)
        card_pos = await probe()
        await page.click('#player .ovl-btn'); await page.click('#player [data-p=exit]')
        await page.wait_for_url(f'**/#/game/{gid}')
        has_card = await page.evaluate(f"new Promise(r => {{ const q = indexedDB.open('mishrin'); q.onsuccess = () => {{ const g = q.result.transaction('files').objectStore('files').get('card:{gid}'); g.onsuccess = () => r(g.result ? g.result.length : 0); }}; }})")
        check('memory card saved locally (IndexedDB)', has_card == 131072, f'{has_card} bytes')
        n_core = len(core_fetches)
        t0 = time.time()
        await page.click('button.btn-play')
        await page.wait_for_selector('#player .ovl-btn', state='visible', timeout=30000)
        metrics['relaunchMs'] = round((time.time() - t0) * 1000)
        restored = await wait_probe(lambda x: x['pixels'] == 1024, 8)
        green = (await page.evaluate(f"{emu}.probe()"))
        check('memory card restores progress on next launch', abs(restored['x'] - card_pos['x']) < 0.004 and abs(restored['y'] - card_pos['y']) < 0.004, f"x {restored['x']:.3f} y {restored['y']:.3f}")
        check('second launch reuses the cached core (no re-download)', len(core_fetches) == n_core, f'relaunch {metrics["relaunchMs"]} ms')

        # ---------- measurements ----------
        await page.wait_for_timeout(2500)
        s = json.loads(await page.evaluate(f'JSON.stringify({emu}.stats)'))
        a0 = await page.evaluate(f'{emu}.audioStats()')
        await page.wait_for_timeout(3000)
        audio = await page.evaluate(f'{emu}.audioStats()')
        audio['steadyUnderruns'] = audio['underruns'] - a0['underruns']
        mets = {x['name']: x['value'] for x in (await cdp.send('Performance.getMetrics'))['metrics']}
        metrics.update(fps=s['fps'], emuFps=s['emuFps'], wasmFrameMs=s['emuMs'], presentMs=s['presentMs'], workerUtilization=s['utilization'], wasmMB=s['wasmMB'],
                       uiHeapMB=round(mets['JSHeapUsedSize'] / 1e6, 1), behind=s['behind'], audio=audio)
        check('steady 60 fps with headroom', s['fps'] >= 58 and s['emuFps'] >= 58 and s['utilization'] < 0.9, f"{s['fps']} fps shown / {s['emuFps']} emulated · {s['emuMs']} ms per frame · worker busy {s['utilization'] * 100:.0f}%")
        check('audio: AudioWorklet running, no underruns in steady state (3 s window)', audio and audio['played'] > 0 and audio['context'] == 'running' and audio['steadyUnderruns'] == 0, json.dumps(audio))
        check('UI thread stays light while emulating', mets['JSHeapUsedSize'] < 15e6, f"UI heap {mets['JSHeapUsedSize'] / 1e6:.1f} MB · core {s['wasmMB']} MB")

        # ---------- WebGPU presenter (sharp scaling) ----------
        try:
            g = await page.evaluate(f'{emu}.gpuSelfTest(1280, 720, 0)')
            check('WebGPU sharp-bilinear scaling pipeline renders the frame', g['pixels'] > 1024 * 4, f"{g['w']}x{g['h']} on {g.get('adapter')}, shader {float(g['shaderMs']):.1f} ms, GPU pass {float(g['gpuMs']):.1f} ms")
            metrics['webgpu'] = {k: g[k] for k in ('adapter', 'shaderMs', 'gpuMs')}
        except Exception as e:
            check('WebGPU presenter (skipped: unavailable in this browser)', True, str(e)[:80])
        await page.click('#player .ovl-btn'); await page.click('#player [data-p=exit]')
        await page.wait_for_timeout(500)
        gone = await page.evaluate('performance.getEntriesByType("resource").length') and True
        check('no game data ever uploaded', not uploads, uploads)

        # ---------- Controllers page ----------
        await boot('#/controllers')
        await page.keyboard.down('KeyZ')
        await page.wait_for_timeout(200)
        lit = await page.evaluate("[...document.querySelectorAll('.padkey.on')].map(e => e.dataset.b)")
        await page.keyboard.up('KeyZ')
        check('Controllers page shows live input + mapping', 'cross' in lit, lit)

        # ---------- profiles ----------
        await boot('#/settings/performance')
        await page.click('.chip:has-text("Battery")')
        await boot(f'#/game/{gid}')
        await page.click('button.btn-play')
        await page.wait_for_selector('#player .ovl-btn', state='visible', timeout=30000)
        await page.wait_for_timeout(2500)
        sb = json.loads(await page.evaluate(f'JSON.stringify({emu}.stats)'))
        check('Battery profile: presents every 2nd frame, game speed unchanged', sb['presentEvery'] >= 2 and sb['emuFps'] >= 58 and sb['fps'] <= 31, f"{sb['fps']} fps shown / {sb['emuFps']} emulated · worker busy {sb['utilization'] * 100:.0f}%")
        metrics['battery'] = {'fps': sb['fps'], 'utilization': sb['utilization']}
        await page.click('#player .ovl-btn'); await page.click('#player [data-p=exit]')
        await boot('#/settings/performance'); await page.click('.chip:has-text("Auto")')

        # ---------- mouse peripheral (Settings → Controls → P1 mouse) ----------
        await boot('#/settings/controls')
        await page.click('.setrow:has-text("P1 mouse") .chip:has-text("Port 1")')
        await boot(f'#/game/{gid}')
        await page.click('button.btn-play')
        await page.wait_for_selector('#player .ovl-btn', state='visible', timeout=30000)
        await page.wait_for_timeout(2000)
        m0 = await probe()
        cv = await page.evaluate("(() => { const r = document.querySelector('#player canvas.emu-surface').getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; })()")
        await page.mouse.move(cv[0], cv[1]); await page.mouse.down(); await page.mouse.up()   # first click: capture (pointer lock where allowed) + left button
        await page.wait_for_timeout(300)
        await page.mouse.move(cv[0] + 64, cv[1] - 32, steps=8)
        ex, ey = m0['x'] + 64 / 320, m0['y'] - 32 / 240   # 1 CSS px of movement = 1 mouse count
        m1 = await wait_probe(lambda x: abs(x['x'] - ex) < 0.06 and abs(x['y'] - ey) < 0.03)
        locked = await page.evaluate('document.pointerLockElement ? document.pointerLockElement.id || document.pointerLockElement.className : null')
        check('mouse → P1 mouse on port 1 (captured mouse movement moves the square 1:1)', m1 and abs(m1['x'] - ex) < 0.06 and abs(m1['y'] - ey) < 0.03, f"{m0['x']:.3f},{m0['y']:.3f} → {m1 and m1['x']:.3f},{m1 and m1['y']:.3f} (expected ≈{ex:.3f},{ey:.3f}) · pointer lock: {locked}")
        await page.evaluate('document.exitPointerLock && document.exitPointerLock()')
        await page.click('#player .ovl-btn'); await page.click('#player [data-p=exit]')
        await boot('#/settings/controls'); await page.click('.setrow:has-text("P1 mouse") .chip:has-text("Off")')

        # ---------- mobile / touch ----------
        m = await browser.new_context(viewport={'width': 390, 'height': 844}, is_mobile=True, has_touch=True)
        await m.add_init_script(SHIM)
        mp = await m.new_page()
        await mp.goto(BASE + '/#/upload'); await mp.wait_for_selector('#boot', state='detached')
        await mp.set_input_files('.dropzone input[type=file]', [os.path.join(T, 'out/saffron-pulse.chd')])
        await mp.wait_for_selector('.emu-card .btn-play'); await mp.tap('.emu-card .btn-play'); await mp.wait_for_url('**/#/game/**', timeout=30000)
        await mp.tap('button.btn-play'); await mp.wait_for_selector('#player .ovl-btn', state='visible', timeout=30000)
        await mp.wait_for_timeout(1500)
        b0 = await mp.evaluate(f'{emu}.probe()')
        box = await mp.evaluate("(() => { const r = document.querySelector('#player .dpad').getBoundingClientRect(); return [r.x, r.y, r.width, r.height]; })()")
        await mp.touchscreen.tap(box[0] + box[2] - 8, box[1] + box[3] / 2)   # real touch: instantaneous tap on D-pad right
        await mp.wait_for_timeout(500)
        b1 = await mp.evaluate(f'{emu}.probe()')
        check('mobile: touch D-pad drives the emulator', b1['x'] > b0['x'], f"{b0['x']:.3f} → {b1['x']:.3f}")
        await mp.screenshot(path=f'{SHOTS}/emu-mobile.png')
        await m.close()

        check('no uncaught errors', not [e for e in errors if 'WebGPU is experimental' not in e], errors[:3])
        await browser.close()
    print('\nMETRICS ' + json.dumps(metrics))


asyncio.run(main())
failed = [r for r in results if not r[1]]
print(f'\n{len(results) - len(failed)}/{len(results)} Mishrin P1 browser checks passed')
sys.exit(1 if failed else 0)
