import { randomUUID } from 'node:crypto';
import { IPC_CHANNELS } from '../../../shared/ipc-channels';
import {
  decideCommand,
  suggestRule,
  type AgentPermissionRules
} from '../../../shared/agent-permissions';
import type { AgentPermissionAsk, AgentPermissionOutcome } from '../../../shared/agent-types';

/**
 * The gate a shell command passes through before it runs.
 *
 * The decision is made here, in main, and never in the renderer: the pane draws
 * the question and relays a click, so a compromised or confused renderer has
 * nothing to grant itself. The rules settle most calls without anybody being
 * asked; what they are silent about comes to the user.
 */

export type PermissionGrant = 'run' | 'refuse';

type Deps = {
  getRules: () => AgentPermissionRules;
  /** Persist a rule the user chose to keep. */
  persistAllow: (rule: string) => void;
  emit: (channel: string, payload: unknown) => void;
};

type Pending = {
  resolve: (grant: PermissionGrant) => void;
  streamId: string;
  command: string;
  /** What "always" would remember, or null when that was not offered. */
  rule: string | null;
};

export type PermissionRequest = {
  streamId: string;
  callId: string;
  command: string;
  /** Aborted when the turn is stopped, which answers a question nobody got to. */
  signal: AbortSignal;
};

export class PermissionGate {
  private readonly pending = new Map<string, Pending>();

  /**
   * What each turn has already been told no about.
   *
   * A refusal is an answer to the command, not to the moment: a model that
   * hears no and calls the same thing again is not owed a second question, and
   * asking one trains the user to click through them.
   */
  private readonly refused = new Map<string, Set<string>>();

  constructor(private readonly deps: Deps) {}

  async check(req: PermissionRequest): Promise<PermissionGrant> {
    if (this.wasRefused(req.streamId, req.command)) return 'refuse';

    const verdict = decideCommand(this.deps.getRules(), req.command);
    if (verdict.kind === 'allow') return 'run';
    if (verdict.kind === 'deny') return 'refuse';

    // A command that always asks is one no rule may quietly cover later, so
    // there is nothing to offer to remember.
    const rule = verdict.kind === 'ask' && !verdict.remember ? null : suggestRule(req.command);
    return this.ask(req, verdict.kind === 'ask' ? verdict.reason : null, rule);
  }

  /** Relay the user's click. A request that already settled is ignored. */
  decide(requestId: string, outcome: AgentPermissionOutcome): void {
    const entry = this.pending.get(requestId);
    if (entry === undefined) return;
    if (outcome === 'always' && entry.rule !== null) this.deps.persistAllow(entry.rule);
    if (outcome === 'no') {
      const already = this.refused.get(entry.streamId) ?? new Set<string>();
      already.add(entry.command);
      this.refused.set(entry.streamId, already);
    }
    // Only the two answers that mean yes mean yes. Anything else - a payload
    // that arrived malformed, an outcome added later and not handled here -
    // leaves the command unrun, which is the direction to be wrong in.
    this.settle(requestId, outcome === 'once' || outcome === 'always' ? 'run' : 'refuse');
  }

  /**
   * Whether this turn has already been told no about a command.
   *
   * A refusal is about the command, so it holds however the command is next
   * offered - including by a tool that does not ask.
   */
  wasRefused(streamId: string, command: string): boolean {
    return this.refused.get(streamId)?.has(command) ?? false;
  }

  /** Called when a turn ends, however it ended: nothing here outlives it. */
  endTurn(streamId: string): void {
    this.refused.delete(streamId);
    for (const [id, entry] of [...this.pending]) {
      if (entry.streamId === streamId) this.settle(id, 'refuse');
    }
  }

  private async ask(
    req: PermissionRequest,
    reason: string | null,
    rule: string | null
  ): Promise<PermissionGrant> {
    return new Promise<PermissionGrant>((resolve) => {
      if (req.signal.aborted) {
        resolve('refuse');
        return;
      }

      const requestId = randomUUID();
      this.pending.set(requestId, {
        resolve,
        streamId: req.streamId,
        command: req.command,
        rule
      });
      // A turn stopped while the question is on screen answers it: the command
      // must not start after the user has already walked away from the turn.
      req.signal.addEventListener('abort', () => this.settle(requestId, 'refuse'), { once: true });

      this.deps.emit(IPC_CHANNELS.AGENT_PERMISSION_ASK, {
        streamId: req.streamId,
        requestId,
        callId: req.callId,
        command: req.command,
        reason,
        rule
      } satisfies AgentPermissionAsk);
    });
  }

  private settle(requestId: string, grant: PermissionGrant): void {
    const entry = this.pending.get(requestId);
    if (entry === undefined) return;
    this.pending.delete(requestId);
    entry.resolve(grant);
  }
}
