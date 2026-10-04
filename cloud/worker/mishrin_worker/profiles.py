"""Session profiles: what runs inside a session sandbox.

    WindowsProfile   Wine (WoW64) + DXVK/VKD3D-Proton runtime layer, game at C:\\Game        runtimes: x64-win, x86
    EmulatorProfile  a native emulator (RPCS3, PCSX2, …) described by an emulator.json       runtimes: ps3, ps2, …

Both reuse the same isolation, storage, display/audio, stream, input and save machinery. A profile only decides
(1) the read-only runtime layer under the session's writable overlay, (2) where the game layer is mounted,
(3) the argv/env of the one process that is started, (4) the save-data scope and (5) extra read-only binds.

emulator.json (one per directory under --emulators, default /opt/mishrin/emulators):
    {
      "name": "rpcs3", "runtime": "ps3", "version": "0.0.36",
      "binary": "rpcs3/usr/bin/rpcs3",                 relative to the emulator directory (bound read-only at /opt/emu)
      "argv": ["{binary}", "--no-gui", "{boot}"],     placeholders only; the boot path comes from the validated manifest
      "home": "home",                                  template home (config, pad bindings, user-installed firmware)
      "firmware": {"label": "PS3 system software", "required": [".config/rpcs3/dev_flash/vsh/module/vsh.self"]},
      "saves": [".config/rpcs3/dev_hdd0/home"],        save-data scope inside home (what the cloud save layer captures)
      "exclude": ["*/cache/*"], "env": {"QT_QPA_PLATFORM": "xcb"}, "mock": false
    }
Firmware/BIOS files are never shipped by Mishrin: the operator installs the user's own copy into the template home.
"""
import hashlib
import json
import os
import re
import shutil
import struct
import subprocess
import time

from .layers import dll_overrides
from .manifest import win_path
from . import savelayer

NAME_RE = re.compile(r'^[a-z0-9][a-z0-9_-]{0,31}$')
RUNTIME_RE = re.compile(r'^(ps2|ps3)$')          # must match server/lib/manifest.mjs EMULATOR_PLATFORMS
PLACEHOLDER_RE = re.compile(r'^(\{binary\}|\{boot\}|[A-Za-z0-9_\-=.,:/+]{1,64})$')
PLATFORM_EMULATOR = {'ps2': 'pcsx2', 'ps3': 'rpcs3'}


class WindowsProfile:
    kind = 'windows'
    runtimes = ('x64-win', 'x86')
    game_mount = 'drive_c/Game'
    save_include = savelayer.INCLUDE
    save_exclude = savelayer.EXCLUDE
    extra_ro = ()
    pad = 'logical'

    def __init__(self, worker):
        self.w = worker

    def available(self):
        return bool(self.w.layers.wine)

    def info(self):
        return None

    def runtime_layer(self, log):
        return self.w.layers.ensure(log)

    def current_layer(self):
        return self.w.layers.prefix()

    def launch_spec(self, s):
        m = s.manifest
        env = {
            'HOME': '/home/player', 'USER': 'player', 'PATH': '/usr/bin:/bin', 'LANG': 'C.UTF-8',
            'WINEPREFIX': '/home/player/prefix', 'WINEDEBUG': '-all', 'DISPLAY': f':{s.display}',
            'XAUTHORITY': '/home/player/.Xauthority',
            'WINEDLLOVERRIDES': dll_overrides(m['graphics'], bool(self.w.layers.dxvk), bool(self.w.layers.vkd3d)),
            'DXVK_LOG_LEVEL': 'info', 'DXVK_STATE_CACHE_PATH': '/home/player/prefix', 'VKD3D_SHADER_CACHE_PATH': '/home/player/prefix',
        }
        wd = '/home/player/prefix/drive_c/Game' + ('/' + m['workingDirectory'] if m['workingDirectory'] else '')
        return ['/usr/bin/wine', win_path(m['executable']), *m['args']], env, wd


class EmulatorError(ValueError):
    pass


