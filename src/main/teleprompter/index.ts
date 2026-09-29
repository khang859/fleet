import { app, clipboard, globalShortcut, screen } from 'electron';
import fs from 'fs/promises';
import { join } from 'path';
import type { SettingsStore } from '../settings-store';
import { BoundsStore } from './bounds-store';
import type { DisplayArea } from './bounds';
import { FileWatcher } from './file-watcher';
import { HotkeyRegistry } from './hotkeys';
import { registerTeleprompterIpcHandlers } from './ipc-handlers';
import { TeleprompterService } from './service';
import { TeleprompterWindow, isWaylandSession } from './teleprompter-window';

function toDisplayArea(display: Electron.Display): DisplayArea {
  return { id: display.id, workArea: display.workArea };
}

/** Build the teleprompter on the real Electron APIs and register its IPC. Call after `app.whenReady`. */
export function createTeleprompter(settingsStore: SettingsStore): TeleprompterService {
  const service = new TeleprompterService({
    settings: {
      get: () => settingsStore.get().teleprompter,
      set: (patch) => settingsStore.set({ teleprompter: patch })
    },
    createWindow: (events) => new TeleprompterWindow(events),
    // On Wayland a refusal comes from the desktop portal, and says nothing
    // about whether another app holds the key.
    hotkeys: new HotkeyRegistry(globalShortcut, isWaylandSession() ? 'portal' : 'in-use'),
    watcher: new FileWatcher(),
    bounds: new BoundsStore(),
    displays: {
      list: () => screen.getAllDisplays().map(toDisplayArea),
      primaryId: () => screen.getPrimaryDisplay().id,
      matching: (rect) => toDisplayArea(screen.getDisplayMatching(rect))
    },
    fs,
    readClipboard: () => clipboard.readText(),
    pastedNotesPath: join(app.getPath('userData'), 'teleprompter', 'pasted.md'),
    now: () => Date.now()
  });
  registerTeleprompterIpcHandlers(service);
  return service;
}
