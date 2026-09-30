import { describe, it, expect } from 'vitest';
import { CopilotSessionStore, type HookEvent } from '../session-store';

function hook(event: string, status: string, extra: Partial<HookEvent> = {}): HookEvent {
  return { session_id: 's1', cwd: '/repo', event, status, ...extra };
}

function storeAfter(...events: HookEvent[]): CopilotSessionStore {
  const store = new CopilotSessionStore();
  for (const e of events) store.processHookEvent(e);
  return store;
}

describe('CopilotSessionStore phases', () => {
  it('keeps the parent processing when a subagent stops', () => {
    const store = storeAfter(
      hook('UserPromptSubmit', 'processing'),
      hook('SubagentStop', 'subagent_stop')
    );
    expect(store.getSession('s1')?.phase).toBe('processing');
  });

  it('ignores SubagentStop from older hook binaries that report waiting_for_input', () => {
    const store = storeAfter(
      hook('UserPromptSubmit', 'processing'),
      hook('SubagentStop', 'waiting_for_input')
    );
    expect(store.getSession('s1')?.phase).toBe('processing');
  });

  it('keeps the phase on notifications and unknown statuses', () => {
    const store = storeAfter(
      hook('PreToolUse', 'running_tool', { tool: 'Bash' }),
      hook('Notification', 'notification', { notification_type: 'auth_success' }),
      hook('SomethingNew', 'unknown')
    );
    expect(store.getSession('s1')?.phase).toBe('processing');
  });

  it('reports a finished turn as waiting for a prompt', () => {
    const store = storeAfter(
      hook('UserPromptSubmit', 'processing'),
      hook('Stop', 'waiting_for_input')
    );
    const session = store.getSession('s1');
    expect(session?.phase).toBe('waitingForInput');
    expect(session?.waitingKind).toBe('prompt');
  });
});

describe('CopilotSessionStore question dialogs', () => {
  const question = hook('PermissionRequest', 'waiting_for_approval', {
    tool: 'AskUserQuestion',
    tool_input: { questions: [] }
  });

  it('marks an AskUserQuestion as a question, not a prompt or a permission', () => {
    const session = storeAfter(hook('UserPromptSubmit', 'processing'), question).getSession('s1');
    expect(session?.phase).toBe('waitingForInput');
    expect(session?.waitingKind).toBe('question');
    expect(session?.pendingPermissions).toEqual([]);
  });

  it('keeps the question open through an idle notification', () => {
    const session = storeAfter(
      question,
      hook('Notification', 'waiting_for_input', { notification_type: 'idle_prompt' })
    ).getSession('s1');
    expect(session?.waitingKind).toBe('question');
  });

  it('clears the question once it is answered', () => {
    const session = storeAfter(
      question,
      hook('PostToolUse', 'processing', { tool: 'AskUserQuestion' })
    ).getSession('s1');
    expect(session?.phase).toBe('processing');
    expect(session?.waitingKind).toBeNull();
  });

  it('turns a later stop back into a prompt', () => {
    const session = storeAfter(
      question,
      hook('PostToolUse', 'processing', { tool: 'AskUserQuestion' }),
      hook('Stop', 'waiting_for_input')
    ).getSession('s1');
    expect(session?.waitingKind).toBe('prompt');
  });
});
