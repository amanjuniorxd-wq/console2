/**
 * Presenters (worker side). Canvas2D: zero-copy ImageData over the core's framebuffer, scaled by the compositor.
 * WebGPU: the frame is uploaded as a texture and scaled on the GPU with a sharp-bilinear shader at display
 * resolution (crisp pixels without shimmering at non-integer scales). The pipeline is compiled once per worker.
 */
export interface Presenter {
  keep?: unknown;
  kind: 'webgpu' | 'canvas2d';
  shaderMs?: number;
  present(data: Uint8Array, w: number, h: number): void;
  resize(w: number, h: number): void;
  setMode(mode: 'sharp' | 'pixel' | 'smooth'): void;
  destroy(): void;
  /** Test/diagnostic: read the last presented frame back from the GPU/canvas (RGBA, top-left origin). */
  readback?(): Promise<{ w: number; h: number; data: Uint8Array }>;
}

export function canvas2d(canvas: OffscreenCanvas): Presenter {
  const ctx = canvas.getContext('2d', { alpha: false, desynchronized: true }) as OffscreenCanvasRenderingContext2D;
  let img: ImageData | null = null, buf: ArrayBufferLike | null = null, off = -1;
  return {
    kind: 'canvas2d',
    present(data, w, h) {
      if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; img = null; }
      if (!img || buf !== data.buffer || off !== data.byteOffset || img.width !== w) {
        img = new ImageData(new Uint8ClampedArray(data.buffer as ArrayBuffer, data.byteOffset, w * h * 4), w, h);
        buf = data.buffer; off = data.byteOffset;
      }
      ctx.putImageData(img, 0, 0);
    },
    resize() { /* CSS scales the canvas */ },
    async readback() { const d = ctx.getImageData(0, 0, canvas.width, canvas.height); return { w: canvas.width, h: canvas.height, data: new Uint8Array(d.data.buffer) }; },
    setMode() { /* main thread switches image-rendering */ },
    destroy() {},
  };
}

const WGSL = /* wgsl */ `
struct U { src: vec2f, tex: vec2f, dst: vec2f, mode: f32, aspect: f32 };
@group(0) @binding(0) var<uniform> u: U;
@group(0) @binding(1) var t: texture_2d<f32>;
@group(0) @binding(2) var s: sampler;
@vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
  var q = array<vec2f, 3>(vec2f(-1., -1.), vec2f(3., -1.), vec2f(-1., 3.));
  return vec4f(q[i], 0., 1.);                               // fullscreen triangle
}
@fragment fn fs(@builtin(position) pos: vec4f) -> @location(0) vec4f {
  var size = u.dst;                                         // letterbox to the game's aspect ratio
  if (u.dst.x / u.dst.y > u.aspect) { size.x = u.dst.y * u.aspect; } else { size.y = u.dst.x / u.aspect; }
  let st = (pos.xy - (u.dst - size) * .5) / size;
  if (any(st < vec2f(0.)) || any(st >= vec2f(1.))) { return vec4f(0., 0., 0., 1.); }
  let px = st * u.src;                                      // position in source pixels
  var uv: vec2f;
  if (u.mode < .5) {                                        // sharp bilinear: integer prescale, then bilinear
    let scale = max(floor(size / u.src), vec2f(1.));
    let w = clamp((fract(px) - .5) * scale + .5, vec2f(0.), vec2f(1.));
    uv = (floor(px) + w) / u.tex;
  } else if (u.mode < 1.5) { uv = (floor(px) + .5) / u.tex; } // nearest
  else { uv = px / u.tex; }                                  // smooth bilinear
  return vec4f(textureSampleLevel(t, s, uv, 0.).rgb, 1.);
}`;

/** The WebGPU scaling pipeline, independent of any canvas (shared by the presenter and the offscreen self-test). */
async function scaler(device: GPUDevice, format: GPUTextureFormat) {
  const t0 = performance.now();
  const module = device.createShaderModule({ code: WGSL });
  const pipeline = await device.createRenderPipelineAsync({
    layout: 'auto', vertex: { module, entryPoint: 'vs' }, fragment: { module, entryPoint: 'fs', targets: [{ format }] }, primitive: { topology: 'triangle-list' },
  });
  const shaderMs = performance.now() - t0;
  const TW = 1024, TH = 512;
  const tex = device.createTexture({ size: [TW, TH], format: 'rgba8unorm', usage: 0x04 | 0x02 /* TEXTURE_BINDING | COPY_DST */ });
  const sampler = device.createSampler({ magFilter: 'linear', minFilter: 'linear' });
  const ubuf = device.createBuffer({ size: 32, usage: 0x40 | 0x08 /* UNIFORM | COPY_DST */ });
  const bind = device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer: ubuf } }, { binding: 1, resource: tex.createView() }, { binding: 2, resource: sampler }] });
  const uni = new Float32Array(8);
  return {
    shaderMs,
    upload(data: Uint8Array, w: number, h: number) {
      device.queue.writeTexture({ texture: tex }, data, { bytesPerRow: w * 4 }, { width: Math.min(w, TW), height: Math.min(h, TH) });
      uni[0] = w; uni[1] = h; uni[2] = TW; uni[3] = TH;
    },
    draw(view: GPUTextureView, dstW: number, dstH: number, mode: number, aspect = 4 / 3) {
      uni[4] = dstW; uni[5] = dstH; uni[6] = mode; uni[7] = aspect;
      device.queue.writeBuffer(ubuf, 0, uni);
      const enc = device.createCommandEncoder();
      const pass = enc.beginRenderPass({ colorAttachments: [{ view, loadOp: 'clear', clearValue: { r: 0, g: 0, b: 0, a: 1 }, storeOp: 'store' }] });
      pass.setPipeline(pipeline); pass.setBindGroup(0, bind); pass.draw(3); pass.end();
      device.queue.submit([enc.finish()]);
    },
    destroy() { tex.destroy(); ubuf.destroy(); },
  };
}

