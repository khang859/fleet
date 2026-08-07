// src/main/sessions/service.ts
import { watch, type FSWatcher } from 'node:fs';
import type { SessionSummary, SessionTranscript } from '../../shared/sessions';
import { claudeProjectsDir, listClaudeSessions, readClaudeSession } from './claude-source';
import { ensurePricesFresh } from './pricing-source';

export class SessionsService {
  private watchers: FSWatcher[] = [];
  private debounce: ReturnType<typeof setTimeout> | null = null;

  async list(): Promise<SessionSummary[]> {
    void ensurePricesFresh(); // best-effort; next list reflects any update
    const claude = await listClaudeSessions();
    return claude.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async read(id: string, cwd: string): Promise<SessionTranscript | null> {
    return readClaudeSession(id, cwd);
  }

  /** Watch the source dir; calls onChange (debounced) when anything changes. */
  startWatching(onChange: () => void): void {
    try {
      const w = watch(claudeProjectsDir(), { recursive: true }, () => {
        if (this.debounce) clearTimeout(this.debounce);
        this.debounce = setTimeout(onChange, 500);
      });
      this.watchers.push(w);
    } catch {
      // dir may not exist yet; skip
    }
  }

  dispose(): void {
    if (this.debounce) clearTimeout(this.debounce);
    for (const w of this.watchers) w.close();
    this.watchers = [];
  }
}