class EmulatorProfile:
    kind = 'emulator'
    game_mount = 'game'
    pad = 'full'

    def __init__(self, worker, directory):
        self.w = worker
        self.dir = os.path.realpath(directory)
        with open(os.path.join(self.dir, 'emulator.json')) as f:
            spec = json.load(f)
        self.spec = self._check(spec)
        self.name, self.runtime = spec['name'], spec['runtime']
        self.runtimes = (self.runtime,)
        self.home = self._inside(spec.get('home', 'home'))
        # Either bundled in the profile directory (bound read-only at /opt/emu) or a system package under /usr
        # (already visible read-only inside every sandbox), e.g. Ubuntu's pcsx2 at /usr/games/PCSX2.
        self.system_binary = spec['binary'].startswith('/usr/')
        self.binary = os.path.realpath(spec['binary']) if self.system_binary else self._inside(spec['binary'])
        if self.system_binary and not self.binary.startswith('/usr/'):
            raise EmulatorError('emulator.json: system binaries must live under /usr')
        self.save_include = [('prefix', p) for p in spec.get('saves', [])]
        self.save_exclude = list(spec.get('exclude', [])) + ['*.log', '*/cache/*', '*/shaders/*']
        self.extra_ro = ((self.dir, '/opt/emu'),)
        self.mock = bool(spec.get('mock'))

    def _check(self, spec):
        if not isinstance(spec, dict) or not NAME_RE.match(str(spec.get('name', ''))):
            raise EmulatorError('emulator.json: bad name')
        if not RUNTIME_RE.match(str(spec.get('runtime', ''))) or PLATFORM_EMULATOR[spec['runtime']] != spec['name'].replace('mock-', ''):
            raise EmulatorError('emulator.json: runtime/emulator pair not allowed')
        argv = spec.get('argv')
        if not isinstance(argv, list) or not argv or argv[0] != '{binary}' or argv.count('{boot}') != 1 or not all(isinstance(a, str) and PLACEHOLDER_RE.match(a) for a in argv):
            raise EmulatorError('emulator.json: argv must be ["{binary}", fixed flags…, "{boot}"]')
        for k in ('saves', 'exclude'):
            if not isinstance(spec.get(k, []), list) or not all(isinstance(x, str) and '..' not in x and not x.startswith('/') for x in spec.get(k, [])):
                raise EmulatorError(f'emulator.json: bad {k}')
        env = spec.get('env', {})
        if not isinstance(env, dict) or not all(re.match(r'^[A-Z][A-Z0-9_]{0,63}$', k) and isinstance(v, str) and len(v) < 256 for k, v in env.items()):
            raise EmulatorError('emulator.json: bad env')
        return spec

    def _inside(self, rel):
        p = os.path.realpath(os.path.join(self.dir, rel))
        if not p.startswith(self.dir + os.sep):
            raise EmulatorError(f'emulator.json: path escapes the emulator directory: {rel}')
        return p

    # ---------------------------------------------------------------- firmware / BIOS (always user-provided)
    def firmware_status(self):
        """{'state': 'present'|'missing'|'test-only', 'detail': str}. Nothing here ever downloads firmware."""
        fw = self.spec.get('firmware') or {}
        home_rel = os.path.relpath(self.home, self.dir)
        if fw.get('kind') == 'ps2-bios':
            d = self._inside(os.path.join(home_rel, fw.get('dir', '.config/PCSX2/bios')))
            found = []
            for n in sorted(os.listdir(d)) if os.path.isdir(d) else []:
                info = ps2_rom_info(os.path.join(d, n))
                if info:
                    found.append((n, info))
            real = [(n, i) for n, i in found if not i['test']]
            if real:
                return {'state': 'present', 'detail': f"{real[0][0]}: {real[0][1]['desc']}", 'file': real[0][0]}
            if found:
                return {'state': 'test-only', 'detail': f"{found[0][0]}: {found[0][1]['desc']} (Mishrin test ROM, not a console BIOS)", 'file': found[0][0]}
            return {'state': 'missing', 'detail': f"no PS2 BIOS in {fw.get('dir', '.config/PCSX2/bios')}"}
        req = fw.get('required', [])
        missing = [r for r in req if not os.path.isfile(self._inside(os.path.join(home_rel, r)))]
        if not missing:
            return {'state': 'present', 'detail': ', '.join(req)}
        if fw.get('hleTest'):
            return {'state': 'test-only', 'detail': f'no {fw.get("label", "firmware")} installed ({", ".join(missing)} missing): built-in HLE libraries only — Mishrin test program, not games'}
        return {'state': 'missing', 'detail': f'missing: {", ".join(missing)}'}

    def firmware_ok(self):
        return self.firmware_status()['state'] == 'present'

    def runnable(self, allow_test=False):
        """Can this worker start a session now? Real firmware, or (test mode only) a test ROM / HLE test program."""
        st = self.firmware_status()['state']
        return self.available() and (st == 'present' or (allow_test and st == 'test-only'))

    def libs_ok(self):
        if getattr(self, '_libs', None) is None:
            try:
                out = subprocess.run(['ldd', self.binary], capture_output=True, text=True, timeout=20).stdout
                self._libs = 'not found' not in out
            except Exception:
                self._libs = False
        return self._libs

    def available(self):
        return os.path.isfile(self.binary) and os.access(self.binary, os.X_OK) and os.path.isdir(self.home) and self.libs_ok()

    def info(self):
        fw = self.firmware_status()
        allow = bool(getattr(self.w.cfg, 'allow_test_firmware', False))
        return {'name': self.name, 'runtime': self.runtime, 'version': str(self.spec.get('version', ''))[:40],
                'installed': self.available(), 'available': self.available(), 'mock': self.mock,
                'firmware': fw['state'] == 'present', 'firmwareState': fw['state'], 'firmwareDetail': fw['detail'][:160],
                'firmwareLabel': (self.spec.get('firmware') or {}).get('label', ''), 'testMode': allow and fw['state'] == 'test-only',
                'verified': getattr(self, 'self_test', None) or {'ok': False, 'detail': 'not run'},
                'status': self.status(), 'formats': list(self.spec.get('formats', []))[:12],
                'requires': self.requirement_text()}

    def status(self):
        """Registry state, honest by construction: READY only after the startup self-test booted the emulator with real
        user firmware/BIOS. A Mishrin test ROM never makes a runtime READY (it proves the emulator, not game support)."""
        if self.mock:
            return 'MOCK'
        if not self.available():
            return 'INSTALLATION_REQUIRED'
        st = self.firmware_status()['state']
        kind = 'BIOS_REQUIRED' if (self.spec.get('firmware') or {}).get('kind') == 'ps2-bios' else 'FIRMWARE_REQUIRED'
        allow = bool(getattr(self.w.cfg, 'allow_test_firmware', False))
        t = getattr(self, 'self_test', None)
        if st == 'missing' or (st == 'test-only' and not allow):
            return kind
        if t is None:
            return 'NOT_VERIFIED'
        if not t.get('ok'):
            return 'ERROR'
        return 'READY' if st == 'present' else kind     # test mode: emulator verified, real BIOS/firmware still required

    def requirement_text(self):
        fw = self.spec.get('firmware') or {}
        return str(fw.get('help') or '')[:400]

    def runtime_layer(self, log):
        if not self.available():
            raise RuntimeError(f'{self.name} is not installed on this worker')
        if not self.runnable(bool(getattr(self.w.cfg, 'allow_test_firmware', False))):
            label = (self.spec.get('firmware') or {}).get('label') or 'firmware'
            raise RuntimeError(f'{label} is not installed on this worker (user-provided firmware/BIOS is required).')
        return self._layer(log)

    def graceful_stop(self, s):
        """Let the emulator close its files (PCSX2 flushes memory cards only on close), then the sandbox is torn down."""
        g = self.spec.get('gracefulStop')
        if not g or not s.inj or not getattr(s, 'game', None) or s.game.poll() is not None:
            return
        try:
            s.inj.key(g.get('key', 'Escape'), True)
            time.sleep(0.1)
            s.inj.key(g.get('key', 'Escape'), False)
        except Exception:
            return
        deadline = time.time() + float(g.get('wait', 3))
        before = savelayer.newest_mtime(s.sb.dir, self.save_include)
        while time.time() < deadline and s.game.poll() is None:
            if savelayer.newest_mtime(s.sb.dir, self.save_include) > before:
                time.sleep(0.5)
                break
            time.sleep(0.2)

    def _signature(self):
        h = hashlib.sha256(f'{self.name}|{self.spec.get("version", "")}'.encode())
        for d, dirs, files in sorted(os.walk(self.home)):
            dirs.sort()
            for f in sorted(files):
                st = os.lstat(os.path.join(d, f))
                h.update(f'{os.path.relpath(os.path.join(d, f), self.home)}|{st.st_size}|{int(st.st_mtime)}'.encode())
        return h.hexdigest()[:16]

    def _layer(self, log=print):
        """Copy of the template home owned by the sandbox uid, built once per template version (like the Wine layer).
        Shared read-only by every session as the overlay's lower layer; sessions only write their own upper dir."""
        base = os.path.join(self.w.cfg.data, 'layers', f'emu-{self.name}-{self._signature()}')
        if os.path.exists(base + '.complete'):
            return base
        log(f'building emulator layer {os.path.basename(base)}')
        tmp = base + '.build'
        shutil.rmtree(tmp, ignore_errors=True)
        shutil.copytree(self.home, tmp, symlinks=True)
        uid = self.w.cfg.game_uid
        for d, dirs, files in os.walk(tmp):
            for n in dirs + files:
                os.lchown(os.path.join(d, n), uid, uid)
        os.chown(tmp, uid, uid)
        shutil.rmtree(base, ignore_errors=True)
        os.rename(tmp, base)
        open(base + '.complete', 'w').close()
        return base

    def current_layer(self):
        return self._layer()

    def launch_spec(self, s):
        fm = [f.lower() for f in self.spec.get('formats', [])]
        ext = s.manifest['boot'].rsplit('.', 1)[-1].lower() if '.' in s.manifest['boot'] else ''
        if fm and s.manifest['boot'] and ext not in fm and not s.manifest['boot'].endswith('EBOOT.BIN'):
            raise RuntimeError(f'{self.name} {self.spec.get("version", "")} on this worker accepts {", ".join("." + f for f in fm)}, not .{ext}')
        boot = '/home/player/prefix/game/' + s.manifest['boot']
        bin_in = self.binary if self.system_binary else '/opt/emu/' + os.path.relpath(self.binary, self.dir)
        argv = [bin_in if a == '{binary}' else boot if a == '{boot}' else a for a in self.spec['argv']]
        env = {'HOME': '/home/player/prefix', 'USER': 'player', 'PATH': '/usr/bin:/bin', 'LANG': 'C.UTF-8',
               'DISPLAY': f':{s.display}', 'XAUTHORITY': '/home/player/.Xauthority', 'XDG_CONFIG_HOME': '/home/player/prefix/.config',
               'XDG_DATA_HOME': '/home/player/prefix/.local/share', 'XDG_CACHE_HOME': '/tmp/cache',
               'MISHRIN_PAD': json.dumps(s.manifest['controllerMap']), **self.spec.get('env', {})}
        if getattr(s, 'pulse', None):
            env.setdefault('SDL_AUDIODRIVER', 'pulseaudio')
        return argv, env, '/home/player/prefix'


