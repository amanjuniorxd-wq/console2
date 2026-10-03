import { settings } from './settings-store';

type KB = { lock?(keys?: string[]): Promise<void>; unlock?(): void };
const kb = () => (navigator as Navigator & { keyboard?: KB }).keyboard;

/** Must run synchronously inside a user gesture (click/keypress) to be permitted. */
export function enterFullscreen(): void {
  if (!settings.autoFullscreen || document.fullscreenElement) return;
  const el = document.documentElement;
  const p = el.requestFullscreen?.({ navigationUI: 'hide' });
  // Keyboard Lock keeps Esc for the in-game overlay instead of leaving fullscreen (Chromium).
  p?.then(() => kb()?.lock?.(['Escape']).catch(() => {})).catch(() => {});
}
export function exitFullscreen(): void {
  kb()?.unlock?.();
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
}
