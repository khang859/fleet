import { watch, type FSWatcher } from 'node:fs';

/** One folder, and the one name in it that matters. With no name, every name does. */
export type WatchTarget = { dir: string; only?: string };

/** Long enough to join the writes of one save or one branch switch. */
const DEBOUNCE_MS = 100;

/**
 * Says when something changes in a set of folders.
 *
 * A folder can be missing, or a branch switch can delete and make it again. A
 * watcher on the old folder hears nothing more. So a caller also names each
 * parent folder, and every change opens all the watchers again.
 */
export class FolderWatcher {
  private targets: WatchTarget[] = [];
  private watchers: FSWatcher[] = [];
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly onChange: () => void,
    private readonly debounceMs = DEBOUNCE_MS
  ) {}

  watch(targets: WatchTarget[]): void {
    this.targets = targets;
    this.open();
  }

  dispose(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.targets = [];
    this.closeAll();
  }

  private open(): void {
    this.closeAll();
    this.watchers = this.targets.flatMap((target) => this.openTarget(target) ?? []);
  }

  private closeAll(): void {
    for (const watcher of this.watchers) watcher.close();
    this.watchers = [];
  }

  /** A watcher on the folder, or null when it cannot be watched. It may not exist yet. */
  private openTarget({ dir, only }: WatchTarget): FSWatcher | null {
    try {
      // `persistent: false`, so a watcher never holds the process open.
      const watcher = watch(dir, { persistent: false }, (_event, name) => {
        if (only === undefined || name === null || name === only) this.changed();
      });
      watcher.on('error', () => this.changed());
      return watcher;
    } catch {
      return null;
    }
  }

  private changed(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.open();
      this.onChange();
    }, this.debounceMs);
  }
}
