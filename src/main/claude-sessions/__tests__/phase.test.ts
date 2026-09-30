import { describe, expect, it } from 'vitest';
import {
  INITIAL_PHASE,
  nextPaneEpoch,
  reducePhase,
  resolvePermission,
  type PhaseInput,
  type PhaseState
} from '../phase';

const input = (event: string, status: string, extra: Partial<PhaseInput> = {}): PhaseInput => ({
  sessionId: 's1',
  event,
  status,
  at: 1000,
  ...extra
});

const run = (...inputs: PhaseInput[]): PhaseState => inputs.reduce(reducePhase, INITIAL_PHASE);

const processing: PhaseState = { phase: 'processing', waitingKind: null, pendingPermissions: [] };
const question = input('PermissionRequest', 'waiting_for_approval', {
  tool: 'AskUserQuestion',
  toolInput: { questions: [] }
});
const bash = (toolUseId?: string): PhaseInput =>
  input('PermissionRequest', 'waiting_for_approval', {
    tool: 'Bash',
    toolInput: { command: 'rm -rf build' },
    toolUseId
  });

describe('reducePhase', () => {
  it.each([
    ['UserPromptSubmit', 'processing', 'processing', null],
    ['PreToolUse', 'running_tool', 'processing', null],
    ['PostToolUse', 'processing', 'processing', null],
    ['Stop', 'waiting_for_input', 'waitingForInput', 'prompt'],
    ['SessionStart', 'waiting_for_input', 'waitingForInput', 'prompt'],
    ['Notification', 'waiting_for_input', 'waitingForInput', 'prompt'],
    ['PreCompact', 'compacting', 'compacting', null],
    ['SessionEnd', 'ended', 'ended', null]
  ])('%s (%s) moves to %s', (event, status, phase, waitingKind) => {
    expect(reducePhase(processing, input(event, status))).toMatchObject({ phase, waitingKind });
  });

  it.each([
    ['a subagent stop', input('SubagentStop', 'subagent_stop')],
    ['a subagent stop from an old binary', input('SubagentStop', 'waiting_for_input')],
    ['a plain notification', input('Notification', 'notification')],
    ['a status from a newer binary', input('SomethingNew', 'unknown')]
  ])('keeps the phase on %s', (_label, event) => {
    expect(reducePhase(processing, event)).toBe(processing);
  });

  it('treats AskUserQuestion as a question, not a permission', () => {
    const state = run(input('UserPromptSubmit', 'processing'), question);
    expect(state).toEqual({
      phase: 'waitingForInput',
      waitingKind: 'question',
      pendingPermissions: []
    });
  });

  it('keeps a question open through the idle notification', () => {
    const state = run(
      question,
      input('Notification', 'waiting_for_input', { notificationType: 'idle_prompt' })
    );
    expect(state.waitingKind).toBe('question');
  });

  it('closes the question when the tool finishes, and a later stop waits for a prompt', () => {
    const answered = run(question, input('PostToolUse', 'processing', { tool: 'AskUserQuestion' }));
    expect(answered).toMatchObject({ phase: 'processing', waitingKind: null });
    expect(reducePhase(answered, input('Stop', 'waiting_for_input')).waitingKind).toBe('prompt');
  });

  it('records a permission request with its tool and input', () => {
    const state = run(input('PreToolUse', 'running_tool'), bash('tu-1'));
    expect(state.phase).toBe('waitingForApproval');
    expect(state.pendingPermissions).toEqual([
      {
        sessionId: 's1',
        toolUseId: 'tu-1',
        tool: { toolName: 'Bash', toolInput: { command: 'rm -rf build' }, toolUseId: 'tu-1' },
        receivedAt: 1000
      }
    ]);
  });

  it('does not duplicate a repeated permission request', () => {
    expect(run(bash('tu-1'), bash('tu-1')).pendingPermissions).toHaveLength(1);
  });

  it('clears the permission when its tool finishes', () => {
    const state = run(bash('tu-1'), input('PostToolUse', 'processing', { toolUseId: 'tu-1' }));
    expect(state).toEqual(processing);
  });

  it('clears the permission when its tool fails', () => {
    const state = run(
      bash('tu-1'),
      input('PostToolUseFailure', 'processing', { toolUseId: 'tu-1' })
    );
    expect(state).toEqual(processing);
  });

  it('keeps waiting for approval while a parallel tool finishes', () => {
    const state = run(
      input('UserPromptSubmit', 'processing'),
      bash('tu-b'),
      input('PostToolUse', 'processing', { tool: 'Read', toolUseId: 'tu-a' }),
      input('PreToolUse', 'running_tool', { tool: 'Grep', toolUseId: 'tu-c' })
    );
    expect(state.phase).toBe('waitingForApproval');
    expect(state.pendingPermissions.map((p) => p.toolUseId)).toEqual(['tu-b']);
    // Once the approved tool finishes, the session is back at work.
    expect(
      reducePhase(state, input('PostToolUse', 'processing', { tool: 'Bash', toolUseId: 'tu-b' }))
        .phase
    ).toBe('processing');
  });

  it('clears leftover permissions at a turn boundary', () => {
    expect(run(bash('tu-1'), input('Stop', 'waiting_for_input')).pendingPermissions).toEqual([]);
  });

  it('does not modify the state it was given', () => {
    const before = run(bash('tu-1'));
    const snapshot = structuredClone(before);
    reducePhase(before, input('PostToolUse', 'processing', { toolUseId: 'tu-1' }));
    expect(before).toEqual(snapshot);
  });
});

describe('resolvePermission', () => {
  it('goes back to processing once nothing is left to approve', () => {
    const state = resolvePermission(run(bash('tu-1')), 'tu-1');
    expect(state).toEqual(processing);
  });

  it('keeps waiting while another permission is pending', () => {
    const state = resolvePermission(run(bash('tu-1'), bash('tu-2')), 'tu-1');
    expect(state.phase).toBe('waitingForApproval');
    expect(state.pendingPermissions.map((p) => p.toolUseId)).toEqual(['tu-2']);
  });

  it('leaves an interrupted turn waiting for a prompt when the hook socket closes late', () => {
    const interrupted = run(bash('tu-1'), input('Stop', 'waiting_for_input'));
    expect(resolvePermission(interrupted, 'tu-1')).toMatchObject({
      phase: 'waitingForInput',
      waitingKind: 'prompt'
    });
  });

  it('returns the same state for an unknown id', () => {
    const state = run(bash('tu-1'));
    expect(resolvePermission(state, 'nope')).toBe(state);
  });
});

describe('nextPaneEpoch', () => {
  it.each([
    ['a first session', undefined, 'a', { sessionId: 'a', epoch: 1, replaces: null }],
    [
      'the same session',
      { sessionId: 'a', epoch: 3 },
      'a',
      { sessionId: 'a', epoch: 3, replaces: null }
    ],
    [
      'a new session after /clear',
      { sessionId: 'a', epoch: 3 },
      'b',
      { sessionId: 'b', epoch: 4, replaces: 'a' }
    ]
  ])('%s', (_label, current, sessionId, expected) => {
    expect(nextPaneEpoch(current, sessionId)).toEqual(expected);
  });
});
