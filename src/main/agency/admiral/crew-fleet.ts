import type { FleetDeps } from '../../agent/fleet/capability';
import type { FleetHost } from '../../agent/fleet/host';

/**
 * The fleet deps narrowed to one job's crew panes: an Admiral's read tools
 * see those sessions and no others, and a wait over "all" means all of its
 * crew. `crew` is read on every call, so a pane hired mid-turn is seen at once.
 * `screen` reads a crew pane that has not reported yet.
 */
export function scopeFleetToCrew(
  deps: FleetDeps,
  crew: () => ReadonlySet<string>,
  screen: (paneId: string) => Promise<string | null>
): FleetDeps {
  const inCrew = (paneId: string): boolean => crew().has(paneId);
  const host: FleetHost = {
    tracking: () => deps.host.tracking(),
    sessions: () => deps.host.sessions().filter((s) => inCrew(s.paneId)),
    starting: () => deps.host.starting().filter((s) => inCrew(s.paneId)),
    transcript: async (sessionId) => deps.host.transcript(sessionId),
    inputsFor: (sessionId) => deps.host.inputsFor(sessionId),
    git: async (cwd, argv) => deps.host.git(cwd, argv),
    now: () => deps.host.now(),
    screen: async (paneId) => (inCrew(paneId) ? screen(paneId) : null)
  };
  const act = deps.act;
  return {
    host,
    ledger: deps.ledger,
    act:
      act === null
        ? null
        : {
            ...act,
            subscribe: (listener) =>
              act.subscribe((change) => {
                // A session going away has no pane to check; the wait itself
                // only reacts to it for a pane it was already watching.
                if (change.session === null || inCrew(change.session.paneId)) listener(change);
              }),
            attention: {
              hold: (threadId, watched) =>
                act.attention.hold(threadId, watched === 'all' ? new Set(crew()) : watched)
            }
          }
  };
}
