// src/main/sessions/service.ts
import type {
  SessionKey,
  SessionSource,
  SessionSummary,
  SessionTranscript
} from '../../shared/sessions';
import { claudeProjectsDir, listClaudeSessions, readClaudeSession } from './claude-source';
import { listPiSessions, piSessionsDir, readPiSession } from './pi-source';
import { ensurePricesFresh } from './pricing-source';
import { ProjectsWatcher } from './projects-watcher';

/** Where one program's past sessions live, and how to read them. */
type Source = {
  dir: () => string;
  list: () => Promise<SessionSummary[]>;
  read: (key: SessionKey) => Promise<SessionTranscript | null>;
};

const SOURCES: Record<SessionSource, Source> = {
  claude: {
    dir: claudeProjectsDir,
    list: listClaudeSessions,
    read: async ({ id, cwd }) => readClaudeSession(id, cwd)
  },
  pi: { dir: piSessionsDir, list: listPiSessions, read: async ({ id }) => readPiSession(id) }
};

export class SessionsService {
  private watchers: ProjectsWatcher[] = [];
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

  async read(key: SessionKey): Promise<SessionTranscript | null> {
    return SOURCES[key.source ?? 'claude'].read(key);
  }

  /** Calls onChange (debounced) when a transcript is added or written. */
  startWatching(onChange: () => void): void {
    this.dispose();
    this.watchers = Object.values(SOURCES).map((s) => new ProjectsWatcher(s.dir(), onChange));
  }

  dispose(): void {
    for (const watcher of this.watchers) watcher.dispose();
    this.watchers = [];
  }

  private async listNow(): Promise<SessionSummary[]> {
    void ensurePricesFresh(); // best-effort; next list reflects any update
    const run = Promise.all(Object.values(SOURCES).map(async (s) => s.list())).then((lists) =>
      lists.flat().sort((a, b) => b.updatedAt - a.updatedAt)
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
