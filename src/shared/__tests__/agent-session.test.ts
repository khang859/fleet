import { describe, expect, it } from 'vitest';
import { textMessage, type AgentMessage } from '../agent-types';
import {
  emptyReplay,
  encodeEvent,
  replaySession,
  sessionHeader,
  SESSION_LOG_VERSION,
  type AgentSessionEvent
} from '../agent-session';

/**
 * Replay is the only thing standing between a session file and a transcript, so
 * every way a file can be odd - truncated by a crash, written by a version that
 * does not exist yet, compacted twice - has to end somewhere sensible rather
 * than in a thrown error or a silently wrong conversation.
 */

const msg = (id: string, role: AgentMessage['role'], content: string): AgentMessage =>
  textMessage(id, role, content);

const log = (...events: AgentSessionEvent[]): string => events.map(encodeEvent).join('');

const HEADER = sessionHeader('s-1', '/repo', '2026-08-05T10:00:00.000Z');

describe('replaySession', () => {
  it('rebuilds the transcript in the order it was written', () => {
    const replay = replaySession(
      log(
        HEADER,
        { t: 'message', message: msg('a', 'user', 'hi') },
        { t: 'message', message: msg('b', 'assistant', 'hello') },
        { t: 'context', tokens: 1939 }
      )
    );

    expect(replay.messages.map((m) => m.id)).toEqual(['a', 'b']);
    expect(replay.contextTokens).toBe(1939);
    expect(replay.cwd).toBe('/repo');
    expect(replay.skipped).toBe(0);
  });

  it('reads an empty file as an empty thread rather than failing', () => {
    expect(replaySession('')).toEqual(emptyReplay());
  });

  // Nothing has run a turn yet, so nothing may pretend to know the size.
  it('leaves the context unknown when no turn ever reported one', () => {
    expect(replaySession(log(HEADER)).contextTokens).toBeNull();
  });

  it('takes the last context reading, not the first', () => {
    const replay = replaySession(
      log(HEADER, { t: 'context', tokens: 10 }, { t: 'context', tokens: 4 })
    );

    expect(replay.contextTokens).toBe(4);
  });

  describe('compaction', () => {
    it('replaces the messages the summary stood in for, and keeps the rest', () => {
      const replay = replaySession(
        log(
          HEADER,
          { t: 'message', message: msg('a', 'user', 'one') },
          { t: 'message', message: msg('b', 'assistant', 'first') },
          { t: 'message', message: msg('c', 'user', 'two') },
          { t: 'message', message: msg('d', 'assistant', 'second') },
          { t: 'compact', summary: msg('s', 'summary', 'we talked'), keep: ['c', 'd'] }
        )
      );

      expect(replay.messages.map((m) => m.id)).toEqual(['s', 'c', 'd']);
    });

    // The folded-up turns stay in the file forever; replay must not resurrect
    // them just because a later event mentions the ones that survived.
    it('does not bring back turns an earlier compaction removed', () => {
      const replay = replaySession(
        log(
          HEADER,
          { t: 'message', message: msg('a', 'user', 'one') },
          { t: 'message', message: msg('b', 'assistant', 'first') },
          { t: 'compact', summary: msg('s1', 'summary', 'early'), keep: ['b'] },
          { t: 'message', message: msg('c', 'user', 'two') },
          { t: 'compact', summary: msg('s2', 'summary', 'later'), keep: ['c'] }
        )
      );

      expect(replay.messages.map((m) => m.id)).toEqual(['s2', 'c']);
    });

    it('drops a kept id that is not in the transcript instead of inventing one', () => {
      const replay = replaySession(
        log(
          HEADER,
          { t: 'message', message: msg('a', 'user', 'one') },
          { t: 'compact', summary: msg('s', 'summary', 'x'), keep: ['a', 'ghost'] }
        )
      );

      expect(replay.messages.map((m) => m.id)).toEqual(['s', 'a']);
    });
  });

  describe('damaged files', () => {
    // What a crash mid-append leaves behind: a line that stops in the middle.
    it('keeps everything before a truncated final line', () => {
      const contents = `${log(HEADER, {
        t: 'message',
        message: msg('a', 'user', 'hi')
      })}{"t":"message","mess`;

      const replay = replaySession(contents);

      expect(replay.messages.map((m) => m.id)).toEqual(['a']);
      expect(replay.skipped).toBe(1);
    });

    it('skips a line that is valid JSON but not an event we know', () => {
      const replay = replaySession(
        `${encodeEvent(HEADER)}{"t":"tool-call","name":"read"}\n${encodeEvent({
          t: 'message',
          message: msg('a', 'user', 'hi')
        })}`
      );

      expect(replay.messages.map((m) => m.id)).toEqual(['a']);
      expect(replay.skipped).toBe(1);
    });

    it('skips a message missing a field rather than replaying half of one', () => {
      const replay = replaySession(
        `${encodeEvent(HEADER)}{"t":"message","message":{"id":"a","role":"user","content":"hi"}}\n`
      );

      expect(replay.messages).toEqual([]);
      expect(replay.skipped).toBe(1);
    });

    it('tolerates blank lines without counting them as damage', () => {
      const replay = replaySession(`${encodeEvent(HEADER)}\n\n`);

      expect(replay.skipped).toBe(0);
    });
  });

  // Files written by earlier versions are ordinary sessions and have to open.
  // Version 1 knew nothing about tools; version 2 wrote the text in one field
  // and the calls in another, which is the ordering this replaces.
  describe('older files', () => {
    const V1 =
      '{"t":"session","version":1,"id":"s-1","cwd":"/repo","createdAt":"2026-08-05T10:00:00.000Z"}\n' +
      '{"t":"message","message":{"id":"a","role":"user","content":"hi","reasoning":"","reasoningMs":null}}\n';

    const V2 =
      '{"t":"session","version":2,"id":"s-1","cwd":"/repo","createdAt":"2026-08-05T10:00:00.000Z"}\n' +
      '{"t":"message","message":{"id":"a","role":"assistant","content":"here","reasoning":"","reasoningMs":null,' +
      '"toolCalls":[{"id":"call_1","name":"read","args":"{}","result":"a.ts lines 1-1","error":null,"summary":"1 line"}]}}\n';

    it('replays one written before there were tools', () => {
      const replay = replaySession(V1);

      expect(replay.skipped).toBe(0);
      expect(replay.messages[0]).toEqual(textMessage('a', 'user', 'hi'));
    });

    it('replays one written before messages had parts, text first', () => {
      const replay = replaySession(V2);

      expect(replay.skipped).toBe(0);
      expect(replay.messages[0].parts).toEqual([
        { type: 'text', text: 'here' },
        { type: 'tool', call: expect.objectContaining({ id: 'call_1' }) }
      ]);
    });

    // An empty content field was how a turn that only ran tools was written.
    it('leaves out the empty text of a turn that only used tools', () => {
      const replay = replaySession(V2.replace('"content":"here"', '"content":""'));

      expect(replay.messages[0].parts).toEqual([
        { type: 'tool', call: expect.objectContaining({ id: 'call_1' }) }
      ]);
    });
  });

  it('keeps what a turn said and did in the order it happened', () => {
    const call = {
      id: 'call_1',
      name: 'read',
      args: '{"path":"a.ts"}',
      result: 'a.ts lines 1-1',
      error: null,
      summary: '1 line'
    };
    const message: AgentMessage = {
      id: 'a',
      role: 'assistant',
      parts: [
        { type: 'text', text: 'Let me look.' },
        { type: 'tool', call },
        { type: 'text', text: 'It says 42.' }
      ],
      reasoning: '',
      reasoningMs: null
    };
    const replay = replaySession(log(HEADER, { t: 'message', message }));

    expect(replay.messages[0]).toEqual(message);
  });

  it('round-trips through the encoder', () => {
    const message = { ...msg('a', 'assistant', 'hello'), reasoning: 'hm', reasoningMs: 1200 };
    const replay = replaySession(log(HEADER, { t: 'message', message }));

    expect(replay.messages[0]).toEqual(message);
  });

  it('stamps the current version in the header', () => {
    expect(HEADER).toMatchObject({ t: 'session', version: SESSION_LOG_VERSION, cwd: '/repo' });
  });

  it('reads the title the session was given', () => {
    const replay = replaySession(log(HEADER, { t: 'title', title: 'Fix the parser' }));

    expect(replay.title).toBe('Fix the parser');
  });

  // A file written before titles existed is the common case, not an edge one:
  // every session on disk today is one.
  it('leaves the title unset when the log never named the session', () => {
    const replay = replaySession(log(HEADER, { t: 'message', message: msg('a', 'user', 'hi') }));

    expect(replay.title).toBeNull();
  });
});

