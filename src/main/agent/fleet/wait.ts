import {
  attentionKey,
  needsAttention,
  type ClaudeSession,
  type ClaudeSessionChange
} from '../../../shared/claude-sessions';
import type { FleetToolOutput, FleetWaitArgs } from '../../../shared/fleet-tools';
import { describeAttention, type FleetAttention } from './attention';
import { describePhase, describeStarting } from './format';
import { sessionRef, type FleetHost, type FleetSession } from './host';

export type FleetWaitDeps = {
  host: FleetHost;
  /** The registry's change feed. */
  subscribe(listener: (change: ClaudeSessionChange) => void): () => void;
  /** Where the wait is noted, so a wakeup digest leaves its sessions to it. */
  attention: Pick<FleetAttention, 'hold'>;
  /** What changed in a session since the Orchestrator last read it, or null when it cannot be read. */
  brief(ref: string): Promise<string | null>;
};

/** A session still doing something the Orchestrator could wait for. */
function working(session: ClaudeSession): boolean {
  return (
    session.phase === 'processing' || session.phase === 'compacting' || session.phase === 'starting'
  );
}

type Outcome =
  | { kind: 'attention'; paneId: string; session: ClaudeSession | null }
  | { kind: 'timeout' }
  | { kind: 'stopped' };

/** The panes the refs name, or `'all'`. A ref may name a session or a spawned pane that is still starting. */
function watchedPanes(host: FleetHost, refs: readonly string[] | undefined): Set<string> | 'all' {
  if (refs === undefined || refs.length === 0) return 'all';
  const sessions = host.sessions();
  const starting = host.starting();
  const panes = new Set<string>();
  for (const raw of refs) {
    const ref = raw.trim();
    const pane =
      sessions.find((s) => s.ref === ref || s.paneId === ref || s.sessionId === ref)?.paneId ??
      starting.find((s) => s.ref === ref || s.paneId === ref)?.paneId;
    if (pane === undefined) {
      throw new Error(
        `No session has the ref "${ref}". Call fleet_sessions for the sessions running now.`
      );
    }
    panes.add(pane);
  }
  return panes;
}

/** One line per watched session as it stands now. */
function standing(host: FleetHost, watched: Set<string> | 'all', skip: string | null): string[] {
  const now = host.now();
  const inWatch = (paneId: string): boolean =>
    paneId !== skip && (watched === 'all' || watched.has(paneId));
  return [
    ...host
      .sessions()
      .filter((s) => inWatch(s.paneId))
      .map((s) => `- ${s.ref} · ${s.label} · ${describePhase(s, now)}`),
    ...host
      .starting()
      .filter((s) => inWatch(s.paneId))
      .map((s) => `- ${s.ref} · ${s.label} · ${describeStarting(s, now)}`)
  ];
}

/**
 * `fleet_wait`: block the turn until a watched session needs attention - it
 * finishes a turn, asks for approval, shows a question, or ends - or the
 * timeout passes, or the user stops the turn.
 *
 * Only a change after the wait began counts: a session already waiting when
 * it was called is not news, and one that was working and is waiting now is.
 * Sessions are followed by pane, so a `/clear` or a spawned pane whose session
 * reports during the wait is still the session asked about.
 */
export async function waitForSessions(
  deps: FleetWaitDeps,
  threadId: string,
  args: FleetWaitArgs,
  signal: AbortSignal
): Promise<FleetToolOutput> {
  const { host } = deps;
  const watched = watchedPanes(host, args.sessions);
  const inWatch = (paneId: string): boolean => watched === 'all' || watched.has(paneId);

  const sessions = host.sessions().filter((s) => inWatch(s.paneId));
  const starting = host.starting().filter((s) => inWatch(s.paneId));
  if (!sessions.some(working) && starting.length === 0) {
    const lines = standing(host, watched, null);
    return {
      text:
        lines.length === 0
          ? 'There are no sessions to wait for. Call fleet_sessions to see what is running.'
          : `None of the watched sessions is working, so there is nothing to wait for:\n${lines.join('\n')}`,
      summary: 'nothing working'
    };
  }

  const seen = new Map<string, string>(sessions.map((s) => [s.paneId, attentionKey(s)]));
  const paneOf = new Map<string, string>(sessions.map((s) => [s.sessionId, s.paneId]));
  const release = deps.attention.hold(threadId, watched);
  let stop = (): void => {};
  const outcome = await new Promise<Outcome>((resolve) => {
    const unsubscribe = deps.subscribe((change) => {
      const session = change.session;
      if (session === null) {
        const paneId = paneOf.get(change.sessionId);
        // A pane that ran `/clear` drops its old session after the new one is in.
        if (paneId === undefined || host.sessions().some((s) => s.paneId === paneId)) return;
        resolve({ kind: 'attention', paneId, session: null });
        return;
      }
      if (!inWatch(session.paneId)) return;
      paneOf.set(session.sessionId, session.paneId);
      const key = attentionKey(session);
      if (seen.get(session.paneId) === key) return;
      seen.set(session.paneId, key);
      if (needsAttention(session)) resolve({ kind: 'attention', paneId: session.paneId, session });
    });
    const timer = setTimeout(() => resolve({ kind: 'timeout' }), args.timeout_s * 1000);
    const onAbort = (): void => resolve({ kind: 'stopped' });
    signal.addEventListener('abort', onAbort, { once: true });
    stop = () => {
      unsubscribe();
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
    };
    if (signal.aborted) onAbort();
  }).finally(() => {
    stop();
    release();
  });

  switch (outcome.kind) {
    case 'stopped':
      return { text: 'The user stopped the wait.', summary: 'stopped' };
    case 'timeout': {
      const lines = standing(host, watched, null);
      return {
        text: [
          `No watched session needed attention within ${args.timeout_s}s.`,
          ...(lines.length > 0 ? ['Where they are now:', ...lines] : [])
        ].join('\n'),
        summary: `timed out after ${args.timeout_s}s`
      };
    }
    case 'attention':
      return reportAttention(deps, watched, outcome.paneId, outcome.session);
  }
}

async function reportAttention(
  deps: FleetWaitDeps,
  watched: Set<string> | 'all',
  paneId: string,
  session: ClaudeSession | null
): Promise<FleetToolOutput> {
  const { host } = deps;
  const current: FleetSession | undefined = host.sessions().find((s) => s.paneId === paneId);
  const ref = current?.ref ?? sessionRef(paneId);
  const name = current === undefined ? ref : `${ref} (${current.label})`;
  const headline = `${name} ${describeAttention(session)}.`;
  const changed =
    current !== undefined && session !== null && session.phase !== 'ended'
      ? await deps.brief(current.ref)
      : null;
  const others = standing(host, watched, paneId);
  return {
    text: [
      headline,
      ...(changed !== null ? ['What changed:', changed] : []),
      ...(others.length > 0 ? ['Other watched sessions:', ...others] : [])
    ].join('\n'),
    summary: `${ref} ${session === null || session.phase === 'ended' ? 'ended' : 'needs attention'}`
  };
}
