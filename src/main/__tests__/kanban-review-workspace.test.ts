import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { headSha, worktreeDiff } from '../kanban/workspace';

let repo: string;
let baseSha: string;
beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'fleet-ws-'));
  const git = (...a: string[]) => execFileSync('git', ['-C', repo, ...a]);
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 't@t');
  git('config', 'user.name', 't');
  writeFileSync(join(repo, 'a.txt'), 'one\n');
  git('add', '.');
  git('commit', '-qm', 'base');
  baseSha = execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
});
afterEach(() => rmSync(repo, { recursive: true, force: true }));

describe('workspace git helpers', () => {
  it('headSha returns the current HEAD sha', () => {
    expect(headSha(repo)).toMatch(/^[0-9a-f]{40}$/);
  });
  it('worktreeDiff returns the diff vs base', () => {
    writeFileSync(join(repo, 'a.txt'), 'two\n');
    execFileSync('git', ['-C', repo, 'commit', '-aqm', 'change']);
    const diff = worktreeDiff({ workspacePath: repo, baseBranch: baseSha, maxBytes: 10000 });
    expect(diff).toContain('a.txt');
  });
  it('worktreeDiff caps output and marks truncation', () => {
    writeFileSync(join(repo, 'big.txt'), 'x\n'.repeat(5000));
    execFileSync('git', ['-C', repo, 'add', '.']);
    execFileSync('git', ['-C', repo, 'commit', '-qm', 'big']);
    const diff = worktreeDiff({ workspacePath: repo, baseBranch: baseSha, maxBytes: 200 });
    expect(diff.length).toBeLessThan(400);
    expect(diff).toContain('truncated');
  });
});
