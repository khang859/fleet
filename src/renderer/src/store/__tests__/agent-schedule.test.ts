import { describe, it, expect, beforeEach, vi } from 'vitest';
import { IPC_CHANNELS } from '../../../../shared/ipc-channels';
import { emptyReplay, type AgentSessionAppend } from '../../../../shared/agent-session';
import type { AgentScheduleRecord } from '../../../../shared/agent-schedule';
import type { AgentSendRequest } from '../../../../shared/agent-types';
import type * as AgentStore from '../agent-store';
import type * as AgentSchedule from '../agent-schedule';

/**
 * Delivery, from the pane's side: which pane collects a fire, what the
 * transcript looks like afterwards, and - the part with all the risk in it -
 * what happens to a fire that arrives while the pane is busy. Main has already
 * let go of it by then, so a pane that drops one drops it for good.
 */

const PANE = 'pane-1';
const SESSION = 'session-1';
const CWD = '/repo';

type Listener = (payload: unknown) => void;
const listeners = new Map<string, Listener>();

const listen =
  (channel: string) =>
  (cb: Listener): (() => void) => {
    listeners.set(channel, cb);
    return () => {};
  };

function emit(channel: string, payload: unknown): void {
  const cb = listeners.get(channel);
  if (!cb) throw new Error(`nothing listening on ${channel}`);
  cb(payload);
}

const agentApi = {
  send: vi.fn(),
  appendSession: vi.fn(),
  refreshGit: vi.fn(),
  runningTasks: vi.fn().mockResolvedValue([]),
  generateTitle: vi.fn().mockResolvedValue({ title: null, usage: null })
};

const scheduleApi = {
  list: vi.fn(),
  cancel: vi.fn(),
  pullDue: vi.fn()
};

let agentStore: typeof AgentStore;
let schedule: typeof AgentSchedule;

/** A pending schedule, as main would describe it. */
function record(over: Partial<AgentScheduleRecord> = {}): AgentScheduleRecord {
  return {
    id: 'sch_00000001',
    sessionId: SESSION,
    cwd: CWD,
    cron: '0 9 * * *',
    note: 'Check whether the deploy landed.',
    recurring: false,
    createdAt: '2026-08-08T08:00:00.000Z',
    expiresAt: null,
    depth: 0,
    state: 'due',
    nextDueAt: '2026-08-08T09:00:00.000Z',
    dueSince: '2026-08-08T09:00:00.000Z',
    terminal: true,
    ...over
  };
}

function thread(
  paneId = PANE
): NonNullable<ReturnType<typeof agentStore.useAgentStore.getState>['threads'][string]> {
  const found = agentStore.useAgentStore.getState().threads[paneId];
  if (!found) throw new Error(`no thread for ${paneId}`);
  return found;
}

/** Let every promise this turn queued settle. */
const settle = async (): Promise<void> => {
  await new Promise((resolve) => setTimeout(resolve, 0));
};

/** The request the pane last handed to main. */
function lastSend(): AgentSendRequest {
  const call = agentApi.send.mock.calls.at(-1);
  if (!call) throw new Error('nothing was sent');
  return call[0] as AgentSendRequest;
}

/** Everything written to the session log. */
function appended(): AgentSessionAppend[] {
  return agentApi.appendSession.mock.calls.map((call) => call[0] as AgentSessionAppend);
}

/** Open a pane on a session with nothing in it. */
async function openPane(paneId = PANE, sessionId = SESSION): Promise<void> {
  await agentStore.useAgentStore.getState().openSession(paneId, sessionId, CWD);
  await settle();
}

/** End whatever turn the pane is running, as main would. */
function endTurn(paneId = PANE): void {
  const streamId = thread(paneId).streamId;
  if (streamId === null) throw new Error('nothing in flight');
  emit(IPC_CHANNELS.AGENT_STREAM_DONE, { streamId, usage: null });
}

