import { FLEET_CHAIN_LIMIT } from '../../../shared/fleet-tools';
import type { FleetLedgerStore } from './ledger-store';

/** Sends and spawns one orchestrator conversation may make in `ACT_WINDOW_MS`. */
export const ACT_LIMIT = 20;
export const ACT_WINDOW_MS = 10 * 60_000;

/**
 * How many prompts each orchestrator conversation has sent, and sessions it
 * has started, lately.
 *
 * Kept outside the turn so a conversation cannot reset it by ending one: a
 * loop that prompts a session, reads the answer and prompts it again is the
 * failure this is for, and it runs across turns as easily as within one.
 */
export class ActLimiter {
  private readonly acts = new Map<string, number[]>();

  /** Why the next send or spawn must wait, or `null` if it may go now. */
  refusal(threadId: string, now: number): string | null {
    const recent = (this.acts.get(threadId) ?? []).filter((at) => now - at < ACT_WINDOW_MS);
    this.acts.set(threadId, recent);
    if (recent.length < ACT_LIMIT) return null;
    const minutes = Math.ceil((recent[0] + ACT_WINDOW_MS - now) / 60_000);
    return `Not done: this conversation has made ${ACT_LIMIT} sends and spawns in the last ${ACT_WINDOW_MS / 60_000} minutes. The next is allowed in about ${minutes} minute${minutes === 1 ? '' : 's'}; ask the user if it cannot wait.`;
  }

  note(threadId: string, now: number): void {
    this.acts.set(threadId, [...(this.acts.get(threadId) ?? []), now]);
  }
}

/** Why a send or spawn is refused at the chain limit, or null when it is not reached. */
export function chainRefusal(ledger: FleetLedgerStore, threadId: string): string | null {
  if (ledger.chain(threadId) < FLEET_CHAIN_LIMIT) return null;
  return `Not done: Fleet has started ${FLEET_CHAIN_LIMIT} turns in a row from session updates since the user last wrote, so sends and spawns are paused until they write. Tell them what you would do next.`;
}
