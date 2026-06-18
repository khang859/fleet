import { describe, it, expect } from 'vitest';
import { buildRetroBriefing } from '../kanban/pm-retro';
import type { Feature, Task, TaskRun, TaskEvent } from '../../shared/kanban-types';

function feature(overrides: Partial<Feature> = {}): Feature {
  return {
    id: 'f1',
    boardId: 'b1',
    name: 'Dark mode',
    status: 'shipped',
    repoPath: '/repo',
    baseBranch: 'main',
    integrationBranch: 'feat/dark-mode',
    mergeState: 'merged',
    prUrl: 'https://x/pull/9',
    prNumber: 9,
    prState: 'merged',
    checksState: 'passing',
    syncedAt: 0,
    prSkipNotified: false,
    qaVerdict: 'pass',
    createdAt: 0,
    updatedAt: 0,
    ...overrides
  };
}

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: 't1',
    title: 'Add toggle',
    body: '',
    assignee: 'alice',
    status: 'done',
    priority: 1,
    tenant: null,
    workspaceKind: 'worktree',
    workspacePath: '/repo',
    repoPath: null,
    branchName: 'kanban/t1',
    baseBranch: 'main',
    modelOverride: null,
    skills: [],
    docs: [],
    boardId: 'b1',
    featureId: 'f1',
    idempotencyKey: null,
    result: null,
    pendingMode: null,
    claimLock: null,
    claimExpires: null,
    workerPid: null,
    currentRunId: null,
    lastHeartbeatAt: null,
    consecutiveFailures: 0,
    resolveAttempts: 0,
    verifyAttempts: 0,
    reviewVerdict: null,
    reviewAttempts: 0,
    reviewHeadSha: null,
    lastFailureError: null,
    maxRuntimeSeconds: null,
    maxRetries: 0,
    scheduleKind: null,
    scheduleCron: null,
    scheduleIntervalMs: null,
    nextRunAt: null,
    schedulePaused: false,
    scheduledFrom: null,
    prInfo: null,
    conflictState: null,
    conflictFiles: [],
    worktreePruned: false,
    systemKind: null,
    pipelineTemplate: null,
    pipelineStage: null,
    createdAt: 0,
    updatedAt: 0,
    ...overrides
  };
}

function run(overrides: Partial<TaskRun> = {}): TaskRun {
  return {
    id: 1,
    taskId: 't1',
    profile: 'alice',
    status: 'finished',
    mode: 'work',
    workerPid: null,
    startedAt: 0,
    endedAt: 1,
    outcome: 'completed',
    summary: 'implemented the toggle',
    metadata: null,
    error: null,
    ...overrides
  };
}

function event(kind: string, taskId = 't1'): TaskEvent {
  return { id: 1, taskId, runId: null, kind, payload: null, createdAt: 0 };
}

describe('buildRetroBriefing', () => {
  it('names the shipped feature and its QA verdict', () => {
    const out = buildRetroBriefing(feature(), [task()], () => [run()], () => []);
    expect(out).toContain('Dark mode');
    expect(out).toContain('qa: pass');
  });

  it('surfaces friction: failing review verdicts and verify retries', () => {
    const flaky = task({
      id: 't2',
      title: 'Persist preference',
      reviewVerdict: 'request_changes',
      reviewAttempts: 2,
      verifyAttempts: 2
    });
    const out = buildRetroBriefing(
      feature(),
      [flaky],
      () => [run({ taskId: 't2', outcome: 'completed', summary: 'eventually green' })],
      (id) => (id === 't2' ? [event('verify_failed', 't2'), event('review_changes_requested', 't2')] : [])
    );
    expect(out).toContain('Persist preference');
    expect(out).toContain('request_changes');
    expect(out).toContain('verify_failed');
  });

  it('instructs the PM to search prior memory, write learnings, and suggest improvements', () => {
    const out = buildRetroBriefing(feature(), [task()], () => [run()], () => []);
    expect(out).toMatch(/learnings_search/);
    expect(out).toMatch(/kanban_learning_create/);
    expect(out).toMatch(/MEMORY\.md/);
    expect(out).toMatch(/suggest/i);
  });
});
