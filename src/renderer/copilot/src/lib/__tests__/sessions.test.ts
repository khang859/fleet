import { describe, it, expect } from 'vitest';
import {
  firstOpenPermission,
  sessionStatus,
  sortSessions,
  spriteStateFor,
  statusLabel,
  turnFinished
} from '../sessions';
import type { CopilotSession } from '../../../../../shared/types';

function session(overrides: Partial<CopilotSession> = {}): CopilotSession {
  return {
    sessionId: 's1',
    runtime: 'claude',
    paneId: 'p1',
    epoch: 0,
    cwd: '/tmp/project',
    projectName: 'project',
    phase: 'waitingForInput',
    waitingKind: 'prompt',
    phaseSince: 0,
    transcriptPath: null,
    configDir: null,
    pendingPermissions: [],
    lastActivity: 0,
    createdAt: 0,
    ...overrides
  };
}

const permission: CopilotSession['pendingPermissions'][number] = {
  sessionId: 's1',
  toolUseId: 't1',
  tool: { toolName: 'Bash', toolInput: { command: 'ls' } },
  receivedAt: 0
};

describe('sessionStatus and statusLabel', () => {
  it('names a question as asking, not idle', () => {
    const asking = session({ waitingKind: 'question' });
    expect(sessionStatus(asking)).toBe('permission');
    expect(statusLabel(asking)).toBe('Asking a question');
  });

  it('gives readable labels instead of phase names', () => {
    expect(statusLabel(session())).toBe('Ready');
    expect(statusLabel(session({ phase: 'processing', waitingKind: null }))).toBe('Working');
    expect(
      statusLabel(
        session({
          phase: 'waitingForApproval',
          waitingKind: null,
          pendingPermissions: [permission]
        })
      )
    ).toBe('Needs permission');
  });
});

describe('sortSessions', () => {
  it('puts sessions that need the user first, then keeps start order', () => {
    const a = session({ sessionId: 'a', createdAt: 1 });
    const b = session({
      sessionId: 'b',
      createdAt: 2,
      phase: 'waitingForApproval',
      waitingKind: null,
      pendingPermissions: [permission]
    });
    const c = session({ sessionId: 'c', createdAt: 0 });
    expect([a, b, c].sort(sortSessions).map((s) => s.sessionId)).toEqual(['b', 'c', 'a']);
  });
});

describe('turnFinished', () => {
  it('is true when a working session returns to its prompt', () => {
    const before = [session({ phase: 'processing', waitingKind: null })];
    expect(turnFinished(before, [session()])).toBe(true);
  });

  it('is false when the session stops to ask a question', () => {
    const before = [session({ phase: 'processing', waitingKind: null })];
    expect(turnFinished(before, [session({ waitingKind: 'question' })])).toBe(false);
  });

  it('is false for a session seen for the first time', () => {
    expect(turnFinished([], [session()])).toBe(false);
  });
});

describe('spriteStateFor', () => {
  it('shows a request for the user over the turn-done moment', () => {
    expect(
      spriteStateFor(
        [
          session({
            phase: 'waitingForApproval',
            waitingKind: null,
            pendingPermissions: [permission]
          })
        ],
        true
      )
    ).toBe('permission');
  });

  it('shows the turn-done moment over other work', () => {
    expect(spriteStateFor([session({ phase: 'processing', waitingKind: null })], true)).toBe(
      'complete'
    );
  });

  it('is idle with nothing going on', () => {
    expect(spriteStateFor([], false)).toBe('idle');
  });
});

describe('firstOpenPermission', () => {
  const second = { ...permission, toolUseId: 't2' };
  const waiting = [
    session({
      phase: 'waitingForApproval',
      waitingKind: null,
      pendingPermissions: [permission, second]
    })
  ];

  it('picks the first request', () => {
    expect(firstOpenPermission(waiting, {})).toBe('t1');
  });

  it('skips a request that failed or is being sent, so the keys reach the next one', () => {
    expect(firstOpenPermission(waiting, { t1: 'failed' })).toBe('t2');
    expect(firstOpenPermission(waiting, { t1: 'sending', t2: 'failed' })).toBeNull();
  });
});
