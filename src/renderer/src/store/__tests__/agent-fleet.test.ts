import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC_CHANNELS } from '../../../../shared/ipc-channels';
import { emptyReplay } from '../../../../shared/agent-session';
import type { AgentSendRequest } from '../../../../shared/agent-types';
import type { ClaudeSessionView, ClaudeSessionsSnapshot } from '../../../../shared/claude-sessions';
import type { FleetDigestPull } from '../../../../shared/fleet-tools';
import type * as AgentStore from '../agent-store';
import type * as AgentFleet from '../agent-fleet';
import type * as ClaudeSessionsStore from '../claude-sessions-store';

/**
 * Wakeups from the pane's side: when an orchestrator pane asks main for a
 * digest, what it does with one, and what it does when it is busy or paused.
 */

const PANE = 'pane-1';
const SESSION = 'session-1';
const CWD = '/repo';

const orchestrators = new Set<string>();
vi.mock('../workspace-store', async () => {
  const { create } = await import('zustand');
  return {
    isOrchestratorPane: (_state: unknown, paneId: string) => orchestrators.has(paneId),
    registerPaneDisposer: () => {},
    useWorkspaceStore: create(() => ({ version: 0 }))
  };
});

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

const send = vi.fn();
const pullDigest = vi.fn<(threadId: string) => Promise<FleetDigestPull>>();
const setMode = vi.fn();

let agentStore: typeof AgentStore;
let fleet: typeof AgentFleet;
let sessions: typeof ClaudeSessionsStore;
let stop: () => void;

function session(over: Partial<ClaudeSessionView> = {}): ClaudeSessionView {
  return {
    sessionId: 'claude-1',
    paneId: 'term-1',
    epoch: 0,
    cwd: '/work',
    projectName: 'work',
    phase: 'processing',
    waitingKind: null,
    phaseSince: 1,
    transcriptPath: null,
    configDir: null,
    pendingPermissions: [],
    lastActivity: 1,
    createdAt: 0,
    usage: { costUsd: null, contextTokens: null, contextLimit: null },
    git: null,
    ...over
  };
}

function snapshot(...list: ClaudeSessionView[]): ClaudeSessionsSnapshot {
  return { status: { state: 'running' }, installProblems: [], sessions: list };
}

const setSessions = (...list: ClaudeSessionView[]): void => {
  sessions.useClaudeSessionsStore.setState({ snapshot: snapshot(...list) });
};

const finished = (over: Partial<ClaudeSessionView> = {}): ClaudeSessionView =>
  session({ phase: 'waitingForInput', waitingKind: 'prompt', phaseSince: 2, ...over });

function thread(): NonNullable<
  ReturnType<typeof agentStore.useAgentStore.getState>['threads'][string]
> {
  const found = agentStore.useAgentStore.getState().threads[PANE];
  if (!found) throw new Error('no thread');
  return found;
}

function lastSend(): AgentSendRequest {
  const call = send.mock.calls.at(-1);
  if (!call) throw new Error('nothing was sent');
  return call[0] as AgentSendRequest;
}

function endTurn(): void {
  const streamId = thread().streamId;
  if (streamId === null) throw new Error('nothing in flight');
  emit(IPC_CHANNELS.AGENT_STREAM_DONE, { streamId, usage: null });
}

const tick = async (ms = 0): Promise<void> => {
  await vi.advanceTimersByTimeAsync(ms);
};

