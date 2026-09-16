import type { MenuItemConstructorOptions } from 'electron';
import type { TerminalMenuAction } from '../shared/ipc-api';

/**
 * The terminal pane's right-click menu.
 *
 * Built here rather than inline in the IPC handler so the shape of the menu can
 * be asserted in a test: which items appear, in what order, and what each one
 * resolves with. The handler stays responsible for popping it up.
 *
 * Nothing in this file touches the filesystem. When the mouse is over a detected
 * path the renderer says so, and the path items are added to the top; the
 * renderer then carries out whichever action comes back, the same way it already
 * handles Copy and Paste against its own xterm instance.
 */

/** What each platform calls showing a file inside its containing folder. */
export function revealLabel(platform: NodeJS.Platform): string {
  if (platform === 'darwin') return 'Reveal in Finder';
  if (platform === 'win32') return 'Show in File Explorer';
  return 'Show in File Manager';
}

export type TerminalContextMenuArgs = {
  /** Copy is disabled without it. */
  hasSelection: boolean;
  /**
   * The path under the pointer, when there is one. Whether Fleet can show it in
   * a pane is the renderer's call - a directory cannot, nor can a `.zip` - and
   * only the reveal and copy items are offered when it cannot.
   */
  path: { canOpenInFleet: boolean } | null;
  platform: NodeJS.Platform;
  onAction: (action: TerminalMenuAction) => void;
};

export function buildTerminalContextMenuTemplate({
  hasSelection,
  path,
  platform,
  onAction
}: TerminalContextMenuArgs): MenuItemConstructorOptions[] {
  const template: MenuItemConstructorOptions[] = [];

  if (path) {
    if (path.canOpenInFleet) {
      template.push({ label: 'Open in Fleet', click: () => onAction('openInFleet') });
    }
    template.push(
      { label: revealLabel(platform), click: () => onAction('reveal') },
      { label: 'Copy Path', click: () => onAction('copyPath') },
      { type: 'separator' }
    );
  }

  template.push(
    { label: 'Copy', enabled: hasSelection, click: () => onAction('copy') },
    { label: 'Paste', click: () => onAction('paste') },
    { type: 'separator' },
    { label: 'Select All', click: () => onAction('selectAll') },
    { label: 'Clear', click: () => onAction('clear') }
  );

  return template;
}
