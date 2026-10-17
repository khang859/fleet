import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC_CHANNELS } from '../../../../shared/ipc-channels';
import { DEFAULT_SETTINGS } from '../../../../shared/constants';
import { emptyReplay, type AgentSessionAppend } from '../../../../shared/agent-session';
import {
  textMessage,
  type AgentMessage,
  type AgentSendRequest
} from '../../../../shared/agent-types';
import type {
  AgencyChanged,
  AgencyJob,
  AgencyQuestion,
  AgencySnapshot,
  WakeupPull
} from '../../../../shared/agency';
import { agencyJob, agencyQuestion } from '../../../../shared/__tests__/agency-fixtures';
import type * as AgentStore from '../agent-store';
import type * as Runtime from '../admiral-runtime';
import type * as SettingsStore from '../settings-store';

/**
 * The Admiral runtime, from the pane's side: when it asks main for wakeups and
 * what it does with them, how a job opened from the lobby is handed the talk
 * that led to it, what the pane reports as a whole, and how a message sent
 * while the Admiral works is queued for it.
 */

const PANE = 'admiral-pane';
const REPO = { repoId: 'repo-1', root: '/repo', name: 'repo' };
const LOBBY = 'lobby-session';
const LOBBY_KEY = `admiral:${PANE}:lobby`;
const keyOf = (jobId: number): string => `admiral:${PANE}:j${jobId}`;

vi.mock('../workspace-store', async () => {
  const { create } = await import('zustand');
  const leaf = {
    type: 'leaf',
    id: 'admiral-pane',
    paneType: 'admiral',
    cwd: '/repo',
    admiralRepo: { repoId: 'repo-1', root: '/repo', name: 'repo' }
  };
  return {
    isOrchestratorPane: () => false,
    registerPaneDisposer: () => {},
    collectPaneLeafs: (node: unknown) => [node],
    isAdmiralLeaf: (l: { paneType?: string }) => l.paneType === 'admiral',
    useWorkspaceStore: create(() => ({
      workspace: { id: 'default', label: 'Default', tabs: [{ id: 'tab', splitRoot: leaf }] },
      backgroundWorkspaces: new Map(),
      setAgentSession: () => {},
      setAdmiralJobSession: () => {},
      setAdmiralActiveJob: activeJob
    }))
  };
});

type Listener = (payload: unknown) => void;
const listeners = new Map<string, Listener>();
const listen =
  (channel: string) =>
  (cb: Listener): (() => void) => {
    listeners.set(channel, cb);
    return () => listeners.delete(channel);
  };
function emit(channel: string, payload: unknown): void {
  const cb = listeners.get(channel);
  if (!cb) throw new Error(`nothing listening on ${channel}`);
  cb(payload);
}

const activeJob = vi.fn();
const send = vi.fn();
const queue = vi.fn();
const appendSession = vi.fn();
const report = vi.fn();
const replays = new Map<string, AgentMessage[]>();
const agency = {
  claimAdmiral: vi.fn(),
  ensureLobby: vi.fn(),
  snapshot: vi.fn(),
  pullWakeups: vi.fn<(args: { repoId: string; jobId: number | null }) => Promise<WakeupPull>>(),
  ackWakeups: vi.fn(),
  releaseWakeups: vi.fn(),
  markHandoff: vi.fn(),
  answerQuestion: vi.fn(),
  cancelJobs: vi.fn(),
  onChanged: listen('agency:changed')
};

let snap: AgencySnapshot;
let agentStore: typeof AgentStore;
let runtime: typeof Runtime;
let settings: typeof SettingsStore;
let stop: () => void;

function job(id: number, over: Partial<AgencyJob> = {}): AgencyJob {
  return agencyJob({
    id,
    repoId: REPO.repoId,
    title: `Job ${id}`,
    sessionId: `job-session-${id}`,
    ...over
  });
}

function question(id: number, jobId: number | null): AgencyQuestion {
  return agencyQuestion({ id, repoId: REPO.repoId, jobId });
}

const NOTHING: WakeupPull = { ids: [], text: null, nextDueAt: null };

