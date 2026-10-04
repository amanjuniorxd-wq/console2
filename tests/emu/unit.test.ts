// Emulation subsystem unit tests: detection/validation, optimizer, read-only WASI sandbox.
// Run: npm run test:emu-unit   (bundled with esbuild, executed in Node — no browser needed)
import { readFileSync } from 'node:fs';
import { detect, parseCue } from '../../src/emu/detect';
import { plan, framesDue, adaptPresent, resolveProfile, INTENSITY } from '../../src/mpc/optimizer';
import { ReadOnlyWasi, bytesSource } from '../../src/emu/wasi';
import { CORES } from '../../src/emu/registry';

let n = 0, fails = 0;
const ok = (name: string, c: unknown, d = '') => { n++; if (!c) fails++; console.log(`${c ? 'PASS' : 'FAIL'} ${name}${d ? ' — ' + d : ''}`); };
const T = 'emulators/p1/testgame/';
const file = (path: string, name = path.split('/').pop()!) => new File([readFileSync(path)], name);
const text = (body: string, name: string) => new File([body], name);

// ---------------------------------------------------------------- detection
const cue = file(T + 'out/saffron-pulse.cue'), bin = file(T + 'out/saffron-pulse.bin');
let d = await detect([cue, bin]);
ok('CUE+BIN → Mishrin P1, primary is the CUE, serial from SYSTEM.CNF', d.ok && d.platform === 'p1' && d.format === 'cue+bin' && d.primary === 'saffron-pulse.cue' && d.serial === 'MAIN.EXE', JSON.stringify({ p: d.platform, f: d.format, s: d.serial, e: d.error }));
d = await detect([file(T + 'out/saffron-pulse.iso')]);
ok('ISO (2048-byte sectors) → P1', d.ok && d.platform === 'p1' && d.format === 'iso');
d = await detect([file(T + 'out/saffron-pulse.bin')]);
ok('bare BIN (2352 raw) → P1 with "no CUE" warning', d.ok && d.platform === 'p1' && d.warnings.some(w => /CUE/.test(w)));
d = await detect([file(T + 'out/saffron-pulse.chd')]);
ok('CHD v5 (CD metadata) → P1', d.ok && d.platform === 'p1' && d.format === 'chd');
d = await detect([file(T + 'out/saffron-pulse.exe')]);
ok('PS-X EXE → P1', d.ok && d.platform === 'p1' && d.format === 'exe');
d = await detect([file(T + 'out/saffron-pulse.m3u'), cue, bin]);
ok('M3U playlist (+ CUE + BIN) → P1, playlist is primary', d.ok && d.platform === 'p1' && d.format === 'm3u' && d.primary === 'saffron-pulse.m3u', d.error);
d = await detect([file(T + 'fixtures/p2-layout.iso')]);
ok('DVD layout with BOOT2 → Mishrin P2 (detected, not runnable)', d.ok && d.platform === 'p2' && !CORES.p2.available && CORES.p2.status === 'experimental');
d = await detect([file(T + 'fixtures/p2-layout.chd')]);
ok('CHD with DVD metadata → P2', d.ok && d.platform === 'p2');
d = await detect([file(T + 'fixtures/p3-layout.iso')]);
ok('PS3_GAME layout → refused: "PS3 games are not supported" (PS3 removed, never routed)', !d.ok && /PS3 games are not supported/.test(d.error || '') && !('p3' in CORES));
const PSP = 'emulators/psp/testapp/fixtures/';
d = await detect([file(PSP + 'mishrin-psp-test.iso')]);
ok('PSP UMD ISO (PSP_GAME, UMD_DATA.BIN) → PSP, title from PARAM.SFO, serial (DISC_ID)', d.ok && d.platform === 'psp' && d.title === 'Mishrin PSP Test' && d.serial === 'MSHR00001', JSON.stringify({ p: d.platform, t: d.title, s: d.serial, e: d.error }));
d = await detect([file(PSP + 'mishrin-psp-test.cso')]);
ok('PSP CSO (CISO v1) → PSP: only the needed blocks are inflated', d.ok && d.platform === 'psp' && d.format === 'cso' && d.title === 'Mishrin PSP Test', d.error);
d = await detect([file(PSP + 'MSHRPSP/EBOOT.PBP')]);
ok('PSP EBOOT.PBP (CATEGORY MG) → PSP', d.ok && d.platform === 'psp' && d.format === 'pbp' && d.title === 'Mishrin PSP Test');
{
  const sfo = (cat: string) => { const k = 'CATEGORY\0TITLE\0\0\0'; const v = cat + '\0\0', t = 'Classic\0'; const b = new Uint8Array(20 + 32 + k.length + 4 + 8);
    const dv = new DataView(b.buffer); b.set([0, 0x50, 0x53, 0x46]); dv.setUint32(4, 0x101, true); dv.setUint32(8, 52, true); dv.setUint32(12, 52 + k.length, true); dv.setUint32(16, 2, true);
    dv.setUint16(20, 0, true); dv.setUint16(22, 0x204, true); dv.setUint32(24, 3, true); dv.setUint32(28, 4, true); dv.setUint32(32, 0, true);
    dv.setUint16(36, 9, true); dv.setUint16(38, 0x204, true); dv.setUint32(40, 8, true); dv.setUint32(44, 8, true); dv.setUint32(48, 4, true);
    b.set([...k].map(c => c.charCodeAt(0)), 52); b.set([...v].map(c => c.charCodeAt(0)), 52 + k.length); b.set([...t].map(c => c.charCodeAt(0)), 56 + k.length); return b; };
  const s = sfo('ME'), h = new Uint8Array(40), dv = new DataView(h.buffer); h.set([0, 0x50, 0x42, 0x50]); dv.setUint32(8, 40, true); for (let i = 1; i < 8; i++) dv.setUint32(8 + i * 4, 40 + s.length, true);
  d = await detect([new File([h, s], 'EBOOT.PBP')]);
  ok('PSone classic PBP (CATEGORY ME) → P1 (local), not PSP', d.ok && d.platform === 'p1' && d.title === 'Classic', JSON.stringify({ p: d.platform, t: d.title, e: d.error }));
}
d = await detect([new File([new Uint8Array([0x7f, 0x43, 0x4e, 0x54, 0, 0, 0, 0])], 'game.pkg')]);
ok('PKG with CNT magic → Mishrin P4 (research)', d.ok && d.platform === 'p4' && CORES.p4.status === 'research');

