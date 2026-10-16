// src/main/sessions/projects-watcher.ts
import { watch, type FSWatcher } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

export type ProjectsWatcherTiming = {
  /** Quiet time after the last write before `onChange`. */
  debounceMs: number;
  /** The longest a stream of writes can hold `onChange` back. */
  maxWaitMs: number;
};

const DEFAULT_TIMING: ProjectsWatcherTiming = { debounceMs: 500, maxWaitMs: 2_000 };

/**
 * Watches the Claude projects dir and each project dir in it, and calls
 * `onChange` (debounced) when a transcript is added or written.
 *
 * Not `recursive`: on Linux Node emulates that in JS with a watcher per
 * subdirectory, and a session's `subagents/` and `tool-results/` dirs make
 * that thousands. Subagent usage is picked up with the next transcript write.
 */
export class ProjectsWatcher {
  private readonly rootWatcher: FSWatcher | null;
  private readonly projects = new Map<string, FSWatcher>();
  private debounce: ReturnType<typeof setTimeout> | null = null;
  /** When the first change not yet reported came in. */
  private pendingSince: number | null = null;
  private disposed = false;

  constructor(
    private readonly root: string,
    private readonly onChange: () => void,
    private readonly timing: ProjectsWatcherTiming = DEFAULT_TIMING
  ) {
    this.rootWatcher = watchDir(root, () => {
      void this.syncProjectDirs().then(() => this.changed());
    });
    if (this.rootWatcher) void this.syncProjectDirs();
  }

  dispose(): void {
    this.disposed = true;
    if (this.debounce) clearTimeout(this.debounce);
    this.rootWatcher?.close();
    for (const w of this.projects.values()) w.close();
    this.projects.clear();
  }

  private changed(): void {
    if (this.disposed) return;
    if (this.debounce) clearTimeout(this.debounce);
    const now = Date.now();
    this.pendingSince ??= now;
    const wait = Math.min(
      this.timing.debounceMs,
      Math.max(0, this.pendingSince + this.timing.maxWaitMs - now)
    );
    this.debounce = setTimeout(() => {
      this.debounce = null;
      this.pendingSince = null;
      this.onChange();
    }, wait);
  }

  /** Watch each project dir in the root, and stop watching the ones that are gone. */
  private async syncProjectDirs(): Promise<void> {
    let names: string[];
    try {
      names = (await readdir(this.root, { withFileTypes: true }))
        .filter((e) => e.isDirectory())
        .map((e) => e.name);
    } catch {
      return; // root removed; its watcher reports that too
    }
    if (this.disposed) return;
    const dirs = new Set(names.map((name) => join(this.root, name)));
    for (const [dir, w] of this.projects) {
      if (!dirs.has(dir)) {
        w.close();
        this.projects.delete(dir);
      }
    }
    for (const dir of dirs) {
      if (this.projects.has(dir)) continue;
      const w = watchDir(dir, (filename) => {
        // A project dir also holds each session's folder of subagents and tool output.
        if (filename === null || filename.endsWith('.jsonl')) this.changed();
      });
      if (w) this.projects.set(dir, w);
    }
  }
}

/** A watcher on the dir, or null when it cannot be watched (it may not exist yet). */
function watchDir(dir: string, onEvent: (filename: string | null) => void): FSWatcher | null {
  try {
    const w = watch(dir, (_event, filename) => onEvent(filename));
    // A watched dir that is deleted errors on some platforms; the next sync drops it.
    w.on('error', () => undefined);
    return w;
  } catch {
    return null;
  }
}
