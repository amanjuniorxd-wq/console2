"""Runtime + Wine layer: one immutable, pre-initialised Wine prefix per (Wine, DXVK, VKD3D-Proton) version set.

Built once per worker, shared read-only by every session through an overlay; each session only writes its own
upper directory. This removes the ~10–30 s `wineboot` cost and ~1 GB of per-session disk from every launch.
"""
import glob
import os
import re
import shutil
import subprocess
import time


def wine_version():
    try:
        return re.sub(r'[^\w.\-]', '', subprocess.run(['wine', '--version'], capture_output=True, text=True, timeout=30).stdout.strip().split()[0])
    except Exception:
        return None


def _ver(d):
    return os.path.basename(d.rstrip('/')) if d and os.path.isdir(d) else None


class Layers:
    def __init__(self, root, game_uid, dxvk_dir=None, vkd3d_dir=None):
        self.root = os.path.join(root, 'layers')
        os.makedirs(self.root, exist_ok=True)
        os.chmod(self.root, 0o711)
        self.uid = game_uid
        self.dxvk = dxvk_dir if dxvk_dir and os.path.isdir(dxvk_dir) else None
        self.vkd3d = vkd3d_dir if vkd3d_dir and os.path.isdir(vkd3d_dir) else None
        self.wine = wine_version()

    @property
    def key(self):
        parts = [self.wine or 'nowine']
        if self.dxvk:
            parts.append(_ver(self.dxvk))
        if self.vkd3d:
            parts.append(_ver(self.vkd3d))
        return '+'.join(parts)

    def info(self):
        return {'key': self.key, 'wine': self.wine, 'dxvk': _ver(self.dxvk), 'vkd3d': _ver(self.vkd3d),
                'ready': os.path.exists(os.path.join(self.root, self.key, '.complete'))}

    def prefix(self):
        return os.path.join(self.root, self.key, 'prefix')

    def ensure(self, log=print):
        if not self.wine:
            raise RuntimeError('Wine is not installed on this worker')
        base = os.path.join(self.root, self.key)
        if os.path.exists(os.path.join(base, '.complete')):
            return self.prefix()
        log(f'building runtime layer {self.key}')
        t0 = time.time()
        tmp = base + '.build'
        shutil.rmtree(tmp, ignore_errors=True)
        os.makedirs(tmp)
        pfx = os.path.join(tmp, 'prefix')
        env = {'PATH': '/usr/bin:/bin', 'HOME': tmp, 'WINEPREFIX': pfx, 'WINEDEBUG': '-all',
               'WINEDLLOVERRIDES': 'mscoree,mshtml=;winemenubuilder.exe=d', 'WINEARCH': 'win64'}
        disp = None
        xvfb = shutil.which('Xvfb')
        if xvfb:
            dnum = 99 + (os.getpid() % 50)
            disp = subprocess.Popen([xvfb, f':{dnum}', '-nolisten', 'tcp', '-screen', '0', '640x480x24'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            env['DISPLAY'] = f':{dnum}'
            time.sleep(1)
        try:
            subprocess.run(['wineboot', '-i'], env=env, check=True, timeout=600, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            subprocess.run(['wineserver', '-w'], env=env, timeout=120)
        finally:
            if disp:
                disp.terminate()
        sys32 = os.path.join(pfx, 'drive_c', 'windows', 'system32')
        wow = os.path.join(pfx, 'drive_c', 'windows', 'syswow64')
        # Translation layers are installed as files; each launch selects them per game with DLL overrides,
        # so wined3d stays available for titles where DXVK is not appropriate.
        for src, sub64, sub32 in ((self.dxvk, 'x64', 'x32'), (self.vkd3d, 'x64', 'x86')):
            if not src:
                continue
            for dll in glob.glob(os.path.join(src, sub64, '*.dll')):
                shutil.copy2(dll, sys32)
            if os.path.isdir(wow):
                for dll in glob.glob(os.path.join(src, sub32, '*.dll')):
                    shutil.copy2(dll, wow)
        # Hardening: no drive letter mapped to the (sandbox) filesystem root.
        z = os.path.join(pfx, 'dosdevices', 'z:')
        if os.path.islink(z):
            os.remove(z)
        for d, dirs, files in os.walk(tmp):
            for n in dirs + files:
                p = os.path.join(d, n)
                os.lchown(p, self.uid, self.uid)
        os.chown(tmp, self.uid, self.uid)
        os.chown(pfx, self.uid, self.uid)
        os.chmod(tmp, 0o711)
        shutil.rmtree(base, ignore_errors=True)
        os.rename(tmp, base)
        with open(os.path.join(base, '.complete'), 'w') as f:
            f.write(str(time.time()))
        log(f'runtime layer ready in {time.time() - t0:.1f}s')
        return self.prefix()


def dll_overrides(graphics, have_dxvk, have_vkd3d):
    """Per-game translation layer selection (no registry edits, no shared state)."""
    base = 'mscoree,mshtml=;winemenubuilder.exe=d;winedbg.exe=d'
    if graphics in ('wined3d', 'gdi') or (graphics == 'dxvk' and not have_dxvk):
        return base + ';d3d8,d3d9,d3d10core,d3d11,dxgi,d3d12,d3d12core=b'
    parts = []
    if have_dxvk and graphics in ('auto', 'dxvk', 'vkd3d'):
        parts.append('d3d8,d3d9,d3d10core,d3d11,dxgi=n,b')
    if have_vkd3d and graphics in ('auto', 'vkd3d'):
        parts.append('d3d12,d3d12core=n,b')
    return ';'.join([base] + parts)
