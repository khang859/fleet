import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * Where the browser comes back to after an OAuth sign-in.
 *
 * A loopback listener rather than a custom URL scheme. It is what RFC 8252
 * recommends for a native app, it needs no registration with the OS, and - the
 * part that matters here - an authorization server will redirect to
 * `http://127.0.0.1:PORT/...` without the user having to have installed
 * anything. A custom scheme would also work, but only after Fleet is installed
 * in the place the OS reads its registrations from, which is not true of a dev
 * build.
 *
 * `127.0.0.1` and never `localhost`: the name can resolve to `::1` first, and a
 * server that redirects to the name while we listened on the address is a
 * sign-in that hangs on a page that never loads.
 *
 * Open only for the length of one flow. A port left listening is a port anything
 * on the machine can post an authorization code to.
 */

/** Tried in order. The first is conventional; the rest are for when it is taken. */
const PORTS = [33418, 33419, 33420, 33421, 33422];

const HOST = '127.0.0.1';

export function callbackUrl(port: number): string {
  return `http://${HOST}:${port}/callback`;
}

/**
 * Every address the browser might be sent back to.
 *
 * All of them are registered with the authorization server, not just the one
 * in use. RFC 8252 says a server should accept any port on a loopback redirect,
 * but not all do - and a sign-in that worked in June and fails in July because
 * something else took the port is the kind of fault nobody can diagnose.
 */
export const CALLBACK_URLS = PORTS.map(callbackUrl);

/** Where a provider points when no flow is running and one is only reading tokens. */
export const DEFAULT_CALLBACK_URL = CALLBACK_URLS[0];

/**
 * The query the browser came back with, whole.
 *
 * Passed on rather than picked apart, because `finishAuth` reads more than the
 * code: it checks `iss` against the issuer it recorded (RFC 9207) before
 * reading anything else, and it can only do that if it is handed the lot.
 */
export type CallbackResult = URLSearchParams;

export type Callback = {
  /** Where the authorization server should send the user back to. */
  redirectUrl: string;
  /** Resolves when the browser arrives, rejects if nobody comes before `signal`. */
  wait: () => Promise<CallbackResult>;
  /** Idempotent. Safe to call after `wait` has settled. */
  close: () => void;
};

/**
 * Start listening for one sign-in.
 *
 * Started before the browser is opened rather than after, so a fast
 * authorization server cannot arrive back before there is anything listening.
 */
export async function startCallback(signal?: AbortSignal): Promise<Callback> {
  const settled = { done: false };
  let deliver: (result: CallbackResult) => void = () => {};
  let fail: (err: Error) => void = () => {};

  const arrival = new Promise<CallbackResult>((resolve, reject) => {
    deliver = resolve;
    fail = reject;
  });

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', `http://${HOST}`);
    // Anything else on this port is not the browser coming back - a favicon
    // request, something else probing. Answered and ignored.
    if (url.pathname !== '/callback') {
      res.writeHead(404).end();
      return;
    }

    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(PAGE);
    if (settled.done) return;
    settled.done = true;
    deliver(url.searchParams);
  });

  await listenOnAny(server);
  const redirectUrl = callbackUrl(portOf(server));

  const close = (): void => {
    server.close();
    // A browser tab left open holds the connection, and `close` alone waits for
    // it. Nothing here outlives the flow.
    server.closeAllConnections();
  };

  const onAbort = (): void => {
    if (settled.done) return;
    settled.done = true;
    fail(new Error('The sign-in was cancelled.'));
  };
  signal?.addEventListener('abort', onAbort, { once: true });

  return {
    redirectUrl,
    wait: async () =>
      arrival.finally(() => {
        signal?.removeEventListener('abort', onAbort);
        close();
      }),
    close: () => {
      signal?.removeEventListener('abort', onAbort);
      close();
    }
  };
}

/**
 * Bind the first port that is free.
 *
 * A fixed range rather than port 0, because the redirect URI is registered with
 * the authorization server: some of them require it to match exactly, and a
 * port that changed since registration is a sign-in that is refused with no
 * useful explanation. A handful of candidates keeps that stable while still
 * surviving a machine where something else already holds the first.
 */
async function listenOnAny(server: Server): Promise<void> {
  for (const port of PORTS) {
    try {
      await listen(server, port);
      return;
    } catch {
      // Taken. Try the next.
    }
  }
  throw new Error(
    `Could not open a port to finish signing in. Ports ${PORTS[0]} to ${PORTS[PORTS.length - 1]} are all in use.`
  );
}

async function listen(server: Server, port: number): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const onError = (err: Error): void => {
      server.removeListener('listening', onListening);
      reject(err);
    };
    const onListening = (): void => {
      server.removeListener('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, HOST);
  });
}

function portOf(server: Server): number {
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('The sign-in listener did not report a port.');
  }
  return (address satisfies AddressInfo).port;
}

/**
 * What the browser shows when it arrives.
 *
 * Deliberately plain and self-contained: it is on screen for a moment, it has
 * no network to fetch anything from, and the only thing it has to say is that
 * the user can go back to Fleet.
 */
const PAGE = `<!doctype html>
<meta charset="utf-8">
<title>Signed in</title>
<style>
  body { font: 15px/1.5 system-ui, sans-serif; display: grid; place-items: center;
         height: 100vh; margin: 0; color: #1c1c1e; background: #fbfbfd; }
  @media (prefers-color-scheme: dark) { body { color: #f2f2f7; background: #17171a; } }
  p { opacity: 0.6; }
</style>
<div>
  <h1>Signed in</h1>
  <p>You can close this tab and go back to Fleet.</p>
</div>
`;
