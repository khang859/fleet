import { describe, expect, it } from 'vitest';
import type { AgentMessage } from '../agent-types';
import {
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

const msg = (id: string, role: AgentMessage['role'], content: string): AgentMessage => ({
  id,
  role,
  content,
  reasoning: '',
  reasoningMs: null,
  toolCalls: []
});

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
    expect(replaySession('')).toEqual({
      messages: [],
      contextTokens: null,
      cwd: null,
      skipped: 0
    });
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

  // Version 1 files were written before the agent had tools, so their messages
  // carry no `toolCalls` at all. They are ordinary sessions and have to open.
  it('replays a session written before there were tools', () => {
    const replay = replaySession(
      '{"t":"session","version":1,"id":"s-1","cwd":"/repo","createdAt":"2026-08-05T10:00:00.000Z"}\n' +
        '{"t":"message","message":{"id":"a","role":"user","content":"hi","reasoning":"","reasoningMs":null}}\n'
    );

    expect(replay.skipped).toBe(0);
    expect(replay.messages[0]).toMatchObject({ id: 'a', toolCalls: [] });
  });

  it('keeps the tool calls a turn made', () => {
    const message = {
      ...msg('a', 'assistant', 'here'),
      toolCalls: [
        {
          id: 'call_1',
          name: 'read',
          args: '{"path":"a.ts"}',
          result: 'a.ts lines 1-1',
          error: null,
          summary: '1 line'
        }
      ]
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
});
