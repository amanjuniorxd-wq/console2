// Mishrin emulator audio: plays interleaved int16 stereo from the emulator worker, resampled to the device rate.
// Input arrives either through a SharedArrayBuffer ring (cross-origin isolated pages: no copies, no main-thread hop)
// or as transferred chunks on a MessagePort. Underruns output silence; overruns drop the oldest audio.
class MishrinAudio extends AudioWorkletProcessor {
  constructor(opts) {
    super();
    const o = opts.processorOptions || {};
    this.base = (o.inRate || 44100) / sampleRate; this.ratio = this.base;
    // Jitter buffer: start (and restart after a starve) only once ~50 ms is queued; then hold that level by
    // nudging the resampling ratio ±0.5% (emulator clock vs audio device clock drift), inaudible as pitch.
    this.target = Math.round((o.inRate || 44100) * 0.05); this.starved = true; this.events = 0;
    this.pos = 0;
    this.q = []; this.qOff = 0; this.queued = 0;
    this.maxQueued = Math.round((o.inRate || 44100) * 2 * 0.25); // ≤250 ms buffered
    if (o.sab) { this.ring = new Int16Array(o.sab, 8); this.ctl = new Int32Array(o.sab, 0, 2); }
    this.port.onmessage = e => {
      if (e.data instanceof Int16Array) {
        this.q.push(e.data); this.queued += e.data.length; this.received += e.data.length / 2;
        while (this.queued > this.maxQueued && this.q.length > 1) { const d = this.q.shift(); this.queued -= d.length - this.qOff; this.qOff = 0; }
      } else if (e.data && e.data.q === 'stats') {
        const fill = this.ring ? ((Atomics.load(this.ctl, 0) - Atomics.load(this.ctl, 1) + this.ring.length) % this.ring.length) : this.queued;
        this.port.postMessage({ stats: { bufferedMs: Math.round(fill / 2 / (this.base * sampleRate) * 1000), underruns: this.events, starvedSamples: this.under, received: this.received, played: this.played, sab: !!this.ring, rate: sampleRate, ratio: +(this.ratio / this.base).toFixed(4) } });
      } else if (e.data && e.data.port) { e.data.port.onmessage = ev => this.port.onmessage({ data: ev.data }); }
    };
    this.l0 = 0; this.r0 = 0; this.l1 = 0; this.r1 = 0; this.under = 0; this.received = 0; this.played = 0;
  }
  next() { // next stereo input frame → this.l1/r1
    this.l0 = this.l1; this.r0 = this.r1;
    if (this.ring) {
      const cap = this.ring.length, w = Atomics.load(this.ctl, 0); let r = Atomics.load(this.ctl, 1);
      if (r === w || (r + 1) % cap === w) { this.under++; if (!this.starved) { this.starved = true; this.events++; } return; }
      this.l1 = this.ring[r] / 32768; this.r1 = this.ring[(r + 1) % cap] / 32768; this.received++;
      Atomics.store(this.ctl, 1, (r + 2) % cap);
      return;
    }
    while (this.q.length && this.qOff >= this.q[0].length) { this.q.shift(); this.qOff = 0; }
    if (!this.q.length) { this.under++; if (!this.starved) { this.starved = true; this.events++; } return; }
    const d = this.q[0]; this.l1 = d[this.qOff] / 32768; this.r1 = d[this.qOff + 1] / 32768; this.qOff += 2; this.queued -= 2;
  }
  fill() { return (this.ring ? ((Atomics.load(this.ctl, 0) - Atomics.load(this.ctl, 1) + this.ring.length) % this.ring.length) : this.queued) / 2; }
  process(_in, outputs) {
    const out = outputs[0], L = out[0], R = out[1] || out[0];
    const f0 = this.fill();
    if (this.starved) {
      if (f0 < this.target) { L.fill(0); if (R !== L) R.fill(0); return true; }  // prebuffering: silence, no clicks
      this.starved = false;
    }
    const err = (f0 - this.target) / this.target;
    this.ratio = this.base * (1 + Math.max(-0.005, Math.min(0.005, err * 0.005)));
    this.played += L.length;
    for (let i = 0; i < L.length; i++) {
      this.pos += this.ratio;
      while (this.pos >= 1) { this.pos -= 1; this.next(); }
      const f = this.pos;
      L[i] = this.l0 + (this.l1 - this.l0) * f; R[i] = this.r0 + (this.r1 - this.r0) * f;
    }
    return true;
  }
}
registerProcessor('mishrin-audio', MishrinAudio);
