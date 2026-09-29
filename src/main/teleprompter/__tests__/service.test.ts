import { describe, it, expect, vi } from 'vitest';
import { resolve } from 'path';
import {
  DEFAULT_TELEPROMPTER_SETTINGS,
  TELEPROMPTER_MAX_FONT_SIZE,
  TELEPROMPTER_MAX_NOTES_BYTES,
  type TeleprompterSettings,
  type TeleprompterState
} from '../../../shared/teleprompter';
import type { DisplayArea, Rect } from '../bounds';
import { FileWatcher } from '../file-watcher';
import { HotkeyRegistry } from '../hotkeys';
import { TeleprompterService, type TeleprompterDeps } from '../service';
import type { OverlayEvents, OverlayPort } from '../teleprompter-window';

const TALK = resolve('/notes/talk.md');
const OTHER = resolve('/notes/other.md');
const PASTED = resolve('/data/teleprompter/pasted.md');
const DISPLAY: DisplayArea = { id: 7, workArea: { x: 0, y: 0, width: 1000, height: 800 } };

class FakeOverlay implements OverlayPort {
  open = false;
  visible = false;
  locked = false;
  bounds: Rect | null = null;
  sent: TeleprompterState[] = [];
  isOpen = (): boolean => this.open;
  isVisible = (): boolean => this.open && this.visible;
  create = (rect: Rect): void => {
    this.open = true;
    this.visible = true;
    this.bounds = rect;
  };
  show = (): void => void (this.visible = true);
  hide = (): void => void (this.visible = false);
  setLocked = (locked: boolean): void => void (this.locked = locked);
  getBounds = (): Rect | null => this.bounds;
  setSize = (width: number, height: number): void => {
    if (this.bounds) this.bounds = { ...this.bounds, width, height };
  };
  send = (state: TeleprompterState): void => void this.sent.push(state);
  destroy = (): void => {
    this.open = false;
    this.visible = false;
    this.bounds = null;
  };
}

function setup(files: Record<string, string> = {}, clipboard = '') {
  let settings: TeleprompterSettings = { ...DEFAULT_TELEPROMPTER_SETTINGS };
  const overlay = new FakeOverlay();
  let events!: OverlayEvents;
  const shortcuts = new Map<string, () => void>();
  let fileChanged: (() => void) | null = null;
  const savedBounds = vi.fn();
  let clock = 1_000;

  const service = new TeleprompterService({
    settings: {
      get: () => settings,
      set: (patch) => void (settings = { ...settings, ...patch })
    },
    createWindow: (e) => {
      events = e;
      return overlay;
    },
    hotkeys: new HotkeyRegistry({
      register: (accelerator, callback) => {
        shortcuts.set(accelerator, callback);
        return true;
      },
      unregister: (accelerator) => void shortcuts.delete(accelerator)
    }),
    watcher: new FileWatcher((_dir, listener) => {
      fileChanged = () => listener('change', null);
      return { close: () => void (fileChanged = null) };
    }, 0),
    bounds: { load: () => ({ lastDisplayId: null, byDisplay: {} }), save: savedBounds },
    displays: { list: () => [DISPLAY], primaryId: () => DISPLAY.id, matching: () => DISPLAY },
    // Only the calls the service makes, so it stands in for `fs/promises` by cast.
    fs: {
      stat: async (path: string) =>
        path in files
          ? Promise.resolve({ isFile: () => true, size: files[path].length })
          : Promise.reject(new Error(`ENOENT: ${path}`)),
      readFile: async (path: string) => Promise.resolve(files[path]),
      writeFile: async (path: string, text: string) => {
        files[path] = text;
        return Promise.resolve();
      },
      mkdir: async () => {}
    } as unknown as TeleprompterDeps['fs'],
    readClipboard: () => clipboard,
    pastedNotesPath: PASTED,
    now: () => clock
  });

  return {
    service,
    overlay,
    files,
    shortcuts,
    savedBounds,
    settings: () => settings,
    events: () => events,
    tick: (ms: number) => void (clock += ms),
    /** Edit a notes file on disk and wait for the reload it triggers to be pushed. */
    changeFile: async (path: string, text: string) => {
      const pushed = overlay.sent.length;
      files[path] = text;
      fileChanged?.();
      await vi.waitFor(() => expect(overlay.sent.length).toBeGreaterThan(pushed));
    },
    watching: () => fileChanged !== null
  };
}

