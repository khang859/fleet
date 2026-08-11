import { BrowserWindow, session, type Session } from 'electron';
import { hostKind } from '../../../shared/agent-web';

/**
 * Running a page's JavaScript, so a page that is only a shell can still be read.
 *
 * Most documentation worth fetching now ships an empty `<div id="root">` and a
 * bundle, and the hosted fetch tools - Anthropic's included - simply give up on
 * those. Fleet is a desktop app with a browser engine already in it, so it does
 * not have to.
 *
 * The page's own scripts run, which is the point and also the risk, so they run
 * as far from everything else as this process can put them: a session that is
 * not the app's, no node, no preload, no downloads, no permissions, nothing
 * shown on screen, and the window destroyed however the attempt ends. What
 * comes back is a string, parsed by the caller in main, so nothing untrusted is
 * ever executing anywhere but inside that renderer.
 */

/**
 * In-memory and not the app's, so nothing browsed here can see a cookie of ours.
 *
 * Two of them, because what a page may reach depends on what the page is. A
 * dev server on this machine has to be able to load its own bundle off this
 * machine; a page from the internet has no business asking for anything here,
 * whatever the user's setting says about the addresses *they* may name. Keeping
 * that as two sessions rather than one flag on a shared filter means the wrong
 * page cannot be rendered under the wrong rule by a later edit.
 */
const PARTITIONS = { strict: 'agent-web-fetch', local: 'agent-web-fetch-local' } as const;

const RENDER_TIMEOUT_MS = 30_000;

/** Time after load for late client-side rendering to put something in the DOM. */
const SETTLE_MS = 700;

/**
 * Characters of rendered HTML brought back into main.
 *
 * The direct path caps what it reads off the socket, and a page that builds
 * itself can just as easily build something enormous - so the cut is made
 * inside the renderer, before the string crosses to the main process at all.
 */
const MAX_RENDER_CHARS = 5_000_000;

const configured = new Map<string, Session>();

/** Whether a request from inside the page is one we would not have made ourselves. */
function isDisallowed(raw: string, allowLocal: boolean): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;

  const kind = hostKind(url.hostname);
  if (kind === 'public') return false;
  if (kind === 'local') return !allowLocal;
  return true;
}

/**
 * A hardened session, made once per rule.
 *
 * The request filter is the part that matters. The page we loaded was checked,
 * but a page can ask for anything once it is running - a subresource, an
 * `img` pointed at a metadata endpoint, a redirect - and none of that went
 * through the check the top-level URL did. Chromium resolves its own names, so
 * this is a host-string check rather than a pinned one; metadata addresses are
 * refused in both rules regardless, which is the part that has to hold.
 */
function getRenderSession(allowLocal: boolean): Session {
  const partition = allowLocal ? PARTITIONS.local : PARTITIONS.strict;
  const existing = configured.get(partition);
  if (existing !== undefined) return existing;

  const ses = session.fromPartition(partition);
  ses.setPermissionRequestHandler((_contents, _permission, callback) => {
    callback(false);
  });
  ses.on('will-download', (event) => event.preventDefault());
  ses.webRequest.onBeforeRequest((details, callback) => {
    callback({ cancel: isDisallowed(details.url, allowLocal) });
  });
  configured.set(partition, ses);
  return ses;
}

/**
 * Load the page, let it build itself, and hand back the HTML that resulted.
 *
 * `allowLocal` is about this page rather than about the user's setting: it is
 * true only when the page being rendered is itself on this machine, so a page
 * fetched from the internet cannot reach a dev server even on a machine where
 * the user has allowed themselves to name one.
 */
export async function renderPage(
  url: string,
  allowLocal: boolean,
  signal: AbortSignal
): Promise<string> {
  if (signal.aborted) throw new Error('aborted');

  const win = new BrowserWindow({
    show: false,
    width: 1280,
    height: 900,
    webPreferences: {
      session: getRenderSession(allowLocal),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      javascript: true,
      // Nothing here is looked at, and images are most of what a page weighs.
      images: false,
      webgl: false,
      // The window is never visible, and a throttled renderer never finishes.
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

/** The HTML once the page has settled, or a rejection on failure, timeout or abort. */
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

    function settle(finish: () => void): void {
      if (done) return;
      done = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      finish();
    }

    signal.addEventListener('abort', onAbort, { once: true });

    win.webContents.once('did-finish-load', () => {
      void (async () => {
        try {
          await new Promise<void>((wake) => setTimeout(wake, SETTLE_MS));
          const html: unknown = await win.webContents.executeJavaScript(
            `document.documentElement.outerHTML.slice(0, ${MAX_RENDER_CHARS})`,
            true
          );
          settle(() => resolve(typeof html === 'string' ? html : String(html)));
        } catch (err) {
          settle(() => reject(err instanceof Error ? err : new Error(String(err))));
        }
      })();
    });

    win.webContents.once('did-fail-load', (_event, code, description) => {
      // -3 is ABORTED, which fires on ordinary in-page navigation and means
      // nothing went wrong.
      if (code === -3) return;
      settle(() => reject(new Error(`Load failed: ${description || 'unknown error'} (${code})`)));
    });

    // `loadURL` rejects on the same failures `did-fail-load` reports, and an
    // unhandled rejection in main is a crash in some builds, so it is caught
    // here and left to the listener above to turn into an answer.
    win.loadURL(url).catch(() => {});
  });
}
