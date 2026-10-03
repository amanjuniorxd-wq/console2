/** MPC capability probe: hardware, browser, network, memory. Cheap checks are sync; WebGPU is async + memoized. */
export interface Caps {
  wasm: boolean;
  simd: boolean;
  threads: boolean;
  sab: boolean;
  offscreen: boolean;
  workerRaf: boolean;
  webgpu: boolean;
  gpuTier: 'none' | 'low' | 'high';
  memGB: number;
  cores: number;
  mobile: boolean;
  touch: boolean;
  os: string;
  net: { type: string; rttMs: number; downMbps: number; saveData: boolean; online: boolean };
  webrtc: boolean;
}

// Smallest modules that only validate when the feature exists (same bytes as wasm-feature-detect).
const SIMD = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1, 8, 0, 65, 0, 253, 15, 253, 98, 11]);
const THREADS = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 1, 4, 1, 96, 0, 0, 3, 2, 1, 0, 5, 4, 1, 3, 1, 1, 10, 11, 1, 9, 0, 65, 0, 254, 16, 2, 0, 26, 11]);

type NavExt = Navigator & {
  deviceMemory?: number;
  connection?: { effectiveType?: string; rtt?: number; downlink?: number; saveData?: boolean };
  userAgentData?: { mobile?: boolean; platform?: string };
  gpu?: { requestAdapter(o?: object): Promise<{ info?: { isFallbackAdapter?: boolean }; isFallbackAdapter?: boolean } | null> };
};

function validate(b: BufferSource): boolean { try { return WebAssembly.validate(b); } catch { return false; } }

export function probeSync(): Caps {
  const n = navigator as NavExt;
  const wasm = typeof WebAssembly === 'object';
  const ua = navigator.userAgent;
  const mobile = n.userAgentData?.mobile ?? /Android|iPhone|iPad|Mobile/i.test(ua);
  const os = n.userAgentData?.platform || (/Windows/.test(ua) ? 'Windows' : /Mac/.test(ua) ? 'macOS' : /Android/.test(ua) ? 'Android' : /iPhone|iPad/.test(ua) ? 'iOS' : /CrOS/.test(ua) ? 'ChromeOS' : /Linux/.test(ua) ? 'Linux' : 'Unknown');
  const c = n.connection;
  return {
    wasm,
    simd: wasm && validate(SIMD),
    threads: wasm && validate(THREADS) && typeof SharedArrayBuffer === 'function' && self.crossOriginIsolated === true,
    sab: typeof SharedArrayBuffer === 'function' && self.crossOriginIsolated === true,
    offscreen: typeof OffscreenCanvas === 'function' && 'transferControlToOffscreen' in HTMLCanvasElement.prototype,
    workerRaf: true, // verified inside the worker; it falls back to timers if absent
    webgpu: false,
    gpuTier: 'none',
    memGB: n.deviceMemory ?? (mobile ? 4 : 8),
    cores: navigator.hardwareConcurrency || 2,
    mobile,
    touch: navigator.maxTouchPoints > 0,
    os,
    net: { type: c?.effectiveType ?? 'unknown', rttMs: c?.rtt ?? 0, downMbps: c?.downlink ?? 0, saveData: !!c?.saveData, online: navigator.onLine },
    webrtc: typeof RTCPeerConnection === 'function',
  };
}

let full: Promise<Caps> | null = null;
/** Full probe including WebGPU adapter. Memoized: the adapter request happens at most once per page. */
export function probe(): Promise<Caps> {
  return (full ??= (async () => {
    const caps = probeSync();
    const gpu = (navigator as NavExt).gpu;
    if (gpu) {
      try {
        const a = await Promise.race([gpu.requestAdapter({ powerPreference: 'high-performance' }), new Promise<null>(r => setTimeout(() => r(null), 1500))]);
        if (a) { caps.webgpu = true; const fa = a as unknown as { info?: { isFallbackAdapter?: boolean }; isFallbackAdapter?: boolean }; caps.gpuTier = (fa.info?.isFallbackAdapter ?? fa.isFallbackAdapter) ? 'low' : 'high'; }
      } catch { /* no adapter */ }
    }
    return caps;
  })());
}

/** Network changes invalidate the cached network fields only. */
export function refreshNet(c: Caps): Caps { c.net = probeSync().net; return c; }
