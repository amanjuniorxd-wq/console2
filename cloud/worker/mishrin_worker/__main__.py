"""Mishrin GPU Game Worker.

    sudo /usr/bin/python3.12 -m mishrin_worker --scheduler http://SCHEDULER:8787 --token $WORKER_TOKEN

Registers with the scheduler, long-polls for allocations, runs each session in its own sandbox, heartbeats every
few seconds, and cleans up anything it does not own (including leftovers from a previous crash of the worker).
"""
import argparse
import glob
import json
import os
import platform
import shutil
import signal
import subprocess
import sys
import threading
import time
import traceback
import urllib.error
import urllib.request
from dataclasses import dataclass

from .layers import Layers
from .profiles import load_profiles, ready_runtimes
from .sandbox import CG_ROOT, Cgroup
from .session import Session
from .store import Store

VERSION = '1.0.0'


@dataclass
class Config:
    scheduler: str
    token: str
    name: str
    data: str = '/var/lib/mishrin'
    capacity: int = 2
    game_uid: int = 20000
    display_base: int = 100
    dxvk_dir: str = '/opt/mishrin/layers/dxvk-2.6.1'
    emulators_dir: str = '/opt/mishrin/emulators'
    allow_test_firmware: bool = False
    self_test: bool = True
    vkd3d_dir: str = '/opt/mishrin/layers/vkd3d-proton-2.14.1'
    cache_gb: float = 200
    window_timeout: float = 90
    hang_timeout: float = 20
    autosave_s: float = 60
    reconnect_grace: float = 60
    heartbeat_s: float = 5

    @property
    def cg_name(self):
        import re
        return 'w-' + re.sub(r'[^A-Za-z0-9_-]', '_', self.name)[:48]

    @property
    def xauth_global(self):
        return os.path.join(self.data, 'xauthority')


class SchedulerClient:
    def __init__(self, cfg, worker):
        self.cfg, self.w = cfg, worker
        self.id = None

    def _req(self, method, path, body=None, timeout=30, raw=False):
        data = None
        headers = {'authorization': f'Bearer {self.cfg.token}'}
        if body is not None and not isinstance(body, (bytes, bytearray)):
            data, headers['content-type'] = json.dumps(body).encode(), 'application/json'
        elif body is not None:
            data, headers['content-type'] = bytes(body), 'application/octet-stream'
        r = urllib.request.Request(self.cfg.scheduler.rstrip('/') + path, data=data, method=method, headers=headers)
        with urllib.request.urlopen(r, timeout=timeout) as resp:
            out = resp.read()
            if raw:
                return out
            return json.loads(out) if out else None

    def register(self):
        self.id = self._req('POST', '/worker/register', self.w.capabilities())['id']
        self.w.log(f'registered as {self.id[:8]}')

    def fetch_chunk(self, sha):
        return self._req('GET', f'/v1/packages/{sha}', raw=True, timeout=120)

    def store_save(self, sid, blob, raw, files, kind):
        import hashlib
        sha = hashlib.sha256(blob).hexdigest()
        try:
            self._req('HEAD', f'/v1/packages/{sha}')
        except urllib.error.HTTPError:
            self._req('PUT', f'/v1/packages/{sha}', blob, timeout=120)
        return self._req('POST', '/worker/save', {'worker': self.id, 'sessionId': sid, 'ref': sha, 'size': len(blob), 'raw': raw, 'files': files, 'kind': kind})

    def fetch_save(self, ref, sid):
        return self._req('GET', f'/worker/saves/{ref}?session={sid}&worker={self.id}', raw=True, timeout=120)


