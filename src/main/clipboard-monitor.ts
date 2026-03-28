import { clipboard, BrowserWindow, app } from 'electron';
import { IPC_CHANNELS } from '../shared/ipc-channels';
import type { ClipboardEntry } from '../shared/ipc-api';

const MAX_HISTORY = 20;
const POLL_INTERVAL_MS = 500;
const PREVIEW_LENGTH = 200;

let history: ClipboardEntry[] = [];
let lastText = '';
let nextId = 1;
let pollTimer: ReturnType<typeof setInterval> | null = null;

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

function poll(): void {
  const text = clipboard.readText();
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

export function startClipboardMonitor(): void {
  if (pollTimer) return;
  // Seed with current clipboard content
  const initial = clipboard.readText();
  if (initial) {
    lastText = initial;
    history.unshift(makeEntry(initial));
  }
  pollTimer = setInterval(poll, POLL_INTERVAL_MS);

  // Pause polling when all windows are hidden, resume when visible
  app.on('browser-window-blur', () => {
    const anyVisible = BrowserWindow.getAllWindows().some((w) => w.isVisible() && w.isFocused());
    if (!anyVisible && pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  });

  app.on('browser-window-focus', () => {
    pollTimer ??= setInterval(poll, POLL_INTERVAL_MS);
  });
}

export function stopClipboardMonitor(): void {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

export function getClipboardHistory(): ClipboardEntry[] {
  return history;
}
