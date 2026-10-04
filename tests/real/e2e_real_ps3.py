"""
REAL_EMULATOR_TEST — PS3-class: the real RPCS3 emulator behind the real cloud pipeline. No mocks anywhere.

    Console (Chromium) → Session API → scheduler → PS3 worker → sandbox → RPCS3 (LLVM PPU, Vulkan RSX) → encoder → WebRTC → Console

What runs: RPCS3 boots the original Mishrin PS3 test program (emulators/ps3/testapp: a PowerPC64 LV2 executable built
with clang/lld) from an uploaded disc-layout game folder. No PS3 system software is installed (none may be shipped), so
the worker runs in test mode with RPCS3's built-in (HLE) system libraries. The program reads GAME.DAT from /dev_bdvd,
draws with RSX clears, reads the pad (cellPad), plays a 750 Hz tone (cellAudio) and saves through cellFs.
Every assertion is made on pixels the browser decoded from the WebRTC stream, or on audio the browser received.

Needs: root, RPCS3 bundled by cloud/worker/emulators/rpcs3/install.sh, the console built and served, and the profiles:
    sh emulators/ps3/testapp/build.sh
    python3 cloud/worker/emulators/rpcs3/setup.py /opt/mishrin/emulators-real/rpcs3 --test-app emulators/ps3/testapp/out/MSHR00001
    python3 cloud/worker/emulators/rpcs3/setup.py /opt/mishrin/emulators-nobios/rpcs3
Run: sudo python3 tests/real/e2e_real_ps3.py      (writes tests/real/report-ps3.json)
"""
import asyncio
import json
import os
import re
import shutil
import signal
import subprocess
import sys
import time
import urllib.request

from playwright.async_api import async_playwright

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
CONSOLE = os.environ.get('BASE', 'http://localhost:4173')
PORT = 8800
SCHED = f'http://127.0.0.1:{PORT}'
WT, AT = 'real-worker-token', 'real-admin-token'
TMP = '/tmp/mishrin-real3'
GAME = os.path.join(ROOT, 'emulators', 'ps3', 'testapp', 'out', 'MSHR00001')
WORKERS = {'ps3-real': ('/var/lib/mishrin-real3', 520, '/opt/mishrin/emulators-real', True),
           'ps3-nofw': ('/var/lib/mishrin-nofw3', 620, '/opt/mishrin/emulators-nobios', False)}
results, procs, timings, metrics = [], {}, {}, {}


def check(name, ok, detail=''):
    results.append((name, bool(ok)))
    print(('PASS ' if ok else 'FAIL ') + name + (f' — {detail}' if detail != '' else ''), flush=True)


def api(method, path, body=None, token=AT, timeout=30):
    r = urllib.request.Request(SCHED + path, data=json.dumps(body).encode() if body is not None else None, method=method,
                               headers={'content-type': 'application/json', 'authorization': f'Bearer {token}'})
    try:
        with urllib.request.urlopen(r, timeout=timeout) as resp:
            t = resp.read()
            return resp.status, (json.loads(t) if t else None)
    except urllib.error.HTTPError as e:
        return e.code, None


def wait_for(fn, timeout, step=0.5):
    end = time.time() + timeout
    while time.time() < end:
        try:
            v = fn()
            if v:
                return v
        except Exception:
            pass
        time.sleep(step)
    return None


def start_worker(name):
    data, base, emus, test = WORKERS[name]
    shutil.rmtree(data, ignore_errors=True)
    log = open(f'{TMP}/{name}.log', 'w')
    procs[name] = subprocess.Popen(['/usr/bin/python3.12', '-m', 'mishrin_worker', '--scheduler', SCHED, '--token', WT, '--name', name, '--data', data,
                                    '--display-base', str(base), '--capacity', '1', '--emulators', emus] + (['--allow-test-firmware'] if test else []),
                                   cwd=os.path.join(ROOT, 'cloud', 'worker'), stdout=log, stderr=log)


def workers():
    return {w['name']: w for w in (api('GET', '/admin/workers')[1] or []) if w['alive']}


