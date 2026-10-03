"""Per-session isolation.

Layout of one session (all under <data>/sessions/<sid>, a size-limited tmpfs = storage limit):
    prefix-upper/  prefix-work/   ← writable layer over the shared, read-only Wine runtime layer
    game-upper/    game-work/     ← writable layer over the shared, read-only game layer
    prefix/                        ← merged view, the only filesystem the game sees as its Wine prefix
    x11/ pulse/ xauth              ← this session's display/audio sockets and X cookie

The game runs as an unprivileged uid inside bubblewrap: new user/pid/net/ipc/uts/cgroup namespaces, no host
filesystem except read-only /usr, no network (not even the host's loopback), no new privileges, a minimal /dev
(plus GPU render nodes only), and cgroup limits on memory, CPU, and process count. Only the manifest-declared
executable is started, as an argv array. Nothing is ever passed to a shell.
"""
import errno
import glob
import os
import resource
import secrets
import shutil
import signal
import subprocess
import time

CG_ROOT = '/sys/fs/cgroup'
CG_CTRL = ('memory', 'cpu', 'pids', 'freezer')


def _write(path, value):
    with open(path, 'w') as f:
        f.write(str(value))


class Cgroup:
    """cgroup v1 (as on this host) with a v2 fallback. Missing controllers degrade to rlimits, reported in caps."""

    def __init__(self, name):
        self.name = name
        self.v2 = os.path.exists(os.path.join(CG_ROOT, 'cgroup.controllers'))
        self.paths = {}

    @staticmethod
    def available():
        if os.path.exists(os.path.join(CG_ROOT, 'cgroup.controllers')):
            return ['v2']
        return [c for c in CG_CTRL if os.access(os.path.join(CG_ROOT, c), os.W_OK)]

    def create(self, mem_mb, cpus, pids=1024):
        if self.v2:
            p = os.path.join(CG_ROOT, 'mishrin', self.name)
            os.makedirs(p, exist_ok=True)
            self.paths['v2'] = p
            for k, v in (('memory.max', mem_mb << 20), ('memory.swap.max', 0), ('pids.max', pids), ('cpu.max', f'{int(cpus * 100000)} 100000')):
                try:
                    _write(os.path.join(p, k), v)
                except OSError:
                    pass
            return self
        for c in CG_CTRL:
            base = os.path.join(CG_ROOT, c)
            if not os.access(base, os.W_OK):
                continue
            p = os.path.join(base, 'mishrin', self.name)
            os.makedirs(p, exist_ok=True)
            self.paths[c] = p
        lim = {('memory', 'memory.limit_in_bytes'): mem_mb << 20, ('cpu', 'cpu.cfs_period_us'): 100000,
               ('cpu', 'cpu.cfs_quota_us'): int(cpus * 100000), ('pids', 'pids.max'): pids}
        for (c, k), v in lim.items():
            if c in self.paths:
                try:
                    _write(os.path.join(self.paths[c], k), v)
                except OSError:
                    pass
        return self

    def task_files(self):
        return [os.path.join(p, 'cgroup.procs' if self.v2 else 'tasks') for p in self.paths.values()]

    def pids(self):
        out = set()
        for p in self.paths.values():
            try:
                with open(os.path.join(p, 'cgroup.procs')) as f:
                    out |= {int(x) for x in f.read().split()}
            except OSError:
                pass
        return out

    def freeze(self, on):
        if self.v2 and 'v2' in self.paths:
            _write(os.path.join(self.paths['v2'], 'cgroup.freeze'), 1 if on else 0)
        elif 'freezer' in self.paths:
            _write(os.path.join(self.paths['freezer'], 'freezer.state'), 'FROZEN' if on else 'THAWED')
            return True
        else:
            for pid in self.pids():
                try:
                    os.kill(pid, signal.SIGSTOP if on else signal.SIGCONT)
                except ProcessLookupError:
                    pass
        return True

    def memory_peak_mb(self):
        for k in ('memory.max_usage_in_bytes', 'memory.peak'):
            for p in self.paths.values():
                f = os.path.join(p, k)
                if os.path.exists(f):
                    with open(f) as fh:
                        return int(fh.read().strip()) >> 20
        return None

    def oom_killed(self):
        p = self.paths.get('memory')
        if p and os.path.exists(os.path.join(p, 'memory.oom_control')):
            with open(os.path.join(p, 'memory.oom_control')) as f:
                return 'oom_kill 1' in f.read() or False
        return False

    def kill_all(self):
        if self.paths.get('freezer') or self.v2:
            try:
                self.freeze(False)
            except OSError:
                pass
        for _ in range(50):
            pids = self.pids()
            if not pids:
                return True
            for pid in pids:
                try:
                    os.kill(pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
            time.sleep(0.1)
        return not self.pids()

    def destroy(self):
        self.kill_all()
        for p in self.paths.values():
            for _ in range(20):
                try:
                    os.rmdir(p)
                    break
                except OSError as e:
                    if e.errno == errno.ENOENT:
                        break
                    time.sleep(0.1)


class _Spawner:
    """All sandboxes are forked from this one long-lived thread. bwrap's --die-with-parent uses PR_SET_PDEATHSIG,
    which fires when the *forking thread* exits — so forking from short-lived request threads would kill games."""

    def __init__(self):
        import queue
        import threading
        self.q = queue.Queue()
        threading.Thread(target=self._run, name='mishrin-spawner', daemon=True).start()

    def _run(self):
        while True:
            fn, box = self.q.get()
            try:
                box['result'] = fn()
            except BaseException as e:  # hand the error back to the caller
                box['error'] = e
            box['done'].set()

    def call(self, fn):
        import threading
        box = {'done': threading.Event()}
        self.q.put((fn, box))
        box['done'].wait()
        if 'error' in box:
            raise box['error']
        return box['result']


SPAWNER = _Spawner()


def _mount(*args):
    subprocess.run(['mount', *args], check=True, capture_output=True)


def _umount(path):
    subprocess.run(['umount', '-l', path], capture_output=True)


class Sandbox:
    def __init__(self, cfg, sid, display_num, limits):
        self.cfg = cfg
        self.sid = sid
        self.dir = os.path.join(cfg.data, 'sessions', sid)
        self.display = display_num
        self.limits = limits
        # Namespaced per worker so one worker's crash cleanup can never touch another worker's sessions.
        self.cg = Cgroup(f'{cfg.cg_name}/session-{sid}')
        self.mounts = []
        self.procs = {}
        self.xauth = os.path.join(self.dir, 'xauth')
        self.cookie = secrets.token_hex(16)

    # ---------- filesystem ----------
    def prepare_storage(self):
        os.makedirs(self.dir, exist_ok=True)
        os.chmod(self.dir, 0o700)
        # Storage limit: the whole writable session lives on a tmpfs of the declared size.
        _mount('-t', 'tmpfs', '-o', f'size={self.limits["storageMB"]}m,mode=0711,nosuid,nodev', 'mishrin-session', self.dir)
        self.mounts.append(self.dir)
        self.reset_uppers()
        for d in ('prefix', 'x11', 'pulse'):
            p = os.path.join(self.dir, d)
            os.makedirs(p, exist_ok=True)
            os.chown(p, self.cfg.game_uid, self.cfg.game_uid)
        os.chmod(os.path.join(self.dir, 'pulse'), 0o700)
        self.cg.create(int(self.limits['ram'] * 1.25) + 256, self.limits['cpus'])

    def reset_uppers(self):
        """Fresh writable layers (used at start and before restoring a save)."""
        for d in ('prefix-upper', 'prefix-work', 'game-upper', 'game-work'):
            p = os.path.join(self.dir, d)
            shutil.rmtree(p, ignore_errors=True)
            os.makedirs(p)
            os.chown(p, self.cfg.game_uid, self.cfg.game_uid)

    def mount_layers(self, runtime_prefix, game_layer):
        merged = os.path.join(self.dir, 'prefix')
        _mount('-t', 'overlay', 'mishrin-prefix', '-o',
               f'lowerdir={runtime_prefix},upperdir={self.dir}/prefix-upper,workdir={self.dir}/prefix-work', merged)
        self.mounts.append(merged)
        game_mnt = os.path.join(merged, 'drive_c', 'Game')
        os.makedirs(game_mnt, exist_ok=True)
        _mount('-t', 'overlay', 'mishrin-game', '-o',
               f'lowerdir={game_layer},upperdir={self.dir}/game-upper,workdir={self.dir}/game-work', game_mnt)
        self.mounts.append(game_mnt)

    def unmount_layers(self):
        for m in [m for m in self.mounts if m != self.dir][::-1]:
            subprocess.run(['umount', m], capture_output=True)
            self.mounts.remove(m)

    # ---------- display + audio (worker-owned, one per session) ----------
    def start_display(self, width, height):
        xconf = os.path.join(self.dir, 'xorg.conf')
        with open(xconf, 'w') as f:
            f.write(xorg_conf(width, height))
        for f in (self.xauth, self.cfg.xauth_global):  # sandbox gets only its own cookie; the worker holds all
            subprocess.run(['xauth', '-f', f, 'add', f':{self.display}', '.', self.cookie], check=True, capture_output=True)
        os.chown(self.xauth, self.cfg.game_uid, self.cfg.game_uid)
        os.chmod(self.xauth, 0o600)
        sock = f'/tmp/.X11-unix/X{self.display}'
        if os.path.exists(sock):
            os.remove(sock)
        log = open(os.path.join(self.dir, 'xorg.log'), 'w')
        # A real 60 Hz mode matters: DXVK divides by the refresh rate (Xvfb reports 0 Hz).
        cmd = ['Xorg', f':{self.display}', '-config', xconf, '-auth', self.xauth, '-nolisten', 'tcp', '-noreset',
               '-novtswitch', '-sharevts', '-logfile', os.path.join(self.dir, 'xorg.log')]
        if not shutil.which('Xorg') or not os.path.exists('/usr/lib/xorg/modules/drivers/dummy_drv.so'):
            cmd = ['Xvfb', f':{self.display}', '-auth', self.xauth, '-nolisten', 'tcp', '-screen', '0', f'{width}x{height}x24']
        self.procs['x'] = subprocess.Popen(cmd, stdout=log, stderr=log, start_new_session=True)
        for _ in range(100):
            if os.path.exists(sock):
                break
            if self.procs['x'].poll() is not None:
                raise RuntimeError('virtual display failed to start')
            time.sleep(0.05)
        else:
            raise RuntimeError('virtual display did not start')
        time.sleep(0.2)
        return sock

    def start_audio(self):
        if not shutil.which('pulseaudio'):
            return None
        rt = os.path.join(self.dir, 'pulse')
        env = {'PATH': '/usr/bin:/bin', 'HOME': rt, 'XDG_RUNTIME_DIR': rt, 'PULSE_RUNTIME_PATH': rt}
        cmd = ['setpriv', f'--reuid={self.cfg.game_uid}', f'--regid={self.cfg.game_uid}', '--clear-groups', '--',
               'pulseaudio', '--daemonize=no', '--exit-idle-time=-1', '--disallow-exit', '--disallow-module-loading', '-n',
               '--use-pid-file=no', '--system=no', '--log-target=stderr',
               '--load=module-native-protocol-unix auth-anonymous=1 socket=' + os.path.join(rt, 'native'),
               '--load=module-null-sink sink_name=game sink_properties=device.description=Game']
        log = open(os.path.join(self.dir, 'pulse.log'), 'w')
        self.procs['pulse'] = subprocess.Popen(cmd, env=env, stdout=log, stderr=log, start_new_session=True)
        sock = os.path.join(rt, 'native')
        for _ in range(100):
            if os.path.exists(sock):
                return sock
            if self.procs['pulse'].poll() is not None:
                return None
            time.sleep(0.05)
        return None

    # ---------- game ----------
    def bwrap_argv(self, inner_argv, env, chdir, pulse_sock=None):
        a = ['setpriv', f'--reuid={self.cfg.game_uid}', f'--regid={self.cfg.game_uid}', '--clear-groups', '--no-new-privs', '--',
             'bwrap', '--unshare-all', '--die-with-parent', '--new-session', '--cap-drop', 'ALL',
             '--ro-bind', '/usr', '/usr', '--symlink', 'usr/bin', '/bin', '--symlink', 'usr/lib', '/lib',
             '--symlink', 'usr/lib64', '/lib64', '--symlink', 'usr/lib32', '/lib32', '--symlink', 'usr/sbin', '/sbin',
             '--ro-bind', '/etc/ld.so.cache', '/etc/ld.so.cache']
        for p in ('/etc/fonts', '/etc/alternatives', '/usr/share/vulkan', '/etc/vulkan'):
            if os.path.exists(p) and not p.startswith('/usr'):
                a += ['--ro-bind', p, p]
        a += ['--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp', '--dir', '/home/player',
              '--ro-bind', f'/tmp/.X11-unix/X{self.display}', f'/tmp/.X11-unix/X{self.display}',
              '--ro-bind', self.xauth, '/home/player/.Xauthority',
              '--bind', os.path.join(self.dir, 'prefix'), '/home/player/prefix']
        for node in sorted(glob.glob('/dev/dri/renderD*')):  # GPU render nodes only (no modesetting/card nodes)
            a += ['--dev-bind', node, node]
        if pulse_sock:
            a += ['--ro-bind', pulse_sock, '/tmp/pulse/native']
        a += ['--clearenv']
        for k, v in env.items():
            a += ['--setenv', k, v]
        a += ['--chdir', chdir, *inner_argv]
        return a

    def launch(self, argv, env, chdir, pulse_sock=None, log_name='game.log'):
        cmd = self.bwrap_argv(argv, env, chdir, pulse_sock)
        task_files = self.cg.task_files()

        def enter_limits():
            pid = str(os.getpid())
            for t in task_files:  # join the session cgroup before exec: every descendant inherits it
                try:
                    _write(t, pid)
                except OSError:
                    pass
            resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
            resource.setrlimit(resource.RLIMIT_NOFILE, (8192, 8192))
            resource.setrlimit(resource.RLIMIT_FSIZE, (self.limits['storageMB'] << 20,) * 2)

        log = open(os.path.join(self.dir, log_name), 'ab')
        p = SPAWNER.call(lambda: subprocess.Popen(cmd, stdout=log, stderr=log, stdin=subprocess.DEVNULL, preexec_fn=enter_limits, start_new_session=True))
        self.procs['game'] = p
        return p

    def stop_game(self):
        p = self.procs.pop('game', None)
        self.cg.kill_all()
        if p:
            try:
                p.wait(5)
            except subprocess.TimeoutExpired:
                p.kill()

    def destroy(self):
        """Kill everything, remove all session data. Safe to call repeatedly."""
        self.stop_game()
        for k in ('pulse', 'x'):
            p = self.procs.pop(k, None)
            if p and p.poll() is None:
                try:
                    os.killpg(p.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
                try:
                    p.wait(5)
                except subprocess.TimeoutExpired:
                    pass
        self.cg.destroy()
        subprocess.run(['xauth', '-f', self.cfg.xauth_global, 'remove', f':{self.display}'], capture_output=True)
        for m in reversed(self.mounts):
            _umount(m)
        self.mounts.clear()
        shutil.rmtree(self.dir, ignore_errors=True)
        for f in (f'/tmp/.X11-unix/X{self.display}', f'/tmp/.X{self.display}-lock'):
            try:
                os.remove(f)
            except OSError:
                pass


_XORG_TMPL = '''Section "ServerFlags"
  Option "AutoAddDevices" "false"
  Option "AutoEnableDevices" "false"
  Option "DontVTSwitch" "true"
  Option "BlankTime" "0"
EndSection
Section "Device"
  Identifier "dummy"
  Driver "dummy"
  VideoRam 256000
EndSection
Section "Monitor"
  Identifier "virtual"
  HorizSync 5.0-1000.0
  VertRefresh 5.0-200.0
  Modeline "game" {pclk} {w} {hss} {hse} {ht} {h} {vss} {vse} {vt} -hsync +vsync
EndSection
Section "Screen"
  Identifier "screen"
  Device "dummy"
  Monitor "virtual"
  DefaultDepth 24
  SubSection "Display"
    Depth 24
    Modes "game"
    Virtual {w} {h}
  EndSubSection
EndSection
'''


def _modeline(w, h, hz=60):
    ht, vt = w + 160, h + 16
    return {'pclk': f'{ht * vt * hz / 1e6:.2f}', 'hss': w + 24, 'hse': w + 80, 'ht': ht, 'vss': h + 3, 'vse': h + 8, 'vt': vt}



def xorg_conf(w, h):
    return _XORG_TMPL.format(w=w, h=h, **_modeline(w, h))
