import { create } from 'zustand';
import { attentionKey, needsAttention } from '../../../shared/claude-sessions';
import type { ClaudeSessionsSnapshot } from '../../../shared/claude-sessions';
import { textMessage } from '../../../shared/agent-types';
import { canDeliverTo, startUnpromptedTurn } from './agent-schedule';
import { useAgentStore } from './agent-store';
import { useClaudeSessionsStore } from './claude-sessions-store';
import { isOrchestratorPane, useWorkspaceStore } from './workspace-store';
import { createLogger } from '../logger';

const log = createLogger('store:agent-fleet');

/**
 * The renderer half of orchestrator wakeups, shaped like `agent-schedule`.
 *
 * Main keeps what happened and writes the digest; this side decides when to
 * ask for one, because only it knows which panes are in orchestrator mode and
 * whether they are free. A session needing attention starts a short wait, so
 * sessions finishing close together make one digest; a pane that is busy
 * when the wait ends is asked again when its turn does.
 */

/** How long after the first attention change the digest is taken. */
export const DIGEST_DEBOUNCE_MS = 2_000;

type AgentFleetState = {
  /** Orchestrator panes whose conversation reached the chain limit, until the user writes. */
  paused: Partial<Record<string, true>>;
};

export const useAgentFleetStore = create<AgentFleetState>(() => ({ paused: {} }));

/** Digests taken from main but not yet in a transcript, by session: main has let go of them. */
const undelivered = new Map<string, string>();
/** Panes with a pull in flight, so a burst of changes makes one round trip. */
const pulling = new Set<string>();
/** Panes waiting out the debounce. */
const timers = new Map<string, ReturnType<typeof setTimeout>>();

function orchestratorPanes(): string[] {
  const workspace = useWorkspaceStore.getState();
  return Object.keys(useAgentStore.getState().threads).filter((paneId) =>
    isOrchestratorPane(workspace, paneId)
  );
}

function setPaused(paneId: string, paused: boolean): void {
  if ((useAgentFleetStore.getState().paused[paneId] === true) === paused) return;
  useAgentFleetStore.setState((s) => {
    const next = { ...s.paused };
    if (paused) next[paneId] = true;
    else delete next[paneId];
    return { paused: next };
  });
}

/** The user wrote in this pane, which is what lifts the pause. */
export function clearFleetPaused(paneId: string): void {
  setPaused(paneId, false);
}

/**
 * Ask for this pane's digest, if it is an orchestrator pane free to take one.
 *
 * Safe to call as often as anything likes: main answers with nothing when
 * nothing needs the pane, and the pull is the only way a digest is taken.
 */
export function checkFleet(paneId: string): void {
  if (!isOrchestratorPane(useWorkspaceStore.getState(), paneId)) return;
  const thread = useAgentStore.getState().threads[paneId];
  if (thread === undefined || !canDeliverTo(thread)) return;
  const sessionId = thread.sessionId;
  if (sessionId === null) return;

  const held = undelivered.get(sessionId);
  if (held !== undefined) {
    undelivered.delete(sessionId);
    deliver(paneId, sessionId, held);
    return;
  }

  if (pulling.has(paneId)) return;
  pulling.add(paneId);
  void window.fleet.agent.fleet
    .pullDigest(sessionId)
    .then((pull) => {
      setPaused(paneId, pull.paused);
      if (pull.text !== null) deliver(paneId, sessionId, pull.text);
    })
    .catch((err) => {
      log.warn('digest pull failed', { sessionId, error: String(err) });
    })
    .finally(() => {
      pulling.delete(paneId);
    });
}

function deliver(paneId: string, sessionId: string, text: string): void {
  const thread = useAgentStore.getState().threads[paneId];
  // Busy or moved on since the pull: held for the next check, since main has
  // already marked what it covers as read.
  if (thread?.sessionId !== sessionId || !canDeliverTo(thread)) {
    const before = undelivered.get(sessionId);
    undelivered.set(sessionId, before === undefined ? text : `${before}\n\n${text}`);
    log.debug('held a digest for a pane that was not free', { sessionId });
    return;
  }
  log.debug('delivering a digest', { paneId, sessionId });
  startUnpromptedTurn(paneId, thread, [textMessage(crypto.randomUUID(), 'fleet', text)]);
}

function soon(paneId: string): void {
  if (timers.has(paneId)) return;
  timers.set(
    paneId,
    setTimeout(() => {
      timers.delete(paneId);
      checkFleet(paneId);
    }, DIGEST_DEBOUNCE_MS)
  );
}

/**
 * Whether a new snapshot has a session that has just started to need
 * attention, or one that has gone. Only a change counts: a session sitting in
 * a wait while its hooks report again is not news.
 */
export function attentionChanged(
  before: ReadonlyMap<string, string>,
  snapshot: ClaudeSessionsSnapshot
): { changed: boolean; keys: Map<string, string> } {
  const keys = new Map<string, string>();
  let changed = false;
  for (const session of snapshot.sessions) {
    const key = attentionKey(session);
    keys.set(session.sessionId, key);
    if (before.get(session.sessionId) !== key && needsAttention(session)) changed = true;
  }
  for (const sessionId of before.keys()) if (!keys.has(sessionId)) changed = true;
  return { changed, keys };
}

/**
 * Follow the sessions, and keep main told which conversations are in
 * orchestrator mode. Returns the unsubscribe.
 */
export function initAgentFleet(): () => void {
  let keys = new Map<string, string>();
  const onSessions = (snapshot: ClaudeSessionsSnapshot | null): void => {
    if (snapshot === null) return;
    const next = attentionChanged(keys, snapshot);
    keys = next.keys;
    if (next.changed) for (const paneId of orchestratorPanes()) soon(paneId);
  };
  onSessions(useClaudeSessionsStore.getState().snapshot);
  const offSessions = useClaudeSessionsStore.subscribe((s) => onSessions(s.snapshot));

  // Conversations main has been told are orchestrating. By conversation, so a
  // pane that starts a new chat has it start from then.
  let modes = new Set<string>();
  let signature = '';
  const syncModes = (): void => {
    const threads = useAgentStore.getState().threads;
    const workspace = useWorkspaceStore.getState();
    const next = new Set<string>();
    const reopened: string[] = [];
    for (const [paneId, thread] of Object.entries(threads)) {
      const on = isOrchestratorPane(workspace, paneId);
      if (on && thread?.sessionId != null) {
        next.add(thread.sessionId);
        // A digest held while the pane showed another conversation.
        if (!modes.has(thread.sessionId) && undelivered.has(thread.sessionId))
          reopened.push(paneId);
      }
      if (!on) setPaused(paneId, false);
    }
    for (const sessionId of next) {
      if (!modes.has(sessionId)) window.fleet.agent.fleet.setMode(sessionId, true);
    }
    for (const sessionId of modes) {
      if (!next.has(sessionId)) window.fleet.agent.fleet.setMode(sessionId, false);
    }
    modes = next;
    for (const paneId of reopened) checkFleet(paneId);
  };
  syncModes();
  // The agent store changes on every streamed token, so only a change to which
  // pane shows which session is worth walking the layout for.
  const offAgent = useAgentStore.subscribe((s) => {
    const next = Object.entries(s.threads)
      .map(([paneId, t]) => `${paneId}:${t?.sessionId ?? ''}`)
      .join(',');
    if (next === signature) return;
    signature = next;
    syncModes();
  });
  const offWorkspace = useWorkspaceStore.subscribe(syncModes);

  return () => {
    offSessions();
    offAgent();
    offWorkspace();
    for (const timer of timers.values()) clearTimeout(timer);
    timers.clear();
  };
}
