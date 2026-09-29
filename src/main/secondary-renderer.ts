import type { BrowserWindow, WebPreferences } from 'electron';
import { existsSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { createLogger } from './logger';

const log = createLogger('secondary-renderer');

/**
 * A window with its own renderer bundle beside the main one: its HTML lives at
 * `src/renderer/<entry>/index.html`, its React root at
 * `src/renderer/<entry>/src/main.tsx`, and its preload at
 * `src/preload/<entry>.ts`. Each needs a matching input in
 * `electron.vite.config.ts`.
 */
export type SecondaryEntry = {
  entry: string;
  title: string;
};

function isDev(): boolean {
  return !!process.env.ELECTRON_RENDERER_URL;
}

/** The built preload, which is `.js` or `.mjs` depending on the build. */
function resolvePreloadPath(entry: string): string {
  const js = fileURLToPath(new URL(`../preload/${entry}.js`, import.meta.url));
  const mjs = fileURLToPath(new URL(`../preload/${entry}.mjs`, import.meta.url));
  return existsSync(js) ? js : mjs;
}

export function secondaryWebPreferences(entry: string): WebPreferences {
  return {
    preload: resolvePreloadPath(entry),
    contextIsolation: true,
    sandbox: false,
    nodeIntegration: false,
    // The dev page is loaded from file:// but pulls its modules from the Vite
    // server, which web security would block.
    webSecurity: !isDev()
  };
}

export function buildDevBootstrapHtml(opts: {
  viteUrl: string;
  title: string;
  mainTsxPath: string;
}): string {
  const { viteUrl, title, mainTsxPath } = opts;
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${title}</title>
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
}

/**
 * Load a secondary renderer into its window.
 *
 * In dev, electron-vite's server does not serve secondary HTML entries (it
 * returns an empty page), so a bootstrap page is written to `out/` that loads
 * the entry's React root straight from the Vite server.
 */
export function loadSecondaryRenderer(win: BrowserWindow, { entry, title }: SecondaryEntry): void {
  win.webContents.on('did-fail-load', (_event, errorCode, errorDescription) => {
    log.error('renderer failed to load', { entry, errorCode, errorDescription });
  });
  win.webContents.on('did-finish-load', () => {
    log.info('renderer loaded', { entry });
  });

  const viteUrl = process.env.ELECTRON_RENDERER_URL;
  if (!viteUrl) {
    const filePath = fileURLToPath(new URL(`../renderer/${entry}/index.html`, import.meta.url));
    void win.loadFile(filePath);
    return;
  }

  const outDir = join(process.cwd(), 'out');
  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
  const bootstrapPath = join(outDir, `${entry}-dev.html`);
  const mainTsxPath = join(process.cwd(), 'src', 'renderer', entry, 'src', 'main.tsx');
  writeFileSync(bootstrapPath, buildDevBootstrapHtml({ viteUrl, title, mainTsxPath }), 'utf-8');
  log.info('loading renderer (dev bootstrap)', { entry, bootstrapPath });
  void win.loadFile(bootstrapPath);
}
