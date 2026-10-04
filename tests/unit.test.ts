// Pure-logic tests for MPC routing and cloud adaptation. Run: npm run test:unit
import { plan, localBudgetMB } from '../src/mpc/router';
import { adapt } from '../src/cloud/client';
import type { Caps } from '../src/mpc/probe';
import type { Game } from '../src/games/types';
import { DEFAULTS, type Settings } from '../src/ui/settings-store';

let fails = 0, n = 0;
const ok = (name: string, c: boolean, d = '') => { n++; if (!c) fails++; console.log(`${c ? 'PASS' : 'FAIL'} ${name}${d ? ' — ' + d : ''}`); };

const caps = (o: Partial<Caps> = {}): Caps => ({ wasm: true, simd: true, threads: false, sab: false, offscreen: true, workerRaf: true, webgpu: true, gpuTier: 'high', memGB: 8, cores: 8, mobile: false, touch: false, os: 'Windows', webrtc: true, net: { type: '4g', rttMs: 40, downMbps: 10, saveData: false, online: true }, ...o });
const S = (o: Partial<Settings> = {}): Settings => ({ ...DEFAULTS, ...o });
const G = (o: Partial<Game>): Game => ({ id: 't', title: 'T', artwork: 'gen:scifi', description: '', runtime: 'wasm', url: '/x.wasm', requirements: {}, ...o });
const routes = (p: ReturnType<typeof plan>) => p.routes.map(r => r.backend).join('>') || p.blocked?.code || '';

ok('capable desktop: wasm local, cloud fallback', routes(plan(G({}), caps(), S({ cloudEndpoint: 'https://c' }))) === 'local-wasm>cloud');
ok('no cloud configured: local only', routes(plan(G({}), caps(), S())) === 'local-wasm');
ok('weak device + heavy title → cloud first', routes(plan(G({ requirements: { memMB: 3000 } }), caps({ memGB: 2, mobile: true }), S({ cloudEndpoint: 'https://c' }))) === 'cloud>local-wasm');
ok('weak device on Data Saver stays local', routes(plan(G({ requirements: { memMB: 3000 } }), caps({ memGB: 2, net: { type: '3g', rttMs: 40, downMbps: 1, saveData: true, online: true } }), S({ cloudEndpoint: 'https://c' }))) === 'local-wasm>cloud');
ok('windows title, no cloud → needs-cloud', routes(plan(G({ runtime: 'x64-win', url: '/a.exe' }), caps(), S())) === 'needs-cloud');
ok('windows title with cloud → cloud only', routes(plan(G({ runtime: 'x64-win', url: '/a.exe' }), caps(), S({ cloudEndpoint: 'https://c' }))) === 'cloud');
ok('windows title offline → offline', routes(plan(G({ runtime: 'x64-win', url: '/a.exe' }), caps({ net: { type: 'none', rttMs: 0, downMbps: 0, saveData: false, online: false } }), S({ cloudEndpoint: 'https://c' }))) === 'offline');
ok('webgpu title without WebGPU → cloud', routes(plan(G({ runtime: 'webgpu', url: '/g.html' }), caps({ webgpu: false }), S({ cloudEndpoint: 'https://c' }))) === 'cloud');
ok('web title never routed to cloud', routes(plan(G({ runtime: 'web', url: '/g.html' }), caps(), S({ cloudEndpoint: 'https://c', runtime: 'cloud' }))) === 'local-web');
ok('missing file → no-file', routes(plan(G({ url: '' }), caps(), S())) === 'no-file');
ok('unknown runtime → unsupported', routes(plan(G({ runtime: 'n64' as never }), caps(), S())) === 'unsupported');
ok('prefer cloud setting', routes(plan(G({}), caps(), S({ cloudEndpoint: 'https://c', runtime: 'cloud' }))) === 'cloud>local-wasm');
ok('low memory mode shrinks local budget', localBudgetMB(caps(), { lowMemory: true }) < localBudgetMB(caps(), { lowMemory: false }));
const q = { height: 1080, fps: 60, kbps: 10000 }, max = { height: 1080, fps: 60, kbps: 20000 };
ok('adapt: loss backs off', adapt(q, max, 0.05, 30).kbps < q.kbps);
ok('adapt: latency backs off', adapt(q, max, 0, 200).kbps < q.kbps);
ok('adapt: clean link probes up, capped', adapt(q, max, 0, 20).kbps > q.kbps && adapt({ ...q, kbps: 20000 }, max, 0, 20).kbps === 20000);
ok('adapt: floor 1 Mbps', adapt({ ...q, kbps: 1100 }, max, 0.5, 300).kbps >= 1000);