/**
 * Summarizing reads the same file as replay, for a different question: what to
 * call this session and where it belongs, without rebuilding the conversation.
 */
describe('replaySession: what a listing reads', () => {
  it('reads the folder, the title and the opening line', () => {
    const replay = replaySession(
      log(
        HEADER,
        { t: 'message', message: msg('a', 'user', 'why does the parser drop tabs') },
        { t: 'message', message: msg('b', 'assistant', 'because…') },
        { t: 'title', title: 'Parser drops tabs' }
      )
    );

    expect(replay).toMatchObject({
      cwd: '/repo',
      title: 'Parser drops tabs',
      firstUserText: 'why does the parser drop tabs'
    });
  });

  /*
   * Why the opening line is captured as the log is read rather than taken from
   * the transcript at the end. Compaction *replaces* the messages it folds, so
   * the words a session opened with are gone from its transcript long before
   * they stop being the best name for it.
   */
  it('keeps the opening line of a session that has since been compacted', () => {
    const replay = replaySession(
      log(
        HEADER,
        { t: 'message', message: msg('a', 'user', 'the original question') },
        { t: 'message', message: msg('b', 'assistant', 'a long answer') },
        { t: 'message', message: msg('c', 'user', 'a later question') },
        { t: 'compact', summary: msg('s', 'summary', 'they discussed things'), keep: ['c'] }
      )
    );

    expect(replay.firstUserText).toBe('the original question');
    expect(replay.messages.map((m) => m.id)).toEqual(['s', 'c']);
  });

  it('takes the last title when a session was somehow named twice', () => {
    const replay = replaySession(
      log(HEADER, { t: 'title', title: 'first' }, { t: 'title', title: 'second' })
    );

    expect(replay.title).toBe('second');
  });

  /*
   * How something that is not a session log stays out of the list: the folder
   * is what the listing matches on, and a file with no header names none.
   */
  it('has no folder when the file has no header', () => {
    expect(replaySession('').cwd).toBeNull();
    expect(replaySession('not json\n{"t":"context","tokens":1}\n').cwd).toBeNull();
  });

  it('carries an empty opening line for a session that was never spoken in', () => {
    expect(replaySession(log(HEADER))).toMatchObject({ firstUserText: '', title: null });
  });
});
