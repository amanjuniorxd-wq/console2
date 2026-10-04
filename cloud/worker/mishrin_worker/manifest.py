"""Windows game manifest validation (worker-side twin of server/lib/manifest.mjs).

The browser never sends commands: it names a game; the scheduler resolves a manifest it validated, and the
worker validates it again before anything touches disk. Only the declared executable is ever launched,
always as an argv array (never through a shell).
"""
import hashlib
import json
import re

ID_RE = re.compile(r'^[a-z0-9][a-z0-9-]{0,63}$')
SHA_RE = re.compile(r'^[a-f0-9]{64}$')
# Path segments: printable, no Windows-reserved characters, no shell metacharacters.
SEG_RE = re.compile(r"^[A-Za-z0-9 _\-.()\[\]+,'&!@#=~]{1,128}$")
ARG_RE = re.compile(r'^[A-Za-z0-9 _\-=.,:/+]{0,128}$')
RESERVED = {'con', 'prn', 'aux', 'nul', *(f'com{i}' for i in range(1, 10)), *(f'lpt{i}' for i in range(1, 10))}
GRAPHICS = {'auto', 'dxvk', 'vkd3d', 'wined3d', 'gdi'}
ARCH = {'auto', 'x64', 'x86'}
KEYS = {'Up', 'Down', 'Left', 'Right', 'Return', 'Escape', 'space', 'Tab', 'BackSpace', 'Shift_L', 'Control_L', 'Alt_L',
        *[chr(c) for c in range(ord('a'), ord('z') + 1)], *[str(d) for d in range(10)], *[f'F{i}' for i in range(1, 13)]}
PAD_BUTTONS = {'up', 'down', 'left', 'right', 'a', 'b', 'start'}
DEFAULT_PAD = {'up': 'Up', 'down': 'Down', 'left': 'Left', 'right': 'Right', 'a': 'Return', 'b': 'Escape', 'start': 'Escape'}
MAX_FILES = 200_000
MAX_TOTAL = 256 * 1024 ** 3


class ManifestError(ValueError):
    pass


def rel_path(p, what, allow_empty=False):
    if not isinstance(p, str):
        raise ManifestError(f'{what} must be a string')
    p = p.replace('\\', '/').strip()
    if p in ('', '.'):
        if allow_empty:
            return ''
        raise ManifestError(f'{what} is empty')
    if len(p) > 260 or p.startswith('/') or re.match(r'^[A-Za-z]:', p) or '\x00' in p:
        raise ManifestError(f'{what} must be a relative path inside the game')
    segs = p.split('/')
    for s in segs:
        if s in ('', '.', '..') or not SEG_RE.match(s) or s.split('.')[0].lower() in RESERVED or s.endswith(('.', ' ')):
            raise ManifestError(f'{what} has an invalid segment: {s!r}')
    return '/'.join(segs)


FULL_PAD = ['up', 'down', 'left', 'right', 'cross', 'circle', 'square', 'triangle', 'l1', 'r1', 'l2', 'r2', 'select', 'start', 'l3', 'r3']
# Analog sticks (full deflection per direction), bound to keys the emulator profiles map to stick directions.
STICKS = ['lup', 'ldown', 'lleft', 'lright', 'rup', 'rdown', 'rleft', 'rright']
DEFAULT_STICKS = {'lup': 'i', 'ldown': 'k', 'lleft': 'j', 'lright': 'l', 'rup': 'w', 'rdown': 's', 'rleft': 'a', 'rright': 'd'}
DEFAULT_FULL_PAD = {'up': 'Up', 'down': 'Down', 'left': 'Left', 'right': 'Right', 'cross': 'x', 'circle': 'c', 'square': 'z', 'triangle': 'v',
                    'l1': 'q', 'r1': 'e', 'l2': '1', 'r2': '3', 'select': 'BackSpace', 'start': 'Return', 'l3': 'f', 'r3': 'g'}
# Same table as server/lib/manifest.mjs EMULATOR_PLATFORMS: the emulator is fixed per platform.
EMULATOR_PLATFORMS = {
    'ps2': {'emulator': 'pcsx2', 'boot': re.compile(r'\.(iso|chd|cue)$', re.I), 'ram': 4096, 'cpus': 2, 'storageMB': 8192},
    'ps3': {'emulator': 'rpcs3', 'boot': re.compile(r'(^|/)EBOOT\.BIN$|\.iso$', re.I), 'ram': 8192, 'cpus': 4, 'storageMB': 65536},
}