beforeEach(async () => {
  vi.resetModules();
  listeners.clear();
  for (const fn of [...Object.values(agentApi), ...Object.values(scheduleApi)]) fn.mockClear();
  scheduleApi.list.mockResolvedValue([]);
  scheduleApi.pullDue.mockResolvedValue([]);
  scheduleApi.cancel.mockResolvedValue(true);

  Object.assign(window.fleet, {
    agent: {
      listModels: vi
        .fn()
        .mockResolvedValue({ models: [], fetchedAt: 1, source: 'cache', error: null }),
      send: agentApi.send,
      compact: vi.fn(),
      cancel: vi.fn(),
      appendSession: agentApi.appendSession,
      addSessionSpend: vi.fn(),
      loadSession: vi.fn().mockImplementation(async () => Promise.resolve(emptyReplay())),
      listSessions: vi.fn().mockResolvedValue([]),
      deleteSession: vi.fn().mockResolvedValue(true),
      generateTitle: agentApi.generateTitle,
      onStreamChunk: listen(IPC_CHANNELS.AGENT_STREAM_CHUNK),
      onStreamReasoning: listen(IPC_CHANNELS.AGENT_STREAM_REASONING),
      onStreamDone: listen(IPC_CHANNELS.AGENT_STREAM_DONE),
      onStreamError: listen(IPC_CHANNELS.AGENT_STREAM_ERROR),
      onCompactDone: listen(IPC_CHANNELS.AGENT_COMPACT_DONE),
      onToolStart: listen(IPC_CHANNELS.AGENT_TOOL_START),
      onToolEnd: listen(IPC_CHANNELS.AGENT_TOOL_END),
      onImagePartial: listen(IPC_CHANNELS.AGENT_IMAGE_PARTIAL),
      onHandOff: listen(IPC_CHANNELS.AGENT_HAND_OFF),
      onPermissionAsk: listen(IPC_CHANNELS.AGENT_PERMISSION_ASK),
      onTaskStart: listen(IPC_CHANNELS.AGENT_TASK_START),
      onTaskDone: listen(IPC_CHANNELS.AGENT_TASK_DONE),
      cancelTask: vi.fn(),
      runningTasks: agentApi.runningTasks,
      taskTranscript: vi.fn().mockImplementation(async () => Promise.resolve(emptyReplay())),
      decidePermission: vi.fn(),
      refreshGit: agentApi.refreshGit,
      hasKey: vi.fn().mockResolvedValue(true),
      setKey: vi.fn().mockResolvedValue(undefined),
      clearKey: vi.fn().mockResolvedValue(undefined),
      schedule: {
        list: scheduleApi.list,
        cancel: scheduleApi.cancel,
        pullDue: scheduleApi.pullDue,
        onChanged: listen(IPC_CHANNELS.AGENT_SCHEDULE_CHANGED)
      }
    },
    pty: { input: vi.fn() },
    activity: {
      report: vi.fn(),
      visiblePanes: vi.fn(),
      onChime: vi.fn().mockReturnValue(() => {}),
      onStateChange: vi.fn().mockReturnValue(() => {})
    }
  });

  agentStore = await import('../agent-store');
  schedule = await import('../agent-schedule');
  agentStore.useAgentStore.setState({ threads: {} });
});

describe('canDeliverTo', () => {
  const free = { sessionId: SESSION, streamId: null, loading: false };

  it('takes a fire when the pane is free', () => {
    expect(schedule.canDeliverTo(free)).toBe(true);
  });

  it('refuses while a turn is in flight', () => {
    expect(schedule.canDeliverTo({ ...free, streamId: 'stream-1' })).toBe(false);
  });

  it('refuses while the history is still being read', () => {
    expect(schedule.canDeliverTo({ ...free, loading: true })).toBe(false);
  });

  it('refuses a pane with no session, which has nothing to be due', () => {
    expect(schedule.canDeliverTo({ ...free, sessionId: null })).toBe(false);
  });
});

