import type { IncomingMessage, ServerResponse } from 'http';
import { z } from 'zod';
import { createLogger } from '../logger';
import type { PermissionSuggestion } from '../../shared/claude-sessions';
import { NOT_ANSWERED, POLL_HOLD_MS, reply, type BridgeRoute } from './bridge-server';
import { HOOK_PROTOCOL, lenient, nonEmpty, type HookEvent } from './hook-events';
import type { HeldRequest, PermissionAnswer } from './permission-broker';

const log = createLogger('claude-sessions:permission-bridge');

/**
 * How long a request is kept between two asks of the mod, which asks again at
 * once. A mod that has not asked by then went away.
 */
export const REASK_GRACE_MS = 5_000;

const destination = z.enum([
  'userSettings',
  'projectSettings',
  'localSettings',
  'session',
  'cliArg'
]);

/** The suggestions Fleet offers; Claude Code's other kinds are dropped. */
const Suggestion = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('addRules'),
    rules: z.array(z.object({ toolName: nonEmpty, ruleContent: z.string().optional() })).min(1),
    behavior: z.literal('allow'),
    destination
  }),
  z.object({
    type: z.literal('addDirectories'),
    directories: z.array(nonEmpty).min(1),
    destination
  }),
  z.object({ type: z.literal('setMode'), mode: nonEmpty, destination })
]) satisfies z.ZodType<PermissionSuggestion>;

/** What the mod sends: the `PermissionRequest` hook's input, with its pane and an id of its own. */
const WireAsk = z.object({
  request_id: nonEmpty,
  session_id: nonEmpty,
  pane_id: nonEmpty,
  cwd: z.string(),
  transcript_path: lenient(nonEmpty),
  tool_name: nonEmpty,
  tool_input: lenient(z.record(z.string(), z.unknown())),
  permission_suggestions: lenient(z.array(z.unknown()))
});

/** A permission request the mod asks about, as a hook event, or null when it is not one. */
export function parsePermissionAsk(text: string): { requestId: string; event: HookEvent } | null {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return null;
  }
  const parsed = WireAsk.safeParse(data);
  if (!parsed.success) return null;
  const w = parsed.data;
  const suggestions = (w.permission_suggestions ?? []).flatMap((s): PermissionSuggestion[] => {
    const one = Suggestion.safeParse(s);
    return one.success ? [one.data] : [];
  });
  return {
    requestId: w.request_id,
    event: {
      sessionId: w.session_id,
      cwd: w.cwd,
      event: 'PermissionRequest',
      runtime: 'claude',
      status: 'waiting_for_approval',
      tool: w.tool_name,
      toolInput: w.tool_input,
      paneId: w.pane_id,
      transcriptPath: w.transcript_path,
      ...(suggestions.length > 0 && { permissionSuggestions: suggestions }),
      protocol: HOOK_PROTOCOL
    }
  };
}

type Reply = { status: number; body?: string };

/**
 * One permission request the mod asks about. The mod's `fetch` is cut off
 * after 30 s, so it asks again and again: each ask is answered when Fleet has
 * an answer, or with 204 after `holdMs`, and the next ask takes its place.
 *
 * An ask that closes while it is open means the mod went away, as it does
 * when the user answers in the terminal; so does a mod that has not asked
 * again within `graceMs`. Fleet's answer is kept as long, so a mod between
 * two asks still gets it.
 */
class BridgeHold implements HeldRequest {
  private ask: ServerResponse | null = null;
  /** Answers the open ask with 204. */
  private holdTimer: ReturnType<typeof setTimeout> | undefined;
  /** Runs out when the mod has not asked again, or once an answer has been kept long enough. */
  private graceTimer: ReturnType<typeof setTimeout> | undefined;
  /** How the request ended: Fleet's answer, or the mod went away. */
  private settled: Reply | null = null;
  private onGoneCb: (() => void) | null = null;

  constructor(
    private readonly holdMs: number,
    private readonly graceMs: number,
    private readonly forget: () => void
  ) {}

