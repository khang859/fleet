import { app, BrowserWindow, screen } from 'electron';
import { existsSync, writeFileSync, mkdirSync } from 'fs';
import { fileURLToPath } from 'url';
import { join } from 'path';
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

/**
 * In dev mode, electron-vite's dev server doesn't properly serve secondary
 * HTML entry points (returns empty page). Workaround: write a bootstrap HTML
 * file to disk that loads the copilot React app from the Vite dev server.
 */
function getDevBootstrapPath(viteUrl: string): string {
  const outDir = join(process.cwd(), 'out');
  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });

  const bootstrapPath = join(outDir, 'copilot-dev.html');
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Fleet Copilot</title>
  <style>html, body, #root { margin: 0; padding: 0; background: transparent; overflow: hidden; }</style>
  <script type="module" src="${viteUrl}/@vite/client"></script>
</head>
<body>
  <div id="root"></div>
  <script type="module" src="${viteUrl}/src/renderer/copilot/src/main.tsx"></script>
</body>
</html>`;
  writeFileSync(bootstrapPath, html, 'utf-8');
  return bootstrapPath;
}

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
    log.info('preload resolution', { preloadPath, exists: existsSync(preloadPath) });

    const isDev = !!process.env.ELECTRON_RENDERER_URL;

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
        // In dev, the bootstrap HTML loads scripts from localhost via file:// origin
        webSecurity: !isDev,
      },
    });

    this.win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    this.win.setContentSize(SPRITE_SIZE, SPRITE_SIZE);
    this.win.setIgnoreMouseEvents(false);

    if (isDev) {
      // electron-vite doesn't serve secondary HTML entries in dev.
      // Write a bootstrap HTML file that loads the copilot app from the Vite dev server.
      const bootstrapPath = getDevBootstrapPath(process.env.ELECTRON_RENDERER_URL!);
      log.info('loading copilot renderer (dev bootstrap)', { bootstrapPath });
      void this.win.loadFile(bootstrapPath);
    } else {
      const filePath = fileURLToPath(new URL('../renderer/copilot/index.html', import.meta.url));
      log.info('loading copilot renderer (prod)', { filePath, exists: existsSync(filePath) });
      void this.win.loadFile(filePath);
    }

    this.win.webContents.on('did-fail-load', (_event, errorCode, errorDescription) => {
      log.error('copilot renderer failed to load', { errorCode, errorDescription });
    });

    this.win.webContents.on('did-finish-load', () => {
      log.info('copilot renderer loaded');
      if (!app.isPackaged) {
        this.win?.webContents
          .executeJavaScript(`document.documentElement.outerHTML.substring(0, 1000)`)
          .then((html: unknown) => log.info('copilot DOM', { html: String(html) }))
          .catch(() => {});
      }
    });

    this.win.webContents.on('console-message', (_event) => {
      // Forward copilot renderer console to main process for debugging
      if (_event.message && !_event.message.startsWith('%c')) {
        log.debug('copilot console', { message: _event.message.substring(0, 200) });
      }
    });

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
