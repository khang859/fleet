import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentSessionStore } from '../session-store';
import type { AgentMessage } from '../../../shared/agent-types';

const msg = (id: string, content: string): AgentMessage => ({
  id,
  role: 'user',
  content,
  reasoning: '',
  reasoningMs: null
});

let dir: string;
let store: AgentSessionStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'fleet-agent-sessions-'));
  store = new AgentSessionStore(dir);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const lines = (sessionId: string): unknown[] =>
  readFileSync(join(dir, `${sessionId}.jsonl`), 'utf8')
    .split('\n')
    .filter((l) => l !== '')
    .map((l) => JSON.parse(l));

describe('AgentSessionStore', () => {
  it('writes a header once, on the first event only', () => {
    store.append('s1', '/repo', { t: 'message', message: msg('a', 'hi') });
    store.append('s1', '/repo', { t: 'message', message: msg('b', 'again') });

    expect(lines('s1')).toMatchObject([
      { t: 'session', id: 's1', cwd: '/repo' },
      { t: 'message', message: { id: 'a' } },
      { t: 'message', message: { id: 'b' } }
    ]);
  });

  it('round-trips a thread through append and load', () => {
    store.append('s1', '/repo', { t: 'message', message: msg('a', 'hi') });
    store.append('s1', '/repo', { t: 'context', tokens: 1939 });

    const replay = store.load('s1');

    expect(replay.messages.map((m) => m.id)).toEqual(['a']);
    expect(replay.contextTokens).toBe(1939);
    expect(replay.cwd).toBe('/repo');
  });

  // A pane that opens and closes without a word should leave nothing behind,
  // so the file waits for a first event rather than being created up front.
  it('reads a session that was never written as an empty thread', () => {
    expect(store.load('never-used')).toEqual({
      messages: [],
      contextTokens: null,
      cwd: null,
      skipped: 0
    });
  });

  it('creates the sessions directory on demand', () => {
    const nested = new AgentSessionStore(join(dir, 'a', 'b'));

    nested.append('s1', '/repo', { t: 'message', message: msg('a', 'hi') });

    expect(nested.load('s1').messages).toHaveLength(1);
  });

  it('keeps appending across instances, as a restart would', () => {
    store.append('s1', '/repo', { t: 'message', message: msg('a', 'before') });

    new AgentSessionStore(dir).append('s1', '/repo', { t: 'message', message: msg('b', 'after') });

    expect(store.load('s1').messages.map((m) => m.id)).toEqual(['a', 'b']);
    // Exactly one header: the second instance found the file already there.
    expect(lines('s1').filter((l) => (l as { t: string }).t === 'session')).toHaveLength(1);
  });

  it('recovers the turns before a line a crash cut in half', () => {
    store.append('s1', '/repo', { t: 'message', message: msg('a', 'hi') });
    writeFileSync(join(dir, 's1.jsonl'), '{"t":"message","mess', { flag: 'a' });

    const replay = store.load('s1');

    expect(replay.messages.map((m) => m.id)).toEqual(['a']);
    expect(replay.skipped).toBe(1);
  });

  // The thread is on screen either way; an unwritable session must not take
  // the turn down with it.
  it('does not throw when the path cannot be written', () => {
    const path = join(dir, 'blocked');
    mkdirSync(join(path, 's1.jsonl'), { recursive: true });
    const blocked = new AgentSessionStore(path);

    expect(() => blocked.append('s1', '/repo', { t: 'context', tokens: 1 })).not.toThrow();
    expect(blocked.load('s1').messages).toEqual([]);
  });
});
