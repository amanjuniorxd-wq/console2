"""Emulator self-test at worker startup: prove the emulator really runs here before the worker reports it.

For each emulator profile with a `selfTest` block, the worker boots the emulator in a throwaway sandbox exactly like
a session (same isolation, overlays, display server), waits for its window and for a real rendered frame (pixels, not
a black screen), measures the timings, then shuts it down. The result is reported to the scheduler; the console shows
READY only for a profile that passed with real user firmware/BIOS installed.

    "selfTest": { "argv": ["{binary}", "--nogui", "--nodisc"], "title": "Slot:", "seconds": 40 }
"""
import os
import re
import secrets
import shutil
import tempfile
import time

from .sandbox import Sandbox


def _frame_stats(display, w, h):
    """Distinct colours, non-black pixels and a digest of a sampled screenshot of the session display."""
    import hashlib
    from Xlib import X, display as xdisplay
    d = xdisplay.Display(f':{display}')
    try:
        raw = d.screen().root.get_image(0, 0, w, h, X.ZPixmap, 0xffffffff).data
    finally:
        d.close()
    colours, lit = set(), 0
    for i in range(0, len(raw), 4 * 97):            # ~1% sample
        px = raw[i:i + 3]
        colours.add(bytes(px))
        if max(px) > 24:
            lit += 1
    return len(colours), lit, hashlib.sha1(raw).hexdigest()


def _windows(display):
    from Xlib import X, display as xdisplay
    d = xdisplay.Display(f':{display}')
    try:
        out = []
        for win in d.screen().root.query_tree().children:
            if win.get_attributes().map_state == X.IsViewable:
                n = win.get_wm_name()
                if n:
                    out.append(n if isinstance(n, str) else n.decode('utf-8', 'replace'))
        return out
    finally:
        d.close()


def run(worker, profile, display):
    spec = profile.spec.get('selfTest')
    if not spec:
        return {'ok': False, 'detail': 'no self-test defined'}
    allow = bool(getattr(worker.cfg, 'allow_test_firmware', False))
    fw = profile.firmware_status()
    if not profile.available():
        return {'ok': False, 'detail': 'emulator not installed (binary or libraries missing)', 'firmware': fw['state']}
    if not profile.runnable(allow):
        return {'ok': False, 'detail': f"firmware {fw['state']}: {fw['detail']}", 'firmware': fw['state']}
    w, h = 640, 480
    sid = f'selftest-{profile.name}-{secrets.token_hex(4)}'
    sb = Sandbox(worker.cfg, sid, display, {'ram': int(spec.get('ram', 2048)), 'cpus': 2, 'storageMB': 1024, 'fileMB': int(profile.spec.get('maxFileMB', 0))})
    empty = tempfile.mkdtemp(prefix='mishrin-selftest-', dir=os.path.join(worker.cfg.data))
    os.chown(empty, worker.cfg.game_uid, worker.cfg.game_uid)
    res = {'ok': False, 'firmware': fw['state'], 'firmwareDetail': fw['detail'], 'version': profile.spec.get('version', '')}
    t0 = time.time()
    try:
        sb.prepare_storage()
        sb.mount_layers(profile.runtime_layer(worker.log), empty, profile.game_mount)
        sb.start_display(w, h)
        binpath = profile.binary if profile.system_binary else '/opt/emu/' + os.path.relpath(profile.binary, profile.dir)
        argv = [binpath if a == '{binary}' else a for a in spec['argv']]

        class _S:  # launch_spec only needs display + manifest-like fields for env
            pass
        s = _S()
        s.display, s.manifest, s.pulse = display, {'boot': '', 'controllerMap': {}}, None
        _, env, wd = profile.launch_spec(s)
        t_launch = time.time()
        proc = sb.launch(argv, env, wd, None, log_name='selftest.log', extra_ro=profile.extra_ro)
        title_re = re.compile(spec.get('title', '.'))
        deadline = t_launch + float(spec.get('seconds', 40))
        t_window = t_frame = first_digest = None
        while time.time() < deadline:
            if proc.poll() is not None:
                res['detail'] = f'emulator exited (code {proc.returncode}) during self-test'
                break
            if t_window is None and any(title_re.search(n) for n in _windows(display)):
                t_window = time.time()
            if t_window is not None:
                colours, lit, digest = _frame_stats(display, w, h)
                if colours >= 3 and lit > 0:
                    t_frame = t_frame or time.time()
                    first_digest = first_digest or digest
                    if digest != first_digest:          # the picture changes: the program is running, not a still image
                        res.update(ok=True, colours=colours, frameUpdates=True)
                        break
                else:
                    t_frame = first_digest = None
            time.sleep(0.25)
        else:
            res['detail'] = 'no window' if t_window is None else 'window but no rendered frame' if t_frame is None else 'frame never changed (program not running)'
        res['emulatorStartMs'] = round(((t_window or time.time()) - t_launch) * 1000)
        if t_frame and res['ok']:
            res['firstFrameMs'] = round((t_frame - t_launch) * 1000)
            res['detail'] = f"window '{[n for n in _windows(display) if title_re.search(n)][:1]}' and rendered, changing frames"
    except Exception as e:
        res['detail'] = f'self-test error: {e}'
    if not res['ok']:
        try:   # keep the emulator's last words for the operator
            with open(os.path.join(sb.dir, 'selftest.log'), 'rb') as f:
                f.seek(0, 2); f.seek(max(0, f.tell() - 1500))
                res['log'] = f.read().decode('utf-8', 'replace')[-1500:]
            worker.log(f'self-test {profile.name} log tail:\n{res["log"]}')
        except Exception:
            pass
    try:
        sb.destroy()
    except Exception:
        pass
    shutil.rmtree(empty, ignore_errors=True)
    res['seconds'] = round(time.time() - t0, 1)
    res['ts'] = int(time.time())
    return res
