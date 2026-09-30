import type { AgentFleetCapability } from '../../../shared/fleet-tools';
import { diffSession } from './diff';
import type { FleetHost } from './host';
import type { FleetLedgerStore } from './ledger-store';
import { readSession, type FleetCursors } from './read';
import { sendToSession, type FleetSendDeps } from './send';
import { answerPermission, type FleetPermissionDeps } from './permission';
import { listSessions } from './sessions';
import { spawnSession, type FleetSpawnDeps } from './spawn';
import { waitForSessions, type FleetWaitDeps } from './wait';

/** What the act tools need beyond reading: `null` where they are not wired up. */
export type FleetActDeps = Omit<
  FleetSendDeps & FleetSpawnDeps & FleetWaitDeps & FleetPermissionDeps,
  'host' | 'ledger' | 'brief'
>;

export type FleetDeps = { host: FleetHost; ledger: FleetLedgerStore; act: FleetActDeps | null };

/**
 * The fleet tools of one orchestrator conversation.
 *
 * `reader: 'subagent'` is the read-only pick its subagents get: the act
 * members are null, and reads see the conversation's cursors without moving
 * them, so a deep read done on its behalf hides nothing from its own next read.
 *
 * An act member is null for a subagent, where the act tools are not wired up,
 * and `permission` is null too while the user has not turned it on.
 */
export function createFleetCapability(
  deps: FleetDeps,
  threadId: string,
  reader: 'orchestrator' | 'subagent',
  /** The pane's folder: where `fleet_spawn` starts a session unless told otherwise. */
  cwd: string,
  /** The user's setting, read for this turn: without it `fleet_permission` is not offered. */
  answerPermissions = false
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
    spawn:
      act === null
        ? null
        : async (args, _signal, approve) =>
            spawnSession({ ...deps, ...act }, threadId, cwd, args, approve),
    wait:
      act === null
        ? null
        : async (args, signal) =>
            waitForSessions(
              {
                ...act,
                host: deps.host,
                // Read like `fleet_read` would, so the cursor moves past what the wait reports.
                brief: async (ref) =>
                  readSession(deps.host, cursors, { session: ref, level: 'brief' })
                    .then((out) => out.text)
                    .catch(() => null)
              },
              threadId,
              args,
              signal
            ),
    permission:
      act === null || !answerPermissions
        ? null
        : async (args, _signal, approve) =>
            answerPermission({ host: deps.host, answers: act.answers }, args, approve)
  };
}
