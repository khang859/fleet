// src/main/sessions/service.ts
import type { SessionSummary, SessionTranscript } from '../../shared/sessions';
import { claudeProjectsDir, listClaudeSessions, readClaudeSession } from './claude-source';
import { ensurePricesFresh } from './pricing-source';
import { ProjectsWatcher } from './projects-watcher';

export class SessionsService {
  private watcher: ProjectsWatcher | null = null;
  private listing: Promise<SessionSummary[]> | null = null;
  private relisting: Promise<SessionSummary[]> | null = null;

  /**
   * The sessions, newest first. A call made while a list is running gets the
   * one list that starts after it, so a burst of changes costs at most two.
   */
  async list(): Promise<SessionSummary[]> {
    if (this.relisting) return this.relisting;
    if (this.listing) {
      this.relisting = this.listing
        .catch(() => undefined)
        .then(async () => {
          this.relisting = null;
          return this.listNow();
        });
      return this.relisting;
    }
    return this.listNow();
  }

  async read(id: string, cwd: string): Promise<SessionTranscript | null> {
    return readClaudeSession(id, cwd);
  }

  /** Calls onChange (debounced) when a transcript is added or written. */
  startWatching(onChange: () => void): void {
    this.watcher?.dispose();
    this.watcher = new ProjectsWatcher(claudeProjectsDir(), onChange);
  }

  dispose(): void {
    this.watcher?.dispose();
    this.watcher = null;
  }

  private async listNow(): Promise<SessionSummary[]> {
    void ensurePricesFresh(); // best-effort; next list reflects any update
    const run = listClaudeSessions().then((claude) =>
      claude.sort((a, b) => b.updatedAt - a.updatedAt)
    );
    this.listing = run;
    void run
      .catch(() => undefined)
      .finally(() => {
        if (this.listing === run) this.listing = null;
      });
    return run;
  }
}
