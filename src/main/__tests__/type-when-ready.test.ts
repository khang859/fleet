import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { IPty } from 'node-pty';
import { typeWhenReady } from '../pty-manager';

vi.mock('../logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })
}));

/** A shell that prints when told to, and records what is typed into it. */
function fakeShell(): { proc: IPty; print: () => void; exit: () => void; typed: string[] } {
  let onData: (() => void) | null = null;
  let onExit: (() => void) | null = null;
  const typed: string[] = [];
  const proc = {
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

    expect(shell.typed).toEqual(['npm install\rnpm run build\r']);
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
