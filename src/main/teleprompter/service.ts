import type fsPromises from 'fs/promises';
import { basename, dirname, isAbsolute } from 'path';
import {
  TELEPROMPTER_MAX_NOTES_BYTES,
  clampFontSize,
  clampOpacity,
  type HotkeyStatus,
  type SetSourceResult,
  type TeleprompterCommand,
  type TeleprompterSettings,
  type TeleprompterSource,
  type TeleprompterState
} from '../../shared/teleprompter';
import {
  MIN_WINDOW_HEIGHT,
  MIN_WINDOW_WIDTH,
  resolveInitialBounds,
  type DisplayArea,
  type Rect,
  type SavedBounds
} from './bounds';
import type { FileWatcher } from './file-watcher';
import type { HotkeyRegistry } from './hotkeys';
import { clampIndex, step, toView, type Position } from './navigation';
import { splitSections } from './sections';
import type { OverlayEvents, OverlayPort } from './teleprompter-window';

export type TeleprompterDeps = {
  settings: {
    get: () => TeleprompterSettings;
    set: (patch: Partial<TeleprompterSettings>) => void;
  };
  createWindow: (events: OverlayEvents) => OverlayPort;
  hotkeys: HotkeyRegistry;
  watcher: FileWatcher;
  bounds: {
    load: () => SavedBounds;
    save: (displayId: number, rect: Rect) => void;
  };
  displays: {
    list: () => DisplayArea[];
    primaryId: () => number;
    /** The display a rect is mostly on. */
    matching: (rect: Rect) => DisplayArea;
  };
  fs: Pick<typeof fsPromises, 'stat' | 'readFile' | 'writeFile' | 'mkdir'>;
  readClipboard: () => string;
  /** Where pasted notes are kept, so they are a file like any other. */
  pastedNotesPath: string;
  now: () => number;
};

const MB = 1024 * 1024;

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * The presenter teleprompter: which notes are loaded, where in them the
 * presenter is, and the overlay window and hotkeys that show and drive them.
 *
 * Main owns all of it because the global hotkeys fire here, and because a
 * locked overlay cannot be clicked at all. The overlay is a view of the state
 * this pushes, so reloading or closing it never loses the presenter's place.
 *
 * Hotkeys exist exactly while the overlay window does. They are system-wide
 * keys, and a feature nobody has open should not be holding any.
 */
export class TeleprompterService {
  private readonly window: OverlayPort;
  private sections: string[] = [];
  private position: Position = { index: 0, timerStartedAt: null };
  private locked = false;
  private error: string | null = null;
  private hotkeyStatus: HotkeyStatus[] = [];

  constructor(private readonly deps: TeleprompterDeps) {
    this.window = deps.createWindow({
      onBoundsChanged: (rect) => deps.bounds.save(deps.displays.matching(rect).id, rect),
      onClosed: () => this.teardown()
    });
  }

  getState(): TeleprompterState {
    const { fontSize, opacity, notesPath } = this.deps.settings.get();
    return {
      open: this.window.isOpen(),
      visible: this.window.isVisible(),
      locked: this.locked,
      index: this.position.index,
      total: this.sections.length,
      ...toView(this.sections, this.position.index),
      timerStartedAt: this.position.timerStartedAt,
      fontSize,
      opacity,
      sourceLabel: this.sourceLabel(notesPath),
      error: this.error,
      hotkeys: this.hotkeyStatus
    };
  }

  /** The one path for hotkeys, the overlay toolbar, and the command palette. */
  async dispatch(command: TeleprompterCommand): Promise<TeleprompterState> {
    switch (command.type) {
      case 'open':
        await this.open();
        break;
      case 'close':
        this.destroy();
        break;
      case 'toggleVisible':
        if (!this.window.isOpen()) await this.open();
        else if (this.window.isVisible()) this.window.hide();
        else this.window.show();
        break;
      case 'next':
      case 'prev':
        this.position = step(
          this.position,
          command.type === 'next' ? 1 : -1,
          this.sections.length,
          this.deps.now()
        );
        break;
      case 'toggleLock':
        if (!this.window.isOpen()) break;
        this.locked = !this.locked;
        this.window.setLocked(this.locked);
        break;
      case 'resetTimer':
        this.position = { ...this.position, timerStartedAt: null };
        break;
      case 'fontSize':
        this.deps.settings.set({
          fontSize: clampFontSize(this.deps.settings.get().fontSize + command.delta)
        });
        break;
      case 'opacity':
        this.deps.settings.set({ opacity: clampOpacity(command.value) });
        break;
    }
    return this.emit();
  }

