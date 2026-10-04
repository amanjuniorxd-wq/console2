// MPC worker selection: pure function so it can be unit-tested.
// Hard filters: alive, runtime, free slot, free RAM, Vulkan for GPU titles, not excluded (failed/dead).
// Score: cache affinity (game layer already on the worker → no download, instant start), hardware GPU and
// encoder, then lowest load. Ties break toward the least-busy worker.
export const WORKER_TIMEOUT = +(globalThis.process?.env?.WORKER_TIMEOUT_MS || 15_000);

export function alive(w, now = Date.now()) {
  if (w.kind === 'worker') return now - w.lastBeat < WORKER_TIMEOUT && !w.dead;
  return !!w.waiter || now - w.seen < 5000; // legacy long-poll node (server/host.html)
}

export function freeRamMB(w) {
  const total = w.caps?.resources?.ramMB;
  return total ? total - (w.reservedRam || 0) - 1024 : Infinity; // keep 1 GB for the worker itself
}

export function score(w, need) {
  let s = 0;
  const cached = w.caps?.cache?.games || [];
  if (need.manifestHash && cached.includes(need.manifestHash)) s += 50;
  if (need.gpu && w.caps?.resources?.gpu?.hardware) s += 30;
  if (w.caps?.hardwareEncoders?.length) s += 15;
  s -= (w.load || 0) * 20;
  s -= (w.active.size / Math.max(1, w.capacity)) * 25;
  return s;
}

/** Detected capabilities a runtime needs on the worker (flags come from real detection in the worker; see capabilities()).
 *  A worker running a declared mock emulator (test double) is accepted for that runtime only via flags.mockRuntimes. */
export const RUNTIME_NEEDS = { ps2: ['pcsx2'], psp: ['ppsspp'] };
export function capable(w, rt) {
  const f = w.caps?.flags, needs = RUNTIME_NEEDS[rt];
  if (!needs || !f || w.kind !== 'worker') return true;            // Windows/x86 or legacy nodes: the runtime list is authoritative
  if ((f.mockRuntimes || []).includes(rt)) return true;
  return needs.every(n => n === 'graphics' ? (f.vulkan || f.opengl) : !!f[n]);
}

export function selectWorker(workers, need, now = Date.now()) {
  const ok = [...workers].filter(w =>
    alive(w, now) &&
    w.runtimes.has(need.runtime) && capable(w, need.runtime) &&
    w.active.size + (w.holds?.size || 0) < w.capacity &&       // slots held for queued players count as taken
    !need.exclude?.has(w.id) &&
    (!need.ramMB || freeRamMB(w) >= need.ramMB) &&
    (!need.gpu || w.kind !== 'worker' || w.caps?.resources?.gpu?.available));
  ok.sort((a, b) => score(b, need) - score(a, need) || a.active.size - b.active.size);
  return ok[0] || null;
}
