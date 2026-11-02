import type { IncomingMessage, ServerResponse } from 'http';
import { sessionKey, type SessionRef } from '../../shared/claude-sessions';
import { NOT_ANSWERED, POLL_HOLD_MS, reply, type BridgeRoute } from './bridge-server';

type Poll = { res: ServerResponse; timer: ReturnType<typeof setTimeout> };

/**
 * The bridge's `GET /prompt?session=<id>&pane=<id>` route: the fleet-bridge mod asks it
 * for a prompt for its session, and the request is held until `deliver`
 * answers it with one, or answered with 204 after `POLL_HOLD_MS`. The mod
 * submits what it gets as the person's own prompt, so the prompt needs no
 * typing into the terminal: it is not read as a paste, and it leaves the
 * person's draft as it was.
 *
 * A session whose mod is not asking right now (an older Claude Code, a mod
 * between two requests, eva) gets its prompt typed as before.
 *
 * Requests are told apart by pane as well as session, so one conversation
 * resumed in two panes has a mod waiting in each. A mod that predates `pane`
 * asks by session alone.
 */
export class PromptBridge implements BridgeRoute {
  /** The request each session's mod has open, newest only, by `sessionKey` or a bare session id. */
  private readonly polls = new Map<string, Poll>();

  constructor(private readonly holdMs: number = POLL_HOLD_MS) {}

  stop(): void {
    for (const key of [...this.polls.keys()]) this.answer(key, 204);
  }

  /** Whether the session's mod is waiting for a prompt now, so `deliver` would take one. */
  has(session: SessionRef): boolean {
    return this.keyOf(session) !== null;
  }

  /** Hand the prompt to the session's mod; false when its mod is not waiting for one. */
  deliver(session: SessionRef, text: string): boolean {
    const key = this.keyOf(session);
    return key !== null && this.answer(key, 200, JSON.stringify({ text }));
  }

  handle(_req: IncomingMessage, res: ServerResponse, url: URL): void {
    const sessionId = url.searchParams.get('session');
    if (!sessionId) {
      res.writeHead(404).end();
      return;
    }
    const paneId = url.searchParams.get('pane');
    const key = paneId ? sessionKey({ sessionId, paneId }) : sessionId;
    // A newer request takes the older one's place: a reloaded mod's, or a second mod's.
    this.answer(key, NOT_ANSWERED);
    const poll: Poll = { res, timer: setTimeout(() => this.answer(key, 204), this.holdMs) };
    this.polls.set(key, poll);
    res.on('close', () => {
      if (this.polls.get(key) !== poll) return;
      clearTimeout(poll.timer);
      this.polls.delete(key);
    });
  }

  /** The key the session's mod asked under, or null when it is not asking. */
  private keyOf(session: SessionRef): string | null {
    const key = sessionKey(session);
    if (this.polls.has(key)) return key;
    return this.polls.has(session.sessionId) ? session.sessionId : null;
  }

  private answer(key: string, status: number, body?: string): boolean {
    const poll = this.polls.get(key);
    if (!poll) return false;
    this.polls.delete(key);
    clearTimeout(poll.timer);
    // The mod went away and 'close' has not fired yet: the prompt would be lost.
    if (poll.res.destroyed) return false;
    reply(poll.res, status, body);
    return true;
  }
}
