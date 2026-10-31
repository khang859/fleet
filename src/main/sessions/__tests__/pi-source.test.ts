import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { __clearPiSummaryCache, listPiSessions, readPiSession } from '../pi-source';

function header(id: string, cwd: string): string {
  return `${JSON.stringify({
    type: 'session',
    version: 3,
    id,
    timestamp: '2026-10-31T01:00:00.000Z',
    cwd
  })}\n`;
}

function message(id: string, parentId: string | null, body: Record<string, unknown>): string {
  return `${JSON.stringify({
    type: 'message',
    id,
    parentId,
    timestamp: '2026-10-31T01:05:00.000Z',
    message: body
  })}\n`;
}

const user = (text: string): Record<string, unknown> => ({
  role: 'user',
  content: [{ type: 'text', text }]
});

const reply = (text: string, cost: number): Record<string, unknown> => ({
  role: 'assistant',
  model: 'gpt-test',
  content: [{ type: 'text', text }],
  usage: { totalTokens: 10, cost: { total: cost } }
});

describe('pi-source', () => {
  let agentDir: string;
  let folder: string;

  beforeEach(() => {
    agentDir = mkdtempSync(join(tmpdir(), 'fleet-pi-sessions-'));
    folder = join(agentDir, 'sessions', '--repo--');
    mkdirSync(folder, { recursive: true });
    vi.stubEnv('PI_CODING_AGENT_DIR', agentDir);
    __clearPiSummaryCache();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(agentDir, { recursive: true, force: true });
  });

  it('lists a session from its file', async () => {
    writeFileSync(
      join(folder, '2026_s1.jsonl'),
      header('s1', '/repo/app') +
        message('a', null, user('Fix it')) +
        message('b', 'a', reply('Done', 0.5))
    );
    const [session] = await listPiSessions();
    expect(session).toMatchObject({
      id: 's1',
      source: 'pi',
      title: 'Fix it',
      project: 'app',
      cwd: '/repo/app',
      messageCount: 2,
      costUsd: 0.5,
      models: ['gpt-test'],
      startedAt: Date.parse('2026-10-31T01:00:00.000Z'),
      endedAt: Date.parse('2026-10-31T01:05:00.000Z')
    });
  });

  it('leaves out a session with no message, and a file that is not a session', async () => {
    writeFileSync(join(folder, 'empty.jsonl'), header('s1', '/repo'));
    writeFileSync(join(folder, 'junk.jsonl'), 'not json\n');
    expect(await listPiSessions()).toEqual([]);
  });

  it('is empty when Pi has no sessions folder', async () => {
    rmSync(join(agentDir, 'sessions'), { recursive: true });
    expect(await listPiSessions()).toEqual([]);
  });

  it('picks up what a session gained', async () => {
    const path = join(folder, 'grow.jsonl');
    writeFileSync(path, header('s1', '/repo') + message('a', null, user('One')));
    expect((await listPiSessions())[0].messageCount).toBe(1);

    appendFileSync(path, message('b', 'a', reply('Two', 0.1)));
    expect((await listPiSessions())[0].messageCount).toBe(2);
  });

  it('reads the branch the session is on, and counts the spend of all of them', async () => {
    writeFileSync(
      join(folder, 'branch.jsonl'),
      header('s1', '/repo') +
        message('a', null, user('Start')) +
        message('b', 'a', reply('Left', 0.25)) +
        message('c', 'a', reply('Right', 0.5))
    );
    const transcript = await readPiSession('s1');
    const text = JSON.stringify(transcript?.messages);
    expect(text).toContain('Right');
    expect(text).not.toContain('Left');
    expect(transcript?.summary.costUsd).toBe(0.75);
  });

  it('gives null for an id no listing knows', async () => {
    expect(await readPiSession('../../etc/passwd')).toBeNull();
  });
});
