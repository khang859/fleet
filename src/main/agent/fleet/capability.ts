import type { AgentFleetCapability } from '../../../shared/fleet-tools';
import { diffSession } from './diff';
import type { FleetHost } from './host';
import type { FleetLedgerStore } from './ledger-store';
import { readSession, type FleetCursors } from './read';
import { listSessions } from './sessions';

export type FleetDeps = { host: FleetHost; ledger: FleetLedgerStore };

/**
 * The fleet tools of one orchestrator conversation.
 *
 * `reader: 'subagent'` is the read-only pick its subagents get: the act
 * members are null, and reads see the conversation's cursors without moving
 * them, so a deep read done on its behalf hides nothing from its own next read.
 *
 * The act members are null until Phase 4 implements them.
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
  return {
    sessions: async () => listSessions(deps.host),
    read: async (args) => readSession(deps.host, cursors, args),
    diff: async (args) => diffSession(deps.host, threadId, args),
    send: null,
    spawn: null,
    wait: null,
    permission: null
  };
}
