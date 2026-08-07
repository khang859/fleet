import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearCreatedPty, draftInto, shellIsReady } from '../use-terminal';

/**
 * A command handed to the user has to land on a prompt.
 *
 * A PTY exists a good while before the shell inside it is ready to be typed
 * at, and text arriving in that window is echoed by the tty and then drawn
 * again by the shell's line editor - the command appears twice, once stranded
 * above the prompt. So a draft waits for the shell to say something first.
 */

const input = vi.fn();

beforeEach(() => {
  vi.useFakeTimers();
  input.mockClear();
  Object.defineProperty(globalThis, 'window', {
    value: { fleet: { pty: { input } } },
    writable: true,
    configurable: true
  });
});

afterEach(() => {
  // Each test leaves its pane where it found it: readiness is module state.
  vi.useRealTimers();
});

describe('draftInto', () => {
  it('waits for the shell before typing', () => {
    draftInto('pane-1', 'gh auth login');

    expect(input).not.toHaveBeenCalled();
    clearCreatedPty('pane-1');
  });

  it('types once the shell has drawn its prompt', () => {
    draftInto('pane-2', 'gh auth login');
    shellIsReady('pane-2');
    vi.advanceTimersByTime(100);

    expect(input).toHaveBeenCalledWith({ paneId: 'pane-2', data: '\x05\x15gh auth login' });
    clearCreatedPty('pane-2');
  });

  it('types anyway when a shell already at its prompt has nothing left to say', () => {
    draftInto('pane-3', 'gh auth login');
    vi.advanceTimersByTime(3_000);

    expect(input).toHaveBeenCalledWith({ paneId: 'pane-3', data: '\x05\x15gh auth login' });
    clearCreatedPty('pane-3');
  });

  it('types straight into a shell that has been running a while', () => {
    shellIsReady('pane-4');

    draftInto('pane-4', 'gh auth login');

    expect(input).toHaveBeenCalledWith({ paneId: 'pane-4', data: '\x05\x15gh auth login' });
    clearCreatedPty('pane-4');
  });

  // The first command is still on the prompt: the user has not run it yet.
  it('clears the line rather than typing onto the end of the last command', () => {
    shellIsReady('pane-6');

    draftInto('pane-6', 'gh auth login');
    draftInto('pane-6', 'sudo -v');

    expect(input).toHaveBeenLastCalledWith({ paneId: 'pane-6', data: '\x05\x15sudo -v' });
    clearCreatedPty('pane-6');
  });

  it('leaves nothing behind to type twice', () => {
    draftInto('pane-5', 'gh auth login');
    shellIsReady('pane-5');
    vi.advanceTimersByTime(3_000);

    expect(input).toHaveBeenCalledTimes(1);
    clearCreatedPty('pane-5');
  });
});
