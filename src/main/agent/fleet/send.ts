import {
  ORCHESTRATOR_PREFIX,
  type FleetApprover,
  type FleetSendArgs,
  type FleetToolOutput
} from '../../../shared/fleet-tools';
import { cleanPrompt, promptProblem, type SendResult } from '../../claude-sessions/input';
import { resolveSession, type FleetHost } from './host';
import type { FleetLedgerStore } from './ledger-store';
import type { ActLimiter } from './limiter';

/** The way into a session's prompt box: `ClaudeSessionsService`, or a test's stand-in. */
export type FleetPrompter = {
  refusal(sessionId: string): string | null;
  send(sessionId: string, text: string): Promise<SendResult>;
};

export type FleetSendDeps = {
  host: FleetHost;
  ledger: FleetLedgerStore;
  prompter: FleetPrompter;
  limiter: ActLimiter;
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
  const limited = deps.limiter.refusal(threadId, deps.host.now());
  if (limited !== null) throw new Error(limited);

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
