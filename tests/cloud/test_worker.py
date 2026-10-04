#!/usr/bin/python3.12
"""Worker component tests (real sandbox, real cgroups, real Wine). Run as root:
    sudo /usr/bin/python3.12 tests/cloud/test_worker.py
"""
import hashlib
import io
import json
import os
import shutil
import socket
import subprocess
import sys
import tarfile
import tempfile
import time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, '..', '..', 'cloud', 'worker'))
from mishrin_worker import savelayer  # noqa: E402
from mishrin_worker.layers import Layers, dll_overrides  # noqa: E402
from mishrin_worker.manifest import ManifestError, manifest_hash, validate  # noqa: E402
from mishrin_worker.sandbox import Cgroup, Sandbox  # noqa: E402
from mishrin_worker.store import Store  # noqa: E402

N = FAILS = 0


def check(name, cond, detail=''):
    global N, FAILS
    N += 1
    FAILS += 0 if cond else 1
    print(f'{"PASS" if cond else "FAIL"} {name}{" — " + str(detail) if detail else ""}', flush=True)


def sha(b):
    return hashlib.sha256(b).hexdigest()


# ------------------------------------------------------------ manifest parity with the scheduler
cases = json.load(open(os.path.join(HERE, 'manifest-cases.json')))
bad = []
for c in cases:
    try:
        validate(c['manifest'])
        v = True
    except ManifestError:
        v = False
    if v != c['valid']:
        bad.append(c['name'])
check(f'manifest validation parity with scheduler ({len(cases)} cases)', not bad, bad)
js = subprocess.run(['node', '--input-type=module', '-e',
                     "import {validateManifest,manifestHash} from './server/lib/manifest.mjs';import fs from 'fs';"
                     "const c=JSON.parse(fs.readFileSync('tests/cloud/manifest-cases.json'));console.log(manifestHash(validateManifest(c[0].manifest)))"],
                    capture_output=True, text=True, cwd=os.path.join(HERE, '..', '..'))
check('manifest hash identical in scheduler and worker', js.stdout.strip() == manifest_hash(validate(cases[0]['manifest'])), js.stderr[:200])
check('translation layer per game: dxvk / vkd3d / wined3d', 'd3d11,dxgi=n,b' in dll_overrides('dxvk', True, True).replace('d3d8,d3d9,d3d10core,', '')
      and 'd3d12,d3d12core=n,b' in dll_overrides('vkd3d', True, True) and '=b' in dll_overrides('wined3d', True, True)
      and 'n,b' not in dll_overrides('wined3d', True, True))

# ------------------------------------------------------------ store: dedup, lazy fetch, delta updates, zero-copy layers
tmp = tempfile.mkdtemp(prefix='mishrin-store-')
remote, fetched = {}, []


def fetch(h):
    fetched.append(h)
    return remote[h]


blobs = {'Game.exe': b'MZ' + os.urandom(5000), 'data/a.pak': os.urandom(3000), 'data/b.pak': os.urandom(2000)}
big = os.urandom(9000)  # multi-chunk file
for b in [*blobs.values(), big[:4000], big[4000:8000], big[8000:]]:
    remote[sha(b)] = b


def man(files, big_parts=True):
    fl = [{'path': p, 'size': len(b), 'chunks': [sha(b)]} for p, b in files.items()]
    if big_parts:
        fl.append({'path': 'data/big.bin', 'size': len(big), 'chunks': [sha(big[:4000]), sha(big[4000:8000]), sha(big[8000:])]})
    return validate({'id': 'store-test', 'type': 'windows', 'runtime': 'wine', 'executable': 'Game.exe', 'files': fl})