// validation: malformed / malicious input
const rejects: [string, File[]][] = [
  ['CUE referencing a parent directory', [text('FILE "../../etc/passwd" BINARY\n  TRACK 01 MODE2/2352\n', 'evil.cue')]],
  ['CUE whose BIN was not selected', [text('FILE "game.bin" BINARY\n  TRACK 01 MODE2/2352\n', 'game.cue')]],
  ['CUE with an unknown track mode', [text('FILE "saffron-pulse.bin" BINARY\n  TRACK 01 MODE9/9999\n', 'x.cue'), bin]],
  ['unsafe file name', [new File([new Uint8Array(4)], 'a/b.iso')]],
  ['duplicate names', [file(T + 'out/saffron-pulse.iso'), file(T + 'out/saffron-pulse.iso')]],
  ['unsupported extension', [text('hello', 'game.zip')]],
  ['random bytes named .iso', [new File([new Uint8Array(1 << 16).map((_, i) => (i * 131) & 255)], 'junk.iso')]],
  ['CHD of an older version', [new File([new Uint8Array([...[...'MComprHD'].map(c => c.charCodeAt(0)), 0, 0, 0, 124, 0, 0, 0, 4, ...new Uint8Array(120)])], 'old.chd')]],
  ['oversized CUE sheet', [new File([new Uint8Array(70 * 1024)], 'big.cue')]],
  ['empty selection', []],
];
const bad: string[] = [];
for (const [name, files] of rejects) { const r = await detect(files); if (r.ok) bad.push(name); }
ok(`malformed/malicious selections rejected (${rejects.length} cases)`, !bad.length, bad.join(', '));
const pc = parseCue('FILE "a.bin" BINARY\n  TRACK 01 MODE2/2352\n  TRACK 02 AUDIO\nFILE b.bin BINARY\n');
ok('CUE parser: files + track modes', pc.files.join() === 'a.bin,b.bin' && pc.modes.join() === 'MODE2/2352,AUDIO');
const t0 = performance.now();
for (let i = 0; i < 20; i++) await detect([cue, bin]);
ok('detection reads headers only (fast)', (performance.now() - t0) / 20 < 50, `${((performance.now() - t0) / 20).toFixed(1)} ms per detection`);

