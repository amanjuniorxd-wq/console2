"""
End-to-end: Mishrin Console → scheduler → two real Wine workers → WebRTC → browser.
Run as root with the console preview up (npm run build && npm run preview):
    python3 tests/cloud/e2e_windows.py
Starts its own scheduler (:8797) and workers (e2e-a, e2e-b), publishes the compatibility titles, and drives the
real console UI in Chromium: Library → Windows game → Play → cloud → controller → Save/Load → crash → worker loss →
reassignment → Exit, plus 32-bit/D3D9/GDI targets, upload path, adaptive quality, timeouts and cleanup.
"""
import asyncio
import base64
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
PORT = 8797
SCHED = f'http://127.0.0.1:{PORT}'
WT, AT = 'e2e-worker-token', 'e2e-admin-token'
TMP = '/tmp/mishrin-e2e'
SHOTS = os.path.join(ROOT, 'tests', 'shots')
WORKERS = {'e2e-a': ('/var/lib/mishrin', 100), 'e2e-b': ('/var/lib/mishrin-b', 200)}
EMULATORS = os.path.join(ROOT, 'cloud', 'test-games', 'emulators')   # MOCK RPCS3 / PCSX2 profiles (test doubles)
results = []
procs = {}


def check(name, ok, detail=''):
    results.append((name, bool(ok)))
    print(('PASS ' if ok else 'FAIL ') + name + (f' — {detail}' if detail != '' else ''), flush=True)


def api(method, path, body=None, token=None, timeout=30):
    data = json.dumps(body).encode() if body is not None else None
    h = {'content-type': 'application/json'}
    if token is None and re.match(r'^/(api/session|v1/sessions)/', path):
        token = AT  # session control needs the session token; the test harness acts as operator (admin token)
    if token:
        h['authorization'] = f'Bearer {token}'
    r = urllib.request.Request(SCHED + path, data=data, method=method, headers=h)
    try:
        with urllib.request.urlopen(r, timeout=timeout) as resp:
            t = resp.read()
            return resp.status, (json.loads(t) if t else None)
    except urllib.error.HTTPError as e:
        t = e.read()
        try:
            return e.code, json.loads(t)
        except Exception:
            return e.code, t


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
    data, base = WORKERS[name]
    log = open(f'{TMP}/{name}.log', 'a')
    procs[name] = subprocess.Popen(['/usr/bin/python3.12', '-m', 'mishrin_worker', '--scheduler', SCHED, '--token', WT, '--name', name,
                                    '--data', data, '--display-base', str(base), '--capacity', '2', '--hang-timeout', '15', '--autosave', '20',
                                    '--reconnect-grace', '45', '--emulators', EMULATORS], cwd=os.path.join(ROOT, 'cloud', 'worker'), stdout=log, stderr=log)


def workers():
    return api('GET', '/admin/workers', token=AT)[1] or []


def session_status(sid):
    return api('GET', f'/api/session/{sid}/status')[1] or {}


def title_of(st):
    return ((st.get('live') or {}).get('windows') or [''])[0]


def parse_title(t):
    return {k: v for k, v in re.findall(r'(\w+)=(\S+)', t)}


def no_leftovers(sid):
    dirs = [os.path.join(d, 'sessions', sid) for d, _ in WORKERS.values()]
    mounts = open('/proc/mounts').read()
    cg = subprocess.run(['bash', '-c', f'ls -d /sys/fs/cgroup/*/mishrin/*/session-{sid} 2>/dev/null'], capture_output=True, text=True).stdout.strip()
    return not any(os.path.exists(d) for d in dirs) and sid not in mounts and not cg


HOOKS = """
(() => {
  const pad = { id: 'E2E Pad', index: 0, connected: true, mapping: 'standard', axes: [0,0,0,0], buttons: Array.from({length: 17}, () => ({ pressed: false, value: 0 })) };
  navigator.getGamepads = () => [window.__padOn ? pad : null];
  window.__press = (i, on) => { pad.buttons[i] = { pressed: on, value: on ? 1 : 0 }; };
  const PC = window.RTCPeerConnection; window.__pcs = [];
  window.RTCPeerConnection = function (...a) { const pc = new PC(...a); window.__pcs.push(pc); return pc; };
  window.RTCPeerConnection.prototype = PC.prototype;
  Object.assign(window.RTCPeerConnection, PC);
})();
"""


