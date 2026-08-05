import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentSessionStore } from '../session-store';
import { emptyReplay } from '../../../shared/agent-session';
import { textMessage, type AgentMessage } from '../../../shared/agent-types';

const msg = (id: string, content: string): AgentMessage => textMessage(id, 'user', content);

/*
 * Real session ids, because the store refuses anything that is not a uuid -
 * that check is what keeps an id from walking out of the sessions folder, so
 * the fixtures have to be the shape production actually mints.
 */
const S1 = '11111111-1111-4111-8111-111111111111';
const S2 = '22222222-2222-4222-8222-222222222222';
const S3 = '33333333-3333-4333-8333-333333333333';
const UNUSED = '44444444-4444-4444-8444-444444444444';
const OLD = '55555555-5555-4555-8555-555555555555';
const NEW = '66666666-6666-4666-8666-666666666666';
const TITLED = '77777777-7777-4777-8777-777777777777';
const BARE = '88888888-8888-4888-8888-888888888888';
const GOOD = '99999999-9999-4999-8999-999999999999';
const GONE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

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
    store.append(S1, '/repo', { t: 'message', message: msg('a', 'hi') });
    store.append(S1, '/repo', { t: 'message', message: msg('b', 'again') });

    expect(lines(S1)).toMatchObject([
      { t: 'session', id: S1, cwd: '/repo' },
      { t: 'message', message: { id: 'a' } },
      { t: 'message', message: { id: 'b' } }
    ]);
  });

  it('round-trips a thread through append and load', () => {
    store.append(S1, '/repo', { t: 'message', message: msg('a', 'hi') });
    store.append(S1, '/repo', { t: 'context', tokens: 1939 });

    const replay = store.load(S1);

    expect(replay.messages.map((m) => m.id)).toEqual(['a']);
    expect(replay.contextTokens).toBe(1939);
    expect(replay.cwd).toBe('/repo');
  });

  // A pane that opens and closes without a word should leave nothing behind,
  // so the file waits for a first event rather than being created up front.
  it('reads a session that was never written as an empty thread', () => {
    expect(store.load(UNUSED)).toEqual(emptyReplay());
  });

  it('creates the sessions directory on demand', () => {
    const nested = new AgentSessionStore(join(dir, 'a', 'b'));

    nested.append(S1, '/repo', { t: 'message', message: msg('a', 'hi') });

    expect(nested.load(S1).messages).toHaveLength(1);
  });

  it('keeps appending across instances, as a restart would', () => {
    store.append(S1, '/repo', { t: 'message', message: msg('a', 'before') });

    new AgentSessionStore(dir).append(S1, '/repo', { t: 'message', message: msg('b', 'after') });

    expect(store.load(S1).messages.map((m) => m.id)).toEqual(['a', 'b']);
    // Exactly one header: the second instance found the file already there.
    expect(lines(S1).filter((l) => (l as { t: string }).t === 'session')).toHaveLength(1);
  });

  it('recovers the turns before a line a crash cut in half', () => {
    store.append(S1, '/repo', { t: 'message', message: msg('a', 'hi') });
    writeFileSync(join(dir, `${S1}.jsonl`), '{"t":"message","mess', { flag: 'a' });

    const replay = store.load(S1);

    expect(replay.messages.map((m) => m.id)).toEqual(['a']);
    expect(replay.skipped).toBe(1);
  });

  // The thread is on screen either way; an unwritable session must not take
  // the turn down with it.
  it('does not throw when the path cannot be written', () => {
    const path = join(dir, 'blocked');
    mkdirSync(join(path, `${S1}.jsonl`), { recursive: true });
    const blocked = new AgentSessionStore(path);

    expect(() =>
      blocked.append(S1, '/repo', { t: 'message', message: msg('a', 'hi') })
    ).not.toThrow();
    expect(blocked.load(S1).messages).toEqual([]);
  });
});

describe('AgentSessionStore.list', () => {
  // The folder is recorded inside each file, so a pane's list is the set of
  // files that say they belong to it - not everything in the directory.
  it('returns only the sessions started in the folder asked about', () => {
    store.append(S1, '/repo', { t: 'message', message: msg('a', 'in repo') });
    store.append(S2, '/other', { t: 'message', message: msg('b', 'elsewhere') });
    store.append(S3, '/repo', { t: 'message', message: msg('c', 'also repo') });

    expect(
      store
        .list('/repo')
        .map((s) => s.id)
        .sort()
    ).toEqual([S1, S3]);
    expect(store.list('/other').map((s) => s.id)).toEqual([S2]);
  });

  it('puts the most recently used session first', () => {
    store.append(OLD, '/repo', { t: 'message', message: msg('a', 'first') });
    store.append(NEW, '/repo', { t: 'message', message: msg('b', 'second') });
    // An append is the only thing that touches these files, so the mtime is
    // what "last used" means. Set them apart explicitly rather than trusting
    // two writes a millisecond apart to land on different stamps.
    utimesSync(join(dir, `${OLD}.jsonl`), new Date(1000), new Date(1000));
    utimesSync(join(dir, `${NEW}.jsonl`), new Date(9000), new Date(9000));

    expect(store.list('/repo').map((s) => s.id)).toEqual([NEW, OLD]);
  });

  it('names a session by its title, falling back to what was said first', () => {
    store.append(TITLED, '/repo', { t: 'message', message: msg('a', 'the question') });
    store.append(TITLED, '/repo', { t: 'title', title: 'The Question' });
    store.append(BARE, '/repo', { t: 'message', message: msg('b', 'no title here') });

    const byId = new Map(store.list('/repo').map((s) => [s.id, s]));

    expect(byId.get(TITLED)).toMatchObject({
      title: 'The Question',
      firstUserText: 'the question'
    });
    expect(byId.get(BARE)).toMatchObject({ title: null, firstUserText: 'no title here' });
  });

  it('is empty rather than an error before anything has been written', () => {
    expect(new AgentSessionStore(join(dir, 'nothing-here')).list('/repo')).toEqual([]);
  });

  // One bad file in the directory should cost that file, not the whole list.
  it('skips what it cannot make sense of and lists the rest', () => {
    store.append(GOOD, '/repo', { t: 'message', message: msg('a', 'fine') });
    writeFileSync(join(dir, 'junk.jsonl'), 'not a session at all\n');
    mkdirSync(join(dir, 'unreadable.jsonl'));

    expect(store.list('/repo').map((s) => s.id)).toEqual([GOOD]);
  });
});

describe('AgentSessionStore.delete', () => {
  it('removes the session and leaves the others alone', () => {
    store.append(S1, '/repo', { t: 'message', message: msg('a', 'hi') });
    store.append(S2, '/repo', { t: 'message', message: msg('b', 'hi') });

    expect(store.delete(S1)).toBe(true);
    expect(store.list('/repo').map((s) => s.id)).toEqual([S2]);
  });

  // Asking for a session to be gone that is already gone is the outcome the
  // caller wanted, not a failure to report to them.
  it('counts a session that was never there as removed', () => {
    expect(store.delete(GONE)).toBe(true);
  });
});