class Worker:
    def __init__(self, cfg):
        self.cfg = cfg
        os.makedirs(cfg.data, exist_ok=True)
        os.chmod(cfg.data, 0o711)
        os.makedirs(os.path.join(cfg.data, 'sessions'), exist_ok=True)
        os.chmod(os.path.join(cfg.data, 'sessions'), 0o711)
        open(cfg.xauth_global, 'a').close()
        os.chmod(cfg.xauth_global, 0o600)
        os.environ['XAUTHORITY'] = cfg.xauth_global
        self.sched = SchedulerClient(cfg, self)
        self.store = Store(cfg.data, self.sched.fetch_chunk, int(cfg.cache_gb * 1024 ** 3), owner_uid=cfg.game_uid)
        self.layers = Layers(cfg.data, cfg.game_uid, cfg.dxvk_dir, cfg.vkd3d_dir)
        self.profiles = load_profiles(self, cfg.emulators_dir)
        self.sessions = {}
        self.lock = threading.Lock()
        self.stopping = threading.Event()

    def log(self, m):
        print(f'{time.strftime("%H:%M:%S")} [worker {self.cfg.name}] {m}', flush=True)

    # ---------- capabilities (used by the scheduler's MPC worker selection) ----------
    def capabilities(self):
        from .stream import ENCODERS, usable_encoders
        enc = usable_encoders()
        vk = {'available': False, 'hardware': False, 'device': None}
        try:
            out = subprocess.run(['vulkaninfo', '--summary'], capture_output=True, text=True, timeout=20).stdout
            names = [l.split('=', 1)[1].strip() for l in out.splitlines() if 'deviceName' in l]
            types = [l.split('=', 1)[1].strip() for l in out.splitlines() if 'deviceType' in l]
            if names:
                vk = {'available': True, 'device': names[0],
                      'hardware': any(t in ('PHYSICAL_DEVICE_TYPE_DISCRETE_GPU', 'PHYSICAL_DEVICE_TYPE_INTEGRATED_GPU') for t in types)}
        except Exception:
            pass
        mem = int(open('/proc/meminfo').read().split()[1]) // 1024
        emus = [p.info() for p in self.profiles if p.kind == 'emulator']
        # OpenGL: a Mesa/vendor GL driver is installed (sessions render on their own Xorg/Xvfb display with it)
        gl = bool(glob.glob('/usr/lib/x86_64-linux-gnu/dri/*_dri.so') or glob.glob('/usr/lib/x86_64-linux-gnu/libGLX_*.so.0')) and bool(glob.glob('/usr/lib/*/libGL.so.1'))
        runs = lambda n: any(e['name'] == n and not e['mock'] and e['installed'] for e in emus)
        flags = {'cpu': True, 'gpu': vk['available'], 'hardwareGpu': vk['hardware'], 'vulkan': vk['available'], 'opengl': bool(gl),
                 'pcsx2': runs('pcsx2'), 'rpcs3': runs('rpcs3'), 'wine': any(p.kind == 'windows' and p.available() for p in self.profiles),
                 'mockRuntimes': sorted({e['runtime'] for e in emus if e['mock']})}
        return {
            'flags': flags,
            'name': self.cfg.name, 'version': VERSION, 'runtimes': ready_runtimes(self.profiles, self.cfg.allow_test_firmware), 'capacity': self.cfg.capacity,
            'emulators': emus,
            'resources': {'ramMB': mem, 'cpus': os.cpu_count(), 'gpu': vk, 'renderNodes': len(glob.glob('/dev/dri/renderD*'))},
            'encoders': enc, 'hardwareEncoders': [e for e in enc if ENCODERS[e][1]],
            'codecs': sorted({ENCODERS[e][0] for e in enc}),
            'layers': self.layers.info(), 'cache': {'games': self.store.cached_layers()},
            'isolation': {'bwrap': bool(shutil.which('bwrap')), 'cgroups': Cgroup.available(), 'network': 'none'},
            'host': platform.platform(),
        }

    # ---------- startup hygiene ----------
    def reclaim_leftovers(self):
        """After a worker crash: unmount, kill and delete every stale session before accepting work."""
        base = os.path.join(self.cfg.data, 'sessions')
        mounts = [l.split()[1] for l in open('/proc/mounts') if l.split()[1].startswith(base + '/')]
        for m in sorted(mounts, key=len, reverse=True):
            subprocess.run(['umount', '-l', m], capture_output=True)
        for d in glob.glob(os.path.join(base, '*')):
            shutil.rmtree(d, ignore_errors=True)
        mine = os.path.join('mishrin', self.cfg.cg_name, 'session-*')
        stale = {}
        for p in glob.glob(os.path.join(CG_ROOT, '*', mine)) + glob.glob(os.path.join(CG_ROOT, mine)):
            stale.setdefault(os.path.basename(p), []).append(p)
        for name, paths in stale.items():  # kill leftover game processes, then remove the groups
            cg = Cgroup(name)
            cg.paths = {f'c{i}': p for i, p in enumerate(paths)}
            cg.destroy()
        # display/audio servers of sessions that died with a previous worker process
        sess_dir = os.path.join(self.cfg.data, 'sessions') + '/'
        for pid in [d for d in os.listdir('/proc') if d.isdigit()]:
            try:
                cmd = open(f'/proc/{pid}/cmdline', 'rb').read().decode(errors='replace')
            except OSError:
                continue
            if sess_dir in cmd and ('Xorg' in cmd or 'Xvfb' in cmd or 'pulseaudio' in cmd):
                try:
                    os.kill(int(pid), signal.SIGKILL)
                except OSError:
                    pass
        for b in glob.glob(os.path.join(self.cfg.data, 'games', '*.build-*')):
            shutil.rmtree(b, ignore_errors=True)
        if mounts:
            self.log(f'reclaimed {len(mounts)} stale mounts')

    def free_display(self):
        used = {s.display for s in self.sessions.values()}
        for n in range(self.cfg.display_base, self.cfg.display_base + 64):
            if n not in used and not os.path.exists(f'/tmp/.X11-unix/X{n}'):
                return n
        raise RuntimeError('no free display')

    # ---------- allocation handling ----------
    def handle(self, msg):
        t = msg.get('type')
        sid = msg.get('id')
        if t == 'session':
            threading.Thread(target=self._start_session, args=(msg,), daemon=True).start()
        elif t == 'reconnect':
            s = self.sessions.get(sid)
            threading.Thread(target=self._answer_reconnect, args=(s, msg), daemon=True).start()
        elif t == 'end':
            s = self.sessions.get(sid)
            if s:
                threading.Thread(target=s.end, args=(msg.get('reason') or 'Session closed.', False), daemon=True).start()
        elif t == 'save':
            s = self.sessions.get(sid)
            threading.Thread(target=self._http_save, args=(s, msg), daemon=True).start()
        elif t == 'input':
            s = self.sessions.get(sid)
            if s:
                s.inject_http(msg.get('events') or [])

    def _start_session(self, msg):
        sid = msg['id']
        s = None
        try:
            with self.lock:
                if len(self.sessions) >= self.cfg.capacity:
                    raise RuntimeError('worker at capacity')
                s = Session(self, msg, self.free_display())
                self.sessions[sid] = s
            answer = s.start()
            self.sched._req('POST', '/worker/answer', {'worker': self.sched.id, 'id': sid, 'sdp': answer, 'status': s.status()})
        except Exception as e:
            self.log(f'session {sid[:8]} failed: {e}')
            traceback.print_exc()
            try:
                self.sched._req('POST', '/worker/answer', {'worker': self.sched.id, 'id': sid, 'error': str(e)[:300]})
            except Exception:
                pass
            if s:
                s.end(f'Start failed: {e}', notify_scheduler=False)

    def _answer_reconnect(self, s, msg):
        try:
            if not s:
                raise RuntimeError('unknown session')
            sdp = s.reconnect(msg['offer'])
            self.sched._req('POST', '/worker/answer', {'worker': self.sched.id, 'id': msg['id'], 'sdp': sdp, 'reconnect': True})
        except Exception as e:
            self.sched._req('POST', '/worker/answer', {'worker': self.sched.id, 'id': msg['id'], 'error': str(e)[:300], 'reconnect': True})

    def _http_save(self, s, msg):
        try:
            if not s:
                raise RuntimeError('unknown session')
            ref = s.save('manual')
            self.sched._req('POST', '/worker/save-result', {'worker': self.sched.id, 'req': msg.get('req'), 'ok': True, **ref})
        except Exception as e:
            self.sched._req('POST', '/worker/save-result', {'worker': self.sched.id, 'req': msg.get('req'), 'ok': False, 'error': str(e)[:200]})

    def session_ended(self, s, notify):
        with self.lock:
            self.sessions.pop(s.id, None)
        if notify:
            try:
                self.sched._req('POST', '/worker/release', {'worker': self.sched.id, 'sessionId': s.id, 'reason': s.end_reason})
            except Exception:
                pass
        threading.Thread(target=self.store.evict, daemon=True).start()

    # ---------- loops ----------
    def heartbeat_loop(self):
        while not self.stopping.wait(self.cfg.heartbeat_s):
            try:
                st = [s.status() for s in list(self.sessions.values())]
                load = os.getloadavg()[0] / (os.cpu_count() or 1)
                r = self.sched._req('POST', '/worker/heartbeat', {'worker': self.sched.id, 'sessions': st, 'load': round(load, 2),
                                                                   'emulators': [p.info() for p in self.profiles if p.kind == 'emulator'],
                                                                   'runtimes': ready_runtimes(self.profiles, self.cfg.allow_test_firmware),
                                                                   'cache': {'games': self.store.cached_layers(), 'stats': self.store.stats}})
                for sid in (r or {}).get('unknown', []):  # scheduler no longer tracks it: clean up
                    s = self.sessions.get(sid)
                    if s:
                        threading.Thread(target=s.end, args=('Session no longer allocated.', False), daemon=True).start()
            except urllib.error.HTTPError as e:
                if e.code in (401, 404):
                    self.log('scheduler forgot this worker; re-registering')
                    try:
                        self.sched.register()
                    except Exception:
                        pass
            except Exception as e:
                self.log(f'heartbeat failed: {e}')

    def run_self_tests(self):
        from . import selftest
        for p in self.profiles:
            if p.kind == 'emulator' and p.spec.get('selfTest'):
                p.self_test = selftest.run(self, p, self.free_display())
                self.log(f"self-test {p.name}: {'PASS' if p.self_test['ok'] else 'FAIL'} — {p.self_test.get('detail')}"
                         f"{' · first frame ' + str(p.self_test['firstFrameMs']) + ' ms' if p.self_test.get('firstFrameMs') else ''}")

    def run(self):
        self.reclaim_leftovers()
        self.layers.ensure(self.log)
        if self.cfg.self_test:
            self.run_self_tests()
        while not self.stopping.is_set():
            try:
                self.sched.register()
                break
            except Exception as e:
                self.log(f'register failed: {e}; retrying')
                time.sleep(2)
        threading.Thread(target=self.heartbeat_loop, daemon=True).start()
        while not self.stopping.is_set():
            try:
                msg = self.sched._req('POST', '/worker/allocate', {'worker': self.sched.id}, timeout=40)
                if msg:
                    self.handle(msg)
            except urllib.error.HTTPError as e:
                if e.code in (401, 404):
                    time.sleep(1)
                    try:
                        self.sched.register()
                    except Exception:
                        pass
                elif e.code != 204:
                    time.sleep(1)
            except Exception:
                time.sleep(1)

    def shutdown(self, *_):
        if self.stopping.is_set():
            return
        self.stopping.set()
        self.log('shutting down: ending sessions')
        for s in list(self.sessions.values()):
            s.end('Cloud node is shutting down.')
        try:
            self.sched._req('POST', '/worker/release', {'worker': self.sched.id, 'bye': True}, timeout=5)
        except Exception:
            pass