function thread(key: string): NonNullable<AgentStore.PaneThread> {
  const found = agentStore.useAgentStore.getState().threads[key];
  if (!found) throw new Error(`no thread ${key}`);
  return found;
}

function sends(): AgentSendRequest[] {
  return send.mock.calls.map((call) => call[0] as AgentSendRequest);
}

function appended(): AgentSessionAppend[] {
  return appendSession.mock.calls.map((call) => call[0] as AgentSessionAppend);
}

function endTurn(key: string, error?: string): void {
  const streamId = thread(key).streamId;
  if (streamId === null) throw new Error('nothing in flight');
  if (error === undefined) emit(IPC_CHANNELS.AGENT_STREAM_DONE, { streamId, usage: null });
  else emit(IPC_CHANNELS.AGENT_STREAM_ERROR, { streamId, message: error, usage: null });
}

const tick = async (ms = 0): Promise<void> => {
  await vi.advanceTimersByTimeAsync(ms);
};

function changed(change: Partial<AgencyChanged>): void {
  emit('agency:changed', { repoId: REPO.repoId, jobIds: [], ...change });
}

beforeEach(async () => {
  vi.useFakeTimers();
  vi.resetModules();
  listeners.clear();
  replays.clear();
  for (const fn of [send, queue, appendSession, report, activeJob]) fn.mockReset();
  for (const fn of Object.values(agency)) if (vi.isMockFunction(fn)) fn.mockReset();
  agency.onChanged = listen('agency:changed');
  snap = {
    repoId: REPO.repoId,
    lobbySessionId: LOBBY,
    jobs: [job(1), job(2)],
    questions: [],
    nextRetryAt: null,
    onboarding: { setupDoneAt: 1, starterDoneAt: 1 }
  };
  agency.claimAdmiral.mockResolvedValue({ ok: true });
  agency.ensureLobby.mockResolvedValue(LOBBY);
  agency.snapshot.mockImplementation(async () => Promise.resolve(structuredClone(snap)));
  agency.pullWakeups.mockResolvedValue(NOTHING);
  agency.ackWakeups.mockResolvedValue(undefined);
  agency.releaseWakeups.mockResolvedValue({ nextDueAt: null, gaveUp: false });
  agency.markHandoff.mockResolvedValue(true);
  queue.mockResolvedValue(true);

  Object.assign(window.fleet, {
    agency,
    agent: {
      send,
      queue,
      compact: vi.fn(),
      cancel: vi.fn(),
      appendSession,
      addSessionSpend: vi.fn(),
      loadSession: vi
        .fn()
        .mockImplementation(async (sessionId: string) =>
          Promise.resolve({ ...emptyReplay(), messages: replays.get(sessionId) ?? [] })
        ),
      generateTitle: vi.fn().mockResolvedValue({ title: null, usage: null }),
      onStreamChunk: listen(IPC_CHANNELS.AGENT_STREAM_CHUNK),
      onStreamReasoning: listen(IPC_CHANNELS.AGENT_STREAM_REASONING),
      onStreamStep: listen(IPC_CHANNELS.AGENT_STREAM_STEP),
      onStreamDone: listen(IPC_CHANNELS.AGENT_STREAM_DONE),
      onStreamError: listen(IPC_CHANNELS.AGENT_STREAM_ERROR),
      onCompactDone: listen(IPC_CHANNELS.AGENT_COMPACT_DONE),
      onServerTool: listen(IPC_CHANNELS.AGENT_SERVER_TOOL),
      onToolStart: listen(IPC_CHANNELS.AGENT_TOOL_START),
      onToolEnd: listen(IPC_CHANNELS.AGENT_TOOL_END),
      onImagePartial: listen(IPC_CHANNELS.AGENT_IMAGE_PARTIAL),
      onQueuedTaken: listen(IPC_CHANNELS.AGENT_STREAM_QUEUED_TAKEN),
      onHandOff: listen(IPC_CHANNELS.AGENT_HAND_OFF),
      onPermissionAsk: listen(IPC_CHANNELS.AGENT_PERMISSION_ASK),
      onTaskStart: listen(IPC_CHANNELS.AGENT_TASK_START),
      onTaskDone: listen(IPC_CHANNELS.AGENT_TASK_DONE),
      runningTasks: vi.fn().mockResolvedValue([]),
      refreshGit: vi.fn(),
      schedule: {
        list: vi.fn().mockResolvedValue([]),
        cancel: vi.fn(),
        pullDue: vi.fn().mockResolvedValue([]),
        onChanged: listen(IPC_CHANNELS.AGENT_SCHEDULE_CHANGED)
      },
      background: {
        list: vi.fn().mockResolvedValue([]),
        stop: vi.fn(),
        stopAll: vi.fn(),
        onChanged: listen(IPC_CHANNELS.AGENT_BACKGROUND_CHANGED)
      },
      fleet: {
        pullDigest: vi.fn().mockResolvedValue({ text: null, paused: false }),
        setMode: vi.fn()
      }
    },
    pty: { input: vi.fn() },
    activity: {
      report,
      visiblePanes: vi.fn(),
      onChime: vi.fn().mockReturnValue(() => {}),
      onStateChange: vi.fn().mockReturnValue(() => {})
    }
  });

  agentStore = await import('../agent-store');
  settings = await import('../settings-store');
  runtime = await import('../admiral-runtime');
  agentStore.useAgentStore.setState({ threads: {} });
  settings.useSettingsStore.setState({
    settings: { ...DEFAULT_SETTINGS, agency: { ...DEFAULT_SETTINGS.agency, enabled: true } }
  });
  stop = runtime.initAdmiralRuntime();
  await tick();
});