// Mouse ABI extension: the real Ember Drift module steers toward a held left button (no mocks: the shipped .wasm).
{
  const { readFileSync } = await import('node:fs');
  const mod = new WebAssembly.Module(readFileSync('public/games/ember-drift/ember-drift.wasm'));
  const run = (press: ((x: Record<string, Function>, w: number, h: number) => void) | null) => {
    const x = new WebAssembly.Instance(mod, {}).exports as unknown as Record<string, Function> & { memory: WebAssembly.Memory };
    x.mpc_init(7); const w = x.mpc_width(), h = x.mpc_height();
    const st = () => new Float32Array(x.memory.buffer, x.mpc_state_ptr() + 4, 2);
    const p0 = [...st()];
    press?.(x, w, h);
    for (let i = 0; i < 30; i++) x.mpc_frame(16.7);
    return { p0, p1: [...st()], w, h };
  };
  const idle = run(null);
  const right = run((x, w) => x.mpc_pointer(w - 1, 0, 0) /* hover: no thrust */);
  const held = run((x, w, h) => x.mpc_pointer(w - 1, h >> 1, 1));
  ok('mouse: module exports mpc_pointer', typeof new WebAssembly.Instance(mod, {}).exports.mpc_pointer === 'function');
  ok('mouse: hover without a button does not steer', Math.abs(right.p1[0] - idle.p1[0]) < 0.01, `${idle.p1[0].toFixed(1)} vs ${right.p1[0].toFixed(1)}`);
  ok('mouse: held left button steers toward the cursor', held.p1[0] - held.p0[0] > 5 && held.p1[0] > idle.p1[0] + 5, `x ${held.p0[0].toFixed(1)} → ${held.p1[0].toFixed(1)} (idle ${idle.p1[0].toFixed(1)})`);
}

