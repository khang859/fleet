import { z } from 'zod';
import type { HostPlatform } from './ipc-api';

/**
 * Whether Fleet draws the minimize / maximize / close buttons itself.
 *
 * Electron's native title bar overlay only takes one background color behind
 * all three buttons, so on Linux it paints an opaque block over the window
 * background and the card corner beneath it. Drawing them in the renderer lets
 * them sit on the canvas like the rest of the chrome.
 *
 * macOS keeps its traffic lights. Windows keeps the native overlay, because
 * hovering its maximize button opens the snap layouts flyout, which a button
 * drawn in the page cannot offer.
 */
export function drawsOwnWindowControls(platform: HostPlatform): boolean {
  return platform === 'linux';
}

export const WindowControlActionSchema = z.enum(['minimize', 'toggle-maximize', 'close']);
export type WindowControlAction = z.infer<typeof WindowControlActionSchema>;
