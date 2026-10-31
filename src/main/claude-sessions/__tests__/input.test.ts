import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ClaudeSession, ClaudeSessionChange } from '../../../shared/claude-sessions';
import {
  ACK_TIMEOUT_MS,
  cleanPrompt,
  EVA_PASTE_MAX_BYTES,
  PROMPT_MISMATCH,
  PromptInput,
  QUIET_MS,
  SUBMIT_DELAY_MS,
  TYPE_CHUNK_CHARS,
  TYPE_CHUNK_GAP_MS
} from '../input';
import { hashPrompt } from '../registry';

const PANE = 'pane-1';

function session(over: Partial<ClaudeSession> = {}): ClaudeSession {
  return {
    sessionId: 's1',
    runtime: 'claude',
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
  let listeners: Set<(change: ClaudeSessionChange) => void>;
  let ackOnSubmit: boolean;
  /** Sessions whose fleet-bridge mod is waiting for a prompt, and what it was handed. */
  let waiting: Set<string>;
  let delivered: string[];
  let input: PromptInput;

  /** What Claude Code says it got on submit: no hash, as older hook binaries send. */
  let submitHash: (typed: string) => string | undefined;
  const emit = (event: string, s = current, promptHash?: string): void => {
    for (const l of [...listeners]) {
      l({
        sessionId: s?.sessionId ?? 's1',
        session: s ?? null,
        event: {
          seq: 1,
          sessionId: 's1',
          at: now,
          event,
          status: '',
          phase: 'processing',
          promptHash
        }
      });
    }
  };

  beforeEach(() => {
    vi.useFakeTimers();
    current = session();
    now = 100_000;
    writes = [];
    sleeps = [];
    listeners = new Set();
    ackOnSubmit = true;
    submitHash = () => undefined;
    waiting = new Set();
    delivered = [];
    let typed = '';
    input = new PromptInput({
      session: (id) => (current?.sessionId === id ? current : undefined),
      subscribe: (l) => {
        listeners.add(l);
        return () => listeners.delete(l);
      },
      write: (_pane, data) => {
        writes.push(data);
        if (data !== '\r') {
          typed += data;
          return;
        }
        // Claude Code acknowledges the submit with UserPromptSubmit.
        if (ackOnSubmit) emit('UserPromptSubmit', current, submitHash(typed));
        typed = '';
      },
      bridge: {
        has: (id) => waiting.has(id),
        deliver: (id, text) => {
          if (!waiting.delete(id)) return false;
          delivered.push(text);
          // The mod submits it, and Claude Code acknowledges as for a typed one.
          if (ackOnSubmit) emit('UserPromptSubmit', current, submitHash(text));
          return true;
        }
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

  it('pastes the prompt into eva as one message, then submits it', async () => {
    current = session({ runtime: 'eva' });
    const text = `${'Fix the login form. '.repeat(10)}\n- Keep it small.`;
    const result = await input.send('s1', text);
    expect(result).toEqual({ ok: true, confirmed: true, text });
    expect(writes).toEqual([`\x1b[200~${text}\x1b[201~`, '\r']);
    expect(sleeps).toEqual([SUBMIT_DELAY_MS]);

    writes = [];
    const long = await input.send('s1', 'x'.repeat(EVA_PASTE_MAX_BYTES + 1));
    expect(long).toEqual({
      ok: false,
      reason: 'Not sent: the prompt is longer than eva takes in one message.'
    });
    expect(writes).toEqual([]);
  });

  it('types the prompt, submits it, and reports the acknowledgement', async () => {
    const result = await input.send('s1', 'Run the tests');
    expect(result).toEqual({ ok: true, confirmed: true, text: 'Run the tests' });
    expect(writes).toEqual(['Run the tests', '\r']);
    expect(sleeps).toEqual([SUBMIT_DELAY_MS]);
    expect(listeners.size).toBe(1); // only its own draft listener is left
  });

  it('hands the prompt to a waiting fleet-bridge mod instead of typing it', async () => {
    waiting.add('s1');
    submitHash = (text) => hashPrompt(text);
    const text = `${'a'.repeat(300)}\n${'b'.repeat(100)}`;
    expect(await input.send('s1', text)).toEqual({
      ok: true,
      confirmed: true,
      text
    });
    expect(delivered).toEqual([text]);
    expect(writes).toEqual([]);
    expect(sleeps).toEqual([]);
  });

  it('lets a waiting mod take a prompt while the user has a draft in the pane', async () => {
    waiting.add('s1');
    input.onUserInput(PANE, 'half a thou');
    expect((await input.send('s1', 'hello')).ok).toBe(true);
    expect(delivered).toEqual(['hello']);
    expect(writes).toEqual([]);
  });

  it('types a long prompt in chunks small enough not to read as a paste', async () => {
    const text = `${'a'.repeat(300)}\n${'b'.repeat(100)}`;
    await input.send('s1', text);
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
    await input.send('s1', text);
    expect(writes[0]).toBe('😀'.repeat(TYPE_CHUNK_CHARS));
    expect(writes[1]).toBe('😀');
  });

  it('reports a submit Claude Code did not acknowledge as not confirmed', async () => {
    ackOnSubmit = false;
    const pending = input.send('s1', 'hello');
    await vi.advanceTimersByTimeAsync(ACK_TIMEOUT_MS - 1);
    let settled = false;
    void pending.then(() => (settled = true));
    await Promise.resolve();
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await pending).toEqual({ ok: true, confirmed: false, text: 'hello' });
    expect(listeners.size).toBe(1);
  });

  it('confirms a prompt Claude Code got as it was typed', async () => {
    submitHash = (typed) => hashPrompt(typed);
    expect(await input.send('s1', '  Run the tests\n')).toEqual({
      ok: true,
      confirmed: true,
      text: 'Run the tests'
    });
  });

  it('fails a send whose prompt arrived different, and does not type it again', async () => {
    submitHash = () => hashPrompt('Run the test');
    const pending = input.send('s1', 'Run the tests');
    await vi.advanceTimersByTimeAsync(ACK_TIMEOUT_MS);
    expect(await pending).toEqual({ ok: false, reason: PROMPT_MISMATCH });
    expect(writes).toEqual(['Run the tests', '\r']);
    expect(listeners.size).toBe(1);
  });

  it('waits past a prompt Claude Code submits on its own for the one typed', async () => {
    ackOnSubmit = false;
    const pending = input.send('s1', 'Run the tests');
    await Promise.resolve();
    emit('UserPromptSubmit', current, hashPrompt('A background agent finished.'));
    emit('UserPromptSubmit', current, hashPrompt('Run the tests'));
    expect(await pending).toEqual({ ok: true, confirmed: true, text: 'Run the tests' });
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
    const result = await input.send('s1', 'hello');
    expect(result).toEqual({ ok: false, reason: expect.stringContaining(reason) });
    expect(writes).toEqual([]);
  });

  it('refuses an unknown session', async () => {
    expect(await input.send('nope', 'hello')).toEqual({
      ok: false,
      reason: expect.stringContaining('not running in a Fleet pane')
    });
  });

  it('refuses while the user has unsent text in the pane, until it is sent or cleared', async () => {
    input.onUserInput(PANE, 'half a thou');
    now += QUIET_MS;
    expect(await input.send('s1', 'hello')).toEqual({
      ok: false,
      reason: expect.stringContaining('typed text in that pane and not sent it')
    });

    for (const clear of ['\r', '\x03', '\x15']) {
      input.onUserInput(PANE, 'draft');
      input.onUserInput(PANE, clear);
      now += QUIET_MS;
      expect((await input.send('s1', 'hello')).ok).toBe(true);
    }
  });

  it('counts the draft by what comes last in one chunk of input', async () => {
    input.onUserInput(PANE, 'sent\rnew draft');
    now += QUIET_MS;
    expect((await input.send('s1', 'hello')).ok).toBe(false);
  });

  it('takes a UserPromptSubmit as the draft being sent', async () => {
    input.onUserInput(PANE, 'typed and submitted some other way');
    now += QUIET_MS;
    emit('UserPromptSubmit');
    expect((await input.send('s1', 'hello')).ok).toBe(true);
  });

  it('refuses while the user is typing, even keys that leave no draft', async () => {
    input.onUserInput(PANE, '\x1b[A'); // arrow up
    now += QUIET_MS - 1;
    expect(await input.send('s1', 'hello')).toEqual({
      ok: false,
      reason: expect.stringContaining('the user is typing')
    });
    now += 1;
    expect((await input.send('s1', 'hello')).ok).toBe(true);
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
    expect((await input.send('s1', 'hello')).ok).toBe(true);
  });

  it('refuses a second prompt while one is being typed into the same session', async () => {
    ackOnSubmit = false;
    const first = input.send('s1', 'first');
    expect(await input.send('s1', 'second')).toEqual({
      ok: false,
      reason: expect.stringContaining('another prompt is being typed')
    });
    await vi.advanceTimersByTimeAsync(ACK_TIMEOUT_MS);
    await first;
  });

  it('refuses an empty prompt and one ending in a backslash', async () => {
    expect((await input.send('s1', ' \t\x1b ')).ok).toBe(false);
    expect(await input.send('s1', 'see C:\\')).toEqual({
      ok: false,
      reason: expect.stringContaining('line break')
    });
    expect(writes).toEqual([]);
  });

  it('forgets a closed pane', async () => {
    input.onUserInput(PANE, 'draft');
    input.forgetPane(PANE);
    expect((await input.send('s1', 'hello')).ok).toBe(true);
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