afterEach(() => {
  stop();
  vi.useRealTimers();
});

describe('attaching', () => {
  it('claims the repository and opens the lobby and every job', () => {
    expect(agency.claimAdmiral).toHaveBeenCalledWith({ repoId: REPO.repoId, paneId: PANE });
    expect(thread(LOBBY_KEY).sessionId).toBe(LOBBY);
    expect(thread(keyOf(1)).sessionId).toBe('job-session-1');
    expect(thread(keyOf(2)).sessionId).toBe('job-session-2');
    expect(runtime.useAdmiralRuntimeStore.getState().panes[PANE]).toEqual({
      kind: 'ready',
      lobbySessionId: LOBBY
    });
  });

  it('says who owns the repository when the claim is refused', async () => {
    stop();
    runtime.detachAdmiral(PANE);
    agency.claimAdmiral.mockResolvedValue({ ok: false, ownerPaneId: 'other' });
    await runtime.attachAdmiral(PANE, REPO);
    expect(runtime.useAdmiralRuntimeStore.getState().panes[PANE]).toEqual({
      kind: 'refused',
      ownerPaneId: 'other'
    });
  });
});

describe('pulling wakeups', () => {
  it('asks for every thread once it is attached', () => {
    const asked = agency.pullWakeups.mock.calls.map((call) => call[0].jobId);
    expect(asked.sort()).toEqual([1, 2, null].sort());
  });

  it('only pulls for a thread that is idle with nothing queued', async () => {
    agentStore.useAgentStore.getState().send(keyOf(1), REPO.root, 'start');
    agency.pullWakeups.mockClear();

    changed({ jobIds: [1] });
    await tick();
    expect(agency.pullWakeups).not.toHaveBeenCalled();

    endTurn(keyOf(1));
    await tick();
    expect(agency.pullWakeups).toHaveBeenCalledWith({ repoId: REPO.repoId, jobId: 1 });
  });

  it('sends what the client queued before asking for wakeups', async () => {
    agentStore.useAgentStore.getState().send(keyOf(1), REPO.root, 'start');
    agentStore.useAgentStore.getState().send(keyOf(1), REPO.root, 'and use pnpm');
    agency.pullWakeups.mockClear();
    send.mockClear();

    endTurn(keyOf(1));
    await tick();

    // The queued message went out as a turn of its own, and nothing was pulled.
    expect(sends()).toHaveLength(1);
    expect(sends()[0].history.at(-1)).toMatchObject({
      role: 'user',
      parts: [{ text: 'and use pnpm' }]
    });
    expect(sends()[0].history.at(-1)?.meta).toBeUndefined();
    expect(agency.pullWakeups).not.toHaveBeenCalled();

    endTurn(keyOf(1));
    await tick();
    expect(agency.pullWakeups).toHaveBeenCalledWith({ repoId: REPO.repoId, jobId: 1 });
  });

  it('acknowledges a batch only after the turn it started is written down', async () => {
    agency.pullWakeups.mockImplementation(async ({ jobId }) =>
      Promise.resolve(
        jobId === 1 ? { ids: [7, 8], text: 'Client answered q3', nextDueAt: null } : NOTHING
      )
    );
    changed({ jobIds: [1] });
    await tick();

    const turn = sends().at(-1);
    expect(turn).toMatchObject({ threadId: 'job-session-1', text: '', mode: 'admiral' });
    expect(turn?.admiral).toEqual({ repoId: REPO.repoId, jobId: 1 });
    expect(turn?.history.at(-1)).toMatchObject({ role: 'fleet', meta: { kind: 'event' } });
    expect(agency.ackWakeups).not.toHaveBeenCalled();

    agency.pullWakeups.mockResolvedValue(NOTHING);
    emit(IPC_CHANNELS.AGENT_STREAM_CHUNK, { streamId: thread(keyOf(1)).streamId, delta: 'On it.' });
    endTurn(keyOf(1));
    await tick();

    expect(agency.ackWakeups).toHaveBeenCalledWith([7, 8]);
    const replyAt = appended().findIndex(
      (a) => a.event.t === 'message' && a.event.message.role === 'assistant'
    );
    expect(replyAt).not.toBe(-1);
    expect(agency.ackWakeups.mock.invocationCallOrder[0]).toBeGreaterThan(
      appendSession.mock.invocationCallOrder[replyAt] ?? Infinity
    );
  });

  it('hands a failed batch back and checks again when it comes due', async () => {
    agency.pullWakeups.mockImplementation(async ({ jobId }) =>
      Promise.resolve(jobId === 2 ? { ids: [5], text: 'Crew finished', nextDueAt: null } : NOTHING)
    );
    changed({ jobIds: [2] });
    await tick();
    agency.pullWakeups.mockReset();
    agency.pullWakeups.mockResolvedValue(NOTHING);
    agency.releaseWakeups.mockResolvedValue({ nextDueAt: Date.now() + 5_000, gaveUp: false });

    endTurn(keyOf(2), 'model unreachable');
    await tick();
    expect(agency.ackWakeups).not.toHaveBeenCalled();
    expect(agency.releaseWakeups).toHaveBeenCalledWith({ ids: [5], error: 'model unreachable' });
    agency.pullWakeups.mockClear();

    await tick(4_999);
    expect(agency.pullWakeups).not.toHaveBeenCalled();
    await tick(1);
    expect(agency.pullWakeups).toHaveBeenCalledWith({ repoId: REPO.repoId, jobId: 2 });
  });

  it('retries a failed batch without saying its event again', async () => {
    agency.pullWakeups.mockImplementation(async ({ jobId }) =>
      Promise.resolve(jobId === 2 ? { ids: [5], text: 'Crew finished', nextDueAt: null } : NOTHING)
    );
    agency.releaseWakeups.mockResolvedValue({ nextDueAt: null, gaveUp: false });
    changed({ jobIds: [2] });
    await tick();
    endTurn(keyOf(2), 'model unreachable');
    await tick();
    changed({ jobIds: [2] });
    await tick();

    const events = thread(keyOf(2)).messages.filter((m) => m.meta?.kind === 'event');
    expect(events).toHaveLength(1);
    expect(thread(keyOf(2)).streamId).not.toBeNull();
  });

  it('never delivers one job’s wakeups into another job’s conversation', async () => {
    agency.pullWakeups.mockImplementation(async ({ jobId }) =>
      Promise.resolve(jobId === 1 ? { ids: [1], text: 'For job one', nextDueAt: null } : NOTHING)
    );
    changed({ jobIds: [1, 2] });
    await tick();

    expect(sends()).toHaveLength(1);
    expect(sends()[0]).toMatchObject({ threadId: 'job-session-1', admiral: { jobId: 1 } });
    expect(thread(keyOf(2)).messages).toEqual([]);
    expect(thread(keyOf(1)).messages.some((m) => m.meta?.kind === 'event')).toBe(true);
  });

  it('holds a batch that lands while the thread got busy, and delivers it next', async () => {
    let resolve: (pull: WakeupPull) => void = () => {};
    agency.pullWakeups.mockImplementation(
      async ({ jobId }) =>
        new Promise((r) => {
          if (jobId === 1) resolve = r;
          else r(NOTHING);
        })
    );
    changed({ jobIds: [1] });
    await tick();
    agentStore.useAgentStore.getState().send(keyOf(1), REPO.root, 'meanwhile');
    resolve({ ids: [9], text: 'Late news', nextDueAt: null });
    await tick();
    expect(sends()).toHaveLength(1);

    agency.pullWakeups.mockResolvedValue(NOTHING);
    endTurn(keyOf(1));
    await tick();
    expect(sends()).toHaveLength(2);
    expect(sends()[1].history.at(-1)).toMatchObject({
      role: 'fleet',
      parts: [{ text: 'Late news' }]
    });
  });
});

