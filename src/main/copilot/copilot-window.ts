import { app, BrowserWindow, screen } from 'electron';
import { existsSync } from 'fs';
import { fileURLToPath } from 'url';
import Store from 'electron-store';
import { createLogger } from '../logger';
import type { CopilotPosition } from '../../shared/types';

const log = createLogger('copilot:window');

const SPRITE_SIZE = 48;
const EXPANDED_WIDTH = 350;
const EXPANDED_HEIGHT = 500;

type CopilotWindowStore = {
  position: CopilotPosition | null;
};

export class CopilotWindow {
  private win: BrowserWindow | null = null;
  private positionStore: Store<CopilotWindowStore>;

  constructor() {
    this.positionStore = new Store<CopilotWindowStore>({
      name: 'fleet-copilot-position',
      defaults: { position: null },
    });
  }

  getWindow(): BrowserWindow | null {
    return this.win;
  }

  create(): void {
    if (this.win && !this.win.isDestroyed()) {
      this.win.focus();
      return;
    }

    const saved = this.positionStore.get('position');
    const { x, y } = this.resolvePosition(saved);

    const preloadPathJs = fileURLToPath(new URL('../preload/copilot.js', import.meta.url));
    const preloadPathMjs = fileURLToPath(new URL('../preload/copilot.mjs', import.meta.url));
    const preloadPath = existsSync(preloadPathJs) ? preloadPathJs : preloadPathMjs;
    log.info('preload resolution', { preloadPathJs, preloadPathMjs, preloadPath, exists: existsSync(preloadPath) });

    this.win = new BrowserWindow({
      width: EXPANDED_WIDTH,
      height: EXPANDED_HEIGHT,
      x,
      y,
      frame: false,
      transparent: true,
      hasShadow: false,
      alwaysOnTop: true,
      focusable: false,
      skipTaskbar: true,
      resizable: false,
      webPreferences: {
        preload: preloadPath,
        contextIsolation: true,
        sandbox: false,
        nodeIntegration: false,
      },
    });

    this.win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    this.win.setContentSize(SPRITE_SIZE, SPRITE_SIZE);
    this.win.setIgnoreMouseEvents(false);

    if (process.env.ELECTRON_RENDERER_URL) {
      // electron-vite serves multi-page apps under /src/renderer/<page>/index.html
      const url = `${process.env.ELECTRON_RENDERER_URL}/src/renderer/copilot/index.html`;
      log.info('loading copilot renderer (dev)', { url });
      void this.win.loadURL(url);
    } else {
      const filePath = fileURLToPath(new URL('../renderer/copilot/index.html', import.meta.url));
      log.info('loading copilot renderer (prod)', { filePath, exists: existsSync(filePath) });
      void this.win.loadFile(filePath);
    }

    this.win.webContents.on('did-fail-load', (_event, errorCode, errorDescription) => {
      log.error('copilot renderer failed to load', { errorCode, errorDescription });
    });

    this.win.webContents.on('did-finish-load', () => {
      log.info('copilot renderer loaded successfully');
      // In dev, dump the HTML for debugging
      if (!app.isPackaged) {
        this.win?.webContents
          .executeJavaScript(`document.documentElement.outerHTML.substring(0, 500)`)
          .then((html: unknown) => log.info('copilot DOM', { html: String(html) }))
          .catch(() => {});
      }
    });

    // Open devtools in dev mode for debugging
    if (!app.isPackaged) {
      this.win.webContents.openDevTools({ mode: 'detach' });
    }

    this.win.on('closed', () => {
      this.win = null;
    });

    log.info('copilot window created', { x, y });
  }

  destroy(): void {
    if (this.win && !this.win.isDestroyed()) {
      this.win.close();
    }
    this.win = null;
  }

  setPosition(x: number, y: number): void {
    if (this.win && !this.win.isDestroyed()) {
      this.win.setPosition(Math.round(x), Math.round(y));
    }
    const display = screen.getDisplayNearestPoint({ x, y });
    this.positionStore.set('position', { x, y, displayId: display.id });
  }

  getPosition(): CopilotPosition | null {
    return this.positionStore.get('position');
  }

  setExpanded(expanded: boolean): void {
    if (!this.win || this.win.isDestroyed()) return;
    if (expanded) {
      this.win.setContentSize(EXPANDED_WIDTH, EXPANDED_HEIGHT);
      this.win.setFocusable(true);
    } else {
      this.win.setContentSize(SPRITE_SIZE, SPRITE_SIZE);
      this.win.setFocusable(false);
    }
  }

  send(channel: string, ...args: unknown[]): void {
    if (this.win && !this.win.isDestroyed()) {
      this.win.webContents.send(channel, ...args);
    }
  }

  private resolvePosition(saved: CopilotPosition | null): { x: number; y: number } {
    if (saved) {
      const displays = screen.getAllDisplays();
      const targetDisplay = displays.find((d) => d.id === saved.displayId);
      if (targetDisplay) {
        const { x: dx, y: dy, width, height } = targetDisplay.bounds;
        if (saved.x >= dx && saved.x < dx + width && saved.y >= dy && saved.y < dy + height) {
          return { x: saved.x, y: saved.y };
        }
      }
    }

    const primary = screen.getPrimaryDisplay();
    return {
      x: primary.bounds.x + primary.bounds.width - SPRITE_SIZE - 20,
      y: primary.bounds.y + 40,
    };
  }
}
