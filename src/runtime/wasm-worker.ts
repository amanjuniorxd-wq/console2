/// <reference lib="webworker" />
import { startLoop, type LoopMsg, type LoopOut } from './fb-loop';

const post = (m: LoopOut, tr: Transferable[] = []) => (self as unknown as DedicatedWorkerGlobalScope).postMessage(m, tr);
let handle: ((m: LoopMsg) => void) | null = null;

self.onmessage = async (e: MessageEvent) => {
  const d = e.data;
  if (d.t === 'boot') {
    try { handle = await startLoop(d.module, d.canvas, d.maxFps, post); }
    catch (err) { post({ t: 'error', message: (err as Error).message }); }
    return;
  }
  handle?.(d as LoopMsg);
};