describe('handing a job the lobby talk', () => {
  beforeEach(async () => {
    stop();
    runtime.detachAdmiral(PANE);
    agentStore.useAgentStore.setState({ threads: {} });
    replays.set(LOBBY, [
      textMessage('u1', 'user', 'fix the drag'),
      textMessage('a1', 'assistant', 'Opening a job for it.')
    ]);
    snap = { ...snap, jobs: [job(3, { handoffDone: false })] };
    stop = runtime.initAdmiralRuntime();
    await tick();
  });

  it('seeds the job, links it from the lobby, and records the handoff once', async () => {
    expect(thread(keyOf(3)).messages.map((m) => m.id)).toEqual(['u1', 'a1']);
    const link = thread(LOBBY_KEY).messages.at(-1);
    expect(link?.meta).toEqual({ kind: 'job-link', jobId: 3 });
    expect(agency.markHandoff).toHaveBeenCalledWith({ jobId: 3, lobbyMessageId: link?.id });

    // Main says the job was opened again before it took the handoff in.
    changed({ jobIds: [3], openedJobId: 3 });
    await tick();
    expect(thread(keyOf(3)).messages.map((m) => m.id)).toEqual(['u1', 'a1']);
    expect(thread(LOBBY_KEY).messages.filter((m) => m.meta?.kind === 'job-link')).toHaveLength(1);
    expect(agency.markHandoff).toHaveBeenLastCalledWith({ jobId: 3, lobbyMessageId: link?.id });
    expect(activeJob).toHaveBeenCalledWith(PANE, 3);
  });

  it('gives every job one turn opened the same lobby talk', async () => {
    stop();
    runtime.detachAdmiral(PANE);
    agentStore.useAgentStore.setState({ threads: {} });
    snap = { ...snap, jobs: [job(3, { handoffDone: false }), job(5, { handoffDone: false })] };
    stop = runtime.initAdmiralRuntime();
    await tick();
    await tick();

    expect(thread(keyOf(3)).messages.map((m) => m.id)).toEqual(['u1', 'a1']);
    expect(thread(keyOf(5)).messages.map((m) => m.id)).toEqual(['u1', 'a1']);
    expect(thread(LOBBY_KEY).messages.filter((m) => m.meta?.kind === 'job-link')).toHaveLength(2);
  });

  it('waits for the lobby turn that opened the job to finish', async () => {
    snap = { ...snap, jobs: [job(3), job(4, { handoffDone: false })] };
    agentStore.useAgentStore.getState().send(LOBBY_KEY, REPO.root, 'and a second one');
    changed({ jobIds: [4], openedJobId: 4 });
    await tick();
    expect(thread(keyOf(4)).messages).toEqual([]);

    emit(IPC_CHANNELS.AGENT_STREAM_CHUNK, {
      streamId: thread(LOBBY_KEY).streamId,
      delta: 'Opened.'
    });
    endTurn(LOBBY_KEY);
    await tick();
    // Since the last job it opened, the client's message and the reply.
    expect(thread(keyOf(4)).messages.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(thread(keyOf(4)).messages[1]?.parts).toEqual([{ type: 'text', text: 'Opened.' }]);
  });
});

describe('what the pane reports', () => {
  const lastState = (): unknown =>
    report.mock.calls.filter((c) => c[0].paneId === PANE).at(-1)?.[0].state;

  it('needs the client while any question is open, works while any turn runs', async () => {
    agentStore.useAgentStore.getState().send(keyOf(2), REPO.root, 'go');
    expect(lastState()).toBe('working');
    expect(report.mock.calls.some((c) => String(c[0].paneId).startsWith('admiral:'))).toBe(false);

    snap = { ...snap, questions: [question(1, 1)] };
    changed({ jobIds: [1] });
    await tick();
    expect(lastState()).toBe('needs_me');

    snap = { ...snap, questions: [] };
    changed({ jobIds: [1] });
    await tick();
    expect(lastState()).toBe('working');

    endTurn(keyOf(2));
    await tick();
    expect(lastState()).toBe('idle');
  });

  it('announces a second question while the first still waits', async () => {
    snap = { ...snap, questions: [question(1, 1)] };
    changed({ jobIds: [1] });
    await tick();
    const mine = (): Array<{ state: string; renotify?: boolean }> =>
      report.mock.calls.filter((c) => c[0].paneId === PANE).map((c) => c[0]);
    expect(mine().at(-1)).toMatchObject({ state: 'needs_me' });
    const before = mine().length;

    snap = { ...snap, questions: [question(1, 1), question(2, 1)] };
    changed({ jobIds: [1] });
    await tick();
    expect(mine()).toHaveLength(before + 1);
    expect(mine().at(-1)).toMatchObject({ state: 'needs_me', renotify: true });

    // An answer that leaves one open is no news.
    snap = { ...snap, questions: [question(2, 1)] };
    changed({ jobIds: [1] });
    await tick();
    expect(mine()).toHaveLength(before + 1);
  });
});

describe('a message sent while the Admiral works', () => {
  it('is queued, written down, and handed to the running turn', () => {
    agentStore.useAgentStore.getState().send(keyOf(1), REPO.root, 'start');
    const streamId = thread(keyOf(1)).streamId;
    agentStore.useAgentStore.getState().send(keyOf(1), REPO.root, 'also this');

    const queued = thread(keyOf(1)).messages.at(-1);
    expect(queued).toMatchObject({ role: 'user', meta: { kind: 'queued' } });
    expect(appended().at(-1)?.event).toEqual({ t: 'message', message: queued });
    expect(queue).toHaveBeenCalledWith({ streamId, message: queued });
    expect(sends()).toHaveLength(1);
  });

  it('moves where the turn took it in, unmarked, and says so in the log', () => {
    agentStore.useAgentStore.getState().send(keyOf(1), REPO.root, 'start');
    const streamId = thread(keyOf(1)).streamId;
    emit(IPC_CHANNELS.AGENT_STREAM_CHUNK, { streamId, delta: 'Reading.' });
    agentStore.useAgentStore.getState().send(keyOf(1), REPO.root, 'also this');
    const queuedId = thread(keyOf(1)).messages.at(-1)?.id;

    emit(IPC_CHANNELS.AGENT_STREAM_QUEUED_TAKEN, { streamId, messageIds: [queuedId] });

    const messages = thread(keyOf(1)).messages;
    expect(messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
    expect(messages[1]?.parts).toEqual([{ type: 'text', text: 'Reading.' }]);
    expect(messages[2]).toMatchObject({ id: queuedId });
    expect(messages[2]?.meta).toBeUndefined();
    expect(messages[3]).toMatchObject({ id: streamId, parts: [] });
    expect(
      appended()
        .map((a) => a.event.t)
        .slice(-2)
    ).toEqual(['message', 'unqueue']);
    expect(appended().at(-1)?.event).toEqual({ t: 'unqueue', id: queuedId });
  });
});