  attach(res: ServerResponse): void {
    if (this.settled) {
      reply(res, this.settled.status, this.settled.body);
      return;
    }
    clearTimeout(this.graceTimer);
    // Another copy of the mod asking about the same request.
    this.answerAsk({ status: NOT_ANSWERED });
    this.ask = res;
    this.holdTimer = setTimeout(() => {
      this.answerAsk({ status: 204 });
      this.graceTimer = setTimeout(() => this.goAway(), this.graceMs);
    }, this.holdMs);
    res.on('close', () => {
      if (this.ask !== res) return;
      this.ask = null;
      this.goAway();
    });
  }

  deliver(answer: PermissionAnswer): boolean {
    return this.settle({ status: 200, body: JSON.stringify(answer) });
  }

  letGo(): void {
    this.settle({ status: NOT_ANSWERED });
  }

  /** The same as `letGo`: unlike a socket, an ask cannot be cut off without an answer. */
  discard(): void {
    this.letGo();
  }

  onGone(cb: () => void): void {
    this.onGoneCb = cb;
  }

  /** Fleet is stopping: answer the open ask and keep nothing. */
  stop(): void {
    this.answerAsk({ status: NOT_ANSWERED });
    this.clearTimers();
  }

  private settle(answer: Reply): boolean {
    if (this.settled) return false;
    // The mod went away and 'close' has not fired yet: the answer would be lost.
    if (this.ask?.destroyed) {
      this.ask = null;
      this.goAway();
      return false;
    }
    this.settled = answer;
    this.clearTimers();
    this.answerAsk(answer);
    // Kept for a mod between two asks, and so a late ask is not taken for a new request.
    this.graceTimer = setTimeout(() => this.forget(), this.graceMs);
    return true;
  }

  private answerAsk(answer: Reply): void {
    const ask = this.ask;
    if (!ask) return;
    this.ask = null;
    if (!ask.destroyed) reply(ask, answer.status, answer.body);
  }

  private goAway(): void {
    if (this.settled) return;
    this.settled = { status: NOT_ANSWERED };
    this.clearTimers();
    this.forget();
    this.onGoneCb?.();
  }

  private clearTimers(): void {
    clearTimeout(this.holdTimer);
    clearTimeout(this.graceTimer);
  }
}

/** Takes a permission request in, holding it for an answer when it returns true. */
export type AdmitPermission = (event: HookEvent, request: HeldRequest) => boolean;

/**
 * The bridge's `POST /permission` route. The fleet-bridge mod asks it about
 * each permission request while Claude Code shows its own dialog, so the
 * request can be answered in Fleet or in the terminal, whichever comes first.
 * Unlike a Go hook's, the request is held for as long as the dialog is open.
 *
 * Each request is admitted once, as a hook event; a later ask about it only
 * waits on. One Fleet does not hold is answered 409, and the dialog decides.
 */
export class PermissionBridge implements BridgeRoute {
  private readonly holds = new Map<string, BridgeHold>();

  constructor(
    private readonly admit: AdmitPermission,
    private readonly holdMs: number = POLL_HOLD_MS,
    private readonly graceMs: number = REASK_GRACE_MS
  ) {}

  handle(req: IncomingMessage, res: ServerResponse): void {
    let text = '';
    req.setEncoding('utf8');
    req.on('data', (chunk: string) => (text += chunk));
    req.on('end', () => this.onAsk(text, res));
  }

  stop(): void {
    for (const hold of this.holds.values()) hold.stop();
    this.holds.clear();
  }

  private onAsk(text: string, res: ServerResponse): void {
    const asked = parsePermissionAsk(text);
    if (!asked) {
      log.warn('invalid permission ask', { data: text.substring(0, 200) });
      reply(res, 400);
      return;
    }
    const hold = this.holds.get(asked.requestId) ?? this.admitNew(asked.requestId, asked.event);
    hold.attach(res);
  }

  private admitNew(requestId: string, event: HookEvent): BridgeHold {
    const hold: BridgeHold = new BridgeHold(this.holdMs, this.graceMs, () => {
      if (this.holds.get(requestId) === hold) this.holds.delete(requestId);
    });
    this.holds.set(requestId, hold);
    if (!this.admit(event, hold)) hold.letGo();
    return hold;
  }
}
