import type { AgentBackgroundChanged, AgentBackgroundJob } from '../../../shared/agent-tools';
import { panesOn, useAgentStore } from './agent-store';
import { createLogger } from '../logger';

const log = createLogger('store:agent-background');

/**
 * The renderer half of background commands: keeping each pane's list current,
 * and the two ways the user ends one.
 *
 * Main owns the processes and pushes a conversation's whole running list
 * whenever it changes. This side only mirrors it onto every pane showing that
 * conversation - the same shape `agent-schedule` has, for the same reason: main
 * has no idea which panes exist.
 */

/** One conversation's running commands changed. Every pane on it is told. */
export function onBackgroundChanged(changed: AgentBackgroundChanged): void {
  const panes = panesOn(changed.threadId);
  if (panes.length === 0) return;
  useAgentStore.setState((s) => {
    const threads = { ...s.threads };
    for (const paneId of panes) {
      const thread = threads[paneId];
      if (thread === undefined) continue;
      threads[paneId] = { ...thread, background: changed.jobs };
    }
    return { threads };
  });
}

/**
 * Read a conversation's running commands for a pane that has just opened it -
 * after a window reload, or coming back to a conversation left running in
 * another session of the same pane.
 */
export async function loadBackground(paneId: string, sessionId: string): Promise<void> {
  let background: AgentBackgroundJob[];
  try {
    background = await window.fleet.agent.background.list(sessionId);
  } catch (err) {
    log.warn('background list failed', { sessionId, error: String(err) });
    return;
  }
  useAgentStore.setState((s) => {
    const thread = s.threads[paneId];
    // The pane moved on while the list was being read.
    if (thread?.sessionId !== sessionId) return s;
    return { threads: { ...s.threads, [paneId]: { ...thread, background } } };
  });
}

/** The user's stop button. Main pushes what is left. */
export async function stopBackground(sessionId: string, id: string): Promise<void> {
  try {
    await window.fleet.agent.background.stop(sessionId, id);
  } catch (err) {
    log.warn('background stop failed', { sessionId, id, error: String(err) });
  }
}

/**
 * Stop a conversation's commands as its pane closes, unless another pane is
 * still showing it.
 *
 * A command started from a conversation nobody can see has nobody left to read
 * it or stop it, which is the state this exists to rule out. Another pane on the
 * same conversation still has the rows and the buttons, so it is left to that.
 */
export function stopBackgroundForClosingPane(paneId: string): void {
  const sessionId = useAgentStore.getState().threads[paneId]?.sessionId ?? null;
  if (sessionId === null) return;
  if (panesOn(sessionId).some((other) => other !== paneId)) return;
  window.fleet.agent.background.stopAll(sessionId);
}
