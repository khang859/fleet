import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentImageStore } from '../image-store';
import { AgentSessionStore } from '../session-store';
import { SCRATCH_DIR } from '../scratch-dir';
import { emptyReplay } from '../../../shared/agent-session';
import { EMPTY_SESSION_SPEND, type AgentSessionSpend } from '../../../shared/agent-spend';
import {
  EMPTY_AGENT_USAGE,
  textMessage,
  type AgentMessage,
  type AgentTurnUsage
} from '../../../shared/agent-types';

const msg = (id: string, content: string): AgentMessage => textMessage(id, 'user', content);

/** A running total, as a turn would have left it. */
const spendOf = (costUsd: number): AgentSessionSpend => ({
  ...EMPTY_SESSION_SPEND,
  costUsd,
  promptTokens: 900,
  completionTokens: 100,
  calls: 3
});

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
  it('lists individual scratch chats together with legacy shared-folder chats', () => {
    store.append(S1, SCRATCH_DIR, { t: 'message', message: msg('a', 'legacy') });
    store.append(S2, join(SCRATCH_DIR, S2), { t: 'message', message: msg('b', 'new') });
    store.append(S3, `${SCRATCH_DIR}-notes`, { t: 'message', message: msg('c', 'project') });
    expect(
      store
        .list(join(SCRATCH_DIR, S2))
        .map((s) => s.id)
        .sort()
    ).toEqual([S1, S2]);
    expect(
      store
        .list(SCRATCH_DIR)
        .map((s) => s.id)
        .sort()
    ).toEqual([S1, S2]);
    expect(store.list(`${SCRATCH_DIR}-notes`).map((s) => s.id)).toEqual([S3]);
  });

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

/*
 * A subagent reports back long after the pane that dispatched it moved on, so
 * the bill arrives for a session nothing is adding up. The total is cumulative
 * and lives in the log, which is why the adding happens here.
 */