def no_leftovers(sid):
    mounts = open('/proc/mounts').read()
    emu = subprocess.run(['pgrep', '-f', 'mishrin-rpcs3/rpcs3'], capture_output=True).returncode == 0
    return not any(os.path.exists(os.path.join(d, 'sessions', sid)) for d, *_ in WORKERS.values()) and sid not in mounts and not emu


HOOKS = """
(() => {
  const pad = { id: 'Real Pad', index: 0, connected: true, mapping: 'standard', axes: [0,0,0,0], buttons: Array.from({length: 17}, () => ({ pressed: false, value: 0 })) };
  navigator.getGamepads = () => [window.__padOn ? pad : null];
  window.__press = (i, on) => { pad.buttons[i] = { pressed: on, value: on ? 1 : 0 }; pad.timestamp = performance.now(); };
  window.__axis = (i, v) => { pad.axes[i] = v; pad.timestamp = performance.now(); };
  const PC = window.RTCPeerConnection; window.__pcs = [];
  window.RTCPeerConnection = function (...a) { const pc = new PC(...a); window.__pcs.push(pc); return pc; };
  window.RTCPeerConnection.prototype = PC.prototype;
  Object.assign(window.RTCPeerConnection, PC);
  // pixels of the decoded WebRTC video, addressed in the program's 1280x720 framebuffer coordinates (located once from
  // the program's background colour).
  const grab = () => { const v = document.querySelector('#player video'); if (!v || !v.videoWidth) return null;
    const c = window.__c || (window.__c = document.createElement('canvas')); c.width = v.videoWidth; c.height = v.videoHeight;
    const x = c.getContext('2d', { willReadFrequently: true }); x.drawImage(v, 0, 0); return x; };
  window.__cal = () => { const x = grab(); if (!x) return null; const W = x.canvas.width, H = x.canvas.height, d = x.getImageData(0, 0, W, H).data;
    const bg = k => Math.abs(d[k] - 16) < 10 && Math.abs(d[k+1] - 8) < 10 && Math.abs(d[k+2] - 16) < 10;
    let x0 = W, y0 = H, x1 = 0, y1 = 0;
    for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) if (bg((j * W + i) * 4)) { if (i < x0) x0 = i; if (i > x1) x1 = i; if (j < y0) y0 = j; if (j > y1) y1 = j; }
    if (x1 <= x0) return null; window.__R = { x0, y0, sx: (x1 + 1 - x0) / 1280, sy: (y1 + 1 - y0) / 720 }; return window.__R; };
  const at = (gx, gy) => { const R = window.__R || { x0: 0, y0: 0, sx: 1, sy: 1 }; return [R.x0 + gx * R.sx, R.y0 + gy * R.sy]; };
  window.__px = (pts) => { const x = grab(); if (!x) return null;
    return pts.map(([gx, gy]) => { const [X, Y] = at(gx, gy); const d = x.getImageData(Math.round(X) - 1, Math.round(Y) - 1, 3, 3).data;
      let r = 0, g = 0, b = 0; for (let i = 0; i < 36; i += 4) { r += d[i]; g += d[i+1]; b += d[i+2]; } return [r / 9 | 0, g / 9 | 0, b / 9 | 0]; }); };
  // bounding box (GS coords) of pixels matching a colour predicate inside a GS rectangle
  window.__find = (kind, rx0, ry0, rx1, ry1) => { const x = grab(); if (!x) return null; const R = window.__R || { x0: 0, y0: 0, sx: 1, sy: 1 };
    const sx = R.sx, sy = R.sy, X0 = Math.round(R.x0 + rx0 * sx), Y0 = Math.round(R.y0 + ry0 * sy), W = Math.round((rx1 - rx0) * sx), H = Math.round((ry1 - ry0) * sy);
    const d = x.getImageData(X0, Y0, W, H).data; let n = 0, mx = 0, my = 0;
    for (let j = 0; j < H; j += 2) for (let i = 0; i < W; i += 2) { const k = (j * W + i) * 4, r = d[k], g = d[k+1], b = d[k+2];
      const hit = kind === 'saffron' ? (r > 200 && g > 110 && g < 190 && b < 100) : kind === 'white' ? (r > 220 && g > 220 && b > 220) : kind === 'violet' ? (r > 150 && g < 140 && b > 220) : false;
      if (hit) { n++; mx += i; my += j; } }
    return n ? { n, x: rx0 + mx / n / sx, y: ry0 + my / n / sy } : { n: 0 }; };
  // press → first decoded video frame in which the game shows the reaction (end-to-end input round trip)
  window.__react = (btn, gx, gy, timeout = 3000) => new Promise(res => { const v = document.querySelector('#player video'); const t0 = performance.now();
    window.__press(btn, true);
    const tick = () => { const p = window.__px([[gx, gy]]); const lit = p && p[0][1] > 180 && p[0][0] < 90;
      if (lit) return res(performance.now() - t0); if (performance.now() - t0 > timeout) return res(null); v.requestVideoFrameCallback(tick); };
    v.requestVideoFrameCallback(tick); });
})();
"""
FULL = ['up', 'down', 'left', 'right', 'cross', 'circle', 'square', 'triangle', 'l1', 'r1', 'l2', 'r2', 'select', 'start', 'l3', 'r3']
STD = {'up': 12, 'down': 13, 'left': 14, 'right': 15, 'cross': 0, 'circle': 1, 'square': 2, 'triangle': 3, 'l1': 4, 'r1': 5, 'l2': 6, 'r2': 7,
       'select': 8, 'start': 9, 'l3': 10, 'r3': 11}