def _files(m, out):
    files = m.get('files')
    if not isinstance(files, list) or not files or len(files) > MAX_FILES:
        raise ManifestError('files must be a non-empty list')
    seen, total, norm_files = set(), 0, []
    for f in files:
        if not isinstance(f, dict):
            raise ManifestError('file entry must be an object')
        path = rel_path(f.get('path'), 'file path')
        key = path.lower()
        if key in seen:
            raise ManifestError(f'duplicate file {path}')
        seen.add(key)
        size, chunks = f.get('size'), f.get('chunks')
        if not isinstance(size, int) or size < 0:
            raise ManifestError(f'bad size for {path}')
        if not isinstance(chunks, list) or (size > 0 and not chunks) or not all(isinstance(c, str) and SHA_RE.match(c) for c in chunks):
            raise ManifestError(f'bad chunks for {path}')
        total += size
        norm_files.append({'path': path, 'size': size, 'chunks': list(chunks)})
    if total > MAX_TOTAL:
        raise ManifestError('game too large')
    out['files'] = norm_files
    return seen


def _common(m, out, d_ram, d_cpus, d_storage):
    if m.get('network', False) is not False:
        raise ManifestError('network access is not permitted for games')
    out['network'] = False
    req = m.get('requirements') or {}
    if not isinstance(req, dict):
        raise ManifestError('requirements must be an object')
    ram, gpu, cpus = req.get('ram', d_ram), req.get('gpu', True), req.get('cpus', d_cpus)
    storage, minutes = req.get('storageMB', d_storage), req.get('maxMinutes', 240)
    if not isinstance(ram, int) or not 128 <= ram <= 65536:
        raise ManifestError('requirements.ram must be 128..65536 MB')
    if not isinstance(gpu, bool):
        raise ManifestError('requirements.gpu must be boolean')
    if not isinstance(cpus, (int, float)) or not 0.25 <= cpus <= 32:
        raise ManifestError('requirements.cpus must be 0.25..32')
    if not isinstance(storage, int) or not 64 <= storage <= 262144:
        raise ManifestError('requirements.storageMB must be 64..262144')
    if not isinstance(minutes, (int, float)) or not 0.05 <= minutes <= 1440:
        raise ManifestError('requirements.maxMinutes out of range')
    out['requirements'] = {'ram': ram, 'gpu': gpu, 'cpus': cpus, 'storageMB': storage, 'maxMinutes': minutes}
    d = m.get('display') or {'width': 1280, 'height': 720}
    if not isinstance(d, dict) or not all(isinstance(d.get(k), int) for k in ('width', 'height')) \
            or not (320 <= d['width'] <= 3840 and 240 <= d['height'] <= 2160):
        raise ManifestError('display must be 320x240..3840x2160')
    out['display'] = {'width': d['width'] & ~1, 'height': d['height'] & ~1}


def _validate_emulator(m, out):
    plat = EMULATOR_PLATFORMS.get(m.get('platform'))
    if not plat:
        raise ManifestError(f'platform must be one of {"|".join(EMULATOR_PLATFORMS)}')
    if m.get('emulator', plat['emulator']) != plat['emulator']:
        raise ManifestError(f'emulator for {m["platform"]} must be {plat["emulator"]}')
    out.update(type='emulator', platform=m['platform'], emulator=plat['emulator'])
    seen = _files(m, out)
    boot = rel_path(m.get('boot'), 'boot')
    if not plat['boot'].search(boot):
        raise ManifestError(f'boot is not a valid {m["platform"]} boot file')
    if boot.lower() not in seen:
        raise ManifestError('boot is not part of the game files')
    out['boot'] = boot
    if 'args' in m and m['args'] != []:
        raise ManifestError('emulator titles take no arguments')
    _common(m, out, plat['ram'], plat['cpus'], plat['storageMB'])
    cm = m.get('controllerMap') or {}
    if not isinstance(cm, dict):
        raise ManifestError('controllerMap must be an object')
    pad = {**DEFAULT_FULL_PAD, **DEFAULT_STICKS}
    for k, v in cm.items():
        if (k not in FULL_PAD and k not in STICKS) or v not in KEYS:
            raise ManifestError(f'controllerMap {k}->{v} not allowed')
        pad[k] = v
    out['controllerMap'] = pad
    return out