// ---- universal runtime registry + resolver --------------------------------------------------------------
{
  const { RUNTIMES, liveStatus, descriptorFor, byRuntimeId } = await import('../src/runtimes/registry');
  const rep = (rt: Record<string, Partial<import('../src/runtimes/registry').CloudRuntimeReport>>) => ({ sessions: 0, auth: { required: false }, runtimes: Object.fromEntries(Object.entries(rt).map(([k, v]) => [k, { runtime: k, workers: 1, capacity: 2, active: 0, free: 2, queued: 0, mock: false, emulators: [], ...v }])) }) as never;
  const C = { wasm: true, webgpu: false };
  ok('registry: every Game runtime kind maps to exactly one runtime', ['wasm', 'web', 'webgpu', 'x64-win', 'x86', 'p1', 'p2', 'p3', 'p4'].every(k => RUNTIMES.filter(r => r.serves.includes(k as never)).length === 1));
  ok('registry: PS2/PS3 never READY (real emulators, firmware/BIOS required), P1/Windows/Browser ready', byRuntimeId('ps2').maturity === 'in-development' && byRuntimeId('ps3-cloud').maturity === 'in-development' && ['browser', 'mishrin-p1', 'windows-cloud'].every(id => byRuntimeId(id as never).maturity === 'ready'));
  const p3 = byRuntimeId('ps3-cloud'), win = byRuntimeId('windows-cloud');
  ok('live: no cloud configured → no-cloud', liveStatus(p3, C, null, false).state === 'no-cloud');
  ok('live: cloud without PS3 workers → not deployed', liveStatus(p3, C, rep({ 'x64-win': {} }), true).state === 'not-deployed');
  ok('live: only mock PS3 workers → mock-only (never available)', (s => s.state === 'mock-only' && !s.ok)(liveStatus(p3, C, rep({ ps3: { mock: true, emulators: [{ name: 'rpcs3', version: 'mock', firmware: true, mock: true }] } }), true)));
  ok('live: real PS3 worker without self-test report → "In development · deployed" (not "Ready")', (s => s.ok && s.label.startsWith('In development') && s.label !== 'Ready')(liveStatus(p3, C, rep({ ps3: { emulators: [{ name: 'rpcs3', version: '0.0.36', firmware: true, mock: false }] } }), true)));
  const E = (o: object) => ({ name: 'pcsx2', version: '1.6.0', firmware: false, mock: false, firmwareLabel: 'PS2 BIOS', requires: 'A PS2 BIOS dumped from your own console.', worker: 'w1', ...o });
  const p2 = byRuntimeId('ps2');
  ok('live: PCSX2 installed, no BIOS → firmware-required with exact setup text (not deployed, not Ready)', (s => s.state === 'firmware-required' && !s.ok && /PS2 BIOS required/.test(s.label) && /own console/.test(s.requires || ''))(liveStatus(p2, C, rep({ ps2: { workers: 0, capacity: 0, free: 0, emulators: [E({ status: 'BIOS_REQUIRED', advertised: false })] } }), true)));
  ok('live: PCSX2 verified with the test ROM only → test-mode (usable, never "Ready")', (s => s.state === 'test-mode' && s.ok && s.label !== 'Ready')(liveStatus(p2, C, rep({ ps2: { emulators: [E({ status: 'BIOS_REQUIRED', testMode: true, advertised: true, verified: { ok: true, firstFrameMs: 900, detail: '' } })] } }), true)));
  ok('live: self-test failed → error; never verified → not-verified', liveStatus(p2, C, rep({ ps2: { workers: 0, emulators: [E({ status: 'ERROR', advertised: false })] } }), true).state === 'error'
    && liveStatus(p2, C, rep({ ps2: { emulators: [E({ status: 'NOT_VERIFIED', advertised: true })] } }), true).state === 'not-verified');
  ok('live: real BIOS + passed self-test → Ready', liveStatus(p2, C, rep({ ps2: { emulators: [E({ status: 'READY', firmware: true, advertised: true, verified: { ok: true, firstFrameMs: 900, detail: '' } })] } }), true).label === 'Ready');
  ok('live: Windows workers all busy → busy + queue hint', (s => s.state === 'busy' && /queued/.test(s.detail))(liveStatus(win, C, rep({ 'x64-win': { free: 0, active: 2, queued: 1 } }), true)));
  ok('live: Windows with a free slot → Ready', liveStatus(win, C, rep({ 'x64-win': {} }), true).label === 'Ready');
  ok('live: P1 needs WebAssembly and its core', liveStatus(byRuntimeId('mishrin-p1'), { wasm: false, webgpu: false }, null, false).ok === false && liveStatus(byRuntimeId('mishrin-p1'), C, null, false, false).label === 'Core missing');
  ok('descriptorFor maps games', descriptorFor({ runtime: 'p3' })?.id === 'ps3-cloud' && descriptorFor({ runtime: 'x86' })?.id === 'windows-cloud');
  ok('resolver: PS3 title uploaded to the cloud → cloud route', routes(plan(G({ runtime: 'p3', url: 'upload:' + 'a'.repeat(32) }), caps(), S({ cloudEndpoint: 'https://c' }))) === 'cloud');
  ok('resolver: PS3 title not uploaded → explains upload, no route', (p => !p.routes.length && /Upload/.test(p.blocked!.message))(plan(G({ runtime: 'p3', url: 'emu:local' }), caps(), S({ cloudEndpoint: 'https://c' }))));
  ok('resolver: PS2 uploaded but no cloud endpoint → needs-cloud', plan(G({ runtime: 'p2', url: 'upload:' + 'b'.repeat(32) }), caps(), S()).blocked?.code === 'needs-cloud');
  ok('resolver: PS4 → research, unsupported', plan(G({ runtime: 'p4', url: 'emu:local' }), caps(), S({ cloudEndpoint: 'https://c' })).blocked?.code === 'unsupported');
  ok('resolver: P1 stays local even with a cloud', routes(plan(G({ runtime: 'p1', url: 'emu:local' }), caps(), S({ cloudEndpoint: 'https://c' }))) === 'local-emu');
}
// ---- unified input mapping ----------------------------------------------------------------------------
{
  const { readFull, FB, KEY_FULL, KEY_LOGICAL, logicalMask, remap, FULL } = await import('../src/input/pad');
  const { PAD } = await import('../src/emu/types');
  const gp = (pressed: number[], axes = [0, 0]) => ({ buttons: Array.from({ length: 17 }, (_, i) => ({ pressed: pressed.includes(i), value: 0, touched: false })), axes });
  ok('gamepad: standard layout → full pad (A=cross, Start, D-pad)', readFull(gp([0, 9, 15])) === ((1 << FB.cross) | (1 << FB.start) | (1 << FB.right)));
  ok('gamepad: left stick folds into the D-pad (dead zone 0.5)', readFull(gp([], [-0.9, 0.3])) === (1 << FB.left) && readFull(gp([], [0.4, 0.4])) === 0);
  ok('gamepad: shoulder/trigger/stick buttons map to L1 R1 L2 R2 L3 R3', readFull(gp([4, 5, 6, 7, 10, 11])) === ['l1', 'r1', 'l2', 'r2', 'l3', 'r3'].reduce((m, n) => m | (1 << FB[n as never]), 0));
  ok('full → logical (menus, MPC/web, Windows): cross=A, circle=B', logicalMask((1 << FB.cross) | (1 << FB.circle) | (1 << FB.up)) === ((1 << 4) | (1 << 5) | (1 << 0)));
  ok('full → Mishrin P1 libretro bits', remap((1 << FB.cross) | (1 << FB.triangle) | (1 << FB.select), PAD as never) === ((1 << PAD.cross) | (1 << PAD.triangle) | (1 << PAD.select)));
  ok('keyboard: one table per layer, every full button reachable from the keyboard', FULL.filter(n => !['l3', 'r3'].includes(n)).every(n => Object.values(KEY_FULL).includes(n)) && KEY_LOGICAL.ArrowUp === 0 && KEY_LOGICAL.Enter === 4);
}
// ---- saves (.msave) + detection helpers ------------------------------------------------------------------
{
  const { encodeSave, decodeSave } = await import('../src/saves/format');
  const payload = new Uint8Array([1, 2, 3, 250]);
  const blob = encodeSave({ provider: 'emulator', gameId: 'e-saffron', title: 'Saffron', kind: 'memory card', ts: 5, raw: 4, encoding: 'raw' }, payload);
  const back = await decodeSave(blob);
  ok('.msave round-trip (header + exact payload)', back.header.gameId === 'e-saffron' && back.header.provider === 'emulator' && back.payload.join() === payload.join());
  const rej = async (b: Blob) => { try { await decodeSave(b); return false; } catch { return true; } };
  ok('.msave rejects foreign files and unsafe headers', await rej(new Blob(['PK\x03\x04'])) && await rej(new Blob(['MSAVE1\n{"provider":"local","gameId":"../x","encoding":"raw"}\n'])) && await rej(new Blob(['MSAVE1\n{"provider":"shell","gameId":"a","encoding":"raw"}\n'])));
  const { peArch, parseSfo } = await import('../src/runtimes/detect');
  const { readFileSync } = await import('node:fs');
  ok('detect: PE architecture from header (x64 and x86 test titles)', peArch(new Uint8Array(readFileSync('cloud/test-games/pkg/gdi64/wintest64.exe'))) === 'x64' && peArch(new Uint8Array(readFileSync('cloud/test-games/pkg/gdi32/wintest32.exe'))) === 'x86' && peArch(new Uint8Array(64)) === null);
  // header (keyTab 36, dataTab 44, 1 entry) · entry (key 0, utf8, len 6, max 8, off 0) · "TITLE\0\0\0" · "Orbit\0\0\0"
  const sfo = new Uint8Array([0, 0x50, 0x53, 0x46, 1, 1, 0, 0, 36, 0, 0, 0, 44, 0, 0, 0, 1, 0, 0, 0, 0, 0, 4, 2, 6, 0, 0, 0, 8, 0, 0, 0, 0, 0, 0, 0, 84, 73, 84, 76, 69, 0, 0, 0, 79, 114, 98, 105, 116, 0, 0, 0]);
  ok('detect: PARAM.SFO parser in the browser detector', parseSfo(sfo)?.TITLE === 'Orbit');
}
console.log(`\n${n - fails}/${n} unit checks passed`);
if (fails) process.exit(1);