  /**
   * Point the teleprompter at new notes and open it on them.
   *
   * The notes change only if the new ones can be read, so a bad pick leaves
   * the current notes on screen, with the reason beneath them.
   */
  async setSource(source: TeleprompterSource): Promise<SetSourceResult> {
    if (source.kind === 'file' && !isAbsolute(source.path)) {
      return { ok: false, error: 'Notes must be given as an absolute path.' };
    }
    let path: string;
    try {
      path = source.kind === 'file' ? source.path : await this.savePasted();
      this.sections = splitSections(await this.readNotes(path));
    } catch (err) {
      // Shown on the overlay too, until the next successful load.
      this.error = errorMessage(err);
      this.emit();
      return { ok: false, error: this.error };
    }
    // Pasting again replaces the pasted file, so it is new notes even though
    // the path is the same.
    const isNew = path !== this.deps.settings.get().notesPath || source.kind === 'clipboard';
    this.position = isNew
      ? { index: 0, timerStartedAt: null }
      : { ...this.position, index: clampIndex(this.position.index, this.sections.length) };
    this.error = null;
    this.deps.settings.set({ notesPath: path });
    await this.open();
    // An overlay that was already open is showing the old notes.
    this.emit();
    return { ok: true };
  }

  /** Set the overlay's size from its resize grip, kept on the display it is on. */
  resize(width: number, height: number): void {
    const bounds = this.window.getBounds();
    if (!bounds) return;
    const { workArea } = this.deps.displays.matching(bounds);
    this.window.setSize(
      Math.min(workArea.width, Math.max(MIN_WINDOW_WIDTH, width)),
      Math.min(workArea.height, Math.max(MIN_WINDOW_HEIGHT, height))
    );
  }

  /** Font, opacity or a hotkey changed in Settings. */
  onSettingsChanged(): void {
    if (!this.window.isOpen()) return;
    this.syncHotkeys();
    this.emit();
  }

  /** Close the overlay and release its hotkeys. Safe to call any number of times. */
  destroy(): void {
    this.teardown();
    this.window.destroy();
  }

  private async open(): Promise<void> {
    if (this.window.isOpen()) {
      this.window.show();
      this.watchNotes();
      return;
    }
    const displays = this.deps.displays.list();
    this.window.create(
      resolveInitialBounds(this.deps.bounds.load(), displays, this.deps.displays.primaryId())
    );
    this.syncHotkeys();
    await this.reload();
    // Closed while the notes were being read: nothing to watch for.
    if (this.window.isOpen()) this.watchNotes();
  }

  /** Re-read the notes, keeping the presenter's place. */
  private async reload(): Promise<void> {
    const { notesPath } = this.deps.settings.get();
    if (!notesPath) return;
    try {
      const sections = splitSections(await this.readNotes(notesPath));
      // Other notes were picked while this file was being read.
      if (notesPath !== this.deps.settings.get().notesPath) return;
      this.sections = sections;
      this.error = null;
    } catch (err) {
      if (notesPath !== this.deps.settings.get().notesPath) return;
      // A save caught half-written, or the file moved away: keep showing the
      // last good copy and say why it is stale.
      this.error = errorMessage(err);
    }
    this.position = {
      ...this.position,
      index: clampIndex(this.position.index, this.sections.length)
    };
  }

  private watchNotes(): void {
    const { notesPath } = this.deps.settings.get();
    if (!notesPath) return;
    try {
      this.deps.watcher.start(notesPath, () => {
        void this.reload().then(() => this.emit());
      });
    } catch (err) {
      this.error = `Live reload is off: ${errorMessage(err)}`;
    }
  }

  private async readNotes(path: string): Promise<string> {
    const stats = await this.deps.fs.stat(path);
    if (!stats.isFile()) throw new Error(`${basename(path)} is not a file.`);
    if (stats.size > TELEPROMPTER_MAX_NOTES_BYTES) {
      throw new Error(
        `${basename(path)} is larger than ${TELEPROMPTER_MAX_NOTES_BYTES / MB} MB, too big for notes.`
      );
    }
    return this.deps.fs.readFile(path, 'utf-8');
  }

  private async savePasted(): Promise<string> {
    const text = this.deps.readClipboard();
    if (!text.trim()) throw new Error('The clipboard has no text to paste.');
    const path = this.deps.pastedNotesPath;
    await this.deps.fs.mkdir(dirname(path), { recursive: true });
    await this.deps.fs.writeFile(path, text, 'utf-8');
    return path;
  }

  private syncHotkeys(): void {
    this.hotkeyStatus = this.deps.hotkeys.sync(this.deps.settings.get().hotkeys, (action) => {
      void this.dispatch({ type: action });
    });
  }

  /** Everything that only exists while the overlay is open. */
  private teardown(): void {
    this.deps.hotkeys.clear();
    this.deps.watcher.stop();
    this.hotkeyStatus = [];
    this.locked = false;
  }

  private sourceLabel(notesPath: string): string | null {
    if (!notesPath) return null;
    return notesPath === this.deps.pastedNotesPath ? 'Pasted notes' : basename(notesPath);
  }

  private emit(): TeleprompterState {
    const state = this.getState();
    this.window.send(state);
    return state;
  }
}