describe('TeleprompterService', () => {
  it('opens on a notes file at the first section, with hotkeys and live reload on', async () => {
    const t = setup({ [TALK]: 'One\n---\nTwo\n---\nThree' });
    expect(await t.service.setSource({ kind: 'file', path: TALK })).toEqual({ ok: true });
    const state = t.service.getState();
    expect(state).toMatchObject({
      open: true,
      index: 0,
      total: 3,
      current: 'One',
      nextPreview: 'Two',
      sourceLabel: 'talk.md'
    });
    expect(t.shortcuts.size).toBe(5);
    expect(t.watching()).toBe(true);
    expect(t.settings().notesPath).toBe(TALK);
  });

  it('steps through the notes from its hotkeys and starts the timer on the first', async () => {
    const t = setup({ [TALK]: 'One\n---\nTwo' });
    await t.service.setSource({ kind: 'file', path: TALK });
    t.tick(500);
    t.shortcuts.get(DEFAULT_TELEPROMPTER_SETTINGS.hotkeys.next)?.();
    await vi.waitFor(() => expect(t.overlay.sent.at(-1)?.current).toBe('Two'));
    expect(t.service.getState().timerStartedAt).toBe(1_500);
    await t.service.dispatch({ type: 'resetTimer' });
    expect(t.service.getState().timerStartedAt).toBeNull();
  });

  it('keeps the presenter on the same section when the file is edited', async () => {
    const t = setup({ [TALK]: 'One\n---\nTwo\n---\nThree' });
    await t.service.setSource({ kind: 'file', path: TALK });
    await t.service.dispatch({ type: 'next' });
    await t.changeFile(TALK, 'One\n---\nTwo, reworded\n---\nThree');
    expect(t.service.getState()).toMatchObject({ index: 1, current: 'Two, reworded' });
  });

  it('pulls the presenter back when sections are deleted under them', async () => {
    const t = setup({ [TALK]: 'One\n---\nTwo\n---\nThree' });
    await t.service.setSource({ kind: 'file', path: TALK });
    await t.service.dispatch({ type: 'next' });
    await t.service.dispatch({ type: 'next' });
    await t.changeFile(TALK, 'Only one');
    expect(t.service.getState()).toMatchObject({ index: 0, total: 1 });
  });

  it('keeps the last good notes on screen when the file disappears', async () => {
    const t = setup({ [TALK]: 'One\n---\nTwo' });
    await t.service.setSource({ kind: 'file', path: TALK });
    delete t.files[TALK];
    await t.service.dispatch({ type: 'close' });
    await t.service.dispatch({ type: 'open' });
    expect(t.service.getState()).toMatchObject({ current: 'One', total: 2 });
    expect(t.service.getState().error).toContain('ENOENT');
  });

  it('starts again from the top for a different file, but not for the same one', async () => {
    const t = setup({ [TALK]: 'A\n---\nB', [OTHER]: 'X\n---\nY' });
    await t.service.setSource({ kind: 'file', path: TALK });
    await t.service.dispatch({ type: 'next' });
    await t.service.setSource({ kind: 'file', path: TALK });
    expect(t.service.getState().index).toBe(1);
    await t.service.setSource({ kind: 'file', path: OTHER });
    expect(t.service.getState()).toMatchObject({ index: 0, current: 'X', timerStartedAt: null });
  });

  it('shows new notes in an overlay that is already open', async () => {
    const t = setup({ [TALK]: 'One', [OTHER]: 'Other' });
    await t.service.setSource({ kind: 'file', path: TALK });
    await t.service.setSource({ kind: 'file', path: OTHER });
    expect(t.overlay.sent.at(-1)).toMatchObject({ current: 'Other', sourceLabel: 'other.md' });
  });

  it('does not start watching when closed while the notes are being read', async () => {
    const t = setup({ [TALK]: 'One' });
    await t.service.setSource({ kind: 'file', path: TALK });
    await t.service.dispatch({ type: 'close' });
    const opening = t.service.dispatch({ type: 'open' });
    t.service.destroy();
    await opening;
    expect(t.watching()).toBe(false);
  });

  it('drops a reload of the old file that finishes after other notes were picked', async () => {
    const t = setup({ [TALK]: 'Talk', [OTHER]: 'Other' });
    await t.service.setSource({ kind: 'file', path: TALK });
    t.files[TALK] = 'Talk, edited';
    const pick = t.service.setSource({ kind: 'file', path: OTHER });
    await t.changeFile(TALK, 'Talk, edited');
    await pick;
    expect(t.service.getState().current).toBe('Other');
  });

  it('leaves the current notes alone when a pick cannot be read', async () => {
    const big = 'x'.repeat(TELEPROMPTER_MAX_NOTES_BYTES + 1);
    const t = setup({ [TALK]: 'One', [OTHER]: big });
    await t.service.setSource({ kind: 'file', path: TALK });
    const tooBig = await t.service.setSource({ kind: 'file', path: OTHER });
    expect(tooBig).toMatchObject({ ok: false, error: expect.stringContaining('too big') });
    // The overlay says why, under the notes it kept.
    expect(t.overlay.sent.at(-1)).toMatchObject({
      current: 'One',
      error: expect.stringContaining('too big')
    });
    await t.changeFile(TALK, 'One, edited');
    expect(t.service.getState().error).toBeNull();
    const relative = await t.service.setSource({ kind: 'file', path: 'talk.md' });
    expect(relative.ok).toBe(false);
    expect(t.settings().notesPath).toBe(TALK);
    expect(t.service.getState().current).toBe('One, edited');
  });

  it('saves pasted text as notes, and a second paste starts from the top', async () => {
    const t = setup({}, 'Pasted one\n---\nPasted two');
    await t.service.setSource({ kind: 'clipboard' });
    expect(t.files[PASTED]).toBe('Pasted one\n---\nPasted two');
    expect(t.service.getState()).toMatchObject({ sourceLabel: 'Pasted notes', total: 2 });
    await t.service.dispatch({ type: 'next' });
    await t.service.setSource({ kind: 'clipboard' });
    expect(t.service.getState().index).toBe(0);
  });

  it('refuses an empty clipboard', async () => {
    const t = setup({}, '  \n');
    const result = await t.service.setSource({ kind: 'clipboard' });
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining('no text') });
    expect(t.overlay.open).toBe(false);
  });

  it('opens from the show/hide hotkey, then hides and shows', async () => {
    const t = setup();
    await t.service.dispatch({ type: 'toggleVisible' });
    expect(t.service.getState()).toMatchObject({ open: true, visible: true, total: 0 });
    await t.service.dispatch({ type: 'toggleVisible' });
    expect(t.service.getState().visible).toBe(false);
    await t.service.dispatch({ type: 'toggleVisible' });
    expect(t.service.getState().visible).toBe(true);
  });

  it('only locks an open overlay, and closing it unlocks and frees every hotkey', async () => {
    const t = setup({ [TALK]: 'One' });
    await t.service.dispatch({ type: 'toggleLock' });
    expect(t.service.getState().locked).toBe(false);
    await t.service.setSource({ kind: 'file', path: TALK });
    await t.service.dispatch({ type: 'toggleLock' });
    expect(t.overlay.locked).toBe(true);
    await t.service.dispatch({ type: 'close' });
    expect(t.service.getState()).toMatchObject({ open: false, locked: false, hotkeys: [] });
    expect(t.shortcuts.size).toBe(0);
    expect(t.watching()).toBe(false);
  });

  it('frees hotkeys when the window closes on its own', async () => {
    const t = setup({ [TALK]: 'One' });
    await t.service.setSource({ kind: 'file', path: TALK });
    t.overlay.open = false;
    t.events().onClosed();
    expect(t.shortcuts.size).toBe(0);
  });

  it('re-registers hotkeys when they change in Settings, only while open', async () => {
    const t = setup({ [TALK]: 'One' });
    t.service.onSettingsChanged();
    expect(t.shortcuts.size).toBe(0);
    await t.service.setSource({ kind: 'file', path: TALK });
    t.settings().hotkeys = { ...t.settings().hotkeys, next: 'Control+Alt+N' };
    t.service.onSettingsChanged();
    expect(t.shortcuts.has('Control+Alt+N')).toBe(true);
    expect(t.shortcuts.has(DEFAULT_TELEPROMPTER_SETTINGS.hotkeys.next)).toBe(false);
  });

  it('keeps font size and opacity within range', async () => {
    const t = setup();
    await t.service.dispatch({ type: 'fontSize', delta: 1000 });
    await t.service.dispatch({ type: 'opacity', value: 5 });
    expect(t.service.getState()).toMatchObject({
      fontSize: TELEPROMPTER_MAX_FONT_SIZE,
      opacity: 1
    });
  });

  it('resizes within the display and saves where the window was moved', async () => {
    const t = setup();
    await t.service.dispatch({ type: 'open' });
    t.service.resize(5000, 10);
    expect(t.overlay.bounds).toMatchObject({ width: 1000, height: 96 });
    const rect = { x: 5, y: 6, width: 300, height: 120 };
    t.events().onBoundsChanged(rect);
    expect(t.savedBounds).toHaveBeenCalledWith(DISPLAY.id, rect);
  });
});