st = Store(tmp, fetch, owner_uid=20000)
m1 = man(blobs)
h1, p1 = st.acquire_layer(m1)
check('game layer assembled from chunks (incl. multi-chunk file)', open(os.path.join(p1, 'data', 'big.bin'), 'rb').read() == big and len(fetched) == 6)
check('single-chunk files are hard links to the store (zero copy)', os.stat(os.path.join(p1, 'Game.exe')).st_ino == os.stat(st.chunk_path(sha(blobs['Game.exe']))).st_ino)
check('layer owned by the sandbox uid (writable only via the session overlay)', os.stat(os.path.join(p1, 'Game.exe')).st_uid == 20000)
st.release(h1)
fetched.clear()
h1b, _ = st.acquire_layer(m1)
st.release(h1b)
check('cache reuse: second session downloads nothing', not fetched and st.stats['layers_reused'] >= 1)
v2 = dict(blobs, **{'data/b.pak': os.urandom(2100)})
remote[sha(v2['data/b.pak'])] = v2['data/b.pak']
fetched.clear()
h2, _ = st.acquire_layer(man(v2))
st.release(h2)
check('delta update: only the changed chunk is downloaded', fetched == [sha(v2['data/b.pak'])], f'{len(fetched)} chunk(s)')
remote['f' * 64] = b'tampered'
try:
    st.ensure_chunks(['f' * 64])
    check('corrupt chunk rejected', False)
except ValueError:
    check('corrupt chunk rejected (integrity check)', True)
st.budget = 0
os.utime(st.layer_path(h1), (0, 0))
st.evict()
check('eviction removes unused layers when over budget', not st.has_layer(h1))
shutil.rmtree(tmp, ignore_errors=True)


# ------------------------------------------------------------ isolation (real bubblewrap + cgroups)
class Cfg:
    data = tempfile.mkdtemp(prefix='mishrin-iso-')
    game_uid = 20000
    name = 'test'
    cg_name = 'w-test'
    xauth_global = os.path.join(data, 'xauthority')


os.chmod(Cfg.data, 0o711)
os.makedirs(os.path.join(Cfg.data, 'sessions'), mode=0o711)
open(Cfg.xauth_global, 'a').close()
PROBE = r'''
import os, socket, json, resource
r = {}
r['uid'] = os.getuid()
def can(f):
    try: f(); return True
    except Exception: return False
r['read_shadow'] = can(lambda: open('/etc/shadow').read())
r['see_root_home'] = os.path.exists('/root')
r['see_home_claude'] = os.path.exists('/home/claude')
r['see_worker_data'] = os.path.exists('/var/lib/mishrin')
r['write_usr'] = can(lambda: open('/usr/x', 'w'))
r['net_external'] = can(lambda: socket.create_connection(('1.1.1.1', 53), timeout=2))
r['net_host_loopback'] = can(lambda: socket.create_connection(('127.0.0.1', 18787), timeout=2))
r['ifaces'] = sorted(os.listdir('/sys/class/net')) if os.path.exists('/sys/class/net') else []
r['cap_eff'] = [l.split()[1] for l in open('/proc/self/status') if l.startswith('CapEff')][0]
r['pid1_visible'] = os.path.exists('/proc/1/cmdline') and 'init' in open('/proc/1/cmdline').read() + 'x'
r['procs'] = len([p for p in os.listdir('/proc') if p.isdigit()])
r['devs'] = sorted(os.listdir('/dev'))
r['nofile'] = resource.getrlimit(resource.RLIMIT_NOFILE)[0]
print(json.dumps(r))
'''
lim = {'ram': 256, 'cpus': 1, 'storageMB': 64, 'maxMinutes': 1}
sb = Sandbox(Cfg, 'iso-test', 390, lim)
sb.prepare_storage()
os.makedirs('/tmp/.X11-unix', exist_ok=True)
xs = '/tmp/.X11-unix/X390'
open(xs, 'a').close()
open(sb.xauth, 'a').close()
lsock = socket.socket()
lsock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
lsock.bind(('127.0.0.1', 18787))
lsock.listen(1)
p = sb.launch(['/usr/bin/python3.12', '-c', PROBE], {'PATH': '/usr/bin'}, '/home/player', log_name='probe.log')
p.wait(30)
out = open(os.path.join(sb.dir, 'probe.log')).read()
try:
    r = json.loads(out.strip().splitlines()[-1])
except Exception:
    r = {}
