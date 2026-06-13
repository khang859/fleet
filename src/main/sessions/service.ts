// src/main/sessions/service.ts
import { watch, type FSWatcher } from 'node:fs';
import type { SessionAgent, SessionSummary, SessionTranscript } from '../../shared/sessions';
import { listRuneSessions, readRuneSession, runeSessionsDir } from './rune-source';
import { claudeProjectsDir, listClaudeSessions, readClaudeSession } from './claude-source';
import { ensurePricesFresh } from './pricing-source';

export class SessionsService {
  private watchers: FSWatcher[] = [];
  private debounce: ReturnType<typeof setTimeout> | null = null;

  async list(): Promise<SessionSummary[]> {
    void ensurePricesFresh(); // best-effort; next list reflects any update
    const [rune, claude] = await Promise.all([listRuneSessions(), listClaudeSessions()]);
    return [...rune, ...claude].sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async read(agent: SessionAgent, id: string, cwd: string): Promise<SessionTranscript | null> {
    return agent === 'rune' ? readRuneSession(id) : readClaudeSession(id, cwd);
  }

  /** Start watching both source dirs; calls onChange (debounced) when anything changes. */
  startWatching(onChange: () => void): void {
    for (const dir of [runeSessionsDir(), claudeProjectsDir()]) {
      try {
        const w = watch(dir, { recursive: true }, () => {
          if (this.debounce) clearTimeout(this.debounce);
          this.debounce = setTimeout(onChange, 500);
        });
        this.watchers.push(w);
      } catch {
        // dir may not exist yet; skip
      }
    }
  }

  dispose(): void {
    if (this.debounce) clearTimeout(this.debounce);
    for (const w of this.watchers) w.close();
    this.watchers = [];
  }
}
