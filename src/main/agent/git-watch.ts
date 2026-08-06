import { watch, type FSWatcher } from 'node:fs';
import { readGitHead, resolveGitDir } from './git-head';
import type { AgentGitHead } from '../../shared/agent-git';

/**
 * Keeping each agent pane's branch current.
 *
 * The hard-won detail: **never watch `.git/HEAD` itself.** Git writes a
 * `HEAD.lock` and renames it over `HEAD`, so every branch switch replaces the
 * inode. A watcher bound to the old one goes permanently deaf - measured here
 * as zero events across four switches, not merely a flaky one. Watching the
 * gitdir *directory* and filtering by filename catches all of them.
 *
 * The filter is not an optimisation. Five commits and a `gc` produce around
 * seventy-five events in a gitdir, of which four concern HEAD; without it this
 * would re-read on every loose object git happens to write.
 */

/** Filenames worth re-reading for. Everything else in a gitdir is churn. */
const WATCHED = new Set([
  'HEAD',
  // The marks an interrupted operation leaves. A conflicted merge writes
  // MERGE_HEAD without touching HEAD, so watching HEAD alone would miss it.
  'MERGE_HEAD',
  'CHERRY_PICK_HEAD',
  'REVERT_HEAD',
  'BISECT_START',
  'rebase-merge',
  'rebase-apply'
]);

/**
 * Long enough to collapse the lock-then-rename pair git writes for a single
 * switch, short enough that the caption changes while you are still looking at
 * the terminal you typed in.
 */
const DEBOUNCE_MS = 75;

type Entry = {
  watcher: FSWatcher | null;
  panes: Set<string>;
  timer: NodeJS.Timeout | null;
};

/** What a pane is watching. Identity doubles as the guard against a stale resolve. */
type Registration = { cwd: string; gitDir: string | null };

export class AgentGitWatcher {
  private readonly panes = new Map<string, Registration>();
  /** Keyed by realpath'd gitdir, so panes on one repo share a single watcher. */
  private readonly repos = new Map<string, Entry>();

  constructor(private readonly emit: (paneId: string, head: AgentGitHead | null) => void) {}

  /**
   * Start reporting a pane's branch, and report it once straight away.
   *
   * A pane whose folder is not a repo is still registered - it just has no
   * gitdir to watch, and answers `null` forever. That is cheaper than making
   * every caller ask first, and it is the honest answer.
   */
  async watch(paneId: string, cwd: string): Promise<void> {
    this.unwatch(paneId);

    const registration: Registration = { cwd, gitDir: null };
    this.panes.set(paneId, registration);

    const gitDir = await resolveGitDir(cwd);
    // The pane may have closed, or re-registered on another folder, while that
    // was resolving. Either way this result is no longer the current answer.
    if (this.panes.get(paneId) !== registration) return;

    registration.gitDir = gitDir;
    if (gitDir !== null) this.join(gitDir, paneId);

    await this.report(paneId);
  }

  /** Stop reporting, and close the watcher if this was the last pane on the repo. */
  unwatch(paneId: string): void {
    const registration = this.panes.get(paneId);
    if (registration === undefined) return;
    this.panes.delete(paneId);
    if (registration.gitDir !== null) this.leave(registration.gitDir, paneId);
  }

  /** Re-read one pane, for a change no watcher would have seen. */
  refresh(paneId: string): void {
    void this.report(paneId);
  }

  /**
   * Re-read every pane. Used when the window regains focus and when a tool call
   * ends - the agent's own shell can run `git checkout`, and a branch switched
   * in another app while Fleet was in the background is exactly what someone is
   * checking for when they click back into it.
   */
  refreshAll(): void {
    for (const paneId of this.panes.keys()) void this.report(paneId);
  }

  dispose(): void {
    for (const entry of this.repos.values()) {
      if (entry.timer !== null) clearTimeout(entry.timer);
      entry.watcher?.close();
    }
    this.repos.clear();
    this.panes.clear();
  }

  private async report(paneId: string): Promise<void> {
    const registration = this.panes.get(paneId);
    if (registration === undefined) return;
    const head = registration.gitDir === null ? null : await readGitHead(registration.gitDir);
    // Closed while reading: the pane is gone and nothing is listening.
    if (!this.panes.has(paneId)) return;
    this.emit(paneId, head);
  }

  private join(gitDir: string, paneId: string): void {
    const existing = this.repos.get(gitDir);
    if (existing !== undefined) {
      existing.panes.add(paneId);
      return;
    }

    const entry: Entry = { watcher: null, panes: new Set([paneId]), timer: null };
    this.repos.set(gitDir, entry);

    try {
      // `persistent: false` so a watcher never holds the process open, matching
      // how the copilot's conversation reader watches its session files.
      const watcher = watch(gitDir, { persistent: false }, (_event, filename) => {
        if (filename === null || !WATCHED.has(filename)) return;
        if (entry.timer !== null) clearTimeout(entry.timer);
        entry.timer = setTimeout(() => {
          entry.timer = null;
          for (const pane of entry.panes) void this.report(pane);
        }, DEBOUNCE_MS);
      });
      // A watcher that dies - the repo was deleted, the mount went away - leaves
      // the pane on its last known branch rather than taking main down with it.
      watcher.on('error', () => {
        watcher.close();
        entry.watcher = null;
      });
      entry.watcher = watcher;
    } catch {
      // Watching is the optional half. Focus and tool-call refreshes still work,
      // so the caption goes stale rather than missing.
    }
  }

  private leave(gitDir: string, paneId: string): void {
    const entry = this.repos.get(gitDir);
    if (entry === undefined) return;
    entry.panes.delete(paneId);
    if (entry.panes.size > 0) return;
    if (entry.timer !== null) clearTimeout(entry.timer);
    entry.watcher?.close();
    this.repos.delete(gitDir);
  }
}