def validate(m, *, allow_network=False):
    if not isinstance(m, dict):
        raise ManifestError('manifest must be an object')
    out = {}
    if not isinstance(m.get('id'), str) or not ID_RE.match(m['id']):
        raise ManifestError('id must match ^[a-z0-9][a-z0-9-]{0,63}$')
    out['id'] = m['id']
    out['title'] = str(m.get('title') or m['id'])[:80]
    if m.get('type') == 'emulator':
        return _validate_emulator(m, out)
    if m.get('type') != 'windows':
        raise ManifestError('type must be "windows" or "emulator"')
    if m.get('runtime') != 'wine':
        raise ManifestError('runtime must be "wine"')
    out['type'], out['runtime'] = 'windows', 'wine'

    files = m.get('files')
    if not isinstance(files, list) or not files or len(files) > MAX_FILES:
        raise ManifestError('files must be a non-empty list')
    seen, total, norm_files = set(), 0, []
    for f in files:
        if not isinstance(f, dict):
            raise ManifestError('file entry must be an object')
        path = rel_path(f.get('path'), 'file path')
        key = path.lower()  # Windows paths are case-insensitive: reject collisions
        if key in seen:
            raise ManifestError(f'duplicate file {path}')
        seen.add(key)
        size, chunks = f.get('size'), f.get('chunks')
        if not isinstance(size, int) or size < 0:
            raise ManifestError(f'bad size for {path}')
        if not isinstance(chunks, list) or (size > 0 and not chunks) or not all(isinstance(c, str) and SHA_RE.match(c) for c in chunks):
            raise ManifestError(f'bad chunks for {path}')
        total += size
        norm_files.append({'path': path, 'size': size, 'chunks': list(chunks)})
    if total > MAX_TOTAL:
        raise ManifestError('game too large')
    out['files'] = norm_files

    archive = m.get('archive')
    is_archive = isinstance(archive, dict)
    if is_archive:
        fmt = str(archive.get('format', ''))
        if fmt not in {'zip', 'rar'}:
            raise ManifestError('archive.format must be zip or rar')
        ap = rel_path(archive.get('path'), 'archive.path')
        if ap.lower() not in seen:
            raise ManifestError('archive.path is not part of the game files')
        out['archive'] = {'path': ap, 'format': fmt}
    exe = rel_path(m.get('executable'), 'executable', allow_empty=is_archive)
    if is_archive and not exe:
        out['executable'] = '__AUTO__'
        out['workingDirectory'] = ''
    else:
        if not exe.lower().endswith('.exe'):
            raise ManifestError('executable must be a .exe')
        if exe.lower() not in seen:
            raise ManifestError('executable is not part of the game files')
        out['executable'] = exe
        wd = rel_path(m.get('workingDirectory', exe.rsplit('/', 1)[0] if '/' in exe else ''), 'workingDirectory', allow_empty=True)
        if wd and not any(p.lower().startswith(wd.lower() + '/') for p in seen):
            raise ManifestError('workingDirectory does not exist in the game')
        out['workingDirectory'] = wd

    args = m.get('args', [])
    if not isinstance(args, list) or len(args) > 16 or not all(isinstance(a, str) and ARG_RE.match(a) for a in args):
        raise ManifestError('args must be up to 16 plain strings')
    out['args'] = list(args)

    net = m.get('network', False)
    if net is not False and not (allow_network and net is True):
        raise ManifestError('network access is not permitted for games')
    out['network'] = bool(net)

    req = m.get('requirements') or {}
    if not isinstance(req, dict):
        raise ManifestError('requirements must be an object')
    ram = req.get('ram', 2048)
    if not isinstance(ram, int) or not 128 <= ram <= 65536:
        raise ManifestError('requirements.ram must be 128..65536 MB')
    gpu = req.get('gpu', True)
    if not isinstance(gpu, bool):
        raise ManifestError('requirements.gpu must be boolean')
    cpus = req.get('cpus', 2)
    if not isinstance(cpus, (int, float)) or not 0.25 <= cpus <= 32:
        raise ManifestError('requirements.cpus must be 0.25..32')
    storage = req.get('storageMB', 2048)
    if not isinstance(storage, int) or not 64 <= storage <= 262144:
        raise ManifestError('requirements.storageMB must be 64..262144')
    minutes = req.get('maxMinutes', 240)
    if not isinstance(minutes, (int, float)) or not 0.05 <= minutes <= 1440:
        raise ManifestError('requirements.maxMinutes out of range')
    out['requirements'] = {'ram': ram, 'gpu': gpu, 'cpus': cpus, 'storageMB': storage, 'maxMinutes': minutes}

    g = m.get('graphics', 'auto')
    if g not in GRAPHICS:
        raise ManifestError(f'graphics must be one of {sorted(GRAPHICS)}')
    out['graphics'] = g
    a = m.get('arch', 'auto')
    if a not in ARCH:
        raise ManifestError('arch must be auto|x64|x86')
    out['arch'] = a

    pad = dict(DEFAULT_PAD)
    cm = m.get('controllerMap') or {}
    if not isinstance(cm, dict):
        raise ManifestError('controllerMap must be an object')
    for k, v in cm.items():
        if k not in PAD_BUTTONS or v not in KEYS:
            raise ManifestError(f'controllerMap {k}->{v} not allowed')
        pad[k] = v
    out['controllerMap'] = pad
    d = m.get('display') or {'width': 1280, 'height': 720}
    if not isinstance(d, dict) or not all(isinstance(d.get(k), int) for k in ('width', 'height')) \
            or not (320 <= d['width'] <= 3840 and 240 <= d['height'] <= 2160):
        raise ManifestError('display must be 320x240..3840x2160')
    out['display'] = {'width': d['width'] & ~1, 'height': d['height'] & ~1}
    return out


def manifest_hash(m):
    """Content identity of the game layer: changes only when files change (not title/limits)."""
    body = json.dumps([[f['path'], f['size'], f['chunks']] for f in m['files']], separators=(',', ':'), ensure_ascii=False)
    return hashlib.sha256(body.encode()).hexdigest()


def win_path(rel):
    return 'C:\\Game' + ('\\' + rel.replace('/', '\\') if rel else '')
