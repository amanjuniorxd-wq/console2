"""Save layer: the part of a session's writable layers that holds the player's progress.

Captured: HKCU registry (user.reg), the Windows user profile (AppData, Documents, Saved Games), ProgramData, and
files the game wrote into its own directory. Excluded: temp files, logs, shader/pipeline caches.
Stored compressed (zstd, else gzip) and content-addressed. Restored into the *unmounted* upper directories before a
launch, with strict member checks — a save blob can never place files outside the two upper directories.
This saves game data on disk (what Windows games themselves persist). It is not a RAM snapshot of the
running process: Load restarts the game from the restored data.
"""
import fnmatch
import io
import os
import shutil
import subprocess
import tarfile

INCLUDE = [('prefix', 'user.reg'), ('prefix', 'drive_c/users'), ('prefix', 'drive_c/ProgramData'), ('game', '')]
EXCLUDE = ['*/Temp/*', '*/temp/*', '*.log', '*.tmp', '*.dxvk-cache', '*.vkd3d-cache*', '*/AppData/Local/Microsoft/*',
           '*/Cache/*', '*/cache/*', '*/ShaderCache/*', '*/INetCache/*']
MAX_SAVE = 2 * 1024 ** 3
ZSTD = shutil.which('zstd')


def _roots(session_dir):
    return {'prefix': os.path.join(session_dir, 'prefix-upper'), 'game': os.path.join(session_dir, 'game-upper')}


def _excluded(rel):
    return any(fnmatch.fnmatch('/' + rel, pat) or fnmatch.fnmatch(rel, pat) for pat in EXCLUDE)


def newest_mtime(session_dir):
    newest = 0.0
    for tag, sub in INCLUDE:
        base = os.path.join(_roots(session_dir)[tag], sub)
        if os.path.isfile(base):
            newest = max(newest, os.path.getmtime(base))
        for d, _, files in os.walk(base):
            for f in files:
                try:
                    newest = max(newest, os.lstat(os.path.join(d, f)).st_mtime)
                except OSError:
                    pass
    return newest


def snapshot(session_dir):
    """Return (blob, raw_bytes, files) — deterministic member order for better dedup."""
    buf = io.BytesIO()
    raw = files = 0
    with tarfile.open(fileobj=buf, mode='w', format=tarfile.PAX_FORMAT) as tar:
        for tag, sub in INCLUDE:
            root = _roots(session_dir)[tag]
            base = os.path.join(root, sub)
            if os.path.isfile(base):
                paths = [base]
            else:
                paths = []
                for d, dirs, fs in os.walk(base):
                    dirs.sort()
                    paths += [os.path.join(d, f) for f in sorted(fs)]
            for p in paths:
                rel = os.path.relpath(p, root).replace(os.sep, '/')
                st = os.lstat(p)
                if not os.path.isfile(p) or os.path.islink(p) or _excluded(rel):  # skips overlay whiteouts too
                    continue
                ti = tarfile.TarInfo(f'{tag}/{rel}')
                ti.size, ti.mtime, ti.mode = st.st_size, int(st.st_mtime), 0o644
                with open(p, 'rb') as fh:
                    tar.addfile(ti, fh)
                raw += st.st_size
                files += 1
                if raw > MAX_SAVE:
                    raise RuntimeError('save data exceeds the 2 GB limit')
    data = buf.getvalue()
    if ZSTD:
        blob = subprocess.run([ZSTD, '-q', '-6', '-c'], input=data, capture_output=True, check=True).stdout
    else:
        import gzip
        blob = gzip.compress(data, 6)
    return blob, raw, files


def _decompress(blob):
    if blob[:4] == b'\x28\xb5\x2f\xfd':
        if not ZSTD:
            raise RuntimeError('zstd save but zstd is not installed')
        return subprocess.run([ZSTD, '-q', '-d', '-c'], input=blob, capture_output=True, check=True).stdout
    if blob[:2] == b'\x1f\x8b':
        import gzip
        return gzip.decompress(blob)
    raise RuntimeError('unknown save format')


def restore(blob, session_dir, uid):
    """Extract into the upper dirs. Only regular files under prefix/ or game/; no links, devices, '..' or absolute paths."""
    roots = _roots(session_dir)
    n = 0
    with tarfile.open(fileobj=io.BytesIO(_decompress(blob)), mode='r:') as tar:
        total = 0
        for m in tar:
            name = m.name
            tag, _, rel = name.partition('/')
            parts = rel.split('/')
            if tag not in roots or not rel or name.startswith('/') or any(p in ('', '.', '..') for p in parts):
                raise RuntimeError(f'unsafe save entry {name!r}')
            if m.isdir():
                continue
            if not m.isfile():
                raise RuntimeError(f'unsafe save entry type {name!r}')
            total += m.size
            if total > MAX_SAVE:
                raise RuntimeError('save too large')
            dst = os.path.join(roots[tag], *parts)
            if not os.path.realpath(dst).startswith(os.path.realpath(roots[tag]) + os.sep):
                raise RuntimeError(f'unsafe save path {name!r}')
            d = os.path.dirname(dst)
            os.makedirs(d, exist_ok=True)
            with tar.extractfile(m) as src, open(dst, 'wb') as out:
                shutil.copyfileobj(src, out)
            os.utime(dst, (m.mtime, m.mtime))
            n += 1
    for root in roots.values():
        for d, dirs, files in os.walk(root):
            for x in dirs + files:
                os.lchown(os.path.join(d, x), uid, uid)
    return n
