import { randomUUID } from 'node:crypto';
import { IPC_CHANNELS } from '../../../shared/ipc-channels';
import {
  decideCommand,
  decideMcpTool,
  suggestRule,
  type AgentPermissionRules
} from '../../../shared/agent-permissions';
import { serverRulePattern } from '../../../shared/agent-mcp-names';
import type {
  AgentPermissionAsk,
  AgentPermissionOutcome,
  AgentTurnUsage
} from '../../../shared/agent-types';
import type { ClassifierVerdict } from './classifier';

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
  /**
   * Whether a model may answer this question instead of the user, and what it
   * said. Absent ⇒ the gate has no such thing and every question is the user's,
   * which is what it was before auto mode existed.
   *
   * It is asked about the commands no rule settled and nothing else. Deciding
   * whether the mode is even on lives behind this rather than here, because
   * "off" and "the model said ask" and "the call failed" all mean the same
   * thing to the gate, and a gate that could tell them apart would only be able
   * to do the same thing about each.
   */
  autoApprove?: (req: AutoApproveRequest) => Promise<AutoApproval>;
};

export type AutoApproveRequest = { command: string; cwd: string; signal: AbortSignal };

/** What the model said, and what asking it cost. */
export type AutoApproval = { verdict: ClassifierVerdict; usage: AgentTurnUsage | null };

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

/** What every question needs, however it was arrived at. */
type Question = {
  streamId: string;
  callId: string;
  command: string;
  /** Aborted when the turn is stopped, which answers a question nobody got to. */
  signal: AbortSignal;
};

export type PermissionRequest = Question & {
  /** Where the command would run. Most of what "outside the folder" means. */
  cwd: string;
  /**
   * Bills a model call this question needed - which in auto mode it may. The
   * turn's account is the caller's, and this is the only side of the wall that
   * knows a second call happened.
   */
  onUsage?: (usage: AgentTurnUsage) => void;
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

  /**
   * What auto mode has already been asked about this turn, and answered.
   *
   * For the money, and for the consistency. A turn that runs the test suite
   * five times should pay for one judgement rather than five, and a model that
   * was told `npm test` is fine must not be stopped and asked about it three
   * rounds later - the same command getting two different answers inside one
   * turn reads as a bug, whichever way round it happens.
   */
  private readonly judged = new Map<string, Map<string, ClassifierVerdict>>();

  constructor(private readonly deps: Deps) {}

  async check(req: PermissionRequest): Promise<PermissionGrant> {
    if (this.wasRefused(req.streamId, req.command)) return 'refuse';

    const verdict = decideCommand(this.deps.getRules(), req.command);
    if (verdict.kind === 'allow') return 'run';
    if (verdict.kind === 'deny') return 'refuse';

    // Only what no rule had anything to say about. A command carrying an
    // always-ask reason is one the user decides whatever the mode is: those are
    // the handful where being wrong costs a rewritten remote or a leaked key,
    // and they are not put to a model.
    if (verdict.kind === 'unknown' && (await this.autoApproved(req))) return 'run';

    // A command that always asks is one no rule may quietly cover later, so
    // there is nothing to offer to remember.
    const rule = verdict.kind === 'ask' && !verdict.remember ? null : suggestRule(req.command);
    return this.ask(req, verdict.kind === 'ask' ? verdict.reason : null, rule);
  }

  /**
   * Whether a model says this one may run unasked.
   *
   * `false` for everything that is not a plain yes - no classifier wired up,
   * auto mode off, the model said ask, the call failed. All of them mean the
   * user is asked, which is what would have happened anyway, so none of them is
   * worth telling apart here.
   */
  private async autoApproved(req: PermissionRequest): Promise<boolean> {
    const ask = this.deps.autoApprove;
    if (ask === undefined) return false;

    const seen = this.judged.get(req.streamId) ?? new Map<string, ClassifierVerdict>();
    const remembered = seen.get(req.command);
    if (remembered !== undefined) return remembered === 'safe';

    const answer = await ask({ command: req.command, cwd: req.cwd, signal: req.signal });
    // Before the verdict is used, so a call that was billed is billed even if
    // what came back is about to be thrown away.
    if (answer.usage !== null) req.onUsage?.(answer.usage);
    seen.set(req.command, answer.verdict);
    this.judged.set(req.streamId, seen);
    return answer.verdict === 'safe';
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
   *
   * Auto mode does not reach here. A classifier reads a command line and says
   * what running it would do; an MCP call is a name and a blob of JSON, and
   * what `create_issue` on somebody's server does cannot be read off either.
   * Asking a model to guess would be inventing an opinion rather than forming
   * one - so the answer stays the server's `readOnly` claim, or the user.
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
    this.judged.delete(streamId);
    this.refusePending(streamId);
  }

  /**
   * Refuse whatever this stream is waiting on, without ending it.
   *
   * For a subagent when the window reloads. It keeps running - that is the
   * point of it - but the question it is stopped on was on a screen that no
   * longer exists, and nothing will ever re-ask it. Refusing is the safe half
   * of that: the command does not run, the child is told so in the ordinary
   * way, and it carries on and reports. The alternative is a subagent stopped
   * forever on a question nobody can see, holding one of the five slots.
   */
  refusePending(streamId: string): void {
    for (const [id, entry] of [...this.pending]) {
      if (entry.streamId === streamId) this.settle(id, 'refuse');
    }
  }

  private async ask(
    req: Question,
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
