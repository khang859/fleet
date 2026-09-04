import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { BrowserWindow } from 'electron';
import { QuitGuard } from '../quit-guard';
import { IPC_CHANNELS } from '../../shared/ipc-channels';
import type { QuitConfirmAsk } from '../../shared/quit-confirm';

/**
 * A window that answers the two questions `QuitGuard` asks of it and records
 * what was sent, which is all it ever touches.
 */
function fakeWindow(overrides: { destroyed?: boolean; contentsDestroyed?: boolean } = {}): {
  win: BrowserWindow;
  sent: QuitConfirmAsk[];
  emitGone: () => void;
} {
  const sent: QuitConfirmAsk[] = [];
  const goneListeners: Array<() => void> = [];
  const win = {
    isDestroyed: () => overrides.destroyed === true,
    webContents: {
      isDestroyed: () => overrides.contentsDestroyed === true,
      send: (_channel: string, payload: QuitConfirmAsk) => sent.push(payload),
      once: (_event: string, listener: () => void) => goneListeners.push(listener),
      removeListener: (_event: string, listener: () => void) => {
        const at = goneListeners.indexOf(listener);
        if (at >= 0) goneListeners.splice(at, 1);
      }
    }
  } as unknown as BrowserWindow;
  return { win, sent, emitGone: () => [...goneListeners].forEach((fn) => fn()) };
}

describe('QuitGuard', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('asks the renderer and resolves with the answer it gives', async () => {
    const { win, sent } = fakeWindow();
    const guard = new QuitGuard(() => win);

    const answer = guard.ask([{ kind: 'background', id: 'bg-1', label: 'npm run dev' }]);
    expect(sent).toHaveLength(1);
    expect(sent[0].items).toEqual([{ kind: 'background', id: 'bg-1', label: 'npm run dev' }]);

    guard.decide(sent[0].requestId, false);

    await expect(answer).resolves.toBe(false);
  });

  it('sends the question on the channel the renderer listens to', () => {
    const channels: string[] = [];
    const win = {
      isDestroyed: () => false,
      webContents: {
        isDestroyed: () => false,
        send: (channel: string) => channels.push(channel),
        once: () => {},
        removeListener: () => {}
      }
    } as unknown as BrowserWindow;

    void new QuitGuard(() => win).ask([]);

    expect(channels).toEqual([IPC_CHANNELS.APP_QUIT_ASK]);
  });

  // Every one of these would otherwise leave the user unable to close the app.
  it('closes anyway when there is no window to ask', async () => {
    await expect(new QuitGuard(() => null).ask([])).resolves.toBe(true);
  });

  it('closes anyway when the window is already destroyed', async () => {
    const { win } = fakeWindow({ destroyed: true });
    await expect(new QuitGuard(() => win).ask([])).resolves.toBe(true);
  });

  it('closes anyway when the renderer is gone', async () => {
    const { win } = fakeWindow({ contentsDestroyed: true });
    await expect(new QuitGuard(() => win).ask([])).resolves.toBe(true);
  });

  it('closes anyway when the renderer dies with the question on screen', async () => {
    const { win, emitGone } = fakeWindow();
    const answer = new QuitGuard(() => win).ask([]);

    emitGone();

    await expect(answer).resolves.toBe(true);
  });

  it('closes anyway when no answer ever comes', async () => {
    const { win } = fakeWindow();
    const answer = new QuitGuard(() => win).ask([]);

    await vi.advanceTimersByTimeAsync(30_000);

    await expect(answer).resolves.toBe(true);
  });

  it('ignores an answer to a question it did not ask', async () => {
    const { win, sent } = fakeWindow();
    const guard = new QuitGuard(() => win);
    const answer = guard.ask([]);

    guard.decide('some-other-id', false);
    expect(guard.isAsking).toBe(true);

    guard.decide(sent[0].requestId, true);
    await expect(answer).resolves.toBe(true);
  });

  // A second close while the dialog is up must not open a second one; index.ts
  // reads this to stand down.
  it('reports whether a question is already on screen', async () => {
    const { win, sent } = fakeWindow();
    const guard = new QuitGuard(() => win);
    expect(guard.isAsking).toBe(false);

    const answer = guard.ask([]);
    expect(guard.isAsking).toBe(true);

    guard.decide(sent[0].requestId, true);
    await answer;
    expect(guard.isAsking).toBe(false);
  });

  it('answers a cancelled question once, not again on timeout', async () => {
    const { win, sent } = fakeWindow();
    const guard = new QuitGuard(() => win);
    const answer = guard.ask([]);

    guard.decide(sent[0].requestId, false);
    await expect(answer).resolves.toBe(false);

    // The timer must have been cleared: a stale fire would flip a cancel into
    // a close long after the user chose to stay.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(guard.isAsking).toBe(false);
  });
});
