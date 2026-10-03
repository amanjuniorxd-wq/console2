"""MPC worker store: content-addressed chunks + immutable game layers.

* Chunks are stored once by SHA-256 (dedup across games, versions and sessions).
* Only missing chunks are fetched (lazy + delta: a new game version downloads changed chunks only).
* A game layer (the assembled read-only game directory) is keyed by the manifest's content hash and reused
  by every session of that version. Single-chunk files are hard links to the chunk (no copy, no extra disk).
* Unreferenced layers/chunks are evicted LRU when over the disk budget.
"""
import hashlib
import json
import os
import shutil
import threading
import time
from concurrent.futures import ThreadPoolExecutor

from .manifest import manifest_hash


class Store:
    def __init__(self, root, fetch, budget_bytes=200 * 1024 ** 3, parallel=4, owner_uid=None):
        # Files are owned by the sandbox uid so overlay copy-up keeps them writable *inside a session*;
        # the shared lower layer itself is never writable through the overlay.
        self.uid = owner_uid
        self.cas = os.path.join(root, 'cas')
        self.games = os.path.join(root, 'games')
        for d in (self.cas, self.games):
            os.makedirs(d, exist_ok=True)
        os.chmod(root, 0o711)
        os.chmod(self.games, 0o711)
        self.fetch = fetch  # fetch(sha) -> bytes
        self.budget = budget_bytes
        self.parallel = parallel
        self.refs = {}  # game layer hash -> active session count
        self.lock = threading.Lock()
        self.building = {}
        self.stats = {'chunks_fetched': 0, 'chunks_reused': 0, 'bytes_fetched': 0, 'layers_built': 0, 'layers_reused': 0}

    def chunk_path(self, sha):
        return os.path.join(self.cas, sha[:2], sha)

    def has_chunk(self, sha):
        return os.path.exists(self.chunk_path(sha))

    def put_chunk(self, sha, data):
        if hashlib.sha256(data).hexdigest() != sha:
            raise ValueError(f'chunk {sha[:12]} failed integrity check')
        p = self.chunk_path(sha)
        os.makedirs(os.path.dirname(p), exist_ok=True)
        tmp = f'{p}.{os.getpid()}.{threading.get_ident()}.tmp'
        with open(tmp, 'wb') as f:
            f.write(data)
        self._own(tmp, 0o644)
        os.replace(tmp, p)

    def ensure_chunks(self, shas, progress=None):
        """Fetch only chunks not already present. Returns (fetched, reused)."""
        missing = sorted({s for s in shas if not self.has_chunk(s)})
        reused = len(set(shas)) - len(missing)
        done = 0

        def one(sha):
            data = self.fetch(sha)
            self.put_chunk(sha, data)
            return len(data)

        with ThreadPoolExecutor(self.parallel) as ex:
            for n in ex.map(one, missing):
                done += 1
                self.stats['bytes_fetched'] += n
                if progress:
                    progress(done, len(missing))
        self.stats['chunks_fetched'] += len(missing)
        self.stats['chunks_reused'] += reused
        return len(missing), reused

    def layer_path(self, mh):
        return os.path.join(self.games, mh)

    def has_layer(self, mh):
        return os.path.exists(self.layer_path(mh) + '.complete') and os.path.isdir(self.layer_path(mh))

    def acquire_layer(self, manifest, progress=None):
        """Return the path of the game's immutable layer, building it if needed. Caller must release()."""
        mh = manifest_hash(manifest)
        with self.lock:
            ev = self.building.get(mh)
            if ev is None and not self.has_layer(mh):
                ev = self.building[mh] = threading.Event()
                owner = True
            else:
                owner = False
            self.refs[mh] = self.refs.get(mh, 0) + 1
        if not owner:
            if ev is not None:
                ev.wait()
            if not self.has_layer(mh):
                self.release(mh)
                raise RuntimeError('game layer build failed')
            self.stats['layers_reused'] += 1
            os.utime(self.layer_path(mh))  # LRU touch
            return mh, self.layer_path(mh)
        try:
            self.ensure_chunks([c for f in manifest['files'] for c in f['chunks']], progress)
            final = self.layer_path(mh)
            tmp = f'{final}.build-{os.getpid()}'
            shutil.rmtree(tmp, ignore_errors=True)
            os.makedirs(tmp)
            for f in manifest['files']:
                dst = os.path.join(tmp, *f['path'].split('/'))
                os.makedirs(os.path.dirname(dst), exist_ok=True)
                if len(f['chunks']) == 1:
                    os.link(self.chunk_path(f['chunks'][0]), dst)  # zero-copy
                else:
                    with open(dst, 'wb') as out:
                        for c in f['chunks']:
                            with open(self.chunk_path(c), 'rb') as src:
                                shutil.copyfileobj(src, out, 1 << 20)
                    self._own(dst, 0o644)
                if os.path.getsize(dst) != f['size']:
                    raise RuntimeError(f'size mismatch for {f["path"]}')
            for d, dirs, _ in os.walk(tmp):
                self._own(d, 0o755)
            os.rename(tmp, final)
            with open(final + '.complete', 'w') as fh:  # marker lives outside the game directory
                json.dump({'built': time.time(), 'files': len(manifest['files'])}, fh)
            self.stats['layers_built'] += 1
            return mh, final
        except Exception:
            self.release(mh)
            raise
        finally:
            with self.lock:
                self.building.pop(mh, None)
            ev.set()

    def _own(self, path, mode):
        if self.uid is not None:
            os.chown(path, self.uid, self.uid)
        os.chmod(path, mode)

    def release(self, mh):
        with self.lock:
            self.refs[mh] = max(0, self.refs.get(mh, 1) - 1)

    def cached_layers(self):
        return [d for d in os.listdir(self.games) if len(d) == 64 and self.has_layer(d)]  # dirs only

    def usage(self):
        total = 0
        for root, _, files in os.walk(self.cas):
            for f in files:
                total += os.path.getsize(os.path.join(root, f))
        return total

    def evict(self):
        """Reclaim disk: drop least-recently-used layers not in use, then chunks no remaining layer needs."""
        if self.usage() <= self.budget:
            return 0
        removed = 0
        layers = sorted(self.cached_layers(), key=lambda d: os.path.getmtime(self.layer_path(d)))
        for mh in layers:
            if self.usage() <= self.budget:
                break
            with self.lock:
                if self.refs.get(mh):
                    continue
            os.remove(self.layer_path(mh) + '.complete')
            shutil.rmtree(self.layer_path(mh), ignore_errors=True)
            removed += 1
        # chunks whose link count is 1 are referenced by no layer (single-chunk files are hard links)
        for root, _, files in os.walk(self.cas):
            for f in files:
                p = os.path.join(root, f)
                if os.stat(p).st_nlink == 1 and self.usage() > self.budget:
                    os.remove(p)
        return removed