check('sandbox runs as unprivileged uid with no capabilities', r.get('uid') == 20000 and int(r.get('cap_eff', '1'), 16) == 0, f"uid={r.get('uid')} CapEff={r.get('cap_eff')}")
check('no host filesystem (no /root, /home, worker data, /etc/shadow)', r and not (r['read_shadow'] or r['see_root_home'] or r['see_home_claude'] or r['see_worker_data']), out[-300:] if not r else '')
check('read-only system files', r and not r['write_usr'])
check('no network: external and host loopback unreachable', r and not r['net_external'] and not r['net_host_loopback'], f"ifaces={r.get('ifaces')}")
check('own PID namespace (cannot see host processes)', r and r['procs'] <= 3, f"{r.get('procs')} processes visible")
check('minimal /dev (no disks, no input devices)', r and not any(d.startswith(('sd', 'vd', 'nvme', 'input', 'mem', 'kmsg')) for d in r['devs']), r.get('devs'))
check('resource limits applied (rlimits)', r and r['nofile'] == 8192)
lsock.close()

# memory limit → killed; pids limit; storage limit
p = sb.launch(['/usr/bin/python3.12', '-c', 'b=[]\nwhile True: b.append(bytearray(32<<20))'], {'PATH': '/usr/bin'}, '/home/player', log_name='mem.log')
try:
    rc = p.wait(60)
except subprocess.TimeoutExpired:
    rc = None
    p.kill()
check('memory limit enforced by cgroup (allocation hog killed)', rc not in (None, 0), f'exit {rc}, peak {sb.cg.memory_peak_mb()} MB')
p = sb.launch(['/usr/bin/python3.12', '-c', 'import os\nn=0\ntry:\n  [os.fork() or os._exit(0) for _ in range(5000)]\nexcept OSError: print("blocked")'],
              {'PATH': '/usr/bin'}, '/home/player', log_name='pids.log')
p.wait(60)
check('process-count limit enforced (fork bomb contained)', 'blocked' in open(os.path.join(sb.dir, 'pids.log')).read())
# storage limit: the session tmpfs is 64 MB
try:
    with open(os.path.join(sb.dir, 'prefix-upper', 'fill'), 'wb') as f:
        for _ in range(100):
            f.write(b'\0' * (1 << 20))
    full = False
except OSError:
    full = True
check('storage limit enforced (session tmpfs)', full)
cgpath = list(sb.cg.paths.values())
sb.destroy()
check('session destroy removes data, mounts and cgroups', not os.path.exists(sb.dir) and not any(os.path.exists(c) for c in cgpath)
      and not any(sb.dir in l for l in open('/proc/mounts')))
try:
    os.remove(xs)
except OSError:
    pass

# ------------------------------------------------------------ save layer: round trip + tamper resistance
d = tempfile.mkdtemp(prefix='mishrin-save-')
for sub in ('prefix-upper/drive_c/users/player/AppData/Roaming/Game', 'prefix-upper/drive_c/users/player/Temp', 'game-upper/saves'):
    os.makedirs(os.path.join(d, sub))
open(os.path.join(d, 'prefix-upper/user.reg'), 'w').write('WINE REGISTRY')
open(os.path.join(d, 'prefix-upper/drive_c/users/player/AppData/Roaming/Game/slot1.sav'), 'w').write('level=7')
open(os.path.join(d, 'prefix-upper/drive_c/users/player/Temp/junk.tmp'), 'w').write('x' * 5000)
open(os.path.join(d, 'game-upper/saves/a.sav'), 'w').write('gold=99')
blob, raw, files = savelayer.snapshot(d)
check('save snapshot captures progress, skips temp/cache', files == 3 and raw < 100, f'{files} files, {raw} B raw → {len(blob)} B compressed')
d2 = tempfile.mkdtemp(prefix='mishrin-save2-')
for sub in ('prefix-upper', 'game-upper'):
    os.makedirs(os.path.join(d2, sub))
savelayer.restore(blob, d2, 20000)
check('save restore round-trip', open(os.path.join(d2, 'game-upper/saves/a.sav')).read() == 'gold=99'
      and open(os.path.join(d2, 'prefix-upper/drive_c/users/player/AppData/Roaming/Game/slot1.sav')).read() == 'level=7')


