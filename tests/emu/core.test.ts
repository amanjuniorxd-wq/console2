// Real-core tests: the shipped public/cores/p1/mishrin-p1.wasm driven through the production P1 backend,
// block cache and read-only WASI layer (src/emu), in Node/V8. Run: npm run test:emu-core
import { readFileSync, openSync, readSync, fstatSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createP1 } from '../../src/emu/backends/p1';
import { PAD } from '../../src/emu/types';
import type { EmulatorBackend, InitOptions } from '../../src/emu/types';

let n = 0, fails = 0;
const ok = (name: string, c: unknown, d = '') => { n++; if (!c) fails++; console.log(`${c ? 'PASS' : 'FAIL'} ${name}${d ? ' — ' + d : ''}`); };

// ---- browser shims: a file-backed Blob + FileReaderSync (the worker's real read path, with real block cache) ----
class FileBlob {
  constructor(public path: string, public start = 0, public end = fstatSync(openSync(path, 'r')).size) {}
  get size() { return this.end - this.start; }
  slice(a = 0, b = this.size) { return new FileBlob(this.path, this.start + a, this.start + Math.min(b, this.size)); }
}
let physicalReads = 0;
(globalThis as any).FileReaderSync = class {
  readAsArrayBuffer(b: FileBlob) { physicalReads++; const fd = openSync(b.path, 'r'); const out = Buffer.alloc(b.size); readSync(fd, out, 0, b.size, b.start); return out.buffer.slice(out.byteOffset, out.byteOffset + b.size); }
};