GREEN = lambda p: p[1] > 180 and p[0] < 90 and p[2] < 90
BLUE = lambda p: p[2] > 180 and p[0] < 90 and p[1] < 90
SAFFRON = lambda p: p[0] > 200 and 110 < p[1] < 190 and p[2] < 100


async def main():
    os.makedirs(TMP, exist_ok=True)
    for d in ('cas', 'games', 'data'):
        shutil.rmtree(f'{TMP}/{d}', ignore_errors=True)
    assert os.path.exists(GAME), 'build the test program first: sh emulators/ps3/testapp/build.sh'
    env = dict(os.environ, PORT=str(PORT), WORKER_TOKEN=WT, ADMIN_TOKEN=AT, CAS_DIR=f'{TMP}/cas', GAMES_DIR=f'{TMP}/games', DATA_DIR=f'{TMP}/data',
               WORKER_TIMEOUT_MS='8000', UPLOAD_DEFAULTS=json.dumps({'ps3': {'ram': 3072, 'cpus': 2, 'storageMB': 4096}}))
    procs['sched'] = subprocess.Popen(['node', 'server/broker.mjs'], cwd=ROOT, env=env, stdout=open(f'{TMP}/sched.log', 'w'), stderr=subprocess.STDOUT)
    wait_for(lambda: api('GET', '/v1/config')[0] == 200, 10)

    # ================= worker start → emulator self-test (real RPCS3 boot) → registry =================
    t0 = time.time()
    for n in WORKERS:
        start_worker(n)
    ws = wait_for(lambda: (lambda w: len(w) == 2 and w)(workers()), 240, 1)
    timings['workerStartToRegisteredMs'] = round((time.time() - t0) * 1000)
    real = (ws or {}).get('ps3-real', {})
    nob = (ws or {}).get('ps3-nofw', {})
    re_ = next((e for e in real.get('emulators', []) if e['name'] == 'rpcs3'), {})
    ne_ = next((e for e in nob.get('emulators', []) if e['name'] == 'rpcs3'), {})
    v = re_.get('verified') or {}
    timings['selfTestEmulatorStartMs'], timings['selfTestFirstFrameMs'] = v.get('emulatorStartMs'), v.get('firstFrameMs')
    check('worker self-test: real RPCS3 booted the test program (game flips > 0 FPS, changing frames) before the worker registered', v.get('ok') and not re_.get('mock'),
          f"{re_.get('version')} · window {v.get('emulatorStartMs')} ms · first frame {v.get('firstFrameMs')} ms · {v.get('detail', '')[:70]}")
    check('firmware check: no PS3 system software (dev_flash liblv2.sprx) → FIRMWARE_REQUIRED + HLE test mode, never READY',
          re_.get('firmwareState') == 'test-only' and re_.get('status') == 'FIRMWARE_REQUIRED' and re_.get('testMode') and 'ps3' in real.get('runtimes', []), re_.get('firmwareDetail'))
    check('worker without firmware (not in test mode): RPCS3 installed, FIRMWARE_REQUIRED, PS3 not offered to the scheduler',
          ne_.get('installed') and ne_.get('status') == 'FIRMWARE_REQUIRED' and 'ps3' not in nob.get('runtimes', []), f"{ne_.get('status')} · {ne_.get('firmwareDetail')}")
    rf, nf = real.get('flags') or {}, nob.get('flags') or {}
    check('worker capability flags from real detection (cpu/gpu/vulkan/opengl/pcsx2/rpcs3)', rf.get('rpcs3') and nf.get('rpcs3') and rf.get('cpu') and (rf.get('vulkan') or rf.get('opengl')),
          {k: rf.get(k) for k in ('cpu', 'gpu', 'hardwareGpu', 'vulkan', 'opengl', 'pcsx2', 'rpcs3')})

    async with async_playwright() as p:
        browser = await p.chromium.launch(executable_path='/opt/pw-browsers/chromium', args=['--disable-features=WebRtcHideLocalIpsWithMdns', '--autoplay-policy=no-user-gesture-required'])
        ctx = await browser.new_context(viewport={'width': 1280, 'height': 720})
        await ctx.add_init_script(HOOKS)
        await ctx.add_init_script(f"try{{ if(!localStorage.getItem('mishrin.settings.v1')) localStorage.setItem('mishrin.settings.v1', JSON.stringify({{cloudEndpoint:'{SCHED}', maxFps:60, cloudQuality:'quality'}})) }}catch(e){{}}")
        page = await ctx.new_page()
        errors, posts = [], []
        page.on('pageerror', lambda e: errors.append(str(e)))
        page.on('request', lambda r: posts.append((time.time(), 'req')) if r.method == 'POST' and re.search(r'/(v1/sessions|api/session)$', r.url) else None)
        created = []

        async def on_resp(r):
            if r.request.method == 'POST' and re.search(r'/(v1/sessions|api/session)$', r.url) and r.status == 201:
                created.append((time.time(), (await r.json()).get('id')))
        page.on('response', lambda r: asyncio.ensure_future(on_resp(r)))

        async def boot(h=''):
            await page.goto(CONSOLE + '/' + h)
            await page.wait_for_selector('#boot', state='detached', timeout=15000)

        async def wait_js(expr, timeout=30000):
            end = time.time() + timeout / 1000
            while time.time() < end:
                try:
                    if await page.evaluate(expr):
                        return True
                except Exception:
                    pass
                await asyncio.sleep(0.1)
            raise TimeoutError(f'timeout waiting for {expr[:80]}')

        async def px(*pts):
            return await page.evaluate('p => window.__px(p)', [list(x) for x in pts])

        async def wait_px(pt, pred, timeout=20):
            end = time.time() + timeout
            while time.time() < end:
                v = await px(pt)
                if v and pred(v[0]):
                    return v[0]
                await asyncio.sleep(0.05)
            return None

        async def shot(name):
            import base64
            u = await page.evaluate("(() => { const v = document.querySelector('#player video'); const c = document.createElement('canvas'); c.width = v.videoWidth; c.height = v.videoHeight; c.getContext('2d').drawImage(v, 0, 0); return c.toDataURL('image/png'); })()")
            open(os.path.join(ROOT, 'tests', 'shots', f'real-ps3-{name}.png'), 'wb').write(base64.b64decode(u.split(',', 1)[1]))

        async def find(kind, rect):
            return await page.evaluate('a => window.__find(...a)', [kind, *rect])

        async def hold(btn, secs=0.5):
            await page.evaluate(f'window.__press({btn}, true)')
            await asyncio.sleep(secs)
            await page.evaluate(f'window.__press({btn}, false)')
            await asyncio.sleep(0.25)

        async def play():
            created.clear()
            t = time.time()
            await page.click('button.btn-play')
            await page.wait_for_selector('#player .ovl-btn', state='visible', timeout=180000)
            for _ in range(100):
                if created:
                    break
                await asyncio.sleep(0.05)
            return t, created[-1] if created else (None, None)

        # ================= registry in the console: PS3 = real emulator, test mode (not Ready) =================
        await boot('#/emulators')
        await wait_js("['test-mode','firmware-required','available'].includes(document.querySelector('.rt-row[data-rt=\"ps3-cloud\"]')?.dataset.state)", timeout=30000)
        row = await page.evaluate("(r => [r.dataset.state, r.querySelector('.rt-live').textContent, r.querySelector('.rt-detail').textContent])(document.querySelector('.rt-row[data-rt=\"ps3-cloud\"]'))")
        setup = await page.text_content('[data-setup="ps3-cloud"]') if await page.query_selector('[data-setup="ps3-cloud"]') else ''
        check('console runtime status: PS3 "Real emulator · PS3 system software required" (test mode), with exact setup instructions', row[0] == 'test-mode' and 'Ready' not in row[1] and 'own console' in setup,
              f'{row[1]} | {setup[:100]}')

        # ================= detector → upload → automatic resolution (browser never names RPCS3) =================
        await boot('#/upload')
        await page.set_input_files('input[data-dir]', GAME)
        await page.wait_for_selector('.emu-card[data-runtime="ps3-cloud"]', timeout=15000)
        card = await page.text_content('.emu-card')
        check('detector: game folder identified as PS3-class from PARAM.SFO (content, not names)', 'PS3-class' in card and 'MSHR00001' in card, card[:140])
        await page.check('[data-consent]')
        tu = time.time()
        await page.click('.emu-card .btn-play')
        await page.wait_for_url('**/#/game/c-*', timeout=60000)
        timings['uploadMs'] = round((time.time() - tu) * 1000)

        # ================= play: allocation → emulator → disc → first frame in the browser =================
        tp, (tc, sid) = await play()
        timings['allocationAndLaunchMs'] = round((tc - tp) * 1000) if tc else None      # POST → worker answered (sandbox + RPCS3 window + stream)
        await wait_js("(() => { const v = document.querySelector('#player video'); return v && v.videoWidth > 0 && v.currentTime > 0; })()", timeout=30000)
        timings['firstFrameBrowserMs'] = round((time.time() - tp) * 1000)
        cal = None
        for _ in range(100):
            cal = await page.evaluate('window.__cal()')
            if cal:
                break
            await asyncio.sleep(0.1)
        metrics['gsArea'] = cal
        disc = await wait_px((1136, 32), GREEN, 60)
        timings['gameLoadedBrowserMs'] = round((time.time() - tp) * 1000)
        st = wait_for(lambda: (lambda x: x and ((x.get('live') or {}).get('windows')) and x)(api('GET', f'/api/session/{sid}/status')[1]), 15) or {}
        live = st.get('live') or {}
        timings['worker'] = live.get('timings')
        box = await px((640, 328))
        await shot('first-frame')
        if os.environ.get('DEBUG_STOP'):
            raise SystemExit('debug stop')
        check('RPCS3 session on the RPCS3-capable worker, scheduled automatically (no emulator chosen by the browser)', st.get('worker') == 'ps3-real' and any('FPS' in w for w in (live.get('windows') or [])),
              f"worker {st.get('worker')} · windows {[w[:60] for w in (live.get('windows') or [])]}")
        check('test image loaded: program read GAME.DAT from /dev_bdvd via cellFs (disc square green, box in the disc colour)',
              disc and box and SAFFRON(box[0]), f'disc {disc} box {box}')
        check('browser receives rendered frames of the running game', timings['firstFrameBrowserMs'] < 120000,
              f"first frame {timings['firstFrameBrowserMs']} ms after Play")

        # ================= controller: every button through Gamepad API → DataChannel → worker → RPCS3 → program =================
        await page.evaluate("window.__padOn = true; dispatchEvent(new Event('gamepadconnected'))")
        await asyncio.sleep(0.5)
        b0 = await find('saffron', (0, 48, 1280, 620))
        lit, lat, trace = {}, [], []
        for i, name in enumerate(FULL):
            if name == 'start':
                continue                                   # START = save; exercised in the save test below
            ms = await page.evaluate('a => window.__react(...a)', [STD[name], 80 * i + 40, 664])
            await page.evaluate(f'window.__press({STD[name]}, false)')
            lit[name] = ms is not None
            await asyncio.sleep(0.2)
            trace.append((name, ms and round(ms), (lambda b: b and b.get('n') and (round(b['x']), round(b['y'])))(await find('saffron', (0, 48, 1280, 620)))))
            if ms is not None:
                lat.append(ms)
            await asyncio.sleep(0.35)
        b1 = await find('saffron', (0, 48, 1280, 620))
        check('D-pad, face buttons, shoulders, triggers, Select, L3/R3 reach the game (indicator lit in the streamed frame)', all(lit.values()),
              ' '.join(f"{k}{'✓' if v else '✗'}" for k, v in lit.items()))
        lat.sort()
        metrics['buttonTrace'] = trace
        metrics['inputRoundTripMs'] = {'median': round(lat[len(lat) // 2]) if lat else None, 'min': round(lat[0]) if lat else None, 'max': round(lat[-1]) if lat else None, 'n': len(lat)}
        b1 = await find('saffron', (0, 48, 1280, 620))
        await hold(STD['right'], 0.6)
        await hold(STD['down'], 0.4)
        b2 = await find('saffron', (0, 48, 1280, 620))
        bar0 = await find('saffron', (16, 20, 1280, 36))
        await hold(STD['cross'], 0.3); await hold(STD['cross'], 0.3)
        await asyncio.sleep(0.3)
        bar1 = await find('saffron', (16, 20, 1280, 36))
        check('game responds: held D-pad moves the box, CROSS raises the score bar', b1 and b2 and b2['n'] and b2['x'] > b1['x'] + 20 and b2['y'] > b1['y'] + 10
              and bar0 and bar1 and bar1['n'] > bar0['n'], f"box ({b1 and round(b1.get('x', 0))},{b1 and round(b1.get('y', 0))}) → ({b2 and round(b2.get('x', 0))},{b2 and round(b2.get('y', 0))}); score bar px {bar0 and bar0['n']} → {bar1 and bar1['n']}")
        sc0 = await find('white', (100, 470, 300, 600))
        await page.evaluate('window.__axis(0, 1)')                    # left stick full right
        await asyncio.sleep(0.8)
        sc1 = await find('white', (100, 470, 300, 600))
        await page.evaluate('window.__axis(0, 0); window.__axis(3, -1)')   # right stick up
        await asyncio.sleep(0.8)
        rs = await find('violet', (900, 470, 1100, 600))
        await page.evaluate('window.__axis(3, 0)')
        await asyncio.sleep(0.8)
        rs0 = await find('violet', (900, 470, 1100, 600))
        check('analog sticks reach the game (left stick → LX marker right, right stick → RY marker up)',
              sc0 and sc1 and sc1['n'] and sc1['x'] > sc0['x'] + 20 and rs and rs0 and rs['n'] and rs['y'] < rs0['y'] - 20,
              f"LX {sc0 and round(sc0.get('x', 0))}→{sc1 and round(sc1.get('x', 0))}, RY {rs0 and round(rs0.get('y', 0))}→{rs and round(rs.get('y', 0))}")
        check('input latency measured (gamepad press → reacting frame decoded in the browser)', lat, metrics['inputRoundTripMs'])

        # ================= video + audio =================
        await asyncio.sleep(3)
        stats = await page.evaluate("""(async () => { const pc = window.__pcs[window.__pcs.length - 1]; const o = {};
            (await pc.getStats()).forEach(s => { if (s.type === 'inbound-rtp') o[s.kind] = s; if (s.type === 'candidate-pair' && s.nominated) o.pair = s; if (s.type === 'codec') o['c_' + s.id] = s.mimeType; });
            return JSON.parse(JSON.stringify(o)); })()""")
        vi, au, pair = stats.get('video', {}), stats.get('audio', {}), stats.get('pair', {})
        live = (api('GET', f'/api/session/{sid}/status')[1] or {}).get('live') or {}
        sm = live.get('stream') or {}
        metrics['video'] = {'resolution': f"{vi.get('frameWidth')}x{vi.get('frameHeight')}", 'browserFps': vi.get('framesPerSecond'), 'workerFps': sm.get('fps'),
                            'codec': sm.get('codec'), 'encoder': sm.get('encoder'), 'hardwareEncoder': sm.get('hardwareEncoder'), 'encodeMs': sm.get('encodeMs'),
                            'networkRttMs': round(pair['currentRoundTripTime'] * 1000, 1) if pair.get('currentRoundTripTime') is not None else None,
                            'jitterBufferMs': round(vi['jitterBufferDelay'] / vi['jitterBufferEmittedCount'] * 1000, 1) if vi.get('jitterBufferEmittedCount') else None,
                            'framesDecoded': vi.get('framesDecoded'), 'framesDropped': vi.get('framesDropped'), 'packetsLost': vi.get('packetsLost'),
                            'rpcs3Window': next((w for w in (live.get('windows') or []) if 'FPS' in w), '')[:120]}
        acodec = stats.get('c_' + au.get('codecId', ''), '')
        # decode the received audio track in the page (WebAudio) and measure it: level + dominant frequency
        tone = await page.evaluate("""(async () => { const pc = window.__pcs[window.__pcs.length - 1];
            const tr = pc.getReceivers().map(r => r.track).find(t => t && t.kind === 'audio'); if (!tr) return null;
            const ac = new AudioContext(); await ac.resume(); const src = ac.createMediaStreamSource(new MediaStream([tr]));
            const an = ac.createAnalyser(); an.fftSize = 8192; src.connect(an);
            await new Promise(r => setTimeout(r, 1500));
            const td = new Float32Array(an.fftSize); an.getFloatTimeDomainData(td); let e = 0; for (const v of td) e += v * v;
            const fd = new Float32Array(an.frequencyBinCount); an.getFloatFrequencyData(fd); let k = 1; for (let i = 1; i < fd.length; i++) if (fd[i] > fd[k]) k = i;
            const out = { rms: Math.sqrt(e / td.length), peakHz: Math.round(k * ac.sampleRate / an.fftSize), sampleRate: ac.sampleRate }; ac.close(); return out; })()""")
        au['decoded'] = tone
        metrics['audio'] = {'codec': acodec, 'packets': au.get('packetsReceived'), 'decodedRms': tone and round(tone['rms'], 4), 'peakHz': tone and tone['peakHz']}
        check('video stream metrics (resolution, fps, encoder, encode latency, RTT, dropped frames)', vi.get('framesDecoded', 0) > 60 and sm.get('encodeMs') is not None,
              json.dumps(metrics['video'])[:260])
        check('audio: the program\'s 750 Hz cellAudio tone (RPCS3 → Cubeb → session PulseAudio → Opus → WebRTC) decoded in the browser',
              au.get('packetsReceived', 0) > 50 and acodec == 'audio/opus' and tone and tone['rms'] > 0.005 and 680 < tone['peakHz'] < 820, metrics['audio'])

        # ================= save (cellFs, user save-data area) → exit → restore =================
        saved_box = await find('saffron', (0, 48, 1280, 620))
        await hold(STD['start'], 0.5)
        done = await wait_px((1232, 32), GREEN, 15)
        check('START saves through cellFs to /dev_hdd0/home/00000001/savedata (program reports DONE)', done, f'box at {saved_box}')
        await page.click('#player .ovl-btn')
        te = time.time()
        await page.click('#player [data-p=exit]')
        gone = wait_for(lambda: api('GET', f'/api/session/{sid}')[0] == 404 and no_leftovers(sid), 60)
        timings['shutdownMs'] = round((time.time() - te) * 1000)
        check('clean termination: RPCS3 closed, sandbox/mounts removed', gone, f"{timings['shutdownMs']} ms")
        wlog = open(f'{TMP}/ps3-real.log').read()
        check('final save captured the save data into the cloud save layer', re.search(r'ending: [^\n]*\n(?:.*\n)*?.*auto save [0-9a-f]{12} \d+ B', wlog), (re.findall(r'auto save [0-9a-f]{12} \d+ B[^\n]*', wlog) or [''])[-1])
        await page.wait_for_timeout(1500)
        tp2, (tc2, sid2) = await play()
        await wait_js("(() => { const v = document.querySelector('#player video'); return v && v.videoWidth > 0 && v.currentTime > 0; })()", timeout=30000)
        for _ in range(100):
            if await page.evaluate('window.__cal()'):
                break
            await asyncio.sleep(0.1)
        loaded = await wait_px((1184, 32), GREEN, 60)
        timings['restartToRestoredMs'] = round((time.time() - tp2) * 1000)
        rb = await find('saffron', (0, 48, 1280, 620))
        check('restart restores the save: save data loaded, box position equals the saved one',
              loaded and rb and saved_box and abs(rb['x'] - saved_box['x']) < 6 and abs(rb['y'] - saved_box['y']) < 6, f'saved {saved_box} → restored {rb}')
        await page.click('#player .ovl-btn')
        await page.click('#player [data-p=exit]')
        check('second session ends cleanly', wait_for(lambda: no_leftovers(sid2), 60))

        # ================= no firmware anywhere → console shows the setup screen, Play is refused =================
        procs['ps3-real'].send_signal(signal.SIGTERM)
        procs['ps3-real'].wait(60)
        wait_for(lambda: 'ps3-real' not in workers(), 30)
        await boot('#/emulators')
        await wait_js("document.querySelector('.rt-row[data-rt=\"ps3-cloud\"]')?.dataset.state === 'firmware-required'", timeout=30000)
        setup = await page.text_content('[data-setup="ps3-cloud"]')
        check('only a firmware-less RPCS3 worker: "PS3 system software required" setup screen (what to provide, how, nothing downloaded)',
              'PS3 system software' in setup and 'own console' in setup and 'setup.py' in setup and 'does not download' in setup, setup[:160])
        await boot('#/upload')
        await page.set_input_files('input[data-dir]', GAME)
        await page.wait_for_selector('.emu-card[data-runtime="ps3-cloud"]', timeout=15000)
        dis = await page.locator('.emu-card .actions button').last.is_disabled()
        check('upload/play refused while the firmware is missing (no fake session)', dis and await page.query_selector('.emu-card [data-setup="ps3-cloud"]'))
        check('no uncaught console errors', not errors, errors[:3])
        await browser.close()


try:
    asyncio.run(main())
except Exception as e:
    import traceback
    traceback.print_exc()
    check('real emulator harness', False, e)
finally:
    for name, p in procs.items():
        if p.poll() is None:
            p.send_signal(signal.SIGTERM)
    for p in procs.values():
        try:
            p.wait(30)
        except Exception:
            p.kill()
failed = [r for r in results if not r[1]]
report = {'suite': 'REAL_EMULATOR_TEST ps3', 'emulator': 'RPCS3 0.0.43 (source build)', 'image': 'Mishrin PS3 test program (original, HLE test mode)',
          'passed': len(results) - len(failed), 'total': len(results), 'results': results, 'timings': timings, 'metrics': metrics}
json.dump(report, open(os.path.join(os.path.dirname(__file__), 'report-ps3.json'), 'w'), indent=1)
print(json.dumps({'timings': timings, 'metrics': metrics}, indent=1))
print(f'\n{len(results) - len(failed)}/{len(results)} REAL_EMULATOR_TEST (PS3) checks passed')
sys.exit(1 if failed else 0)