// ---------------------------------------------------------------- Mishrin Runtime Optimizer (~80% intensity)
const desk = { cores: 8, memGB: 16, webgpu: true, mobile: false, lowMemory: false };
const phone = { cores: 8, memGB: 4, webgpu: false, mobile: true, charging: false, lowMemory: false };
ok('Auto → Performance on a capable desktop, Balanced on battery mobile', resolveProfile('auto', desk) === 'performance' && resolveProfile('auto', phone) === 'balanced');
const pp = plan('performance', desk);
ok('Performance budget = 80% of a 60 Hz frame', INTENSITY === 0.8 && pp.budgetMs === +(1000 / 60 * 0.8).toFixed(2), `${pp.budgetMs} ms`);
ok('worker budget leaves a core for UI/audio (≈80% of the rest)', pp.workers === Math.floor(7 * 0.8));
ok('Battery halves presentation; Maximum allows WebGPU + more catch-up', plan('battery', desk).presentEvery === 2 && plan('maximum', desk).presenter === 'webgpu' && plan('maximum', desk).maxCatchUp > pp.maxCatchUp);
ok('disk cache bounded by memory (low-memory mode ≤ 8 MB)', plan('balanced', { ...desk, lowMemory: true }).diskCacheMB <= 8 && pp.diskCacheMB <= 64);
ok('frame scheduler: on time → 1 frame', framesDue(0, 1000 / 60 + 1, 0, 60, 3).run === 1);
ok('frame scheduler: hiccup → bounded catch-up', framesDue(0, 100, 0, 60, 3).run === 3);
ok('frame scheduler: long stall → resync, no fast-forward', framesDue(0, 5000, 0, 60, 3).resync === true);
ok('adaptive presentation: over budget → skip presents; headroom → recover', adaptPresent(1, pp, { emuMs: 20, presentMs: 2, behind: 0 }) === 2 && adaptPresent(2, pp, { emuMs: 2, presentMs: 1, behind: 0 }) === 1);

// ---------------------------------------------------------------- read-only WASI sandbox
const mem = new WebAssembly.Memory({ initial: 2 });
const wasi = new ReadOnlyWasi({ '/game': { 'disc.bin': bytesSource(new Uint8Array([1, 2, 3, 4, 5])) }, '/bios': {}, '/save': {} });
wasi.bind(mem);
const imp = wasi.imports() as Record<string, (...a: unknown[]) => number>;
const dv = new DataView(mem.buffer), u8 = new Uint8Array(mem.buffer);
const put = (s: string, p: number) => { const b = new TextEncoder().encode(s); u8.set(b, p); return b.length; };
const open = (path: string, oflags = 0) => imp.path_open(3, 0, 1000, put(path, 1000), oflags, 0n, 0n, 0, 2000);
ok('WASI: open a selected game file', open('disc.bin') === 0);
const fd = dv.getUint32(2000, true);
dv.setUint32(3000, 4000, true); dv.setUint32(3004, 3, true);
imp.fd_read(fd, 3000, 1, 3100);
ok('WASI: positional read through the block source', dv.getUint32(3100, true) === 3 && u8[4000] === 1 && u8[4002] === 3);
ok('WASI: path traversal denied', open('../bios/x') === 2 && open('../../etc/passwd') === 2);
ok('WASI: nested paths / unknown files not found', open('a/b') === 44 && open('nope.bin') === 44);
ok('WASI: create/truncate denied (read-only)', open('new.sav', 1) === 69 && open('disc.bin', 8) === 69);
ok('WASI: writing to files denied (only stdout/stderr)', imp.fd_write(fd, 3000, 1, 3100) === 8);
ok('WASI: unknown syscalls (sockets etc.) return ENOSYS', (imp as Record<string, (...a: unknown[]) => number>).sock_accept(0, 0, 0) === 52 && wasi.stats.denied >= 5);

console.log(`\n${n - fails}/${n} emulator unit checks passed`);
if (fails) process.exit(1);