beforeEach(async () => {
  vi.useFakeTimers();
  vi.resetModules();
  listeners.clear();
  orchestrators.clear();
  orchestrators.add(PANE);
  send.mockClear();
  setMode.mockClear();
  pullDigest.mockReset();
  pullDigest.mockResolvedValue({ text: null, paused: false });

  Object.assign(window.fleet, {
    agent: {
      send,
      compact: vi.fn(),
      cancel: vi.fn(),
      appendSession: vi.fn(),
      addSessionSpend: vi.fn(),
      loadSession: vi.fn().mockImplementation(async () => Promise.resolve(emptyReplay())),
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
      fleet: { pullDigest, setMode }
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
  fleet = await import('../agent-fleet');
  sessions = await import('../claude-sessions-store');
  agentStore.useAgentStore.setState({ threads: {} });
  setSessions(session());
  stop = fleet.initAgentFleet();
  await agentStore.useAgentStore.getState().openSession(PANE, SESSION, CWD);
  await tick();
});

afterEach(() => {
  stop();
  vi.useRealTimers();
});

describe('attentionChanged', () => {
  it('counts a session starting to wait, and one going away, but not the same wait again', () => {
    const first = fleet.attentionChanged(new Map(), snapshot(session()));
    expect(first.changed).toBe(false);
    const done = fleet.attentionChanged(first.keys, snapshot(finished()));
    expect(done.changed).toBe(true);
    // An idle reminder: another event, the same wait.
    expect(fleet.attentionChanged(done.keys, snapshot(finished({ lastActivity: 9 }))).changed).toBe(
      false
    );
    expect(fleet.attentionChanged(done.keys, snapshot()).changed).toBe(true);
  });
});

describe('orchestrator mode', () => {
  it('tells main which conversations are orchestrating, and when one stops', async () => {
    expect(setMode).toHaveBeenCalledWith(SESSION, true);
    orchestrators.delete(PANE);
    const { useWorkspaceStore } = await import('../workspace-store');
    useWorkspaceStore.setState({});
    expect(setMode).toHaveBeenLastCalledWith(SESSION, false);
  });
});

describe('wakeups', () => {
  it('makes one pull for sessions finishing close together, after the debounce', async () => {
    setSessions(finished(), session({ sessionId: 'claude-2', paneId: 'term-2' }));
    await tick(1_500);
    setSessions(finished(), finished({ sessionId: 'claude-2', paneId: 'term-2', phaseSince: 3 }));
    await tick(499);
    expect(pullDigest).not.toHaveBeenCalled();
    await tick(1);
    expect(pullDigest).toHaveBeenCalledTimes(1);
    expect(pullDigest).toHaveBeenCalledWith(SESSION);
  });

  it('does not wake for hook events that change nothing', async () => {
    setSessions(session({ lastActivity: 5 }));
    await tick(5_000);
    expect(pullDigest).not.toHaveBeenCalled();
  });

  it('starts a turn from the digest, as a fleet message nobody typed', async () => {
    pullDigest.mockResolvedValue({ text: '- abcdef12 finished its turn.', paused: false });
    setSessions(finished());
    await tick(2_000);

    const request = lastSend();
    expect(request.text).toBe('');
    expect(request.orchestrator).toBe(true);
    expect(request.history.at(-1)).toMatchObject({ role: 'fleet' });
    expect(thread().messages.at(-2)).toMatchObject({
      role: 'fleet',
      parts: [{ type: 'text', text: '- abcdef12 finished its turn.' }]
    });
  });

  it('holds the digest while the pane is busy, and takes it when the turn ends', async () => {
    agentStore.useAgentStore.getState().send(PANE, CWD, 'check the api session');
    const userTurn = send.mock.calls.length;
    pullDigest.mockResolvedValue({ text: '- abcdef12 finished its turn.', paused: false });
    setSessions(finished());
    await tick(2_000);
    expect(pullDigest).not.toHaveBeenCalled();

    endTurn();
    await tick();
    expect(pullDigest).toHaveBeenCalledTimes(1);
    expect(send.mock.calls.length).toBe(userTurn + 1);
    expect(lastSend().history.at(-1)).toMatchObject({ role: 'fleet' });
  });

  it('keeps a digest that lands on a pane that just got busy, for when it is free', async () => {
    let answer: (pull: FleetDigestPull) => void = () => {};
    pullDigest.mockReturnValueOnce(new Promise((resolve) => (answer = resolve)));
    setSessions(finished());
    await tick(2_000);
    agentStore.useAgentStore.getState().send(PANE, CWD, 'something else first');
    answer({ text: '- abcdef12 ended.', paused: false });
    await tick();
    expect(lastSend().text).toBe('something else first');

    endTurn();
    await tick();
    expect(lastSend().history.at(-1)).toMatchObject({
      role: 'fleet',
      parts: [{ type: 'text', text: '- abcdef12 ended.' }]
    });
  });

  it('leaves a pane that is not orchestrating alone', async () => {
    orchestrators.clear();
    setSessions(finished());
    await tick(2_000);
    expect(pullDigest).not.toHaveBeenCalled();
  });

  it('shows the pause at the chain limit until the user writes', async () => {
    pullDigest.mockResolvedValue({ text: '- abcdef12 finished its turn.', paused: true });
    setSessions(finished());
    await tick(2_000);
    expect(fleet.useAgentFleetStore.getState().paused[PANE]).toBe(true);

    pullDigest.mockResolvedValue({ text: null, paused: true });
    endTurn();
    await tick();
    expect(fleet.useAgentFleetStore.getState().paused[PANE]).toBe(true);

    agentStore.useAgentStore.getState().send(PANE, CWD, 'carry on');
    expect(fleet.useAgentFleetStore.getState().paused[PANE]).toBeUndefined();
  });
});
