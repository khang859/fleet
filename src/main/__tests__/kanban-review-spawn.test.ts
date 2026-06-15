import { describe, it, expect } from 'vitest';
import { buildWorkerInvocation } from '../kanban/spawn-worker';
import { REVIEWER_PROFILE_NAME, DEFAULT_REVIEWER_INSTRUCTIONS } from '../../shared/types';
import { mkdtempSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const ws = (): string => mkdtempSync(join(tmpdir(), 'fleet-spawn-'));
const baseTask = { id: 't1', title: 'T', body: 'B', assignee: 'w', modelOverride: null };

describe('review run prompt + tools', () => {
  it('review mode requires kanban_review_verdict and injects the diff', () => {
    const inv = buildWorkerInvocation({
      task: baseTask,
      workspace: ws(),
      mcpPort: 1,
      runToken: 'tok',
      logPath: '/tmp/x.log',
      mode: 'review',
      reviewDiff: 'diff --git a/x b/x\n+changed'
    });
    expect(inv.args).toContain('--require-tool');
    expect(inv.args[inv.args.indexOf('--require-tool') + 1]).toBe('kanban_review_verdict');
    const prompt = inv.args[inv.args.indexOf('--prompt') + 1];
    expect(prompt).toContain('diff --git a/x b/x');
    expect(prompt).toContain('kanban_review_verdict');
  });

  it('work mode injects prior review findings (the bounce)', () => {
    const inv = buildWorkerInvocation({
      task: baseTask,
      workspace: ws(),
      mcpPort: 1,
      runToken: 'tok',
      logPath: '/tmp/x.log',
      mode: 'work',
      reviewFindings: '- x.ts: missing null check'
    });
    const prompt = inv.args[inv.args.indexOf('--prompt') + 1];
    expect(prompt).toContain('missing null check');
    expect(prompt).toContain('review');
  });

  it('exports a reviewer profile name and default persona', () => {
    expect(REVIEWER_PROFILE_NAME).toBe('reviewer');
    expect(DEFAULT_REVIEWER_INSTRUCTIONS.length).toBeGreaterThan(20);
  });
});
