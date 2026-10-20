import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'http';
import { createLogger } from '../logger';
import { BRIDGE_SOCKET_PATH } from '../../shared/constants';
import { listenOnSocket, removeSocketFile } from './socket-file';

const log = createLogger('claude-sessions:prompt-bridge');

/** How long a request for a prompt is held before it is answered with none. */
export const POLL_HOLD_MS = 20_000;

type Poll = { res: ServerResponse; timer: ReturnType<typeof setTimeout> };

/**
 * What a request is answered with when a newer one for its session took its
 * place: a reloaded mod's, or a second mod's. The mod waits before it asks
 * again, so two mods asking for one session do not take turns in a busy loop.
 */
const REPLACED = 409;

/**
 * The other end of the fleet-bridge mod (resources/claude-mod/fleet-bridge),
 * which Claude Code loads in every Fleet pane. The mod asks this socket for a
 * prompt for its session (`GET /prompt?session=<id>`), and the request is held
 * until `deliver` answers it with one, or answered with 204 after
 * `POLL_HOLD_MS`. The mod submits what it gets as the person's own prompt, so
 * the prompt needs no typing into the terminal: it is not read as a paste, and
 * it leaves the person's draft as it was.
 *
 * A session whose mod is not asking right now (an older Claude Code, a mod
 * between two requests, eva) gets its prompt typed as before.
 */
export class PromptBridge {
  private server: Server | null = null;
  /** The request each session's mod has open, newest only. */
  private readonly polls = new Map<string, Poll>();

  constructor(
    private readonly socketPath: string = BRIDGE_SOCKET_PATH,
    private readonly holdMs: number = POLL_HOLD_MS
  ) {}

  async start(): Promise<void> {
    this.server = createServer((req, res) => this.onRequest(req, res));
    return listenOnSocket(this.server, this.socketPath, log);
  }

  async stop(): Promise<void> {
    const server = this.server;
    if (!server) return;
    this.server = null;
    for (const sessionId of [...this.polls.keys()]) this.answer(sessionId, 204);
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    removeSocketFile(this.socketPath, log);
  }

  /** Whether the session's mod is waiting for a prompt now, so `deliver` would take one. */
  has(sessionId: string): boolean {
    return this.polls.has(sessionId);
  }

  /** Hand the prompt to the session's mod; false when its mod is not waiting for one. */
  deliver(sessionId: string, text: string): boolean {
    return this.answer(sessionId, 200, JSON.stringify({ text }));
  }

  private onRequest(req: IncomingMessage, res: ServerResponse): void {
    const url = new URL(req.url ?? '/', 'http://fleet');
    const sessionId = url.searchParams.get('session');
    if (req.method !== 'GET' || url.pathname !== '/prompt' || !sessionId) {
      res.writeHead(404).end();
      return;
    }
    this.answer(sessionId, REPLACED);
    const poll: Poll = { res, timer: setTimeout(() => this.answer(sessionId, 204), this.holdMs) };
    this.polls.set(sessionId, poll);
    res.on('close', () => {
      if (this.polls.get(sessionId) !== poll) return;
      clearTimeout(poll.timer);
      this.polls.delete(sessionId);
    });
  }

  private answer(sessionId: string, status: number, body?: string): boolean {
    const poll = this.polls.get(sessionId);
    if (!poll) return false;
    this.polls.delete(sessionId);
    clearTimeout(poll.timer);
    if (body === undefined) poll.res.writeHead(status).end();
    else poll.res.writeHead(status, { 'content-type': 'application/json' }).end(body);
    return true;
  }
}
