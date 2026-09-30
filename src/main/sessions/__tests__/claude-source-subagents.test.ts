import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type * as os from 'node:os';

const home = vi.hoisted(() => ({ dir: '' }));
vi.mock('node:os', async (importOriginal) => ({
  ...(await importOriginal<typeof os>()),
  homedir: () => home.dir
}));

import { __clearClaudeSummaryCache, listClaudeSessions, readClaudeSession } from '../claude-source';

const CWD = '/Users/me/proj';

function usageLine(id: string, sidechain: boolean): string {
  return JSON.stringify({
    type: 'assistant',
    isSidechain: sidechain,
    message: { id, model: 'claude-opus-4-8', usage: { output_tokens: 1_000_000 } }
  });
}

beforeEach(() => {
  __clearClaudeSummaryCache();
  home.dir = mkdtempSync(join(tmpdir(), 'fleet-claude-home-'));
  const project = join(home.dir, '.claude', 'projects', '-Users-me-proj');
  mkdirSync(join(project, 'sess', 'subagents'), { recursive: true });
  const user = JSON.stringify({
    type: 'user',
    uuid: 'u1',
    cwd: CWD,
    message: { role: 'user', content: 'hello there' }
  });
  writeFileSync(join(project, 'sess.jsonl'), `${user}\n${usageLine('main', false)}\n`);
  writeFileSync(join(project, 'sess', 'subagents', 'agent-a.jsonl'), usageLine('sub', true));
  // Claude Code keeps a metadata file beside each subagent transcript.
  writeFileSync(join(project, 'sess', 'subagents', 'agent-a.meta.json'), '{}');
});

afterEach(() => {
  rmSync(home.dir, { recursive: true, force: true });
});

describe('subagent usage in session cost', () => {
  it('is added to a listed session', async () => {
    const [summary] = await listClaudeSessions();
    // One million output tokens each at $25/MTok.
    expect(summary.costUsd).toBeCloseTo(50);
  });

  it('is added to a session read on its own', async () => {
    const session = await readClaudeSession('sess', CWD);
    expect(session?.summary.costUsd).toBeCloseTo(50);
  });
});