def evil(name, kind=tarfile.REGTYPE, link=''):
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode='w') as t:
        ti = tarfile.TarInfo(name)
        ti.type, ti.linkname, ti.size = kind, link, 0 if kind != tarfile.REGTYPE else 3
        t.addfile(ti, io.BytesIO(b'bad') if kind == tarfile.REGTYPE else None)
    import gzip
    return gzip.compress(buf.getvalue())


blocked = 0
for b in (evil('../../etc/passwd'), evil('/etc/passwd'), evil('prefix/../../x'), evil('other/x'), evil('prefix/link', tarfile.SYMTYPE, '/etc'),
          evil('game/dev', tarfile.CHRTYPE)):
    try:
        savelayer.restore(b, d2, 20000)
    except RuntimeError:
        blocked += 1
check('malicious save layers rejected (traversal, absolute, links, devices)', blocked == 6, f'{blocked}/6 blocked')
shutil.rmtree(d, ignore_errors=True)
shutil.rmtree(d2, ignore_errors=True)
shutil.rmtree(Cfg.data, ignore_errors=True)

# ------------------------------------------------------------ runtime layer
lay = Layers('/var/lib/mishrin', 20000, '/opt/mishrin/layers/dxvk-2.6.1', '/opt/mishrin/layers/vkd3d-proton-2.14.1')
info = lay.info()
pfx = lay.prefix()
check('runtime layer: Wine + DXVK + VKD3D-Proton, shared and immutable', info['ready'] and info['dxvk'] and info['vkd3d']
      and os.path.exists(os.path.join(pfx, 'drive_c/windows/system32/d3d11.dll')) and os.path.exists(os.path.join(pfx, 'drive_c/windows/syswow64/d3d9.dll'))
      and not os.path.exists(os.path.join(pfx, 'dosdevices/z:')), info['key'])

# ------------------------------------------------------------ emulator profiles (PPSSPP / PCSX2, mock binaries)
from mishrin_worker.profiles import EmulatorProfile, EmulatorError, load_profiles, ready_runtimes, profile_for  # noqa: E402


class FakeWorker:
    class cfg:
        data = tempfile.mkdtemp(prefix='mishrin-prof-')
        game_uid = 20000
    layers = lay
    logs = []

    def log(self, m):
        self.logs.append(m)


fw = FakeWorker()
EMU = os.path.join(HERE, '..', '..', 'cloud', 'test-games', 'emulators')
profs = load_profiles(fw, EMU)
names = sorted((p.name, p.runtime, p.mock) for p in profs if p.kind == 'emulator')
check('emulator profiles discovered from emulator.json (mock PCSX2 + mock PPSSPP)', names == [('pcsx2', 'ps2', True), ('ppsspp', 'psp', True)], names)
check('worker advertises only runtimes that can start now (Wine + firmware present)', sorted(ready_runtimes(profs)) == sorted(['x64-win', 'x86', 'ps2', 'psp']), ready_runtimes(profs))
tmp = tempfile.mkdtemp(prefix='mishrin-emu-')
shutil.copytree(os.path.join(EMU, 'mock-pcsx2'), os.path.join(tmp, 'nofw'))
os.remove(os.path.join(tmp, 'nofw/home/.config/PCSX2/bios/mock-bios.bin'))
nofw = EmulatorProfile(fw, os.path.join(tmp, 'nofw'))
check('firmware missing → profile installed but its runtime is not advertised',
      not nofw.firmware_ok() and 'ps2' not in ready_runtimes([profs[0], nofw]) and nofw.info()['firmware'] is False)
psp_prof = next(p for p in profs if p.kind == 'emulator' and p.runtime == 'psp')
check('PSP needs no firmware: profile without a firmware block is runnable', psp_prof.firmware_ok() and psp_prof.runnable())
try:
    nofw.runtime_layer(print)
    check('firmware missing → runtime_layer raises', False)
except RuntimeError as e:
    check('firmware missing → runtime_layer raises (user-provided firmware required)', 'firmware' in str(e).lower(), e)


