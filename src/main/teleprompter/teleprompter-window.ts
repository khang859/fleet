import { BrowserWindow } from 'electron';
import { createLogger } from '../logger';
import { restoreDockIcon } from '../dock-icon';
import { loadSecondaryRenderer, secondaryWebPreferences } from '../secondary-renderer';
import { IPC_CHANNELS } from '../../shared/ipc-channels';
import type { TeleprompterState } from '../../shared/teleprompter';
import { MIN_WINDOW_HEIGHT, MIN_WINDOW_WIDTH, type Rect } from './bounds';

const log = createLogger('teleprompter:window');

const BOUNDS_SAVE_DEBOUNCE_MS = 300;

/** What the service needs from the overlay window, so it can be tested without Electron. */
export type OverlayPort = {
  isOpen: () => boolean;
  isVisible: () => boolean;
  create: (rect: Rect) => void;
  show: () => void;
  hide: () => void;
  setLocked: (locked: boolean) => void;
  getBounds: () => Rect | null;
  setSize: (width: number, height: number) => void;
  send: (state: TeleprompterState) => void;
  destroy: () => void;
};

export type OverlayEvents = {
  /** The user moved or resized the window; debounced. */
  onBoundsChanged: (rect: Rect) => void;
  /** Closed by anything other than `destroy`, e.g. the OS. */
  onClosed: () => void;
};

export function isWaylandSession(): boolean {
  return process.platform === 'linux' && process.env.XDG_SESSION_TYPE === 'wayland';
}

/**
 * On Wayland a client cannot show itself without taking focus, so there it
 * falls back to a normal show. Everywhere else the presenter's slides keep
 * focus when the overlay appears.
 */
function showWithoutFocus(win: BrowserWindow): void {
  if (isWaylandSession()) win.show();
  else win.showInactive();
}

export class TeleprompterWindow implements OverlayPort {
  private win: BrowserWindow | null = null;
  private boundsTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly events: OverlayEvents) {}

  isOpen(): boolean {
    return this.live() !== null;
  }

  isVisible(): boolean {
    return this.live()?.isVisible() ?? false;
  }

  create(rect: Rect): void {
    if (this.isOpen()) return;

    const win = new BrowserWindow({
      ...rect,
      minWidth: MIN_WINDOW_WIDTH,
      minHeight: MIN_WINDOW_HEIGHT,
      title: 'Fleet Teleprompter',
      show: false,
      frame: false,
      transparent: true,
      hasShadow: false,
      skipTaskbar: true,
      // Transparent windows cannot be resized natively on every platform, and
      // turning it on can break the transparency; the overlay draws its own grip.
      resizable: false,
      maximizable: false,
      fullscreenable: false,
      webPreferences: secondaryWebPreferences('teleprompter')
    });
    this.win = win;

    // Above full-screen slides and every ordinary window.
    win.setAlwaysOnTop(true, 'screen-saver');
    // Never with { visibleOnFullScreen: true }: electron/electron#26350 hides
    // the dock icon (docs/learnings/2026-03-28-copilot-dock-icon-disappears.md).
    win.setVisibleOnAllWorkspaces(true);
    restoreDockIcon();
    // Keeps the notes out of screen shares on Windows 10 2004+ and on macOS for
    // capture APIs that respect it. Linux has no equivalent.
    if (process.platform !== 'linux') win.setContentProtection(true);

    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.on('will-navigate', (event) => event.preventDefault());

    win.once('ready-to-show', () => showWithoutFocus(win));
    win.on('move', () => this.scheduleBoundsSave());
    win.on('resize', () => this.scheduleBoundsSave());
    win.on('closed', () => {
      this.clearBoundsTimer();
      if (this.win !== win) return;
      this.win = null;
      this.events.onClosed();
    });

    loadSecondaryRenderer(win, { entry: 'teleprompter', title: 'Fleet Teleprompter' });
    log.info('teleprompter window created', rect);
  }

  show(): void {
    const win = this.live();
    if (win) showWithoutFocus(win);
  }

  hide(): void {
    this.live()?.hide();
  }

  setLocked(locked: boolean): void {
    // Clicks pass through to whatever is underneath, the slides included.
    this.live()?.setIgnoreMouseEvents(locked);
  }

  getBounds(): Rect | null {
    return this.live()?.getBounds() ?? null;
  }

  setSize(width: number, height: number): void {
    const win = this.live();
    if (!win) return;
    // On Linux a non-resizable window pins its minimum and maximum size to its
    // current size, so `setSize` could grow the overlay but never shrink it.
    // Lifting the pin just for the call keeps the OS from offering its own resize.
    win.setResizable(true);
    win.setSize(Math.round(width), Math.round(height));
    win.setResizable(false);
  }

  send(state: TeleprompterState): void {
    this.live()?.webContents.send(IPC_CHANNELS.TELEPROMPTER_STATE, state);
  }

  /** Close without reporting `onClosed`: the caller is the one tearing down. */
  destroy(): void {
    this.clearBoundsTimer();
    const win = this.win;
    this.win = null;
    if (win && !win.isDestroyed()) win.destroy();
  }

  private live(): BrowserWindow | null {
    return this.win && !this.win.isDestroyed() ? this.win : null;
  }

  private scheduleBoundsSave(): void {
    this.clearBoundsTimer();
    this.boundsTimer = setTimeout(() => {
      this.boundsTimer = null;
      const bounds = this.getBounds();
      if (bounds) this.events.onBoundsChanged(bounds);
    }, BOUNDS_SAVE_DEBOUNCE_MS);
  }

  private clearBoundsTimer(): void {
    if (this.boundsTimer) clearTimeout(this.boundsTimer);
    this.boundsTimer = null;
  }
}
