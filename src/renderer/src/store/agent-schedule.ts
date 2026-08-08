import type { AgentMessage } from '../../../shared/agent-types';
import { textMessage } from '../../../shared/agent-types';
import type { AgentScheduleChanged, AgentScheduleRecord } from '../../../shared/agent-schedule';
import { renderScheduleFire } from '../../../shared/agent-schedule';
import { record, reportActivity, useAgentStore } from './agent-store';
import { createLogger } from '../logger';

const log = createLogger('store:agent-schedule');

/**
 * The renderer half of self-scheduling: keeping each pane's list current, and
 * turning a due fire into a turn.
 *
 * Main decides *when* a schedule is due and hands the batch over exactly once;
 * everything about *delivering* it is here, because a fire becomes a message in
 * a transcript and the transcript lives on this side. The pane that collects a
 * fire is whichever one is showing that session, which is also why main cannot
 * do it: it has no idea which panes exist.
 */

/**
 * Whether a pane can be handed a fire right now.
 *
 * The same rule `send` and `resume` follow, for the same reason: a turn in
 * flight is answered rather than interrupted, and a history still being read
 * would make the woken turn look answered when it was not. A fire that arrives
 * at a busy pane is not lost by this - it stays claimed in main, and the next
 * check collects it.
 *
 * Takes the fields rather than the thread so the rule can be read - and
 * tested - without a store.
 */
export function canDeliverTo(thread: {
  sessionId: string | null;
  streamId: string | null;
  loading: boolean;
}): boolean {
  return thread.sessionId !== null && thread.streamId === null && !thread.loading;
}

/**
 * Fires pulled out of main that have not made it into a transcript yet, by
 * session.
 *
 * The pull is a round trip, and a pane can start a turn during it - the user
 * types, or a subagent reports. Main has already handed the batch over by then
 * and will never hand it over again, so the alternative to holding it here is
 * dropping it. Drained by the next check on that session, which `endTurn` runs
 * the moment the pane is free.
 *
 * It does not survive the window: a reload between the pull and the delivery
 * loses whatever is in here. That is the narrow cost of the wide guarantee
 * `pullDue` buys, and it is narrower than the alternative, which is losing a
 * fire every time one lands on a pane mid-turn.
 */
const undelivered = new Map<string, AgentScheduleRecord[]>();

/** Panes with a pull in flight, so a burst of changes makes one round trip. */
const pulling = new Set<string>();

/**
 * One session's schedules changed - created, cancelled, claimed by the tick, or
 * collected. Every pane showing that session is told, and asked to look.
 *
 * The push doubles as the nudge to deliver, which is what makes a fire reach an
 * idle pane without main knowing anything about panes.
 */
export function onScheduleChanged(changed: AgentScheduleChanged): void {
  const panes = panesOn(changed.sessionId);
  if (panes.length === 0) return;
  useAgentStore.setState((s) => {
    const threads = { ...s.threads };
    for (const paneId of panes) {
      const thread = threads[paneId];
      if (thread === undefined) continue;
      threads[paneId] = { ...thread, schedules: changed.schedules };
    }
    return { threads };
  });
  for (const paneId of panes) checkSchedules(paneId);
}

/**
 * Read a session's schedules for a pane that has just opened it.
 *
 * A pane resumed from disk has a panel to draw and, quite often, a fire that
 * came due while the app was closed waiting to be collected.
 */
export async function loadSchedules(paneId: string, sessionId: string): Promise<void> {
  let schedules: AgentScheduleRecord[];
  try {
    schedules = await window.fleet.agent.schedule.list(sessionId);
  } catch (err) {
    log.warn('schedule list failed', { sessionId, error: String(err) });
    return;
  }
  useAgentStore.setState((s) => {
    const thread = s.threads[paneId];
    // The pane moved on while the list was being read, exactly as `replayInto`
    // can find when its own read lands.
    if (thread?.sessionId !== sessionId) return s;
    return { threads: { ...s.threads, [paneId]: { ...thread, schedules } } };
  });
  checkSchedules(paneId);
}

