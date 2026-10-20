import type { IncomingMessage, ServerResponse } from 'http';
import { NOT_ANSWERED, POLL_HOLD_MS, reply, type BridgeRoute } from './bridge-server';

type Poll = { res: ServerResponse; timer: ReturnType<typeof setTimeout> };

/**
 * The bridge's `GET /prompt?session=<id>` route: the fleet-bridge mod asks it
 * for a prompt for its session, and the request is held until `deliver`
 * answers it with one, or answered with 204 after `POLL_HOLD_MS`. The mod
 * submits what it gets as the person's own prompt, so the prompt needs no
 * typing into the terminal: it is not read as a paste, and it leaves the
 * person's draft as it was.
 *
 * A session whose mod is not asking right now (an older Claude Code, a mod
 * between two requests, eva) gets its prompt typed as before.
 */
export class PromptBridge implements BridgeRoute {
  /** The request each session's mod has open, newest only. */
  private readonly polls = new Map<string, Poll>();

  constructor(private readonly holdMs: number = POLL_HOLD_MS) {}

  stop(): void {
    for (const sessionId of [...this.polls.keys()]) this.answer(sessionId, 204);
  }

  /** Whether the session's mod is waiting for a prompt now, so `deliver` would take one. */
  has(sessionId: string): boolean {
    return this.polls.has(sessionId);
  }

  /** Hand the prompt to the session's mod; false when its mod is not waiting for one. */
  deliver(sessionId: string, text: string): boolean {
    return this.answer(sessionId, 200, JSON.stringify({ text }));
  }

  handle(_req: IncomingMessage, res: ServerResponse, url: URL): void {
    const sessionId = url.searchParams.get('session');
    if (!sessionId) {
      res.writeHead(404).end();
      return;
    }
    // A newer request took the older one's place: a reloaded mod's, or a
    // second mod's. The mod waits before it asks again, so two mods asking
    // for one session do not take turns in a busy loop.
    this.answer(sessionId, NOT_ANSWERED);
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
    // The mod went away and 'close' has not fired yet: the prompt would be lost.
    if (poll.res.destroyed) return false;
    reply(poll.res, status, body);
    return true;
  }
}