describe('the list a pane holds', () => {
  it('arrives on the pane showing that session', async () => {
    await openPane();
    const one = record({ state: 'pending', dueSince: null, terminal: false });

    emit(IPC_CHANNELS.AGENT_SCHEDULE_CHANGED, { sessionId: SESSION, schedules: [one] });
    await settle();

    expect(thread().schedules).toEqual([one]);
  });

  it('leaves a pane on another session alone', async () => {
    await openPane(PANE, SESSION);
    await openPane('pane-2', 'session-2');

    emit(IPC_CHANNELS.AGENT_SCHEDULE_CHANGED, {
      sessionId: SESSION,
      schedules: [record({ state: 'pending' })]
    });
    await settle();

    expect(thread('pane-2').schedules).toEqual([]);
  });

  it('is read when a pane opens a session', async () => {
    const one = record({ state: 'pending', dueSince: null, terminal: false });
    scheduleApi.list.mockResolvedValue([one]);

    await openPane();

    expect(scheduleApi.list).toHaveBeenCalledWith(SESSION);
    expect(thread().schedules).toEqual([one]);
  });
});

describe('delivery', () => {
  it('turns a due fire into a message and a turn', async () => {
    await openPane();
    scheduleApi.pullDue.mockResolvedValue([record()]);

    emit(IPC_CHANNELS.AGENT_SCHEDULE_CHANGED, { sessionId: SESSION, schedules: [record()] });
    await settle();

    const fire = thread().messages.at(-2);
    expect(fire?.role).toBe('scheduled');
    expect(fire?.parts[0]).toMatchObject({ text: expect.stringContaining('deploy landed') });
    expect(thread().streamId).not.toBeNull();
  });

  it('sends the fire as history rather than as something the user said', async () => {
    await openPane();
    scheduleApi.pullDue.mockResolvedValue([record()]);

    emit(IPC_CHANNELS.AGENT_SCHEDULE_CHANGED, { sessionId: SESSION, schedules: [] });
    await settle();

    const sent = lastSend();
    expect(sent.text).toBe('');
    expect(sent.attachments).toEqual([]);
    expect(sent.threadId).toBe(SESSION);
    expect(sent.history.at(-1)?.role).toBe('scheduled');
  });

  it('writes the fire to the session log', async () => {
    await openPane();
    scheduleApi.pullDue.mockResolvedValue([record()]);

    emit(IPC_CHANNELS.AGENT_SCHEDULE_CHANGED, { sessionId: SESSION, schedules: [] });
    await settle();

    const events = appended().filter((event) => event.event.t === 'message');
    expect(events).toHaveLength(1);
    expect(events[0]?.sessionId).toBe(SESSION);
  });

  it('carries the deepest hop of the batch, so the shallow one buys nothing', async () => {
    await openPane();
    scheduleApi.pullDue.mockResolvedValue([
      record({ id: 'sch_a', depth: 1 }),
      record({ id: 'sch_b', depth: 2, note: 'And the other thing.' })
    ]);

    emit(IPC_CHANNELS.AGENT_SCHEDULE_CHANGED, { sessionId: SESSION, schedules: [] });
    await settle();

    expect(lastSend().scheduleChainDepth).toBe(2);
    expect(thread().messages.filter((m) => m.role === 'scheduled')).toHaveLength(2);
  });

  it('says the pane is working, so a pane nobody is watching says so', async () => {
    await openPane();
    scheduleApi.pullDue.mockResolvedValue([record()]);

    emit(IPC_CHANNELS.AGENT_SCHEDULE_CHANGED, { sessionId: SESSION, schedules: [] });
    await settle();

    expect(window.fleet.activity.report).toHaveBeenCalledWith(
      expect.objectContaining({ paneId: PANE, state: 'working' })
    );
  });

  it('does not go looking while a turn is in flight', async () => {
    await openPane();
    agentStore.useAgentStore.getState().send(PANE, CWD, 'hello');
    scheduleApi.pullDue.mockClear();

    emit(IPC_CHANNELS.AGENT_SCHEDULE_CHANGED, { sessionId: SESSION, schedules: [record()] });
    await settle();

    expect(scheduleApi.pullDue).not.toHaveBeenCalled();
    expect(thread().messages.some((m) => m.role === 'scheduled')).toBe(false);
  });

  it('collects it as soon as the turn ends', async () => {
    await openPane();
    agentStore.useAgentStore.getState().send(PANE, CWD, 'hello');
    scheduleApi.pullDue.mockResolvedValue([record()]);

    emit(IPC_CHANNELS.AGENT_SCHEDULE_CHANGED, { sessionId: SESSION, schedules: [record()] });
    await settle();
    endTurn();
    await settle();

    expect(thread().messages.some((m) => m.role === 'scheduled')).toBe(true);
  });

  it('holds a fire the pane got busy under rather than dropping it', async () => {
    await openPane();
    // The pull is a round trip, and this is what happens in it: the user types
    // between the pane being free and main answering. Main has already handed
    // the fire over and will not hand it over again.
    let handOver = (records: AgentScheduleRecord[]): void => {
      throw new Error(`nothing waiting for ${records.length}`);
    };
    scheduleApi.pullDue.mockReturnValue(
      new Promise<AgentScheduleRecord[]>((resolve) => {
        handOver = resolve;
      })
    );

    emit(IPC_CHANNELS.AGENT_SCHEDULE_CHANGED, { sessionId: SESSION, schedules: [] });
    agentStore.useAgentStore.getState().send(PANE, CWD, 'hello');
    handOver([record()]);
    await settle();

    // Not in the transcript, and not lost either.
    expect(thread().messages.some((m) => m.role === 'scheduled')).toBe(false);

    scheduleApi.pullDue.mockResolvedValue([]);
    endTurn();
    await settle();

    expect(thread().messages.some((m) => m.role === 'scheduled')).toBe(true);
  });

  it('delivers a held fire once, not once per check', async () => {
    await openPane();
    let handOver = (records: AgentScheduleRecord[]): void => {
      throw new Error(`nothing waiting for ${records.length}`);
    };
    scheduleApi.pullDue.mockReturnValue(
      new Promise<AgentScheduleRecord[]>((resolve) => {
        handOver = resolve;
      })
    );
    emit(IPC_CHANNELS.AGENT_SCHEDULE_CHANGED, { sessionId: SESSION, schedules: [] });
    agentStore.useAgentStore.getState().send(PANE, CWD, 'hello');
    handOver([record()]);
    await settle();

    scheduleApi.pullDue.mockResolvedValue([]);
    endTurn();
    await settle();
    endTurn();
    await settle();

    expect(thread().messages.filter((m) => m.role === 'scheduled')).toHaveLength(1);
  });

  it('leaves the transcript alone when nothing is due', async () => {
    await openPane();

    emit(IPC_CHANNELS.AGENT_SCHEDULE_CHANGED, { sessionId: SESSION, schedules: [] });
    await settle();

    expect(agentApi.send).not.toHaveBeenCalled();
    expect(thread().messages).toEqual([]);
  });

  it('says nothing to a session no pane is showing', async () => {
    await openPane();

    emit(IPC_CHANNELS.AGENT_SCHEDULE_CHANGED, { sessionId: 'session-9', schedules: [record()] });
    await settle();

    expect(agentApi.send).not.toHaveBeenCalled();
  });
});

describe('cancelSchedule', () => {
  it('names no session, because the user is looking at the row', async () => {
    await schedule.cancelSchedule('sch_00000001');
    expect(scheduleApi.cancel).toHaveBeenCalledWith('sch_00000001');
  });

  it('survives a cancel that could not be delivered', async () => {
    scheduleApi.cancel.mockRejectedValue(new Error('gone'));
    await expect(schedule.cancelSchedule('sch_00000001')).resolves.toBeUndefined();
  });
});