describe('AgentSessionStore.addSpend', () => {
  const usage = (costUsd: number): AgentTurnUsage => ({
    billed: { ...EMPTY_AGENT_USAGE, costUsd, promptTokens: 100, completionTokens: 10 },
    contextTokens: 110,
    calls: 1,
    model: 'anthropic/claude-sonnet-4.5',
    provider: 'Anthropic'
  });

  it('adds to what the session had already spent', () => {
    store.append(S1, '/repo', { t: 'message', message: msg('a', 'hi') });
    store.append(S1, '/repo', { t: 'spend', total: spendOf(0.5) });

    store.addSpend(S1, '/repo', usage(0.25));

    expect(store.load(S1).spend).toMatchObject({ costUsd: 0.75, calls: 4 });
  });

  it('starts from nothing for a session that has never been billed', () => {
    store.append(S1, '/repo', { t: 'message', message: msg('a', 'hi') });

    store.addSpend(S1, '/repo', usage(0.25));

    expect(store.load(S1).spend).toMatchObject({ costUsd: 0.25, calls: 1 });
  });

  // Two children of the same closed session finishing at once. Each read sees
  // the write before it, which is the whole reason this is not done in a pane.
  it('does not lose one of two bills that arrive together', () => {
    store.append(S1, '/repo', { t: 'message', message: msg('a', 'hi') });

    store.addSpend(S1, '/repo', usage(0.25));
    store.addSpend(S1, '/repo', usage(0.25));

    expect(store.load(S1).spend).toMatchObject({ costUsd: 0.5, calls: 2 });
  });

  // Same rule as every other event: only something that was said starts a file,
  // so a bill for a deleted session does not put it back in the list.
  it('writes nothing for a session that is gone', () => {
    store.addSpend(GONE, '/repo', usage(0.25));

    expect(existsSync(join(dir, `${GONE}.jsonl`))).toBe(false);
  });

  /*
   * The total is read from the end of the file rather than by replaying it, so
   * that a turn's cost does not grow with the length of the conversation. Past
   * the window this switches to, a session that kept reading the head would
   * find a stale total and undercount everything after it.
   */
  it('keeps adding to the total in a conversation far past the tail window', () => {
    store.append(S1, '/repo', { t: 'message', message: msg('a', 'hi') });
    store.append(S1, '/repo', { t: 'spend', total: spendOf(0.5) });
    for (let i = 0; i < 20; i += 1) {
      store.append(S1, '/repo', { t: 'message', message: msg(`pad-${i}`, 'x'.repeat(10_000)) });
    }

    store.addSpend(S1, '/repo', usage(0.25));

    expect(store.load(S1).spend).toMatchObject({ costUsd: 0.75, calls: 4 });
  });

  /*
   * One turn long enough to push the last total out of the window. Reading the
   * missing total as zero would silently reset what the user has spent, so this
   * case goes back to the whole file rather than guessing.
   */
  it('falls back to the whole file when one turn is longer than the window', () => {
    store.append(S1, '/repo', { t: 'message', message: msg('a', 'hi') });
    store.append(S1, '/repo', { t: 'spend', total: spendOf(0.5) });
    store.append(S1, '/repo', { t: 'message', message: msg('huge', 'x'.repeat(200_000)) });

    store.addSpend(S1, '/repo', usage(0.25));

    expect(store.load(S1).spend).toMatchObject({ costUsd: 0.75, calls: 4 });
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

  it('reports what a session cost, and nothing at all for one from before', () => {
    store.append(S1, '/repo', { t: 'message', message: msg('a', 'hi') });
    store.append(S1, '/repo', { t: 'spend', total: spendOf(0.02) });
    store.append(S2, '/repo', { t: 'message', message: msg('b', 'hi') });

    const byId = new Map(store.list('/repo').map((s) => [s.id, s]));

    expect(byId.get(S1)?.spend).toMatchObject({ costUsd: 0.02, calls: 3 });
    // Not a zero. A session written before any of this existed has no answer,
    // and printing one would be inventing it.
    expect(byId.get(S2)?.spend).toBeNull();
  });

  /*
   * The head scan stops well short of a long conversation's end, and the total
   * is the last line rather than the first. A long session that reported no
   * cost would be the one people most want the number for.
   */
  it('finds the total at the end of a conversation too long to scan', () => {
    store.append(S1, '/repo', { t: 'message', message: msg('a', 'the question') });
    store.append(S1, '/repo', { t: 'spend', total: spendOf(0.01) });
    // Comfortably past the 256KB the list reads from the front.
    for (let i = 0; i < 40; i += 1) {
      store.append(S1, '/repo', { t: 'message', message: msg(`pad-${i}`, 'x'.repeat(10_000)) });
    }
    store.append(S1, '/repo', { t: 'spend', total: spendOf(0.09) });

    expect(store.list('/repo')[0].spend).toMatchObject({ costUsd: 0.09 });
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

  /*
   * The pictures go with it. What the user attached lives outside the session
   * file - it has to, since a screenshot pasted into the composer never had a
   * file of its own - so a delete that only unlinked the JSONL would leave the
   * images the user thought they had deleted sitting on disk forever.
   */
  it('takes the images the conversation owned with it', () => {
    const images = join(dir, 'images');
    const attachments = join(dir, 'attachments');
    const withImages = new AgentSessionStore(
      dir,
      new AgentImageStore(images),
      new AgentImageStore(attachments)
    );
    withImages.append(S1, '/repo', { t: 'message', message: msg('a', 'hi') });
    const drawn = new AgentImageStore(images).save(S1, new Uint8Array([1]), 'image/png');
    const pasted = new AgentImageStore(attachments).save(S1, new Uint8Array([2]), 'image/png');

    expect(withImages.delete(S1)).toBe(true);

    expect(existsSync(drawn)).toBe(false);
    expect(existsSync(pasted)).toBe(false);
  });

  /*
   * Not every conversation ends by being deleted. A pane from before sessions
   * existed filed its pictures under its own id and left them there for good,
   * and nothing was ever going to come back for them.
   */
  it('sweeps pictures whose conversation is gone, and leaves the rest alone', () => {
    const images = join(dir, 'images');
    const attachments = join(dir, 'attachments');
    const withImages = new AgentSessionStore(
      dir,
      new AgentImageStore(images),
      new AgentImageStore(attachments)
    );
    withImages.append(S1, '/repo', { t: 'message', message: msg('a', 'hi') });
    const kept = new AgentImageStore(images).save(S1, new Uint8Array([1]), 'image/png');
    const orphan = new AgentImageStore(attachments).save(GONE, new Uint8Array([2]), 'image/png');

    withImages.sweep();

    expect(existsSync(kept)).toBe(true);
    expect(existsSync(orphan)).toBe(false);
  });

  /*
   * A first run has no sessions folder at all. Reading that as "no conversation
   * owns anything" would throw away every picture on the machine.
   */
  it('sweeps nothing when there are no sessions to sweep against', () => {
    const images = join(dir, 'images');
    const kept = new AgentImageStore(images).save(S1, new Uint8Array([1]), 'image/png');

    // Both roots named, never defaulted: a store built with defaults points at
    // the real home folder, and this test's whole subject is what sweep does
    // when it cannot see any sessions.
    new AgentSessionStore(
      join(dir, 'not-here'),
      new AgentImageStore(images),
      new AgentImageStore(join(dir, 'attachments'))
    ).sweep();

    expect(existsSync(kept)).toBe(true);
  });
});