def main():
    ap = argparse.ArgumentParser(prog='mishrin_worker')
    ap.add_argument('--scheduler', default=os.environ.get('MISHRIN_SCHEDULER', 'http://127.0.0.1:8787'))
    ap.add_argument('--token', default=os.environ.get('MISHRIN_WORKER_TOKEN', ''))
    ap.add_argument('--name', default=os.environ.get('MISHRIN_WORKER_NAME', platform.node()))
    ap.add_argument('--data', default=os.environ.get('MISHRIN_DATA', '/var/lib/mishrin'))
    ap.add_argument('--capacity', type=int, default=int(os.environ.get('MISHRIN_CAPACITY', '2')))
    ap.add_argument('--display-base', type=int, default=int(os.environ.get('MISHRIN_DISPLAY_BASE', '100')))
    ap.add_argument('--game-uid', type=int, default=int(os.environ.get('MISHRIN_GAME_UID', '20000')))
    ap.add_argument('--hang-timeout', type=float, default=float(os.environ.get('MISHRIN_HANG_TIMEOUT', '20')))
    ap.add_argument('--autosave', type=float, default=float(os.environ.get('MISHRIN_AUTOSAVE_S', '60')))
    ap.add_argument('--emulators', default=os.environ.get('MISHRIN_EMULATORS', '/opt/mishrin/emulators'),
                    help='directory of emulator profiles (one emulator.json per subdirectory)')
    ap.add_argument('--allow-test-firmware', action='store_true', default=os.environ.get('MISHRIN_ALLOW_TEST_FIRMWARE') == '1',
                    help='test mode: accept Mishrin test ROMs / HLE test programs in place of user firmware (sessions only run test programs)')
    ap.add_argument('--skip-self-test', action='store_true', help='do not boot each emulator once at startup')
    ap.add_argument('--reconnect-grace', type=float, default=float(os.environ.get('MISHRIN_RECONNECT_GRACE', '60')))
    a = ap.parse_args()
    if os.geteuid() != 0:
        sys.exit('mishrin_worker must run as root (it creates mounts, cgroups and drops each game to an unprivileged uid)')
    cfg = Config(scheduler=a.scheduler, token=a.token, name=a.name, data=a.data, capacity=a.capacity, display_base=a.display_base,
                 game_uid=a.game_uid, hang_timeout=a.hang_timeout, autosave_s=a.autosave, reconnect_grace=a.reconnect_grace,
                 emulators_dir=a.emulators, allow_test_firmware=a.allow_test_firmware, self_test=not a.skip_self_test)
    w = Worker(cfg)
    signal.signal(signal.SIGTERM, lambda *_: (w.shutdown(), sys.exit(0)))
    signal.signal(signal.SIGINT, lambda *_: (w.shutdown(), sys.exit(0)))
    w.run()


if __name__ == '__main__':
    main()
