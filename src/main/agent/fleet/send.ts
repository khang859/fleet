import {
  ORCHESTRATOR_PREFIX,
  type FleetApprover,
  type FleetSendArgs,
  type FleetToolOutput
} from '../../../shared/fleet-tools';
import { cleanPrompt, promptProblem, type SendResult } from '../../claude-sessions/input';
import { resolveSession, type FleetHost } from './host';
import type { FleetLedgerStore } from './ledger-store';

/** Prompts one orchestrator conversation may send in `SEND_WINDOW_MS`. */
export const SEND_LIMIT = 20;
export const SEND_WINDOW_MS = 10 * 60_000;

/** The way into a session's prompt box: `ClaudeSessionsService`, or a test's stand-in. */
export type FleetPrompter = {
  refusal(sessionId: string): string | null;
  send(sessionId: string, text: string): Promise<SendResult>;
};

/**
 * How many prompts each orchestrator conversation has sent lately.
 *
 * Kept outside the turn so a conversation cannot reset it by ending one: a
 * loop that prompts a session, reads the answer and prompts it again is the
 * failure this is for, and it runs across turns as easily as within one.
 */
export class SendLimiter {
  private readonly sent = new Map<string, number[]>();

  /** When the next send is allowed, or `null` if it is allowed now. */
  blockedUntil(threadId: string, now: number): number | null {
    const recent = (this.sent.get(threadId) ?? []).filter((at) => now - at < SEND_WINDOW_MS);
    this.sent.set(threadId, recent);
    return recent.length < SEND_LIMIT ? null : recent[0] + SEND_WINDOW_MS;
  }

  note(threadId: string, now: number): void {
    this.sent.set(threadId, [...(this.sent.get(threadId) ?? []), now]);
  }
}

export type FleetSendDeps = {
  host: FleetHost;
  ledger: FleetLedgerStore;
  prompter: FleetPrompter;
  limiter: SendLimiter;
};

/**
 * `fleet_send`: type a prompt into a session that is waiting for one, after
 * the user says yes, and write it in the ledger.
 *
 * Everything that would make the send fail is checked before the user is
 * asked, so they are never asked about a prompt that could not go in; and
 * again as it is typed, because they may have started typing in that pane
 * while the card was up.
 */
export async function sendToSession(
  deps: FleetSendDeps,
  threadId: string,
  args: FleetSendArgs,
  approve: FleetApprover
): Promise<FleetToolOutput> {
  const session = resolveSession(deps.host, args.session);
  const text = cleanPrompt(`${ORCHESTRATOR_PREFIX} ${args.prompt}`);
  const before = deps.prompter.refusal(session.sessionId) ?? promptProblem(text);
  if (before !== null) throw new Error(before);
  const until = deps.limiter.blockedUntil(threadId, deps.host.now());
  if (until !== null) {
    const minutes = Math.ceil((until - deps.host.now()) / 60_000);
    throw new Error(
      `Not sent: this conversation has sent ${SEND_LIMIT} prompts in the last ${SEND_WINDOW_MS / 60_000} minutes. Wait about ${minutes} minute${minutes === 1 ? '' : 's'}, or ask the user.`
    );
  }

  const allowed = await approve({
    action: 'send',
    sessionId: session.sessionId,
    target: `${session.ref} (${session.label})`,
    prompt: text
  });
  if (!allowed) throw new Error('The user did not let this prompt be sent.');

  const at = deps.host.now();
  const result = await deps.prompter.send(session.sessionId, text);
  if (!result.ok) throw new Error(result.reason);
  deps.limiter.note(threadId, at);
  const entry = deps.ledger.addEntry(threadId, {
    action: 'send',
    ref: session.ref,
    paneId: session.paneId,
    sessionId: session.sessionId,
    epoch: session.epoch,
    prompt: result.text,
    why: args.why,
    expect: args.expect,
    at,
    started: result.confirmed
  });
  const ack = result.confirmed
    ? 'Claude Code took it and is working on it.'
    : 'Claude Code has not acknowledged it yet. Check with fleet_read before sending it again.';
  return {
    text: `Sent to ${session.ref} as ledger entry ${entry.id}. ${ack} Call fleet_wait to be told when it finishes.`,
    summary: `sent to ${session.ref}`
  };
}
