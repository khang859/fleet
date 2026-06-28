import { BrowserWindow, session, type Session } from 'electron';
import { isFetchableUrl } from './web-fetch';

/** In-memory (non-persisted) partition isolates web-fetch browsing from the app. */
const PARTITION = 'web-fetch';
const RENDER_TIMEOUT_MS = 30_000;
/** Settle delay after load so late client-side rendering (SPA hydration) lands. */
const SETTLE_MS = 700;

let configured: Session | null = null;

/** Block http(s) requests to a private/loopback host (allow data:/blob:/about:). */
function isPrivateHttpUrl(raw: string): boolean {
  let protocol: string;
  try {
    protocol = new URL(raw).protocol;
  } catch {
    return false;
  }
  if (protocol !== 'http:' && protocol !== 'https:') return false;
  return !isFetchableUrl(raw);
}

/** Lazily harden the shared fetch session once (no downloads, no permissions). */
function getRenderSession(): Session {
  if (configured) return configured;
  const ses = session.fromPartition(PARTITION);
  ses.setPermissionRequestHandler((_wc, _perm, cb) => {
    cb(false);
  });
  ses.on('will-download', (e) => e.preventDefault());
  // Defense in depth: even a validated page can redirect or pull subresources
  // to an internal IP. Cancel any request that resolves to a private host.
  ses.webRequest.onBeforeRequest((details, cb) => {
    cb({ cancel: isPrivateHttpUrl(details.url) });
  });
  configured = ses;
  return ses;
}

/**
 * Load `url` in a hidden, sandboxed BrowserWindow, let its JavaScript run, and
 * return the fully-rendered `outerHTML`. The window is sandboxed (no node
 * integration, isolated session, images/permissions/downloads off) and always
 * torn down. Untrusted JS only runs inside this renderer — the caller parses the
 * returned string in the main process.
 */
export async function renderPage(url: string, signal: AbortSignal): Promise<string> {
  if (signal.aborted) throw new Error('aborted');
  const win = new BrowserWindow({
    show: false,
    width: 1280,
    height: 900,
    webPreferences: {
      session: getRenderSession(),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      javascript: true,
      images: false,
      webgl: false,
      backgroundThrottling: false
    }
  });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  try {
    return await loadAndExtract(win, url, signal);
  } finally {
    if (!win.isDestroyed()) win.destroy();
  }
}

/** Resolve with the rendered outerHTML, or reject on load failure / timeout / abort. */
async function loadAndExtract(
  win: BrowserWindow,
  url: string,
  signal: AbortSignal
): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    let done = false;
    const timer = setTimeout(() => {
      settle(() => reject(new Error('Render timed out')));
    }, RENDER_TIMEOUT_MS);
    const onAbort = (): void => {
      settle(() => reject(new Error('aborted')));
    };
    function settle(fn: () => void): void {
      if (done) return;
      done = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      fn();
    }

    signal.addEventListener('abort', onAbort, { once: true });

    win.webContents.once('did-finish-load', () => {
      void (async () => {
        try {
          // Give late client-side rendering a moment to populate the DOM.
          await new Promise<void>((r) => setTimeout(r, SETTLE_MS));
          const html: unknown = await win.webContents.executeJavaScript(
            'document.documentElement.outerHTML',
            true
          );
          settle(() => resolve(typeof html === 'string' ? html : String(html)));
        } catch (err) {
          settle(() => reject(err instanceof Error ? err : new Error(String(err))));
        }
      })();
    });
    win.webContents.once('did-fail-load', (_e, code, desc) => {
      // -3 (ABORTED) fires on benign in-page navigations; ignore it.
      if (code === -3) return;
      settle(() => reject(new Error(`Load failed: ${desc || 'unknown error'} (${code})`)));
    });

    void win.loadURL(url);
  });
}