/** The user's stop button. Main tells every pane what is left. */
export async function cancelSchedule(id: string): Promise<void> {
  try {
    await window.fleet.agent.schedule.cancel(id);
  } catch (err) {
    log.warn('schedule cancel failed', { id, error: String(err) });
  }
}

/**
 * Collect whatever is due for this pane, if it is free to take it.
 *
 * Safe to call as often as anything has reason to: a pane that is busy does
 * nothing, and the pull itself is the only consume path there is, so two calls
 * racing cannot deliver the same fire twice.
 */
export function checkSchedules(paneId: string): void {
  const thread = useAgentStore.getState().threads[paneId];
  if (thread === undefined || !canDeliverTo(thread)) return;
  const sessionId = thread.sessionId;
  if (sessionId === null) return;

  // Anything a previous check pulled and could not deliver goes first, and is
  // the whole of what this check does: delivering it starts a turn, which makes
  // the pane busy, which is exactly the state a pull would be pointless in. The
  // turn ending runs this again.
  const held = undelivered.get(sessionId);
  if (held !== undefined) {
    undelivered.delete(sessionId);
    deliver(paneId, sessionId, held);
    return;
  }

  if (pulling.has(paneId)) return;
  pulling.add(paneId);
  void window.fleet.agent.schedule
    .pullDue(sessionId)
    .then((due) => {
      if (due.length > 0) deliver(paneId, sessionId, due);
    })
    .catch((err) => {
      log.warn('schedule pull failed', { sessionId, error: String(err) });
    })
    .finally(() => {
      pulling.delete(paneId);
    });
}

/**
 * Start a turn from a batch of fires.
 *
 * One message per fire rather than one for the batch: each was set separately,
 * says its own thing, and is as late as it is. They are written down like any
 * other message, because a turn the user did not ask for is exactly the kind
 * they will want to find in the transcript tomorrow.
 */
function deliver(paneId: string, sessionId: string, records: AgentScheduleRecord[]): void {
  const thread = useAgentStore.getState().threads[paneId];
  // Busy or moved on since the pull. Held rather than dropped - main has
  // already let go of these.
  if (thread?.sessionId !== sessionId || !canDeliverTo(thread)) {
    undelivered.set(sessionId, [...(undelivered.get(sessionId) ?? []), ...records]);
    log.debug('held a fire for a pane that was not free', { sessionId, count: records.length });
    return;
  }

  const now = new Date();
  const fires = records.map((schedule) =>
    textMessage(
      crypto.randomUUID(),
      'scheduled',
      renderScheduleFire({
        note: schedule.note,
        dueSince: schedule.dueSince,
        deliveredAt: now,
        recurring: schedule.recurring
      })
    )
  );
  const streamId = crypto.randomUUID();
  const assistant: AgentMessage = {
    id: streamId,
    role: 'assistant',
    parts: [],
    reasoning: '',
    reasoningMs: null
  };
  log.debug('delivering', { paneId, sessionId, count: fires.length });

  useAgentStore.setState((s) => ({
    threads: {
      ...s.threads,
      [paneId]: {
        ...thread,
        messages: [...thread.messages, ...fires, assistant],
        streamId,
        startedAt: Date.now(),
        error: null
      }
    }
  }));
  reportActivity(paneId, 'working');
  for (const fire of fires) record(thread, { t: 'message', message: fire });

  window.fleet.agent.send({
    streamId,
    threadId: sessionId,
    cwd: thread.cwd,
    // The fires ride in the transcript, as its last messages, rather than as
    // the turn's opening one - which is what `text: ''` says. They are not the
    // user speaking, and the empty opening is how main is told nobody did.
    history: [...thread.messages, ...fires],
    text: '',
    attachments: [],
    todos: thread.todos,
    // How many hops of schedule-set-a-schedule produced this turn. The deepest
    // of the batch, so a fire that arrives beside a shallower one cannot use it
    // to buy itself another hop.
    scheduleChainDepth: Math.max(...records.map((schedule) => schedule.depth))
  });
}

function panesOn(sessionId: string): string[] {
  const threads = useAgentStore.getState().threads;
  return Object.keys(threads).filter((paneId) => threads[paneId]?.sessionId === sessionId);
}
