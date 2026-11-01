import { clipboard, BrowserWindow, app } from 'electron';
import { IPC_CHANNELS } from '../shared/ipc-channels';
import type { ClipboardEntry } from '../shared/ipc-api';
import { createLogger } from './logger';

const log = createLogger('clipboard-monitor');

const MAX_HISTORY = 20;
const POLL_INTERVAL_MS = 500;
const PREVIEW_LENGTH = 200;

let history: ClipboardEntry[] = [];
let lastText = '';
let nextId = 1;
let pollTimer: ReturnType<typeof setInterval> | null = null;
let reading = false;

function makeEntry(text: string): ClipboardEntry {
  const lines = text.split('\n');
  return {
    id: nextId++,
    text,
    timestamp: Date.now(),
    charCount: text.length,
    lineCount: lines.length,
    preview: text.length > PREVIEW_LENGTH ? text.slice(0, PREVIEW_LENGTH) + '...' : text
  };
}

function record(text: string): void {
  if (!text || text === lastText) return;

  lastText = text;

  // Deduplicate: remove any existing entry with the same text
  history = history.filter((e) => e.text !== text);
  history.unshift(makeEntry(text));
  if (history.length > MAX_HISTORY) history.length = MAX_HISTORY;

  // Push to all renderer windows
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send(IPC_CHANNELS.CLIPBOARD_CHANGED, { entries: history });
    }
  }
}

/**
 * Reads are async, so they run one at a time: a slow read must not land after
 * a newer one. A pause or stop replaces `pollTimer`, which is how a read still
 * in flight knows that its result is out of date.
 */
async function poll(): Promise<void> {
  if (reading) return;
  reading = true;
  const timer = pollTimer;

  try {
    const text = await clipboard.readText();
    if (timer === pollTimer) record(text);
  } catch (err) {
    log.warn('clipboard read failed', { error: String(err) });
  } finally {
    reading = false;
  }
}

function startPolling(): void {
  pollTimer ??= setInterval(() => void poll(), POLL_INTERVAL_MS);
}

function stopPolling(): void {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = null;
}

export function startClipboardMonitor(): void {
  if (pollTimer) return;
  startPolling();
  // Seed with current clipboard content
  void poll();

  // Pause polling when all windows are hidden, resume when visible
  app.on('browser-window-blur', () => {
    const anyVisible = BrowserWindow.getAllWindows().some((w) => w.isVisible() && w.isFocused());
    if (!anyVisible) stopPolling();
  });

  app.on('browser-window-focus', startPolling);
}

export function stopClipboardMonitor(): void {
  stopPolling();
}

export function getClipboardHistory(): ClipboardEntry[] {
  return history;
}