def bad_spec(**over):
    d = tempfile.mkdtemp(prefix='mishrin-bad-', dir=tmp)
    shutil.copytree(os.path.join(EMU, 'mock-ppsspp'), os.path.join(d, 'e'))
    spec = json.load(open(os.path.join(d, 'e/emulator.json')))
    spec.update(over)
    json.dump(spec, open(os.path.join(d, 'e/emulator.json'), 'w'))
    try:
        EmulatorProfile(fw, os.path.join(d, 'e'))
        return False
    except EmulatorError:
        return True


rejected = [k for k, v in {
    'shell in argv': {'argv': ['{binary}', '; rm -rf /', '{boot}']}, 'argv not starting with binary': {'argv': ['/bin/sh', '-c', '{boot}']},
    'boot missing': {'argv': ['{binary}']}, 'binary escapes dir': {'binary': '../../../../bin/sh'}, 'home escapes dir': {'home': '/etc'},
    'save scope escapes': {'saves': ['../../etc']}, 'unknown runtime': {'runtime': 'ps4'}, 'emulator/runtime mismatch': {'name': 'pcsx2'},
    'bad env': {'env': {'LD_PRELOAD;': 'x'}},
}.items() if bad_spec(**v)]
check('unsafe emulator.json variants rejected (9)', len(rejected) == 9, rejected)
emu_m = validate({'id': 'psp', 'type': 'emulator', 'platform': 'psp', 'boot': 'G/EBOOT.PBP',
                  'files': [{'path': 'G/EBOOT.PBP', 'size': 1, 'chunks': ['a' * 64]}]})


class S:
    manifest = emu_m
    display = 101


pp = profile_for(profs, emu_m)
argv, env, wd = pp.launch_spec(S)
check('emulator argv = profile binary + fixed flags + validated boot path (no shell)',
      argv == ['/opt/emu/mock-emulator', '--mode=psp', '/home/player/prefix/game/G/EBOOT.PBP'] and env['HOME'] == '/home/player/prefix', argv)
check('emulator binary bound read-only into the sandbox', pp.extra_ro == ((os.path.realpath(os.path.join(EMU, 'mock-ppsspp')), '/opt/emu'),))
lay_e = pp.runtime_layer(print)
check('emulator layer built once, owned by the sandbox uid (template untouched)', os.stat(lay_e).st_uid == 20000 and pp.runtime_layer(print) == lay_e
      and os.stat(os.path.join(EMU, 'mock-ppsspp', 'home')).st_uid != 20000)
check('profile_for picks the Windows profile for Windows manifests', profile_for(profs, validate(cases[0]['manifest'])).kind == 'windows')
# save scope: emulator save data only, never system/config files
sd = tempfile.mkdtemp(prefix='mishrin-sv-')
for rel, data in (('prefix-upper/.config/ppsspp/PSP/SAVEDATA/MSHR00001/SAVE.DAT', '{"x":1}'),
                  ('prefix-upper/.config/ppsspp/PSP/SYSTEM/ppsspp.ini', 'cfg'), ('prefix-upper/.config/ppsspp/PSP/SYSTEM/CACHE/x.bin', 'cache')):
    os.makedirs(os.path.dirname(os.path.join(sd, rel)), exist_ok=True)
    open(os.path.join(sd, rel), 'w').write(data)
os.makedirs(os.path.join(sd, 'game-upper'), exist_ok=True)
blob, raw, files = savelayer.snapshot(sd, pp.save_include, pp.save_exclude)
names_in = tarfile.open(fileobj=io.BytesIO(savelayer._decompress(blob))).getnames()
check('emulator save layer = save data only (no config, no cache)', names_in == ['prefix/.config/ppsspp/PSP/SAVEDATA/MSHR00001/SAVE.DAT'], names_in)
shutil.rmtree(tmp, ignore_errors=True)
shutil.rmtree(sd, ignore_errors=True)
shutil.rmtree(FakeWorker.cfg.data, ignore_errors=True)

print(f'\n{N - FAILS}/{N} worker checks passed')
sys.exit(1 if FAILS else 0)