async def main():
    os.makedirs(TMP, exist_ok=True)
    os.makedirs(SHOTS, exist_ok=True)
    for d in ('cas', 'games', 'data'):
        shutil.rmtree(f'{TMP}/{d}', ignore_errors=True)
    env = dict(os.environ, PORT=str(PORT), WORKER_TOKEN=WT, ADMIN_TOKEN=AT, CAS_DIR=f'{TMP}/cas', GAMES_DIR=f'{TMP}/games', DATA_DIR=f'{TMP}/data',
               WORKER_TIMEOUT_MS='6000', CLIENT_HEARTBEAT_TIMEOUT_MS='35000', ORPHAN_GRACE_MS='90000',
               # operator defaults for uploaded console titles: the mock emulator needs little (8 GB VM; real RPCS3 needs more)
               UPLOAD_DEFAULTS=json.dumps({'ps3': {'ram': 1024, 'cpus': 1, 'storageMB': 2048}, 'ps2': {'ram': 1024, 'cpus': 1, 'storageMB': 2048}}))
    procs['sched'] = subprocess.Popen(['node', 'server/broker.mjs'], cwd=ROOT, env=env, stdout=open(f'{TMP}/sched.log', 'w'), stderr=subprocess.STDOUT)
    wait_for(lambda: api('GET', '/v1/config')[0] == 200, 10)

    # ---------- publish compatibility titles (chunked, deduplicated) ----------
    tg = os.path.join(ROOT, 'cloud', 'test-games')
    pub = {}
    for d in ('d3d11', 'd3d9', 'gdi64', 'gdi32'):
        out = subprocess.run(['node', 'cloud/tools/pack.mjs', f'{tg}/pkg/{d}', f'{tg}/manifests/{d}.json', '--scheduler', SCHED, '--admin-token', AT],
                             cwd=ROOT, capture_output=True, text=True)
        pub[d] = json.loads(out.stdout.strip().splitlines()[-1]) if out.returncode == 0 else {'error': out.stderr}
    short = json.load(open(f'{tg}/manifests/gdi64.json'))
    short.update(id='mishrin-gdi64-short', title='Short Session Test', requirements=dict(short['requirements'], maxMinutes=0.4))
    json.dump(short, open(f'{TMP}/short.json', 'w'))
    out = subprocess.run(['node', 'cloud/tools/pack.mjs', f'{tg}/pkg/gdi64', f'{TMP}/short.json', '--scheduler', SCHED, '--admin-token', AT], cwd=ROOT, capture_output=True, text=True)
    pub['short'] = json.loads(out.stdout.strip().splitlines()[-1])
    check('games published via content-addressed chunks', all('manifestHash' in v for v in pub.values()) and pub['short']['chunksUploaded'] == 0,
          f"re-publish of gdi64 as a new title uploaded {pub['short']['chunksUploaded']} chunks ({pub['short']['chunksDeduplicated']} deduplicated)")

    # ---------- workers ----------
    for n in WORKERS:
        start_worker(n)
    ws = wait_for(lambda: len([w for w in workers() if w['alive'] and w['name'] in WORKERS]) == 2 and workers(), 180, 1)
    check('two workers registered with GPU/encoder/isolation capabilities', ws and all(w['gpu']['available'] and w['encoders'] and w['isolation']['bwrap'] for w in ws),
          '; '.join(f"{w['name']}: {w['gpu']['device']}, {','.join(w['encoders'])}, cgroups {w['isolation']['cgroups']}" for w in ws or []))

    async with async_playwright() as p:
        browser = await p.chromium.launch(executable_path='/opt/pw-browsers/chromium', args=['--disable-features=WebRtcHideLocalIpsWithMdns', '--autoplay-policy=no-user-gesture-required'])
        ctx = await browser.new_context(viewport={'width': 1280, 'height': 720})
        await ctx.add_init_script(HOOKS)
        await ctx.add_init_script(f"try{{ if(!localStorage.getItem('mishrin.settings.v1')) localStorage.setItem('mishrin.settings.v1', JSON.stringify({{cloudEndpoint:'{SCHED}', maxFps:30, cloudQuality:'performance'}})) }}catch(e){{}}")
        page = await ctx.new_page()
        errors = []
        page.on('pageerror', lambda e: errors.append(str(e)))
        sessions_seen = []

        def on_resp(r):
            if r.request.method == 'POST' and re.search(r'/(v1/sessions|api/session)$', r.url) and r.status == 201:
                sessions_seen.append(r)
        page.on('response', on_resp)

        async def boot(h=''):
            await page.goto(CONSOLE + '/' + h)
            await page.wait_for_selector('#boot', state='detached', timeout=15000)

        async def current_sid():
            r = sessions_seen[-1]
            return (await r.json()).get('id')

        async def frame_has_saffron():
            return await page.evaluate("""(() => { const v = document.querySelector('#player video'); if (!v || !v.videoWidth) return false;
              const c = document.createElement('canvas'); c.width = v.videoWidth; c.height = v.videoHeight; const x = c.getContext('2d'); x.drawImage(v, 0, 0);
              const d = x.getImageData(0, 0, c.width, c.height).data; let n = 0;
              for (let i = 0; i < d.length; i += 16) if (d[i] > 200 && d[i+1] > 90 && d[i+1] < 175 && d[i+2] < 70) n++;
              return n > 50; })()""")

        async def pad_tap(i):
            await page.evaluate(f'window.__press({i}, true)')
            await page.wait_for_timeout(150)
            await page.evaluate(f'window.__press({i}, false)')
            await page.wait_for_timeout(250)

        async def wait_title(sid, pred, timeout=30):
            end = time.time() + timeout
            t = ''
            while time.time() < end:
                t = title_of(session_status(sid))
                if t and pred(parse_title(t)):
                    return parse_title(t)
                await asyncio.sleep(0.5)
            return None

        # ================= 1. Library → Windows game → Play → automatic cloud routing =================
        await boot('#/library')
        await page.click('.card[data-id="mishrin-d3d11"]')
        await page.wait_for_url('**/#/game/mishrin-d3d11')
        t0 = time.time()
        await page.click('button.btn-play')
        await page.wait_for_selector('#player .ovl-btn', state='visible', timeout=180000)
        start_s = time.time() - t0
        sid = await current_sid()
        await page.wait_for_timeout(1500)
        wait_for(lambda: title_of(session_status(sid)) and (session_status(sid)['live'].get('stream') or {}).get('fps'), 20)  # first heartbeat
        st = session_status(sid)
        live = st.get('live') or {}
        vt = parse_title(title_of(st))
        check('Library → Windows game → Play starts a cloud session', bool(sid) and st.get('state') == 'streaming', f'{start_s:.1f}s to first frame on {st.get("worker")}')
        check('Wine launched the declared 64-bit D3D11 executable', vt.get('bits') == '64' and 'd3d11' in title_of(st), title_of(st))
        check('GPU rendering through DXVK → Vulkan', (live.get('graphics') or '').startswith('DXVK') and 'llvmpipe' in vt.get('gpu', ''), live.get('graphics'))
        check('browser receives video frames of the game', await frame_has_saffron(), f"{live.get('stream', {}).get('codec')} via {live.get('stream', {}).get('encoder')} "
              f"({'hardware' if live.get('stream', {}).get('hardwareEncoder') else 'software'}) {live.get('stream', {}).get('width')}x{live.get('stream', {}).get('height')}@{live.get('stream', {}).get('fps')}")
        rtp = await page.evaluate("""(async () => { const pc = window.__pcs[window.__pcs.length - 1]; const o = {};
            (await pc.getStats()).forEach(s => { if (s.type === 'inbound-rtp') o[s.kind] = { packets: s.packetsReceived, frames: s.framesDecoded, codecId: s.codecId };
              if (s.type === 'codec') o['c_' + s.id] = s.mimeType; }); return o; })()""")
        acodec = rtp.get('c_' + rtp.get('audio', {}).get('codecId', ''), '')
        check('browser receives audio (Opus)', rtp.get('audio', {}).get('packets', 0) > 50 and acodec == 'audio/opus', f"{rtp.get('audio')} {acodec}")
        await page.click('#player .ovl-btn')
        await page.click('#player [data-p=perf]')
        await page.wait_for_timeout(2200)
        perf = await page.text_content('#player .ovl-panel')
        check('automatic cloud routing shown in console', 'Cloud' in perf, perf.replace('\n', ' ')[:110])
        await page.keyboard.press('Escape')
        await page.screenshot(path=f'{SHOTS}/windows-d3d11-cloud.png')

        # ================= 2. controller + keyboard input =================
        base = await wait_title(sid, lambda d: 'x' in d)
        await page.evaluate("window.__padOn = true; dispatchEvent(new Event('gamepadconnected'))")
        await page.wait_for_timeout(300)
        await pad_tap(15)   # D-pad right
        await pad_tap(0)    # A
        moved = await wait_title(sid, lambda d: int(d['x']) == int(base['x']) + 20 and int(d['score']) == int(base['score']) + 1, 10)
        check('controller works (D-pad → move, A → action)', moved, f"x {base['x']}→{moved and moved['x']}, score {base['score']}→{moved and moved['score']}")
        await page.evaluate('window.__padOn = false')
        await page.keyboard.down('ArrowDown')
        await page.wait_for_timeout(120)
        await page.keyboard.up('ArrowDown')
        kb = await wait_title(sid, lambda d: int(d['y']) == int(moved['y']) + 20, 10) if moved else None
        check('keyboard works (raw keys, no double input)', kb and int(kb['x']) == int(moved['x']), kb)

        # mouse: click inside the streamed picture → the game sees the click at that window position (letterbox-aware)
        geo = await page.evaluate('''(() => { const v = document.querySelector('#player video.game-surface'); const r = v.getBoundingClientRect();
          const k = Math.min(r.width / v.videoWidth, r.height / v.videoHeight); return { l: r.left + (r.width - v.videoWidth * k) / 2, t: r.top + (r.height - v.videoHeight * k) / 2, w: v.videoWidth * k, h: v.videoHeight * k }; })()''')
        fx, fy = 0.25, 0.5
        await page.mouse.click(geo['l'] + geo['w'] * fx, geo['t'] + geo['h'] * fy)
        ex, ey = int(fx * 639) - 20, int(fy * 359) - 20
        mc = await wait_title(sid, lambda d: abs(int(d['x']) - ex) <= 4 and abs(int(d['y']) - ey) <= 4, 10)
        check('mouse: left click lands at the clicked window position', mc, f"expected ≈({ex},{ey}) got {mc and (mc['x'], mc['y'])}")
        sc0 = int((mc or kb or base)['score'])
        await page.mouse.click(geo['l'] + geo['w'] * 0.5, geo['t'] + geo['h'] * 0.5, button='right')
        rc = await wait_title(sid, lambda d: int(d['score']) == sc0 + 1, 10)
        check('mouse: right click reaches the game (no browser context menu)', rc, f"score {sc0} → {rc and rc['score']}")
        if mc:
            await page.mouse.move(geo['l'] + geo['w'] * 0.5, geo['t'] + geo['h'] * 0.5)
            await page.mouse.wheel(0, 200)   # two notches towards the user
            wh = await wait_title(sid, lambda d: int(d['y']) == int(mc['y']) + 20, 10)
            check('mouse: wheel reaches the game (2 notches)', wh, f"y {mc['y']} → {wh and wh['y']}")

        # ================= 3. Save State / Load =================
        await page.click('#player .ovl-btn')
        await page.click('#player [data-p=save]')
        await page.wait_for_timeout(300)
        await page.click('#player .ovl-panel .btn-play')
        await page.wait_for_selector('.toast:has-text("Saved")', timeout=30000)
        saved_toast = await page.text_content('.toast')
        saved = parse_title(title_of(session_status(sid)))
        check('Save State works (cloud save layer)', 'Saved' in saved_toast and api('GET', f'/api/session/{sid}')[1].get('save'), saved_toast)
        await page.keyboard.press('Escape')
        for _ in range(2):
            await page.keyboard.press('ArrowLeft')
            await page.wait_for_timeout(200)
        await wait_title(sid, lambda d: int(d['x']) == int(saved['x']) - 40, 10)
        await page.click('#player .ovl-btn')
        await page.click('#player [data-p=save]')
        await page.wait_for_timeout(300)
        await page.click('#player .ovl-panel .btn:not(.btn-play)')
        await page.wait_for_selector('.toast:has-text("loaded")', timeout=120000)
        back = await wait_title(sid, lambda d: d.get('loaded') == '1', 60)
        check('Load State restores the saved progress', back and back['x'] == saved['x'] and back['y'] == saved['y'], f"saved x={saved['x']} → after load x={back and back['x']}")

        # ================= 4. HTTP input + save API =================
        code, _ = api('POST', f'/api/session/{sid}/input', {'events': ['k1ArrowRight', 'k0ArrowRight']})
        hx = await wait_title(sid, lambda d: int(d['x']) == int(back['x']) + 20, 10) if back else None
        check('POST /api/session/:id/input (low-latency fallback path)', code == 202 and hx)
        code, sv = api('POST', f'/api/session/{sid}/save', timeout=90)
        check('POST /api/session/:id/save stores a compressed save layer', code == 200 and sv.get('ref') and sv['size'] < sv['raw'] + 512, sv)

        # ================= 5. crash recovery =================
        await page.keyboard.press('F12')
        await page.wait_for_selector('.toast:has-text("restarting")', timeout=40000)
        wait_for(lambda: (session_status(sid).get('live') or {}).get('restarts') == 1, 30)  # status arrives with the next heartbeat
        rec = await wait_title(sid, lambda d: True, 60)
        st = session_status(sid)
        check('crash recovery: game restarted in place, progress kept', rec and st['live']['restarts'] == 1 and rec.get('loaded') == '1' and st['state'] == 'streaming',
              f"restarts={st['live']['restarts']} title loaded={rec and rec.get('loaded')}")

        # ================= 6. stream parameters negotiated from console prefs =================
        q = wait_for(lambda: session_status(sid)['live']['stream'], 5)
        check('stream negotiated with adaptive controls', q and q['kbps'] > 0 and q['targetFps'] <= 30, q)

        # ================= 7. Exit destroys the session =================
        worker_name = session_status(sid)['worker']
        await page.click('#player .ovl-btn')
        await page.click('#player [data-p=exit]')
        gone = wait_for(lambda: api('GET', f'/api/session/{sid}')[0] == 404 and no_leftovers(sid), 30)
        check('Exit destroys the session (scheduler, sandbox, mounts, cgroups, data)', gone, f'worker {worker_name}')

        # ================= 8. persistence + worker failure → reassignment =================
        sessions_seen.clear()
        await page.click('button.btn-play')
        await page.wait_for_selector('#player .ovl-btn', state='visible', timeout=180000)
        sid2 = await current_sid()
        again = await wait_title(sid2, lambda d: True, 30)
        check('progress persists into the next session', again and again.get('loaded') == '1' and again['x'] == hx['x'] if hx else False, f"x={again and again['x']} (last {hx and hx['x']})")
        victim = session_status(sid2)['worker']
        await page.keyboard.press('ArrowUp')
        await wait_title(sid2, lambda d: int(d['y']) == int(again['y']) - 20, 10)
        api('POST', f'/api/session/{sid2}/save', timeout=90)
        procs[victim].send_signal(signal.SIGKILL)
        procs[victim].wait()
        t_fail = time.time()
        await page.wait_for_selector('.toast:has-text("Resumed on another cloud node")', timeout=150000)
        resumed = await wait_title(sid2, lambda d: True, 60)
        st = session_status(sid2)
        check('worker failure → session reassigned and resumed from its save', st.get('worker') not in (None, victim) and st.get('reassignments') == 1
              and resumed and resumed['y'] == str(int(again['y']) - 20), f'{victim} killed → {st.get("worker")} in {time.time() - t_fail:.0f}s, y={resumed and resumed["y"]}')
        check('stream continues after reassignment', await frame_has_saffron())
        await page.screenshot(path=f'{SHOTS}/windows-reassigned.png')
        start_worker(victim)  # restarted worker reclaims what the crash left behind
        wait_for(lambda: any(w['name'] == victim and w['alive'] for w in workers()), 60, 1)
        data_dir = WORKERS[victim][0]
        check('restarted worker reclaims crash leftovers (mounts, sandboxes, X servers)',
              not os.listdir(os.path.join(data_dir, 'sessions')) and f'{data_dir}/sessions/' not in open('/proc/mounts').read()
              and not subprocess.run(['pgrep', '-f', f'{data_dir}/sessions/'], capture_output=True).stdout)
        await page.click('#player .ovl-btn')
        await page.click('#player [data-p=exit]')
        check('second Exit also cleans up', wait_for(lambda: api('GET', f'/api/session/{sid2}')[0] == 404 and no_leftovers(sid2), 30))

        # ================= 9. compatibility targets via API (32-bit WoW64, D3D9, GDI) + live quality change =================
        apage = await ctx.new_page()
        await apage.set_content('<!doctype html><title>API client</title>')  # plain HTML document (media can play)
        CLIENT = """async ([sched, game, rt]) => {
          if (window.__s) { window.__s.pc.close(); window.__s.v.remove(); }  // one stream per page, like the console
          const pc = new RTCPeerConnection(); pc.addTransceiver('video', {direction:'recvonly'}); pc.addTransceiver('audio', {direction:'recvonly'});
          const input = pc.createDataChannel('input', {ordered:false, maxRetransmits:0}); const ctl = pc.createDataChannel('ctl');
          await pc.setLocalDescription(await pc.createOffer());
          await new Promise(r => { pc.onicegatheringstatechange = () => pc.iceGatheringState === 'complete' && r(); setTimeout(r, 2500); });
          const r = await fetch(sched + '/api/session', {method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({game:{id:game, runtime:rt, catalogId:game}, offer: pc.localDescription.sdp, prefs:{height:360,fps:30,kbps:1500}})});
          const j = await r.json(); if (!r.ok) return {error: j};
          await pc.setRemoteDescription({type:'answer', sdp:j.answer});
          const v = document.createElement('video'); v.muted = true; v.autoplay = true; document.body.append(v);
          v.srcObject = new MediaStream(pc.getReceivers().map(x => x.track)); v.play().catch(() => {});
          await new Promise(r => { v.onloadeddata = r; setTimeout(r, 20000); });
          window.__s = {pc, ctl, input, v, id: j.id}; window.__ends = []; ctl.onmessage = e => window.__ends.push(e.data);
          return {id: j.id, w: v.videoWidth};
        }"""
        for gid, rt, api_name, bits, dx in (('mishrin-d3d9', 'x86', 'd3d9', '32', True), ('mishrin-gdi32', 'x86', 'gdi', '32', False), ('mishrin-gdi64', 'x64-win', 'gdi', '64', False)):
            res = await apage.evaluate(CLIENT, [SCHED, gid, rt])
            s = res.get('id')
            tt = await wait_title(s, lambda d: 'bits' in d, 60) if s else None
            gfx = (session_status(s).get('live') or {}).get('graphics') if s else None
            ok = tt and tt.get('bits') == bits and title_of(session_status(s)).startswith(f'MISHRIN-TEST {api_name}') and (bool(gfx) == dx)
            check(f'compatibility: {gid} ({api_name}, {bits}-bit{", DXVK" if dx else ""})', ok and res.get('w', 0) > 0,
                  f"{gfx or 'no translation layer'} · video {res.get('w')}px · {title_of(session_status(s))[:60] if s else res}")
            if gid == 'mishrin-gdi64':
                await apage.evaluate("window.__s.ctl.send(JSON.stringify({t:'quality', height:180, fps:15, kbps:700}))")
                q = wait_for(lambda: (lambda x: x if x['height'] == 180 and x['targetFps'] == 15 and x['kbps'] == 700 else None)(session_status(s)['live']['stream']), 10)
                await apage.wait_for_timeout(2500)
                vw = await apage.evaluate('window.__s.v.videoWidth')
                check('adaptive bitrate / resolution / FPS applied live', q and vw == 320, f'{q} → browser now decodes {vw}px wide')
                # graceful disconnect: client vanishes without DELETE → timeout cleanup
                await apage.close()
                t_gone = time.time()
                cleaned = wait_for(lambda: api('GET', f'/api/session/{s}')[0] == 404 and no_leftovers(s), 60)
                check('timeout cleanup when the player disappears', cleaned, f'{time.time() - t_gone:.0f}s')
            else:
                api('DELETE', f'/api/session/{s}')
                wait_for(lambda: no_leftovers(s), 30)

        # ================= 10. session time limit =================
        apage = await ctx.new_page()
        await apage.set_content('<!doctype html><title>API client</title>')  # plain HTML document (media can play)
        res = await apage.evaluate(CLIENT, [SCHED, 'mishrin-gdi64-short', 'x64-win'])
        s = res.get('id')
        keep = True

        async def heartbeat():
            while keep:
                api('POST', f'/v1/sessions/{s}/heartbeat')
                await asyncio.sleep(3)
        hb = asyncio.create_task(heartbeat())
        ended = None
        for _ in range(80):
            ended = await apage.evaluate("window.__ends.find(m => m.includes('\"end\"'))")
            if ended:
                break
            await asyncio.sleep(0.5)
        keep = False
        await hb
        check('session time limit enforced (worker ends + cleans up)', ended and 'time limit' in ended and wait_for(lambda: no_leftovers(s), 30), ended)
        await apage.close()

        # ================= 11. user-uploaded Windows .exe (manifest synthesized by the cloud) =================
        await boot('#/library')
        await page.click('.card-add')
        await page.set_input_files('[data-modal] input[type=file]', os.path.join(tg, 'pkg', 'gdi64', 'wintest64.exe'))
        await page.wait_for_url('**/#/game/u-wintest64')
        sessions_seen.clear()
        await page.click('button.btn-play')
        await page.wait_for_selector('#player .ovl-btn', state='visible', timeout=180000)
        sid3 = await current_sid()
        ut = await wait_title(sid3, lambda d: True, 40)
        check('uploaded Windows .exe runs in the cloud from the console', ut and ut.get('bits') == '64', title_of(session_status(sid3)))
        await page.click('#player .ovl-btn')
        await page.click('#player [data-p=exit]')
        wait_for(lambda: no_leftovers(sid3), 30)

        # ================= 12. PS3-class cloud runtime through the real worker with a MOCK RPCS3 =================
        # Everything except the emulator is real: upload (chunked, server-side inspection), scheduling, sandbox,
        # overlays, Xorg, stream, full-pad input, cloud save layer, restore on the next session.
        def make_sfo(entries):
            keys = list(entries); idx = b''; kt = b''; dt = b''
            for k in keys:
                v = entries[k].encode() + b'\0'; mx = (len(v) + 3) // 4 * 4
                idx += len(kt).to_bytes(2, 'little') + (0x0204).to_bytes(2, 'little') + len(v).to_bytes(4, 'little') + mx.to_bytes(4, 'little') + len(dt).to_bytes(4, 'little')
                kt += k.encode() + b'\0'; dt += v + b'\0' * (mx - len(v))
            kt += b'\0' * (-len(kt) % 4)
            hdr = b'\0PSF' + (0x101).to_bytes(4, 'little') + (20 + len(idx)).to_bytes(4, 'little') + (20 + len(idx) + len(kt)).to_bytes(4, 'little') + len(keys).to_bytes(4, 'little')
            return hdr + idx + kt + dt
        game_dir = f'{TMP}/ps3/SAFFRON_ORBIT'
        shutil.rmtree(f'{TMP}/ps3', ignore_errors=True)
        os.makedirs(f'{game_dir}/PS3_GAME/USRDIR')
        open(f'{game_dir}/PS3_GAME/PARAM.SFO', 'wb').write(make_sfo({'TITLE': 'Saffron Orbit', 'TITLE_ID': 'MSHR00001', 'CATEGORY': 'HG'}))
        open(f'{game_dir}/PS3_GAME/USRDIR/EBOOT.BIN', 'wb').write(b'\x7fELF' + bytes(4092))   # original test stub, not a game
        await boot('#/emulators')
        await page.wait_for_selector('.rt-row[data-rt="ps3-cloud"]')
        await page.wait_for_function("document.querySelector('.rt-row[data-rt=\"ps3-cloud\"]')?.dataset.state === 'mock-only'", timeout=20000)
        rows = await page.evaluate("[...document.querySelectorAll('.rt-row')].map(r => [r.dataset.rt, r.dataset.state, r.querySelector('.rt-live').textContent])")
        rs = {r[0]: r for r in rows}
        check('runtime status from live workers: Windows Ready, PS3/PS2 "Mock worker" (never Ready)', rs['windows-cloud'][1] == 'available' and rs['ps3-cloud'][1] == 'mock-only' and rs['ps2'][1] == 'mock-only', rows)
        await boot('#/upload')
        await page.set_input_files('input[data-dir]', game_dir)
        await page.wait_for_selector('.emu-card[data-runtime="ps3-cloud"]', timeout=15000)
        card_txt = await page.text_content('.emu-card')
        go = page.locator('.emu-card .btn-play')
        disabled_before = await go.is_disabled()
        check('PS3 game folder detected in the browser (PARAM.SFO) + upload needs explicit consent', 'MSHR00001' in card_txt and 'Saffron Orbit' in card_txt and disabled_before and 'mock' in card_txt.lower(), card_txt[:160])
        await page.check('[data-consent]')
        await go.click()
        await page.wait_for_url('**/#/game/c-saffron-orbit', timeout=60000)
        badges = ' | '.join(await page.locator('.badges .badge').all_text_contents())
        check('uploaded PS3 title in the universal library (runtime · platform · cloud · maturity)', 'Mishrin P3 Cloud · PS3-class' in badges and 'Cloud · uploaded by you' in badges and 'In development' in badges, badges)
        sessions_seen.clear()
        t_p3 = time.time()
        await page.click('button.btn-play')
        await page.wait_for_selector('#player .ovl-btn', state='visible', timeout=120000)
        p3_start = time.time() - t_p3
        sid4 = await current_sid()
        p3t = await wait_title(sid4, lambda d: d.get('id') == 'MSHR00001', 40)
        st4 = session_status(sid4)
        check('PS3 session runs the worker emulator profile in the sandbox (mock RPCS3)', p3t and title_of(st4).startswith('MOCK-P3') and 'rpcs3' in ((st4.get('live') or {}).get('graphics') or ''), f"{title_of(st4)} · {(st4.get('live') or {}).get('graphics')} · Play → first frame {p3_start:.1f}s")
        check('PS3 stream reaches the browser', await frame_has_saffron())
        await page.evaluate("window.__padOn = true; dispatchEvent(new Event('gamepadconnected'))")
        await page.wait_for_timeout(300)
        await pad_tap(15); await pad_tap(0); await pad_tap(5)   # D-pad right, cross, R1
        f1 = await wait_title(sid4, lambda d: int(d['x']) == int(p3t['x']) + 20 and int(d['score']) == int(p3t['score']) + 1 and d.get('pad') == 'r1', 10) if p3t else None
        check('full controller over the data channel (D-pad, cross, R1 → emulator pad bindings)', f1, f1 or title_of(session_status(sid4)))
        await page.evaluate('window.__padOn = false')
        await page.keyboard.press('ArrowDown')
        f2 = await wait_title(sid4, lambda d: int(d['y']) == int(p3t['y']) + 20, 10) if p3t else None
        check('keyboard reaches the emulator', f2, f2)
        await page.evaluate("window.__padOn = true; dispatchEvent(new Event('gamepadconnected'))"); await page.wait_for_timeout(200)
        await pad_tap(3); await page.evaluate('window.__padOn = false')   # triangle = in-game save
        saved4 = await wait_title(sid4, lambda d: d.get('pad') == 'triangle', 10)
        await page.wait_for_timeout(500)
        await page.click('#player .ovl-btn')
        await page.click('#player [data-p=exit]')
        gone4 = wait_for(lambda: api('GET', f'/api/session/{sid4}')[0] == 404 and no_leftovers(sid4), 40)
        check('PS3 session destroyed on exit (sandbox, mounts, cgroups)', gone4)
        await page.wait_for_timeout(1500)
        sessions_seen.clear()
        await page.click('button.btn-play')
        await page.wait_for_selector('#player .ovl-btn', state='visible', timeout=120000)
        sid5 = await current_sid()
        r5 = await wait_title(sid5, lambda d: d.get('id') == 'MSHR00001', 40)
        check('PS3 save data persisted in the cloud and restored next session', saved4 and r5 and r5.get('loaded') == '1' and r5['x'] == saved4['x'] and r5['y'] == saved4['y'] and r5['score'] == saved4['score'], f'saved {saved4} → next session {r5}')
        await page.click('#player .ovl-btn')
        await page.click('#player [data-p=exit]')
        wait_for(lambda: no_leftovers(sid5), 40)

        # PS2-class through the same pipeline (mock PCSX2): DVD ISO → server-side inspection → session
        await boot('#/upload')
        await page.set_input_files('input[data-files]', os.path.join(ROOT, 'emulators', 'p1', 'testgame', 'fixtures', 'p2-layout.iso'))
        await page.wait_for_selector('.emu-card[data-runtime="ps2"]', timeout=15000)
        await page.check('[data-consent]')
        await page.click('.emu-card .btn-play')
        await page.wait_for_url('**/#/game/c-*', timeout=60000)
        sessions_seen.clear()
        await page.click('button.btn-play')
        await page.wait_for_selector('#player .ovl-btn', state='visible', timeout=120000)
        sid6 = await current_sid()
        p2t = await wait_title(sid6, lambda d: True, 40)
        check('PS2-class ISO → cloud inspection → mock PCSX2 session', p2t and title_of(session_status(sid6)).startswith('MOCK-P2'), title_of(session_status(sid6)))
        await page.click('#player .ovl-btn')
        await page.click('#player [data-p=exit]')
        wait_for(lambda: no_leftovers(sid6), 40)

        cache = {w['name']: w.get('cacheStats') for w in workers()}
        check('worker cache reuse across sessions (layers + chunks)', any((c or {}).get('layers_reused', 0) > 0 for c in cache.values()), cache)
        check('no uncaught console errors', not errors, errors[:3])
        await browser.close()


try:
    asyncio.run(main())
except Exception as e:
    import traceback
    traceback.print_exc()
    check('e2e harness', False, e)
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
print(f'\n{len(results) - len(failed)}/{len(results)} Windows end-to-end checks passed')
sys.exit(1 if failed else 0)
