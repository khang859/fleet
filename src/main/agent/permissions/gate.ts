import { randomUUID } from 'node:crypto';
import { IPC_CHANNELS } from '../../../shared/ipc-channels';
import {
  decideCommand,
  decideMcpTool,
  suggestRule,
  type AgentPermissionRules
} from '../../../shared/agent-permissions';
import { serverRulePattern } from '../../../shared/agent-mcp-names';
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
  /**
   * The same, for a server's tool. A separate call because it lands in a
   * separate list - one matched against tool names rather than shell commands.
   */
  persistAllowMcp: (rule: string) => void;
  emit: (channel: string, payload: unknown) => void;
};

type Pending = {
  resolve: (grant: PermissionGrant) => void;
  streamId: string;
  command: string;
  /** What "always" would remember, or null when that was not offered. */
  rule: string | null;
  /** Which list a remembered rule belongs in. */
  rules: 'shell' | 'mcp';
  /** Detaches this question's abort listener once it has been answered. */
  release: () => void;
};

export type PermissionRequest = {
  streamId: string;
  callId: string;
  command: string;
  /** Aborted when the turn is stopped, which answers a question nobody got to. */
  signal: AbortSignal;
};

/** The same question, about one of a connected server's tools. */
export type McpPermissionRequest = {
  streamId: string;
  callId: string;
  signal: AbortSignal;
  /** The name the model called, which is what a rule is matched against. */
  wireName: string;
  server: string;
  /** The tool's own name on the server, which is what the user sees. */
  tool: string;
  /** The arguments as the model wrote them, for the card to show. */
  args: string;
  /** The server's claim that this tool only reads. Its word, not a guarantee. */
  readOnly: boolean;
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

  /**
   * Whether one of a connected server's tools may run.
   *
   * A tool the server marks read-only runs unasked. That is the server's own
   * claim about its own tool and nothing checks it, so it is a convenience and
   * never a boundary: it saves a click on a search, and a server that lied
   * about it was already a server the user chose to hand their machine to. The
   * user's own rules still come first, so a denied tool stays denied whatever
   * the server says about it.
   */
  async checkMcp(req: McpPermissionRequest): Promise<PermissionGrant> {
    if (this.wasRefused(req.streamId, req.wireName)) return 'refuse';

    const verdict = decideMcpTool(this.deps.getRules(), req.wireName);
    if (verdict.kind === 'deny') return 'refuse';
    if (verdict.kind === 'allow') return 'run';
    if (req.readOnly) return 'run';

    return this.ask(
      { streamId: req.streamId, callId: req.callId, command: req.wireName, signal: req.signal },
      null,
      serverRulePattern(req.server),
      { server: req.server, tool: req.tool, args: req.args }
    );
  }

  /** Relay the user's click. A request that already settled is ignored. */
  decide(requestId: string, outcome: AgentPermissionOutcome): void {
    const entry = this.pending.get(requestId);
    if (entry === undefined) return;
    if (outcome === 'always' && entry.rule !== null) {
      if (entry.rules === 'mcp') this.deps.persistAllowMcp(entry.rule);
      else this.deps.persistAllow(entry.rule);
    }
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
    rule: string | null,
    mcp: AgentPermissionAsk['mcp'] = null
  ): Promise<PermissionGrant> {
    return new Promise<PermissionGrant>((resolve) => {
      if (req.signal.aborted) {
        resolve('refuse');
        return;
      }

      const requestId = randomUUID();
      // A turn stopped while the question is on screen answers it: the command
      // must not start after the user has already walked away from the turn.
      // Detached once answered - one turn asks many questions, and a signal
      // that outlives them collects a listener for every one.
      const onAbort = (): void => this.settle(requestId, 'refuse');
      req.signal.addEventListener('abort', onAbort, { once: true });

      this.pending.set(requestId, {
        resolve,
        streamId: req.streamId,
        command: req.command,
        rule,
        rules: mcp === null ? 'shell' : 'mcp',
        release: () => req.signal.removeEventListener('abort', onAbort)
      });

      this.deps.emit(IPC_CHANNELS.AGENT_PERMISSION_ASK, {
        streamId: req.streamId,
        requestId,
        callId: req.callId,
        command: req.command,
        reason,
        rule,
        mcp
      } satisfies AgentPermissionAsk);
    });
  }

  private settle(requestId: string, grant: PermissionGrant): void {
    const entry = this.pending.get(requestId);
    if (entry === undefined) return;
    this.pending.delete(requestId);
    entry.release();
    entry.resolve(grant);
  }
}
