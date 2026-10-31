import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { IPty } from 'node-pty';
import { typeWhenReady } from '../pty-manager';

vi.mock('../logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })
}));

type FakeShell = {
  proc: IPty;
  print: () => void;
  exit: () => void;
  /** Names the process in the foreground. */
  run: (name: string) => void;
  typed: string[];
};

/** A shell that prints when told to, and records what is typed into it. */
function fakeShell(): FakeShell {
  let onData: (() => void) | null = null;
  let onExit: (() => void) | null = null;
  let foreground = 'zsh';
  const typed: string[] = [];
  const proc = {
    get process() {
      return foreground;
    },
    onData: (cb: () => void) => {
      onData = cb;
      return { dispose: () => (onData = null) };
    },
    onExit: (cb: () => void) => {
      onExit = cb;
      return { dispose: () => (onExit = null) };
    },
    write: (text: string) => typed.push(text)
  };
  return {
    proc: proc as unknown as IPty,
    print: () => onData?.(),
    exit: () => onExit?.(),
    run: (name) => (foreground = name),
    typed
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('typeWhenReady', () => {
  it('types once the shell has printed and then gone quiet', () => {
    const shell = fakeShell();
    typeWhenReady(shell.proc, 'npm install');

    shell.print();
    vi.advanceTimersByTime(300);
    shell.print();
    vi.advanceTimersByTime(300);
    expect(shell.typed).toEqual([]);

    vi.advanceTimersByTime(100);
    expect(shell.typed).toEqual(['npm install\r']);
  });

  it('types each line with Enter, and only once', () => {
    const shell = fakeShell();
    typeWhenReady(shell.proc, 'npm install\nnpm run build');

    shell.print();
    vi.advanceTimersByTime(400);
    shell.print();
    vi.advanceTimersByTime(10_000);

    expect(shell.typed).toEqual(['npm install\r', 'npm run build\r']);
  });

  it('holds the next line while the line before still runs, even with no output', () => {
    const shell = fakeShell();
    typeWhenReady(shell.proc, 'npm install\nclaude');

    shell.print();
    vi.advanceTimersByTime(400);
    shell.run('node');
    vi.advanceTimersByTime(60_000);
    expect(shell.typed).toEqual(['npm install\r']);

    shell.run('zsh');
    vi.advanceTimersByTime(200);
    expect(shell.typed).toEqual(['npm install\r', 'claude\r']);
  });

  it('types the next line after quiet alone when the foreground name never changes', () => {
    const shell = fakeShell();
    typeWhenReady(shell.proc, 'npm install\nclaude');

    shell.print();
    vi.advanceTimersByTime(400);
    shell.print();
    vi.advanceTimersByTime(300);
    expect(shell.typed).toEqual(['npm install\r']);

    vi.advanceTimersByTime(100);
    expect(shell.typed).toEqual(['npm install\r', 'claude\r']);
  });

  it('drops the lines not typed yet when stopped', () => {
    const shell = fakeShell();
    const stop = typeWhenReady(shell.proc, 'npm install\nclaude');

    shell.print();
    vi.advanceTimersByTime(400);
    stop();
    shell.print();
    vi.advanceTimersByTime(20_000);

    expect(shell.typed).toEqual(['npm install\r']);
  });

  it('types anyway when the shell never goes quiet', () => {
    const shell = fakeShell();
    typeWhenReady(shell.proc, 'make');

    for (let i = 0; i < 40; i++) {
      shell.print();
      vi.advanceTimersByTime(250);
    }

    expect(shell.typed).toEqual(['make\r']);
  });

  it('types nothing into a shell that exited first', () => {
    const shell = fakeShell();
    typeWhenReady(shell.proc, 'make');

    shell.print();
    shell.exit();
    vi.advanceTimersByTime(20_000);

    expect(shell.typed).toEqual([]);
  });
});
