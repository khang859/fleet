import { randomUUID } from 'crypto';
import { IPC_CHANNELS } from '../../../shared/ipc-channels';
import type {
  PermissionOutcome,
  PermissionRequestPayload,
  PermissionResolvedPayload,
  PermissionRules,
  PermissionVerdict
} from '../../../shared/chat-permissions';
import { evaluatePermission, suggestRememberRule } from './rule-evaluator';

export type PermissionEmitter = (channel: string, payload: unknown) => void;

type Deps = {
  /** Read the current persisted rule set (from settings). */
  getRules: () => PermissionRules;
  /** Persist a new permanent allow rule (on "Allow & remember"). */
  persistAllowRule: (rule: string) => void;
  /** Emit a request to the renderer. */
  emit: PermissionEmitter;
};

type Pending = {
  resolve: (verdict: 'allow' | 'deny') => void;
  rememberRule: string;
  tool: string;
  command: string;
  streamId: string;
};

export type PermissionGrant = 'allow' | 'deny';

export type PermissionRequest = {
  streamId: string;
  tool: string;
  command: string;
  cwd?: string;
  /** Optional +/- diff preview shown on the card (file-mutating tools). */
  diff?: string;
  /** Aborts a still-pending ask when the stream is cancelled. */
  signal?: AbortSignal;
};

/**
 * Deterministic main-process gate for tool calls. The renderer never decides
 * whether a call is safe — it only renders the card and relays the user's
 * click. A `request` that the rules already allow/deny resolves synchronously
 * without ever reaching the renderer.
 */
export class PermissionManager {
  private readonly deps: Deps;
  private readonly pending = new Map<string, Pending>();

  constructor(deps: Deps) {
    this.deps = deps;
  }

  /** Pure rule evaluation with no side effects (used by "auto" mode branching). */
  evaluate(tool: string, command: string): PermissionVerdict {
    return evaluatePermission(this.deps.getRules(), tool, command);
  }

  /**
   * Gate a tool call. Resolves `allow`/`deny` once the rules decide or the
   * user clicks. An aborted signal resolves to `deny`.
   */
  async request(req: PermissionRequest): Promise<PermissionGrant> {
    const verdict = evaluatePermission(this.deps.getRules(), req.tool, req.command);
    if (verdict === 'allow') return 'allow';
    if (verdict === 'deny') return 'deny';

    const requestId = randomUUID();
    const rememberRule = suggestRememberRule(req.tool, req.command);
    return new Promise<PermissionGrant>((resolve) => {
      if (req.signal?.aborted) {
        resolve('deny');
        return;
      }
      this.pending.set(requestId, {
        resolve,
        rememberRule,
        tool: req.tool,
        command: req.command,
        streamId: req.streamId
      });
      req.signal?.addEventListener('abort', () => this.settle(requestId, 'deny'), { once: true });

      const payload: PermissionRequestPayload = {
        requestId,
        streamId: req.streamId,
        tool: req.tool,
        command: req.command,
        cwd: req.cwd,
        rememberPrefix: this.prefixOf(rememberRule),
        diff: req.diff
      };
      this.deps.emit(IPC_CHANNELS.CHAT_PERMISSION_REQUEST, payload);
    });
  }

  /** Relay the user's click. No-op if the request already settled. */
  decide(requestId: string, outcome: PermissionOutcome): void {
    const entry = this.pending.get(requestId);
    if (!entry) return;
    if (outcome === 'allow-always') this.deps.persistAllowRule(entry.rememberRule);
    this.settle(requestId, outcome === 'deny' ? 'deny' : 'allow');
    // A freshly persisted allow rule may now cover other queued requests; resolve
    // them without a second prompt so a fanned-out batch clears in one click.
    if (outcome === 'allow-always') this.resolveNewlyAllowed();
  }

  /** Settle every still-pending request the current rules now auto-allow. */
  private resolveNewlyAllowed(): void {
    const rules = this.deps.getRules();
    for (const [id, entry] of [...this.pending]) {
      if (evaluatePermission(rules, entry.tool, entry.command) !== 'allow') continue;
      this.settle(id, 'allow');
      const payload: PermissionResolvedPayload = {
        requestId: id,
        streamId: entry.streamId,
        outcome: 'allow-once'
      };
      this.deps.emit(IPC_CHANNELS.CHAT_PERMISSION_RESOLVED, payload);
    }
  }

  private settle(requestId: string, grant: PermissionGrant): void {
    const entry = this.pending.get(requestId);
    if (!entry) return;
    this.pending.delete(requestId);
    entry.resolve(grant);
  }

  /** Extract the human-readable prefix from a `Tool(prefix *)` rule. */
  private prefixOf(rule: string): string | undefined {
    const m = /\((.*?)\s*\*?\)$/.exec(rule);
    const inner = m?.[1]?.trim();
    return inner || undefined;
  }
}