const core = readFileSync('public/cores/p1/mishrin-p1.wasm');
const manifest = JSON.parse(readFileSync('public/cores/p1/core.json', 'utf8'));
const T = 'emulators/p1/testgame/out/';
const t0 = performance.now();
const module = await WebAssembly.compile(core);
const compileMs = performance.now() - t0;
ok('core matches its manifest (sha256, size)', createHash('sha256').update(core).digest('hex') === manifest.sha256 && core.length === manifest.size, `${(core.length / 1024).toFixed(0)} KB, compile ${compileMs.toFixed(0)} ms`);
const imports = WebAssembly.Module.imports(module);
ok('core imports only WASI (no network, DOM, or host escape)', imports.every(i => i.module === 'wasi_snapshot_preview1'), [...new Set(imports.map(i => i.name))].join(','));
const srcPath = 'public/cores/p1/' + manifest.sourceArchive.replace(/^\/cores\/p1\//, '');
const src = readFileSync(srcPath);
const { execSync } = await import('node:child_process');
const listing = execSync(`tar tJf ${srcPath}`).toString();
ok('GPL: corresponding source shipped beside the core (pinned tree + host + patch + build script + licence)',
  createHash('sha256').update(src).digest('hex') === manifest.sourceSha256 && ['mishrin/host.c', 'mishrin/pcsx-rearmed-wasi.patch', 'mishrin/build-core.sh', 'pcsx_rearmed/COPYING', 'pcsx_rearmed/frontend/libretro.c'].every(f => listing.includes('mishrin-p1-source/' + f))
  && readFileSync('public/cores/p1/COPYING', 'utf8').includes('GNU GENERAL PUBLIC LICENSE'), `${(src.length / 1048576).toFixed(1)} MB archive`);
ok('core ships no BIOS / firmware data', !core.includes(Buffer.from('Sony Computer Entertainment Inc')) && !core.includes(Buffer.from('SCPH')));

async function boot(files: string[], primary: string, card: Uint8Array | null = null, extra: Partial<InitOptions> = {}) {
  const be = createP1();
  const info = await be.initialize({
    platform: 'p1', module, files: files.map(f => ({ name: f, blob: new FileBlob(T + f) as unknown as Blob })), primary, bios: [], card,
    options: {}, presenter: 'canvas2d', scaling: 'pixel', diskCacheMB: 16, maxCatchUp: 3, presentEvery: 1, audio: null, ...extra,
  }, () => {});
  return { be, info };
}
/** Locate the saffron square in the core's RGBA framebuffer. */
function scene(be: EmulatorBackend) {
  const { data, width: w, height: h } = be.framebuffer();
  let n = 0, x0 = w, y0 = h, gold = 0, green = 0;
  for (let i = 0; i < w * h; i++) {
    const R = data[i * 4], G = data[i * 4 + 1], B = data[i * 4 + 2];
    if (R > 220 && G > 100 && G < 170 && B < 50) { n++; x0 = Math.min(x0, i % w); y0 = Math.min(y0, (i / w) | 0); }
    else if (R > 190 && G > 150 && G < 200 && B < 90) gold++;
    else if (R < 40 && G > 200 && B < 40) green++;
  }
  return { w, h, box: n, x: x0, y: y0, gold, green, hash: createHash('sha1').update(data).digest('hex').slice(0, 12) };
}
const run = (be: EmulatorBackend, frames: number, mask = 0) => { for (let i = 0; i < frames; i++) { be.setControllerInput(0, mask); be.runFrame(); } };
const tap = (be: EmulatorBackend, bit: number) => { run(be, 2, 1 << bit); run(be, 2, 0); };

// ---- every supported container boots the same program ----
for (const [label, files, primary] of [['PS-X EXE', ['saffron-pulse.exe'], 'saffron-pulse.exe'], ['CUE+BIN', ['saffron-pulse.cue', 'saffron-pulse.bin'], 'saffron-pulse.cue'],
  ['ISO', ['saffron-pulse.iso'], 'saffron-pulse.iso'], ['CHD', ['saffron-pulse.chd'], 'saffron-pulse.chd'], ['BIN (no CUE)', ['saffron-pulse.bin'], 'saffron-pulse.bin'],
  ['M3U playlist', ['saffron-pulse.m3u', 'saffron-pulse.cue', 'saffron-pulse.bin'], 'saffron-pulse.m3u']] as const) {
  try {
    const { be, info } = await boot([...files], primary);
    run(be, 150);
    const s = scene(be);
    ok(`boots ${label} on the open HLE BIOS`, s.w === 320 && s.h === 240 && s.box === 1024 && s.x === 144 && s.y === 96 && info.bios === 'open-hle', `${s.w}x${s.h}, square at ${s.x},${s.y}, ${info.fps.toFixed(2)} Hz`);
    be.shutdown();
  } catch (e) { ok(`boots ${label} on the open HLE BIOS`, false, (e as Error).message); }
}

// ---- input, determinism, save states, memory card, reset ----
const { be, info } = await boot(['saffron-pulse.cue', 'saffron-pulse.bin'], 'saffron-pulse.cue');
run(be, 120);
tap(be, PAD.right); tap(be, PAD.right); tap(be, PAD.down);
let s = scene(be);
ok('controller input: D-pad moves the square (16 px per press)', s.x === 176 && s.y === 112, `${s.x},${s.y}`);
tap(be, PAD.cross);
ok('controller input: ✕ scores (gold bar drawn)', scene(be).gold > 0);
// ---- mouse peripheral (the test disc reads a mouse on port 1 via the real pad protocol, device id 0x12) ----
{
  const m = await boot(['saffron-pulse.cue', 'saffron-pulse.bin'], 'saffron-pulse.cue', null, { devices: ['mouse'] });
  run(m.be, 120);
  m.be.setPointerInput!(0, 32, -8, 0); m.be.runFrame(); run(m.be, 3);
  let ms = scene(m.be);
  // (x is drawn with a VRAM fill, which the GPU aligns to 16 px; y is exact)
  ok('mouse on port 1: movement moves the square by the mouse delta', ms.x === 176 && ms.y === 88, `144,96 → ${ms.x},${ms.y}`);
  m.be.setPointerInput!(0, -200, 0, 0); m.be.runFrame(); run(m.be, 3);
  ok('mouse: large deltas are clamped to the device range (±127 per poll)', scene(m.be).x === ((176 - 127) & ~15), `x ${scene(m.be).x} (unclamped would be 0)`);
  m.be.setPointerInput!(0, 0, 0, 1); m.be.runFrame(); m.be.setPointerInput!(0, 0, 0, 0); run(m.be, 3);
  ok('mouse: left button scores', scene(m.be).gold > 0);
  m.be.shutdown();
  const sw = await boot(['saffron-pulse.cue', 'saffron-pulse.bin'], 'saffron-pulse.cue');
  run(sw.be, 120); sw.be.setPortDevice!(0, 'mouse'); run(sw.be, 40); // the core emulates a real re-plug: the port reads as empty for 32 frames
  sw.be.setPointerInput!(0, -16, 16, 0); sw.be.runFrame(); run(sw.be, 3);
  ms = scene(sw.be);
  ok('mouse can be plugged in at runtime (pad → mouse)', ms.x === 128 && ms.y === 112, `${ms.x},${ms.y}`);
  sw.be.setPortDevice!(0, 'pad'); run(sw.be, 40); tap(sw.be, PAD.right);
  ok('…and unplugged again (mouse → pad, D-pad works)', scene(sw.be).x === 144, `x ${scene(sw.be).x}`);
  sw.be.shutdown();
}
let audio = 0;
for (let i = 0; i < 60; i++) { be.runFrame(); audio += be.audio().length / 2; }
ok('audio produced in step with video (~735 stereo frames per video frame)', Math.abs(audio / 60 - info.sampleRate / info.fps) < 40, `${(audio / 60).toFixed(0)} per frame @ ${info.sampleRate} Hz`);

const st = be.saveState();
ok('save state captured', st.length === info.stateSize && st.length > 1 << 20, `${(st.length / 1048576).toFixed(2)} MB raw`);
const script = [PAD.left, PAD.up, PAD.cross, PAD.right];
const playScript = () => { for (const b of script) tap(be, b); run(be, 30); return scene(be).hash; };
const h1 = playScript();
const moved = scene(be);
ok('load state restores the exact machine', be.loadState(st) && (run(be, 0), true));
const h2 = playScript();
ok('deterministic replay after load state (bit-identical frames)', h1 === h2 && scene(be).x === moved.x, `${h1} vs ${h2}`);
const gz = await new Response(new Blob([st]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer();
ok('save states compress well for local storage', gz.byteLength < st.length / 4, `${(st.length / 1048576).toFixed(2)} MB → ${(gz.byteLength / 1024).toFixed(0)} KB gzip`);

const before = be.memoryCard()!.slice();
tap(be, PAD.start);
run(be, 10);
const card = be.memoryCard()!.slice();
const saved = scene(be);
ok('memory card written by the game (128 KB card image changed)', card.length === 131072 && Buffer.compare(Buffer.from(before), Buffer.from(card)) !== 0);
be.reset(); run(be, 120);
ok('reset reboots the program', scene(be).green === 256 && scene(be).x === saved.x, 'card is still inserted → state restored');
be.shutdown();
const fresh = await boot(['saffron-pulse.cue', 'saffron-pulse.bin'], 'saffron-pulse.cue', card);
run(fresh.be, 150);
s = scene(fresh.be);
ok('memory card persists across sessions (progress restored at boot)', s.green === 256 && s.x === saved.x && s.y === saved.y, `${s.x},${s.y}`);
fresh.be.shutdown();

// ---- robustness: damaged images fail cleanly ----
for (const [label, files, primary] of [['truncated BIN', ['truncated.bin'], 'truncated.bin'], ['zero-filled ISO', ['zero.iso'], 'zero.iso']] as const) {
  const { writeFileSync } = await import('node:fs');
  if (label === 'truncated BIN') writeFileSync(T + 'truncated.bin', readFileSync(T + 'saffron-pulse.bin').subarray(0, 2352 * 20));
  else writeFileSync(T + 'zero.iso', Buffer.alloc(2048 * 64));
  try {
    const r = await boot([...files], primary);
    run(r.be, 120);
    const x = scene(r.be);
    ok(`damaged image (${label}) does not crash the worker`, x.box === 0, 'core ran, program absent');
    r.be.shutdown();
  } catch (e) { ok(`damaged image (${label}) rejected cleanly`, /load|image|Not/i.test((e as Error).message), (e as Error).message); }
  (await import('node:fs')).rmSync(T + files[0]);
}

// ---- performance (WASM execution time in V8; the browser worker runs the same code) ----
const perf = await boot(['saffron-pulse.cue', 'saffron-pulse.bin'], 'saffron-pulse.cue');
run(perf.be, 60);
const times: number[] = [];
physicalReads = 0;
for (let i = 0; i < 600; i++) { const a = performance.now(); perf.be.runFrame(); times.push(performance.now() - a); }
times.sort((a, b) => a - b);
const avg = times.reduce((a, b) => a + b) / times.length, p95 = times[Math.floor(times.length * 0.95)], p99 = times[Math.floor(times.length * 0.99)];
const disk = perf.be.diskStats();
ok('runs faster than real time (avg frame < 16.7 ms)', avg < 1000 / 60, `avg ${avg.toFixed(2)} ms · p95 ${p95.toFixed(2)} · p99 ${p99.toFixed(2)} → ${(1000 / avg).toFixed(0)} emulated fps capacity`);
ok('disc streaming: block cache absorbs repeat reads', disk.hit > 0.5 || physicalReads === 0, `${disk.reads} reads, hit ${(disk.hit * 100).toFixed(0)}%, ${physicalReads} physical reads in 600 frames`);
ok('memory: core linear memory', perf.be.memoryBytes() < 64 << 20, `${(perf.be.memoryBytes() / 1048576).toFixed(1)} MB`);
perf.be.shutdown();

console.log(`\n${n - fails}/${n} P1 core checks passed`);
if (fails) process.exit(1);