async function readTexture(device: GPUDevice, t: GPUTexture, w: number, h: number, bgra: boolean) {
  const bpr = Math.ceil((w * 4) / 256) * 256;
  const out = device.createBuffer({ size: bpr * h, usage: 0x08 | 0x01 /* COPY_DST | MAP_READ */ });
  const enc = device.createCommandEncoder();
  enc.copyTextureToBuffer({ texture: t }, { buffer: out, bytesPerRow: bpr }, [w, h]);
  device.queue.submit([enc.finish()]);
  await out.mapAsync(1 /* READ */);
  const src = new Uint8Array(out.getMappedRange()), data = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const s = y * bpr + x * 4, d = (y * w + x) * 4;
    data[d] = src[s + (bgra ? 2 : 0)]; data[d + 1] = src[s + 1]; data[d + 2] = src[s + (bgra ? 0 : 2)]; data[d + 3] = 255;
  }
  out.unmap(); out.destroy();
  return data;
}

async function gpuDevice() {
  const gpu = (navigator as Navigator & { gpu?: GPU }).gpu;
  if (!gpu) return null;
  const adapter = await gpu.requestAdapter({ powerPreference: 'high-performance' }).catch(() => null);
  if (!adapter) return null;
  const device = await adapter.requestDevice().catch(() => null);
  return device ? { gpu, adapter, device } : null;
}

/**
 * Offscreen self-test of the exact presenter pipeline: scales a frame into a dstW×dstH texture and reads it back.
 * Used by automated tests and diagnostics on machines where a WebGPU canvas cannot be composited.
 */
export async function gpuSelfTest(data: Uint8Array, w: number, h: number, dstW: number, dstH: number, mode: number) {
  const g = await gpuDevice();
  if (!g) return null;
  const format: GPUTextureFormat = 'rgba8unorm';
  const sc = await scaler(g.device, format);
  sc.upload(data, w, h);
  const t = g.device.createTexture({ size: [dstW, dstH], format, usage: 0x10 | 0x01 /* RENDER_ATTACHMENT | COPY_SRC */ });
  const t0 = performance.now();
  sc.draw(t.createView(), dstW, dstH, mode);
  const out = await readTexture(g.device, t, dstW, dstH, false);
  const gpuMs = performance.now() - t0;
  sc.destroy(); t.destroy(); g.device.destroy();
  return { data: out, w: dstW, h: dstH, shaderMs: sc.shaderMs, gpuMs, adapter: (g.adapter as GPUAdapter & { info?: { description?: string; vendor?: string } }).info?.description || (g.adapter as GPUAdapter & { info?: { vendor?: string } }).info?.vendor || 'unknown' };
}

export async function webgpu(canvas: OffscreenCanvas, onLost: (reason: string) => void = () => {}): Promise<Presenter | null> {
  const g = await gpuDevice();
  if (!g) return null;
  const { device } = g;
  const ctx = canvas.getContext('webgpu') as GPUCanvasContext | null;
  if (!ctx) return null;
  const format = g.gpu.getPreferredCanvasFormat();
  ctx.configure({ device, format, alphaMode: 'opaque' });
  const sc = await scaler(device, format);
  let mode = 0, lost = false, destroyed = false;
  device.lost.then(i => { if (destroyed) return; lost = true; console.warn(`[P1] WebGPU device lost: ${i.message}`); onLost(i.message); });
  device.addEventListener('uncapturederror', e => console.warn(`[P1] WebGPU error: ${(e as GPUUncapturedErrorEvent).error.message}`));
  return {
    // Keep the adapter alive for the presenter's lifetime (if collected, Chromium can drop the instance).
    keep: g,
    kind: 'webgpu', shaderMs: sc.shaderMs,
    present(data, w, h) {
      if (lost || !w || !h) return;
      sc.upload(data, w, h);
      sc.draw(ctx.getCurrentTexture().createView(), canvas.width, canvas.height, mode);
    },
    resize(w, h) { canvas.width = Math.max(1, Math.min(3840, w)); canvas.height = Math.max(1, Math.min(2160, h)); },
    setMode(m) { mode = m === 'sharp' ? 0 : m === 'pixel' ? 1 : 2; },
    destroy() { destroyed = true; sc.destroy(); device.destroy(); },
  };
}