def load_profiles(worker, emulators_dir):
    profiles = [WindowsProfile(worker)]
    if emulators_dir and os.path.isdir(emulators_dir):
        for d in sorted(os.listdir(emulators_dir)):
            p = os.path.join(emulators_dir, d)
            if os.path.isfile(os.path.join(p, 'emulator.json')):
                try:
                    profiles.append(EmulatorProfile(worker, p))
                except (EmulatorError, OSError, ValueError) as e:
                    worker.log(f'emulator profile {d} rejected: {e}')
    return profiles


def ready_runtimes(profiles, allow_test=False):
    """Runtimes this worker advertises: only profiles that can actually start a session right now (real firmware;
    a test ROM / HLE test program only when the worker runs in test mode)."""
    out = []
    for p in profiles:
        if p.kind == 'windows' and p.available():
            out += list(p.runtimes)
        elif p.kind == 'emulator' and p.runnable(allow_test) and (getattr(p, 'self_test', None) or {'ok': True})['ok']:
            out += list(p.runtimes)   # a failed startup self-test keeps the runtime off the market
    return sorted(set(out), key=out.index)


def profile_for(profiles, manifest):
    if manifest.get('type') == 'emulator':
        for p in profiles:
            if p.kind == 'emulator' and p.runtime == manifest['platform']:
                return p
        raise RuntimeError(f'no {manifest["platform"]} emulator on this worker')
    return profiles[0]


