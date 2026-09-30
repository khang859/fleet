import type { AgentFleetCapability } from '../../../shared/fleet-tools';
import { diffSession } from './diff';
import type { FleetHost } from './host';
import type { FleetLedgerStore } from './ledger-store';
import { readSession, type FleetCursors } from './read';
import { sendToSession, type FleetPrompter, type SendLimiter } from './send';
import { listSessions } from './sessions';

/** What the act tools need beyond reading: `null` where they are not wired up. */
export type FleetActDeps = { prompter: FleetPrompter; limiter: SendLimiter };

export type FleetDeps = { host: FleetHost; ledger: FleetLedgerStore; act: FleetActDeps | null };

/**
 * The fleet tools of one orchestrator conversation.
 *
 * `reader: 'subagent'` is the read-only pick its subagents get: the act
 * members are null, and reads see the conversation's cursors without moving
 * them, so a deep read done on its behalf hides nothing from its own next read.
 *
 * An act member is null for a subagent, where the act tools are not wired up,
 * and until the phase that implements it lands.
 */
export function createFleetCapability(
  deps: FleetDeps,
  threadId: string,
  reader: 'orchestrator' | 'subagent'
): AgentFleetCapability {
  const cursors: FleetCursors = {
    get: (ref) => deps.ledger.cursor(threadId, ref),
    set: (ref, cursor) => {
      if (reader === 'orchestrator') deps.ledger.setCursor(threadId, ref, cursor);
    }
  };
  const act = reader === 'orchestrator' ? deps.act : null;
  return {
    sessions: async () => listSessions(deps.host),
    read: async (args) => readSession(deps.host, cursors, args),
    diff: async (args) => diffSession(deps.host, threadId, args),
    send:
      act === null
        ? null
        : async (args, _signal, approve) =>
            sendToSession({ ...deps, ...act }, threadId, args, approve),
    spawn: null,
    wait: null,
    permission: null
  };
}
