"""One game session: prepare layers → sandbox → display/audio → game process (Wine or an emulator profile) → stream,
with watchdog, saves and cleanup."""
import base64
import json
import os
import threading
import time
import traceback

from . import savelayer
from .manifest import manifest_hash, validate
from .profiles import profile_for
from .sandbox import Sandbox

STATES = ('preparing', 'launching', 'streaming', 'disconnected', 'restarting', 'ending', 'ended')


class Session:
    def __init__(self, worker, msg, display_num):
        self.w = worker
        self.id = msg['id']
        self.manifest = validate(msg['manifest'], allow_network=False)  # defence in depth: re-validate on the worker
        if manifest_hash(self.manifest) != msg.get('manifestHash', manifest_hash(self.manifest)):
            raise ValueError('manifest hash mismatch')
        self.profile = profile_for(worker.profiles, self.manifest)  # Windows/Wine or an emulator (RPCS3, PCSX2, …)
        self.req = self.manifest['requirements']
        disp = self.manifest['display']
        self.screen = (int(disp.get('width', 1280)) // 2 * 2, int(disp.get('height', 720)) // 2 * 2)
        if not (320 <= self.screen[0] <= 3840 and 240 <= self.screen[1] <= 2160):
            raise ValueError('display size out of range')
        self.offer, self.prefs, self.ice = msg['offer'], msg.get('prefs') or {}, msg.get('iceServers') or []
        self.restore_ref = msg.get('restore')
        self.display = display_num
        self.sb = Sandbox(worker.cfg, self.id, display_num, self.req)
        self.state = 'preparing'
        self.started = time.time()
        self.restarts = 0
        self.max_restarts = 2
        self.stream = None
        self.inj = None
        self.pulse = None
        self.layer_hash = None
        self.ended = threading.Event()
        self.lock = threading.RLock()
        self.disconnected_at = None
        self.last_save_mtime = 0.0
        self.last_autosave = time.time()
        self.end_reason = None
        self.events = []
        self.paused = False

    def log(self, m):
        self.events.append((round(time.time() - self.started, 2), m))
        self.events = self.events[-40:]
        self.w.log(f'[{self.id[:8]}] {m}')

    # ------------------------------------------------------------------ start
    def start(self):
        """Blocking: returns the SDP answer once the game window is up and the stream is negotiated."""
        cfg = self.w.cfg
        t0 = time.time()
        self.layer_hash, layer = self.w.store.acquire_layer(self.manifest)
        self.log(f'game layer ready ({"reused" if self.w.store.stats["layers_reused"] else "built"}) in {time.time() - t0:.2f}s')
        ms = lambda a, b=None: round(((b or time.time()) - a) * 1000)
        self.timings = {'layerMs': ms(t0)}
        prefix = self.profile.runtime_layer(self.log)
        self.sb.prepare_storage()
        if self.restore_ref:
            blob = self.w.sched.fetch_save(self.restore_ref, self.id)
            n = savelayer.restore(blob, self.sb.dir, cfg.game_uid)
            self.log(f'restored save layer ({n} files)')
        self.sb.mount_layers(prefix, layer, self.profile.game_mount)
        self.state = 'launching'
        self.sb.start_display(*self.screen)
        # MISHRIN_AUDIO=silence: diagnostic/headless mode — stream generated silence instead of the game's audio
        self.pulse = None if os.environ.get('MISHRIN_AUDIO') == 'silence' else self.sb.start_audio()
        from .inputx import Injector
        self.inj = Injector(self.display, self.manifest['controllerMap'])
        self.timings['sandboxMs'] = ms(t0) - self.timings['layerMs']
        self._launch_game()
        self._wait_window(cfg.window_timeout)
        self.timings['emulatorWindowMs'] = ms(self.game_started)     # process start → first mapped window
        t_s = time.time()
        self.last_save_mtime = savelayer.newest_mtime(self.sb.dir, self.profile.save_include)
        self.stream = self._new_stream(self.offer)
        self.state = 'streaming'
        self.timings['streamSetupMs'] = ms(t_s)
        self.timings['totalMs'] = ms(t0)
        threading.Thread(target=self._watchdog, name=f'watchdog-{self.id[:8]}', daemon=True).start()
        self.log(f'streaming {self.stream.codec} via {self.stream.encoder} ({"hardware" if self.stream.hw else "software"}) in {time.time() - self.started:.1f}s')
        return self.stream.answer

    def _launch_game(self):
        # argv only — the executable/boot file comes from the validated manifest and the worker's own profile, never from the browser.
        argv, env, wd = self.profile.launch_spec(self)
        if self.pulse:
            env['PULSE_SERVER'] = 'unix:/tmp/pulse/native'
        self.game = self.sb.launch(argv, env, wd, self.pulse, extra_ro=self.profile.extra_ro)
        self.game_started = time.time()
        what = self.manifest.get('executable') or f'{self.profile.name} {self.manifest["boot"]}'
        self.log(f'launched {what} ({self.profile.kind})')

    def _wait_window(self, timeout):
        deadline = time.time() + timeout
        while time.time() < deadline:
            if self.inj.windows():
                return
            if self.game.poll() is not None:
                raise RuntimeError(f'game exited during startup (code {self.game.returncode})')
            time.sleep(0.25)
        raise RuntimeError('game window did not appear in time')

    def _new_stream(self, offer):
        from .stream import Stream
        st = Stream(self.display, self.screen, offer, self.prefs, self.ice, self.pulse,
                    on_input=self._on_input, on_ctl=self._on_ctl, on_state=self._on_conn_state, log=self.log)
        st.send_ctl(json.dumps({'t': 'caps', 'save': True, 'kind': 'save-data', 'pad': self.profile.pad}))  # queued until the channel opens
        return st

    # ------------------------------------------------------------------ input / control
    def _on_input(self, data):
        if self.inj and not self.paused:
            try:
                self.inj.handle(data)
            except Exception as e:  # never let a malformed message kill the stream
                self.log(f'input dropped: {e}')

    def inject_http(self, events):
        """HTTP fallback path (/api/session/:id/input): same vocabulary as the data channel."""
        n = 0
        for ev in events[:256]:
            if isinstance(ev, str):
                self._on_input(ev[:64])
            elif isinstance(ev, list) and all(isinstance(x, int) and 0 <= x < 256 for x in ev[:6]):
                self._on_input(bytes(ev[:6]))
            else:
                continue
            n += 1
        return n

    def _send(self, obj):
        if self.stream:
            self.stream.send_ctl(json.dumps(obj))

    def _on_ctl(self, text):
        try:
            m = json.loads(text)
        except ValueError:
            return
        t = m.get('t')
        if t == 'quality':
            self.stream.set_quality(m.get('height'), m.get('fps'), m.get('kbps'))
        elif t == 'pause':
            self.set_paused(bool(m.get('on')))
        elif t == 'save':
            threading.Thread(target=self._ctl_save, args=(m.get('id'),), daemon=True).start()
        elif t == 'load':
            threading.Thread(target=self._ctl_load, args=(m.get('id'), m.get('data')), daemon=True).start()

    def set_paused(self, on):
        """Pause = freeze the whole sandbox cgroup (CPU drops to zero); the stream keeps showing the last frame."""
        with self.lock:
            if on != self.paused:
                self.paused = on
                if self.inj:
                    self.inj.release_all()
                self.sb.cg.freeze(on)

    def _ctl_save(self, req_id):
        try:
            ref = self.save('manual')
            data = base64.b64encode(json.dumps(ref).encode()).decode()
            self._send({'t': 'saved', 'id': req_id, 'data': data})
        except Exception as e:
            self.log(f'save failed: {e}')
            self._send({'t': 'saved', 'id': req_id})

    def _ctl_load(self, req_id, data):
        try:
            ref = json.loads(base64.b64decode(data or '').decode())
            ok = self.load(ref['ref'])
        except Exception as e:
            self.log(f'load failed: {e}')
            ok = False
        self._send({'t': 'loaded', 'id': req_id, 'ok': ok})

    # ------------------------------------------------------------------ saves
    def save(self, kind):
        with self.lock:
            was = self.paused
            if not was:
                self.sb.cg.freeze(True)  # consistent snapshot: no writes while copying
            try:
                blob, raw, files = savelayer.snapshot(self.sb.dir, self.profile.save_include, self.profile.save_exclude)
            finally:
                if not was:
                    self.sb.cg.freeze(False)
        ref = self.w.sched.store_save(self.id, blob, raw, files, kind)
        self.last_save_mtime = savelayer.newest_mtime(self.sb.dir, self.profile.save_include)
        self.last_autosave = time.time()
        self.log(f'{kind} save {ref["ref"][:12]} {len(blob)} B (raw {raw} B, {files} files)')
        return ref

    def load(self, ref):
        """Restart the game from a save layer that belongs to this session's player and game (checked by scheduler)."""
        blob = self.w.sched.fetch_save(ref, self.id)
        with self.lock:
            self.state = 'restarting'
            self.inj.release_all()
            self.sb.stop_game()
            self.sb.unmount_layers()
            self.sb.reset_uppers()
            savelayer.restore(blob, self.sb.dir, self.w.cfg.game_uid)
            self.sb.mount_layers(self.profile.current_layer(), self.w.store.layer_path(self.layer_hash), self.profile.game_mount)
            self._launch_game()
            self._wait_window(self.w.cfg.window_timeout)
            self.state = 'streaming'
        self.log(f'loaded save {ref[:12]}')
        return True

    # ------------------------------------------------------------------ reconnect
    def reconnect(self, offer):
        with self.lock:
            old = self.stream
            self.stream = self._new_stream(offer)
            if old:
                old.close()
            self.disconnected_at = None
            self.state = 'streaming'
        self.log('client reconnected')
        return self.stream.answer

    def _on_conn_state(self, st):
        if st in ('failed', 'disconnected', 'closed') and self.state == 'streaming':
            self.disconnected_at = time.time()
            self.state = 'disconnected'
            self.log(f'peer {st}; waiting for reconnect')
        elif st == 'connected' and self.state == 'disconnected':
            self.disconnected_at = None
            self.state = 'streaming'

    # ------------------------------------------------------------------ watchdog
    def _watchdog(self):
        cfg = self.w.cfg
        missing_since = None
        while not self.ended.wait(1.0):
            try:
                now = time.time()
                if now - self.started > self.req['maxMinutes'] * 60:
                    return self.end('Session time limit reached.')
                if self.state == 'disconnected' and self.disconnected_at and now - self.disconnected_at > cfg.reconnect_grace:
                    return self.end('Player disconnected.')
                if self.state not in ('streaming', 'disconnected') or self.paused:
                    continue
                code = self.game.poll()
                wins = self.inj.windows() if code is None else []
                if code is None and not wins:  # alive but no window: hung or crashed into a dialog-less state
                    missing_since = missing_since or now
                if code is None and wins:
                    missing_since = None
                hung = missing_since and now - missing_since > cfg.hang_timeout
                if code is not None or hung:
                    crashed = hung or code != 0 or self.sb.cg.oom_killed()
                    if not crashed:
                        return self.end('Game exited.')
                    why = 'stopped responding' if hung else 'out of memory' if self.sb.cg.oom_killed() else f'crashed (code {code})'
                    if self.restarts >= self.max_restarts:
                        return self.end(f'Game {why} repeatedly.')
                    self.restarts += 1
                    self._keep_crash_log(why)
                    self.log(f'game {why}; restarting ({self.restarts}/{self.max_restarts})')
                    self._send({'t': 'notice', 'text': 'Game stopped unexpectedly — restarting.'})
                    with self.lock:
                        self.state = 'restarting'
                        self.sb.stop_game()
                        self._launch_game()
                        self._wait_window(cfg.window_timeout)
                        self.state = 'streaming'
                        missing_since = None
                    continue
                # periodic autosave (only if save data changed) keeps reassignment loss small
                if now - self.last_autosave > cfg.autosave_s and savelayer.newest_mtime(self.sb.dir, self.profile.save_include) > self.last_save_mtime:
                    self.save('auto')
            except Exception as e:
                self.log(f'watchdog error: {e}\n{traceback.format_exc()}')
                return self.end(f'Session error: {e}')

    def _keep_crash_log(self, why):
        """Keep the last 64 KB of the game's log outside the (about to be destroyed) session for diagnosis."""
        try:
            src = os.path.join(self.sb.dir, 'game.log')
            d = os.path.join(self.w.cfg.data, 'crash-logs')
            os.makedirs(d, exist_ok=True)
            with open(src, 'rb') as f:
                f.seek(max(0, os.path.getsize(src) - 65536))
                tail = f.read()
            with open(os.path.join(d, f'{self.id}-{self.restarts}.log'), 'wb') as f:
                f.write(f'{why}\n'.encode() + tail)
        except OSError:
            pass

    # ------------------------------------------------------------------ end
    def end(self, reason='Session ended.', notify_scheduler=True):
        with self.lock:
            if self.ended.is_set():
                return
            self.ended.set()
            self.state = 'ending'
            self.end_reason = reason
        self.log(f'ending: {reason}')
        try:
            self._send({'t': 'end', 'reason': reason})
            time.sleep(0.2)
        except Exception:
            pass
        try:  # keep progress: final save if anything changed since the last one
            if self.sb.mounts and self.paused:
                self.sb.cg.freeze(False)
                self.paused = False
            stop = getattr(self.profile, 'graceful_stop', None)
            if stop:
                stop(self)   # emulators that flush save data only on close (PCSX2 memory cards)
            if os.path.isdir(self.sb.dir) and savelayer.newest_mtime(self.sb.dir, self.profile.save_include) > self.last_save_mtime:
                self.sb.stop_game()
                self.save('auto')
        except Exception as e:
            self.log(f'final save skipped: {e}')
        for closer in (lambda: self.stream and self.stream.close(), lambda: self.inj and self.inj.close(), self.sb.destroy):
            try:
                closer()
            except Exception as e:
                self.log(f'cleanup: {e}')
        if self.layer_hash:
            self.w.store.release(self.layer_hash)
        self.state = 'ended'
        self.w.session_ended(self, notify_scheduler)

    def graphics_backend(self):
        """Which translation layer the running game actually loaded (from its log), e.g. 'DXVK 2.6.1 on llvmpipe'."""
        if self.profile.kind == 'emulator':
            i = self.profile.info()
            return f"{i['name']} {i['version']}{' (mock)' if i['mock'] else ''}".strip()
        if getattr(self, '_gfx', None):
            return self._gfx
        try:
            with open(os.path.join(self.sb.dir, 'game.log'), 'rb') as f:
                head = f.read(65536).decode('utf-8', 'replace')
        except OSError:
            return None
        import re
        dx = re.search(r'info:\s+DXVK: (v[\d.]+)', head)
        vk = re.search(r'info:\s+vkd3d-proton - applying workarounds|vkd3d-proton.*?(v?[\d.]+)', head)
        dev = re.search(r'info:\s+Device\s*:\s*([^\n]+)', head)
        label = None
        if dx:
            label = f'DXVK {dx.group(1)}' + (f' on {dev.group(1).strip()}' if dev else '')
        elif vk:
            label = 'VKD3D-Proton'
        if label and (dev or vk):  # cache only once the device line has been logged
            self._gfx = label
        return label

    def status(self):
        s = {'id': self.id, 'game': self.manifest['id'], 'state': self.state, 'uptime': round(time.time() - self.started, 1),
             'restarts': self.restarts, 'paused': self.paused, 'display': f'{self.screen[0]}x{self.screen[1]}',
             'timings': getattr(self, 'timings', None)}
        if self.inj and self.state in ('streaming', 'disconnected'):
            s['windows'] = [t[:160] for t in self.inj.windows()[:3]]
            s['inputEvents'] = self.inj.events
        if self.stream:
            s['stream'] = self.stream.stats()
        g = self.graphics_backend()
        if g:
            s['graphics'] = g
        peak = self.sb.cg.memory_peak_mb()
        if peak is not None:
            s['memoryPeakMB'] = peak
        return s