TEST_ROMVER = b'0100XD20261004'   # emulators/ps2/testrom: identifies the Mishrin test ROM (zone X = test, D = devel)


def ps2_rom_info(path):
    """Structural check of a PS2 boot ROM (the same ROMDIR walk PCSX2 does). Returns None if it is not one.
    Only metadata is read; the ROM itself is the operator's own file and is never copied anywhere else."""
    try:
        if not 512 * 1024 <= os.path.getsize(path) <= 8 * 1024 * 1024:
            return None
        with open(path, 'rb') as f:
            data = f.read(512 * 1024)
    except OSError:
        return None
    i = data.find(b'RESET\0')
    if i < 0 or i % 16:
        return None
    off, pos = 0, i
    while pos + 16 <= len(data) and data[pos]:
        name = data[pos:pos + 10].split(b'\0')[0]
        size = struct.unpack_from('<I', data, pos + 12)[0]
        if name == b'ROMVER':
            rv = data[off:off + 14]
            zones = {ord('J'): 'Japan', ord('A'): 'USA', ord('E'): 'Europe', ord('H'): 'HK', ord('P'): 'Free', ord('C'): 'China', ord('T'): 'T10K', ord('X'): 'Test'}
            zone = zones.get(rv[4], 'unknown') if len(rv) == 14 else 'unknown'
            return {'romver': rv.decode('latin1', 'replace'), 'desc': f'{zone} v{rv[0:2].decode("latin1")}.{rv[2:4].decode("latin1")}', 'test': rv == TEST_ROMVER}
        off += size if size % 16 == 0 else (size + 0x10) & ~0xF
        pos += 16
    return None
