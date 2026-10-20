import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'http';
import { createLogger } from '../logger';
import { BRIDGE_SOCKET_PATH } from '../../shared/constants';
import { listenOnSocket, removeSocketFile } from './socket-file';

const log = createLogger('claude-sessions:bridge');

/**
 * How long a request from the mod is held before it is answered with 204 and
 * the mod asks again. Under the 30 s Claude Code allows a mod's `fetch`.
 */
export const POLL_HOLD_MS = 20_000;

/**
 * The answer to a request Fleet will not answer: a newer one took its place,
 * or Fleet let it go. For a prompt, the mod waits before it asks again, so two
 * mods asking for one session do not take turns in a busy loop. For a
 * permission request, the mod passes it on to the settings hooks.
 */
export const NOT_ANSWERED = 409;

/** Answer a request from the mod, with a JSON body when there is one. */
export function reply(res: ServerResponse, status: number, body?: string): void {
  if (body === undefined) res.writeHead(status).end();
  else res.writeHead(status, { 'content-type': 'application/json' }).end(body);
}

/** One thing the fleet-bridge mod asks Fleet for, such as a prompt. */
export type BridgeRoute = {
  handle(req: IncomingMessage, res: ServerResponse, url: URL): void;
  /** Answer every request it holds, as Fleet stops. */
  stop(): void;
};

/**
 * The socket the fleet-bridge mod (resources/claude-mod/fleet-bridge) asks
 * Fleet over, which Claude Code loads in every Fleet pane. Each route is keyed
 * by method and path, as in `GET /prompt`.
 */
export class BridgeServer {
  private server: Server | null = null;
  private readonly routes: ReadonlyMap<string, BridgeRoute>;

  constructor(
    routes: Record<string, BridgeRoute>,
    private readonly socketPath: string = BRIDGE_SOCKET_PATH
  ) {
    this.routes = new Map(Object.entries(routes));
  }

  async start(): Promise<void> {
    this.server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://fleet');
      const route = this.routes.get(`${req.method} ${url.pathname}`);
      if (route) route.handle(req, res, url);
      else res.writeHead(404).end();
    });
    return listenOnSocket(this.server, this.socketPath, log);
  }

  async stop(): Promise<void> {
    const server = this.server;
    if (!server) return;
    this.server = null;
    for (const route of this.routes.values()) route.stop();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    removeSocketFile(this.socketPath, log);
  }
}
