import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as ClipboardMonitor from '../clipboard-monitor';

const electron = vi.hoisted(() => ({
  readText: vi.fn<() => Promise<string>>(),
  send: vi.fn()
}));

vi.mock('electron', () => ({
  clipboard: { readText: electron.readText },
  app: { on: vi.fn() },
  BrowserWindow: {
    getAllWindows: () => [{ isDestroyed: () => false, webContents: { send: electron.send } }]
  }
}));

async function loadMonitor(): Promise<typeof ClipboardMonitor> {
  vi.resetModules();
  return import('../clipboard-monitor');
}

describe('clipboard monitor', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    electron.readText.mockReset();
    electron.send.mockReset();
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
});
