import { app, nativeImage } from 'electron';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { createLogger } from './logger';

const log = createLogger('dock-icon');

/**
 * Put Fleet's icon back on the macOS dock.
 *
 * `setVisibleOnAllWorkspaces` on any window resets the dock entry
 * (electron/electron#26350), so this runs after every window that calls it is
 * created: the copilot at startup, the teleprompter whenever it opens.
 */
export function restoreDockIcon(): void {
  if (process.platform !== 'darwin') return;
  const iconPath = join(dirname(fileURLToPath(import.meta.url)), '../../build/icon.png');
  const icon = nativeImage.createFromPath(iconPath);
  if (icon.isEmpty()) return;
  app.dock?.setIcon(icon);
  log.info('dock icon set');
}
