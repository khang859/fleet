import { createLogger } from '../logger';
import type { PermissionSuggestion } from '../../shared/claude-sessions';

const log = createLogger('claude-sessions:permission-broker');

/** The answer a held request got through Fleet. */
export type PermissionAnswer = {
  decision: 'allow' | 'deny';
  reason: string;
  /** Changes Claude Code suggested that the user allowed along with the request. */
  updatedPermissions?: PermissionSuggestion[];
};

/**
 * A permission request whose asker waits for Fleet's answer: a Go hook on its
 * socket, or the fleet-bridge mod asking over the bridge.
 */
export type HeldRequest = {
  /** Hand the asker the answer; false when it can no longer take one. */
  deliver(answer: PermissionAnswer): boolean;
  /** Stop holding it without an answer, so the runtime's own prompt takes it. */
  letGo(): void;
  /** It was settled elsewhere: drop it. */
  discard(): void;
  /** Calls `cb` once if the asker goes away on its own. */
  onGone(cb: () => void): void;
};

type Held = { sessionId: string; request: HeldRequest };

/**
 * Keeps the permission requests waiting on an answer from Fleet, and delivers
 * the answer when one comes.
 *
 * `onReleased` fires once per held request that goes away: answered here,
 * with the answer, or with null when Fleet let it go or the asker went away
 * (the user answered in the terminal, or the hook timed out).
 */
export class PermissionBroker {
  private readonly held = new Map<string, Held>();

  constructor(
    private readonly onReleased: (
      sessionId: string,
      toolUseId: string,
      answer: PermissionAnswer | null
    ) => void
  ) {}

  hold(sessionId: string, toolUseId: string, request: HeldRequest): void {
    // A request already held under the id is one Fleet can no longer answer.
    this.held.get(toolUseId)?.request.discard();
    this.held.set(toolUseId, { sessionId, request });
    request.onGone(() => {
      if (this.held.get(toolUseId)?.request !== request) return;
      log.info('permission asker went away', { toolUseId, sessionId });
      this.release(toolUseId, null);
    });
    log.debug('holding permission', { toolUseId });
  }

  has(toolUseId: string): boolean {
    return this.held.has(toolUseId);
  }

  /** Every request held now. */
  list(): Array<{ sessionId: string; toolUseId: string }> {
    return [...this.held].map(([toolUseId, h]) => ({ sessionId: h.sessionId, toolUseId }));
  }

  /** Stop holding one request without an answer, so the runtime's own prompt takes it. */
  letGo(toolUseId: string): void {
    this.held.get(toolUseId)?.request.letGo();
    this.release(toolUseId, null);
  }

  respond(
    toolUseId: string,
    decision: 'allow' | 'deny',
    reason?: string,
    updatedPermissions?: PermissionSuggestion[]
  ): boolean {
    const pending = this.held.get(toolUseId);
    if (!pending) {
      log.warn('no held permission', { toolUseId });
      return false;
    }
    const answer: PermissionAnswer = {
      decision,
      reason: reason ?? '',
      ...(updatedPermissions && { updatedPermissions })
    };
    let delivered = false;
    try {
      delivered = pending.request.deliver(answer);
    } catch (err) {
      log.error('failed to write permission answer', { toolUseId, error: String(err) });
    }
    this.release(toolUseId, delivered ? answer : null);
    if (delivered) log.info('permission answered', { toolUseId, decision });
    return delivered;
  }

  /**
   * Drop held requests the session no longer lists, without reporting them:
   * the event stream already said they are settled (the tool ran, or the turn
   * ended), typically because the user answered in the terminal.
   */
  retainOnly(sessionId: string, toolUseIds: ReadonlySet<string>): void {
    for (const [toolUseId, pending] of this.held) {
      if (pending.sessionId !== sessionId || toolUseIds.has(toolUseId)) continue;
      this.held.delete(toolUseId);
      pending.request.discard();
    }
  }

  /** Let every held request go, giving the askers a moment to read that. */
  async dispose(): Promise<void> {
    const requests = [...this.held.values()].map((h) => h.request);
    this.held.clear();
    for (const request of requests) request.letGo();
    if (requests.length === 0) return;
    await new Promise((resolve) => setTimeout(resolve, 500));
    for (const request of requests) request.discard();
  }

  private release(toolUseId: string, answer: PermissionAnswer | null): void {
    const pending = this.held.get(toolUseId);
    if (!pending) return;
    this.held.delete(toolUseId);
    this.onReleased(pending.sessionId, toolUseId, answer);
  }
}
