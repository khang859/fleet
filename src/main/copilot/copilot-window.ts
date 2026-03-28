import { BrowserWindow, screen } from 'electron';
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
const TOGGLE_DEBOUNCE_MS = 800;

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
  // Use an absolute file path so Vite can resolve and transform the module
  const mainTsxPath = join(process.cwd(), 'src', 'renderer', 'copilot', 'src', 'main.tsx');
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Fleet Copilot</title>
  <style>
    html, body, #root { margin: 0; padding: 0; width: 100%; height: 100%; overflow: hidden; background: transparent; }
  </style>
  <script type="module" src="${viteUrl}/@vite/client"></script>
  <script type="module">
    import RefreshRuntime from "${viteUrl}/@react-refresh";
    RefreshRuntime.injectIntoGlobalHook(window);
    window.$RefreshReg$ = () => {};
    window.$RefreshSig$ = () => (type) => type;
    window.__vite_plugin_react_preamble_installed__ = true;
  </script>
</head>
<body>
  <div id="root"></div>
  <script type="module" src="${viteUrl}/@fs${mainTsxPath}"></script>
</body>
</html>`;
  writeFileSync(bootstrapPath, html, 'utf-8');
  return bootstrapPath;
}

export class CopilotWindow {
  private win: BrowserWindow | null = null;
  private positionStore: Store<CopilotWindowStore>;
  private expanded = false;
  private lastToggleTime = 0;

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
      width: SPRITE_SIZE,
      height: SPRITE_SIZE,
      x,
      y,
      frame: false,
      transparent: true,
      hasShadow: false,
      skipTaskbar: true,
      resizable: false,
      // Keep focusable so clicks work; alwaysOnTop keeps it visible
      focusable: true,
      webPreferences: {
        preload: preloadPath,
        contextIsolation: true,
        sandbox: false,
        nodeIntegration: false,
        webSecurity: !isDev,
      },
    });

    this.win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    this.win.setAlwaysOnTop(true, 'floating');

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
    });

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

  /**
   * Toggle expanded state. Main process owns this state and debounces
   * to prevent phantom click events caused by setBounds() from
   * triggering rapid re-toggles in the renderer.
   * Returns the new expanded state, or null if debounced.
   */
  toggleExpanded(): boolean | null {
    const now = Date.now();
    if (now - this.lastToggleTime < TOGGLE_DEBOUNCE_MS) {
      log.info('toggleExpanded DEBOUNCED', { elapsed: now - this.lastToggleTime });
      return null;
    }
    this.lastToggleTime = now;
    this.expanded = !this.expanded;
    log.info('toggleExpanded', { expanded: this.expanded });
    this.applyExpanded();
    return this.expanded;
  }

  setExpanded(expanded: boolean): void {
    if (this.expanded === expanded) return;
    const now = Date.now();
    if (now - this.lastToggleTime < TOGGLE_DEBOUNCE_MS) {
      log.info('setExpanded DEBOUNCED', { expanded, elapsed: now - this.lastToggleTime });
      return;
    }
    this.lastToggleTime = now;
    this.expanded = expanded;
    log.info('setExpanded', { expanded });
    this.applyExpanded();
  }

  isExpanded(): boolean {
    return this.expanded;
  }

  private applyExpanded(): void {
    if (!this.win || this.win.isDestroyed()) return;
    const bounds = this.win.getBounds();

    if (this.expanded) {
      const newBounds = {
        x: bounds.x - (EXPANDED_WIDTH - bounds.width),
        y: bounds.y,
        width: EXPANDED_WIDTH,
        height: EXPANDED_HEIGHT,
      };
      log.info('expanding to', newBounds);
      this.win.setBounds(newBounds);
      this.win.setAlwaysOnTop(true, 'pop-up-menu');
    } else {
      const newBounds = {
        x: bounds.x + (bounds.width - SPRITE_SIZE),
        y: bounds.y,
        width: SPRITE_SIZE,
        height: SPRITE_SIZE,
      };
      log.info('collapsing to', newBounds);
      this.win.setBounds(newBounds);
      this.win.setAlwaysOnTop(true, 'floating');
    }

    // Notify renderer of authoritative state
    this.win.webContents.send('copilot:expanded-changed', this.expanded);
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
      y: primary.bounds.y + 60,
    };
  }
}
