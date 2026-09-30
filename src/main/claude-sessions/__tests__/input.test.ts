import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ClaudeSession, ClaudeSessionChange } from '../../../shared/claude-sessions';
import {
  ACK_TIMEOUT_MS,
  cleanPrompt,
  PromptInput,
  QUIET_MS,
  SUBMIT_DELAY_MS,
  TYPE_CHUNK_CHARS,
  TYPE_CHUNK_GAP_MS
} from '../input';

const PANE = 'pane-1';

function session(over: Partial<ClaudeSession> = {}): ClaudeSession {
  return {
    sessionId: 's1',
    paneId: PANE,
    epoch: 0,
    cwd: '/work',
    projectName: 'work',
    phase: 'waitingForInput',
    waitingKind: 'prompt',
    phaseSince: 0,
    transcriptPath: null,
    configDir: null,
    pendingPermissions: [],
    lastActivity: 0,
    createdAt: 0,
    ...over
  };
}

describe('PromptInput', () => {
  let current: ClaudeSession | undefined;
  let now: number;
  let writes: string[];
  let sleeps: number[];
  let noted: Array<{ origin: string; text: string }>;
  let listeners: Set<(change: ClaudeSessionChange) => void>;
  let ackOnSubmit: boolean;
  let input: PromptInput;

  const emit = (event: string, s = current): void => {
    for (const l of [...listeners]) {
      l({
        sessionId: s?.sessionId ?? 's1',
        session: s ?? null,
        event: { seq: 1, sessionId: 's1', at: now, event, status: '', phase: 'processing' }
      });
    }
  };

  beforeEach(() => {
    vi.useFakeTimers();
    current = session();
    now = 100_000;
    writes = [];
    sleeps = [];
    noted = [];
    listeners = new Set();
    ackOnSubmit = true;
    input = new PromptInput({
      session: (id) => (current?.sessionId === id ? current : undefined),
      noteInput: (_id, origin, text) => noted.push({ origin, text }),
      subscribe: (l) => {
        listeners.add(l);
        return () => listeners.delete(l);
      },
      write: (_pane, data) => {
        writes.push(data);
        // Claude Code acknowledges the submit with UserPromptSubmit.
        if (data === '\r' && ackOnSubmit) emit('UserPromptSubmit');
      },
      now: () => now,
      sleep: async (ms) => {
        sleeps.push(ms);
        return Promise.resolve();
      }
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('types the prompt, submits it, and reports the acknowledgement', async () => {
    const result = await input.send('s1', '[orchestrator] Run the tests', 'orchestrator');
    expect(result).toEqual({ ok: true, confirmed: true, text: '[orchestrator] Run the tests' });
    expect(writes).toEqual(['[orchestrator] Run the tests', '\r']);
    expect(sleeps).toEqual([SUBMIT_DELAY_MS]);
    expect(noted).toEqual([{ origin: 'orchestrator', text: '[orchestrator] Run the tests' }]);
    expect(listeners.size).toBe(1); // only its own draft listener is left
  });

  it('types a long prompt in chunks small enough not to read as a paste', async () => {
    const text = `${'a'.repeat(300)}\n${'b'.repeat(100)}`;
    await input.send('s1', text, 'user');
    const typed = writes.slice(0, -1);
    expect(typed.join('')).toBe(text);
    expect(typed.every((w) => w.length <= TYPE_CHUNK_CHARS)).toBe(true);
    expect(typed).toHaveLength(Math.ceil(text.length / TYPE_CHUNK_CHARS));
    expect(sleeps).toEqual([
      TYPE_CHUNK_GAP_MS,
      TYPE_CHUNK_GAP_MS,
      TYPE_CHUNK_GAP_MS,
      SUBMIT_DELAY_MS
    ]);
  });

  it('never splits a character that takes two UTF-16 units', async () => {
    const text = '😀'.repeat(TYPE_CHUNK_CHARS + 1);
    await input.send('s1', text, 'user');
    expect(writes[0]).toBe('😀'.repeat(TYPE_CHUNK_CHARS));
    expect(writes[1]).toBe('😀');
  });

  it('reports a submit Claude Code did not acknowledge as not confirmed', async () => {
    ackOnSubmit = false;
    const pending = input.send('s1', 'hello', 'user');
    await vi.advanceTimersByTimeAsync(ACK_TIMEOUT_MS - 1);
    let settled = false;
    void pending.then(() => (settled = true));
    await Promise.resolve();
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await pending).toEqual({ ok: true, confirmed: false, text: 'hello' });
    expect(listeners.size).toBe(1);
  });

  it.each([
    [{ phase: 'processing' as const, waitingKind: null }, 'it is working on a turn'],
    [
      { phase: 'waitingForApproval' as const, waitingKind: null },
      'waiting for a permission answer'
    ],
    [{ phase: 'waitingForInput' as const, waitingKind: 'question' as const }, 'question dialog'],
    [{ phase: 'compacting' as const, waitingKind: null }, 'compacting'],
    [{ phase: 'starting' as const, waitingKind: null }, 'not finished starting'],
    [{ phase: 'ended' as const, waitingKind: null }, 'it has ended']
  ])('refuses a session that is not waiting for a prompt (%o)', async (over, reason) => {
    current = session(over);
    const result = await input.send('s1', 'hello', 'orchestrator');
    expect(result).toEqual({ ok: false, reason: expect.stringContaining(reason) });
    expect(writes).toEqual([]);
    expect(noted).toEqual([]);
  });

  it('refuses an unknown session', async () => {
    expect(await input.send('nope', 'hello', 'user')).toEqual({
      ok: false,
      reason: expect.stringContaining('not running in a Fleet pane')
    });
  });

  it('refuses while the user has unsent text in the pane, until it is sent or cleared', async () => {
    input.onUserInput(PANE, 'half a thou');
    now += QUIET_MS;
    expect(await input.send('s1', 'hello', 'orchestrator')).toEqual({
      ok: false,
      reason: expect.stringContaining('typed text in that pane and not sent it')
    });

    for (const clear of ['\r', '\x03', '\x15']) {
      input.onUserInput(PANE, 'draft');
      input.onUserInput(PANE, clear);
      now += QUIET_MS;
      expect((await input.send('s1', 'hello', 'orchestrator')).ok).toBe(true);
    }
  });

  it('counts the draft by what comes last in one chunk of input', async () => {
    input.onUserInput(PANE, 'sent\rnew draft');
    now += QUIET_MS;
    expect((await input.send('s1', 'hello', 'user')).ok).toBe(false);
  });

  it('takes a UserPromptSubmit as the draft being sent', async () => {
    input.onUserInput(PANE, 'typed and submitted some other way');
    now += QUIET_MS;
    emit('UserPromptSubmit');
    expect((await input.send('s1', 'hello', 'user')).ok).toBe(true);
  });

  it('refuses while the user is typing, even keys that leave no draft', async () => {
    input.onUserInput(PANE, '\x1b[A'); // arrow up
    now += QUIET_MS - 1;
    expect(await input.send('s1', 'hello', 'user')).toEqual({
      ok: false,
      reason: expect.stringContaining('the user is typing')
    });
    now += 1;
    expect((await input.send('s1', 'hello', 'user')).ok).toBe(true);
  });

  it('does not count what the terminal reports on its own as typing', async () => {
    for (const report of [
      '\x1b[I',
      '\x1b[O',
      '\x1b[<0;10;5M',
      '\x1b[12;5R',
      '\x1b[?1;2c',
      '\x1b]11;rgb:0000/0000/0000\x07'
    ]) {
      input.onUserInput(PANE, report);
    }
    expect((await input.send('s1', 'hello', 'user')).ok).toBe(true);
  });

  it('refuses a second prompt while one is being typed into the same session', async () => {
    ackOnSubmit = false;
    const first = input.send('s1', 'first', 'user');
    expect(await input.send('s1', 'second', 'user')).toEqual({
      ok: false,
      reason: expect.stringContaining('another prompt is being typed')
    });
    await vi.advanceTimersByTimeAsync(ACK_TIMEOUT_MS);
    await first;
  });

  it('refuses an empty prompt and one ending in a backslash', async () => {
    expect((await input.send('s1', ' \t\x1b ', 'user')).ok).toBe(false);
    expect(await input.send('s1', 'see C:\\', 'user')).toEqual({
      ok: false,
      reason: expect.stringContaining('line break')
    });
    expect(writes).toEqual([]);
  });

  it('forgets a closed pane', async () => {
    input.onUserInput(PANE, 'draft');
    input.forgetPane(PANE);
    expect((await input.send('s1', 'hello', 'user')).ok).toBe(true);
  });
});

describe('cleanPrompt', () => {
  it('types line breaks as LF and a tab as four spaces, as Claude Code records them', () => {
    expect(cleanPrompt('a\r\nb\rc\td')).toBe('a\nb\nc    d');
  });

  it('drops control characters that would act as keys', () => {
    expect(cleanPrompt('a\x1b[2Jb\x03c\x7fd\x9be')).toBe('a[2Jbcde');
  });

  it('trims', () => {
    expect(cleanPrompt('\n  hi  \n')).toBe('hi');
  });
});
