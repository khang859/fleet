import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as ClipboardMonitor from '../clipboard-monitor';

const electron = vi.hoisted(() => ({
  readText: vi.fn<() => Promise<string>>(),
  send: vi.fn(),
  on: vi.fn<(event: string, listener: () => void) => void>()
}));

vi.mock('electron', () => ({
  clipboard: { readText: electron.readText },
  app: { on: electron.on },
  BrowserWindow: {
    getAllWindows: () => [
      {
        isDestroyed: () => false,
        isVisible: () => true,
        isFocused: () => false,
        webContents: { send: electron.send }
      }
    ]
  }
}));

async function loadMonitor(): Promise<typeof ClipboardMonitor> {
  vi.resetModules();
  return import('../clipboard-monitor');
}

/** A clipboard read that stays in flight until the test settles it. */
function deferRead(): PromiseWithResolvers<string> {
  const read = Promise.withResolvers<string>();
  electron.readText.mockReturnValueOnce(read.promise);
  return read;
}

function fireAppEvent(event: string): void {
  for (const [name, listener] of electron.on.mock.calls) {
    if (name === event) listener();
  }
}

describe('clipboard monitor', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    electron.readText.mockReset();
    electron.send.mockReset();
    electron.on.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('seeds history from the async clipboard read', async () => {
    electron.readText.mockResolvedValue('first');
    const monitor = await loadMonitor();

    monitor.startClipboardMonitor();
    await vi.advanceTimersByTimeAsync(0);

    expect(monitor.getClipboardHistory().map((entry) => entry.text)).toEqual(['first']);
    monitor.stopClipboardMonitor();
  });

  it('records a new value once and ignores repeats', async () => {
    electron.readText.mockResolvedValue('first');
    const monitor = await loadMonitor();
    monitor.startClipboardMonitor();
    await vi.advanceTimersByTimeAsync(0);

    electron.readText.mockResolvedValue('second');
    await vi.advanceTimersByTimeAsync(1500);

    expect(monitor.getClipboardHistory().map((entry) => entry.text)).toEqual(['second', 'first']);
    expect(electron.send).toHaveBeenCalledTimes(2);
    monitor.stopClipboardMonitor();
  });

  it('keeps one read in flight, so a slow read cannot land after a newer one', async () => {
    electron.readText.mockResolvedValue('');
    const monitor = await loadMonitor();
    monitor.startClipboardMonitor();
    await vi.advanceTimersByTimeAsync(0);

    const older = deferRead();
    const newer = deferRead();
    await vi.advanceTimersByTimeAsync(1000);

    newer.resolve('newer');
    await vi.advanceTimersByTimeAsync(0);
    older.resolve('older');
    await vi.advanceTimersByTimeAsync(0);

    await vi.advanceTimersByTimeAsync(500);

    expect(monitor.getClipboardHistory().map((entry) => entry.text)).toEqual(['newer', 'older']);
    monitor.stopClipboardMonitor();
  });

  it('drops a read that finishes after the monitor stops', async () => {
    const read = deferRead();
    const monitor = await loadMonitor();
    monitor.startClipboardMonitor();

    monitor.stopClipboardMonitor();
    read.resolve('too late');
    await vi.advanceTimersByTimeAsync(0);

    expect(monitor.getClipboardHistory()).toEqual([]);
    expect(electron.send).not.toHaveBeenCalled();
  });

  it('drops a read that finishes after a pause, then reads again on resume', async () => {
    electron.readText.mockResolvedValue('');
    const monitor = await loadMonitor();
    monitor.startClipboardMonitor();
    await vi.advanceTimersByTimeAsync(0);

    const read = deferRead();
    await vi.advanceTimersByTimeAsync(500);
    fireAppEvent('browser-window-blur');
    fireAppEvent('browser-window-focus');
    read.resolve('from before the pause');
    await vi.advanceTimersByTimeAsync(0);

    expect(monitor.getClipboardHistory()).toEqual([]);

    electron.readText.mockResolvedValue('after the pause');
    await vi.advanceTimersByTimeAsync(500);

    expect(monitor.getClipboardHistory().map((entry) => entry.text)).toEqual(['after the pause']);
    monitor.stopClipboardMonitor();
  });

  it('keeps polling after a failed read', async () => {
    electron.readText.mockRejectedValueOnce(new Error('read failed'));
    electron.readText.mockResolvedValue('next');
    const monitor = await loadMonitor();
    monitor.startClipboardMonitor();
    await vi.advanceTimersByTimeAsync(500);

    expect(monitor.getClipboardHistory().map((entry) => entry.text)).toEqual(['next']);
    monitor.stopClipboardMonitor();
  });
});
