import { describe, expect, it } from 'vitest';
import type { ClaudePendingPermission, ClaudeSession } from '../../../../shared/claude-sessions';
import { asAnswerer } from '../crew-fleet';

function member(over: Partial<ClaudeSession> = {}): ClaudeSession {
  return {
    sessionId: 's1',
    runtime: 'claude',
    paneId: 'pane-1',
    epoch: 1,
    cwd: '/work/front-1',
    projectName: 'front-1',
    phase: 'processing',
    waitingKind: null,
    phaseSince: 0,
    transcriptPath: null,
    configDir: null,
    pendingPermissions: [],
    lastActivity: 0,
    createdAt: 0,
    ...over
  };
}

const request = (delegated: boolean): ClaudePendingPermission => ({
  sessionId: 's1',
  toolUseId: 'tool-1',
  tool: { toolName: 'Bash', toolInput: { command: 'git push' } },
  receivedAt: 0,
  delegated
});

describe('asAnswerer', () => {
  it('shows a member with a request held for the agency as waiting for approval', () => {
    expect(asAnswerer(member({ pendingPermissions: [request(true)] })).phase).toBe(
      'waitingForApproval'
    );
  });

  it('leaves a member alone that is working, or waits on something else', () => {
    const working = member();
    expect(asAnswerer(working)).toBe(working);
    const prompt = member({ phase: 'waitingForInput', waitingKind: 'prompt' });
    expect(asAnswerer(prompt)).toBe(prompt);
    const outsider = member({ phase: 'waitingForApproval', pendingPermissions: [request(false)] });
    expect(asAnswerer(outsider)).toBe(outsider);
  });
});
