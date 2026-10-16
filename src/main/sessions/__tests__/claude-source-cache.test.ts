import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type * as os from 'node:os';
import type * as fsp from 'node:fs/promises';

const home = vi.hoisted(() => ({ dir: '' }));
vi.mock('node:os', async (importOriginal) => ({
  ...(await importOriginal<typeof os>()),
  homedir: () => home.dir
}));
// Count opens, to show which files a list actually reads.
const opened = vi.hoisted(() => [] as string[]);
vi.mock('fs/promises', async (importOriginal) => {
  const real = await importOriginal<typeof fsp>();
  return {
    ...real,
    open: async (path: string, flags: string) => {
      opened.push(path);
      return real.open(path, flags);
    }
  };
});

import { __clearClaudeSummaryCache, listClaudeSessions, readClaudeSession } from '../claude-source';

const CWD = '/Users/me/proj';
let project = '';
let transcript = '';

function user(uuid: string, text: string): string {
  return JSON.stringify({
    type: 'user',
    uuid,
    cwd: CWD,
    message: { role: 'user', content: text }
  });
}

function assistant(id: string, text: string, outputTokens = 1_000_000): string {
  return JSON.stringify({
    type: 'assistant',
    uuid: `a-${id}`,
    message: {
      id,
      role: 'assistant',
      model: 'claude-opus-4-8',
      content: [{ type: 'text', text }],
      usage: { output_tokens: outputTokens }
    }
  });
}

/** What a list says about the transcript when nothing was read before. */
async function listedFromScratch(): Promise<Awaited<ReturnType<typeof listClaudeSessions>>> {
  __clearClaudeSummaryCache();
  return listClaudeSessions();
}

beforeEach(() => {
  __clearClaudeSummaryCache();
  opened.length = 0;
  home.dir = mkdtempSync(join(tmpdir(), 'fleet-claude-home-'));
  project = join(home.dir, '.claude', 'projects', '-Users-me-proj');
  mkdirSync(project, { recursive: true });
  transcript = join(project, 'sess.jsonl');
  writeFileSync(transcript, `${user('u1', 'hello there')}\n${assistant('m1', 'hi')}\n`);
});

afterEach(() => {
  rmSync(home.dir, { recursive: true, force: true });
});

describe('listClaudeSessions as transcripts grow', () => {
  it('does not read a transcript that is unchanged', async () => {
    const first = await listClaudeSessions();
    expect(opened).toContain(transcript);
    opened.length = 0;
    const second = await listClaudeSessions();
    expect(second).toEqual(first);
    expect(opened).toEqual([]);
  });

  it('reads only the lines a transcript gained, and sums them like a full read', async () => {
    await listClaudeSessions();
    appendFileSync(transcript, `${user('u2', 'next')}\n${assistant('m2', 'ok')}\n`);
    const [grown] = await listClaudeSessions();
    expect(grown.messageCount).toBe(4);
    expect(grown.preview).toBe('hello there');
    // Two million output tokens at $25/MTok.
    expect(grown.costUsd).toBeCloseTo(50);
    expect([grown]).toEqual(await listedFromScratch());
  });

  it('starts the count and the preview over after /clear', async () => {
    await listClaudeSessions();
    const clear = JSON.stringify({
      type: 'user',
      uuid: 'c1',
      message: { role: 'user', content: '<command-name>/clear</command-name>' }
    });
    appendFileSync(transcript, `${clear}\n${user('u2', 'fresh start')}\n`);
    const [cleared] = await listClaudeSessions();
    expect(cleared.preview).toBe('fresh start');
    expect([cleared]).toEqual(await listedFromScratch());
  });

  it('waits for a line still being written', async () => {
    await listClaudeSessions();
    const line = user('u2', 'split');
    appendFileSync(transcript, line.slice(0, 20));
    expect((await listClaudeSessions())[0].messageCount).toBe(2);
    appendFileSync(transcript, `${line.slice(20)}\n`);
    expect((await listClaudeSessions())[0].messageCount).toBe(3);
  });

  it('reads a transcript again from the start when it got shorter', async () => {
    await listClaudeSessions();
    writeFileSync(transcript, `${user('u9', 'replaced')}\n`);
    const [replaced] = await listClaudeSessions();
    expect(replaced.messageCount).toBe(1);
    expect(replaced.preview).toBe('replaced');
  });

  it('adds what a subagent wrote by the next transcript write', async () => {
    await listClaudeSessions();
    mkdirSync(join(project, 'sess', 'subagents'), { recursive: true });
    writeFileSync(join(project, 'sess', 'subagents', 'agent-a.jsonl'), `${assistant('s1', 'x')}\n`);
    appendFileSync(transcript, `${user('u2', 'next')}\n`);
    const [summary] = await listClaudeSessions();
    expect(summary.costUsd).toBeCloseTo(50);
    expect([summary]).toEqual(await listedFromScratch());
  });

  // Recent Claude Code versions prepend metadata lines that carry no cwd.
  it('finds the cwd past leading metadata lines', async () => {
    const meta = [
      JSON.stringify({ type: 'last-prompt', leafUuid: 'x', sessionId: 's' }),
      JSON.stringify({ type: 'mode', mode: 'default' })
    ];
    writeFileSync(transcript, `${meta.join('\n')}\n${user('u1', 'hi')}\n`);
    expect((await listClaudeSessions())[0].cwd).toBe(CWD);
  });

  it('leaves out a transcript with no cwd', async () => {
    writeFileSync(transcript, '{"type":"last-prompt"}\n{"type":"mode"}\n');
    expect(await listClaudeSessions()).toEqual([]);
  });

  it('forgets transcripts that disappear', async () => {
    await listClaudeSessions();
    rmSync(transcript);
    expect(await listClaudeSessions()).toEqual([]);
    writeFileSync(transcript, `${user('u1', 'back again')}\n`);
    expect((await listClaudeSessions())[0].preview).toBe('back again');
  });

  it('counts each line once when lists overlap', async () => {
    appendFileSync(transcript, `${user('u2', 'next')}\n`);
    const [a, b] = await Promise.all([listClaudeSessions(), listClaudeSessions()]);
    expect(a[0].messageCount).toBe(3);
    expect(b[0].messageCount).toBe(3);
  });
});

describe('readClaudeSession as the transcript grows', () => {
  it('shows the lines the transcript gained', async () => {
    expect((await readClaudeSession('sess', CWD))?.messages).toHaveLength(2);
    appendFileSync(transcript, `${assistant('m2', 'more')}\n`);
    const grown = await readClaudeSession('sess', CWD);
    expect(grown?.messages).toHaveLength(3);
    expect(grown?.messages[2].blocks).toEqual([{ type: 'text', text: 'more' }]);
    expect(grown?.summary.messageCount).toBe(3);
  });

  it('reads another session whole after switching to it', async () => {
    writeFileSync(join(project, 'other.jsonl'), `${user('o1', 'other one')}\n`);
    await readClaudeSession('sess', CWD);
    const other = await readClaudeSession('other', CWD);
    expect(other?.messages).toHaveLength(1);
    expect(other?.summary.preview).toBe('other one');
  });
});
