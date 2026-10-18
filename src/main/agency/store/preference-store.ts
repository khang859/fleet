import type Database from 'better-sqlite3';
import { normText, type PreferenceConflict } from '../../../shared/agency-client-file';
import type { ProjectTrust, TrustLevel } from '../../../shared/agency-projects';

type ConflictRow = {
  id: number;
  layer: string;
  norm_text: string;
  rule_source: string;
  rule_text: string;
  status: PreferenceConflict['status'];
};

/**
 * What Fleet keeps about the client's preference lines beside the Markdown
 * files: which jobs used a line, lines that clash with an instruction file,
 * topics the client said not to remember, and each project's trust level. A
 * line is keyed by its layer and normal form, so a reworded line starts over.
 */
export class PreferenceStore {
  constructor(
    private readonly db: Database.Database,
    private readonly now: () => number
  ) {}

  /** Count `text` as used by `jobId`, once per job however often it is cited. */
  recordUse(layer: string, text: string, jobId: number): void {
    this.db
      .prepare('INSERT OR IGNORE INTO preference_uses (layer, norm_text, job_id) VALUES (?, ?, ?)')
      .run(layer, normText(text), jobId);
  }

  /** Carry a line's uses over to its edited text, so an edit keeps the count. */
  moveUses(layer: string, from: string, to: string): void {
    this.db.transaction(() => {
      this.db
        .prepare(
          'UPDATE OR IGNORE preference_uses SET norm_text = ? WHERE layer = ? AND norm_text = ?'
        )
        .run(normText(to), layer, normText(from));
      this.db
        .prepare('DELETE FROM preference_uses WHERE layer = ? AND norm_text = ?')
        .run(layer, normText(from));
    })();
  }

  /** How many jobs used each of the layer's lines, by normal form. */
  useCounts(layer: string): Map<string, number> {
    const rows = this.db
      .prepare<
        [string],
        { norm_text: string; n: number }
      >('SELECT norm_text, COUNT(*) AS n FROM preference_uses WHERE layer = ? GROUP BY norm_text')
      .all(layer);
    return new Map(rows.map((r) => [r.norm_text, r.n]));
  }

  openConflict(input: {
    layer: string;
    text: string;
    ruleSource: string;
    ruleText: string;
  }): number {
    return Number(
      this.db
        .prepare(
          `INSERT INTO preference_conflicts (layer, norm_text, rule_source, rule_text, status, created_at)
           VALUES (?, ?, ?, ?, 'open', ?)`
        )
        .run(input.layer, normText(input.text), input.ruleSource, input.ruleText, this.now())
        .lastInsertRowid
    );
  }

  /** The layer's conflicts the client has not settled for the rule, oldest first. */
  conflicts(layer: string): PreferenceConflict[] {
    return this.db
      .prepare<[string], ConflictRow>(
        "SELECT * FROM preference_conflicts WHERE layer = ? AND status != 'rule' ORDER BY id"
      )
      .all(layer)
      .map((r) => ({
        id: r.id,
        layer: r.layer,
        normText: r.norm_text,
        ruleSource: r.rule_source,
        ruleText: r.rule_text,
        status: r.status
      }));
  }

  /** Settle an open conflict. False when it is not open. */
  settleConflict(id: number, winner: 'line' | 'rule'): boolean {
    return (
      this.db
        .prepare("UPDATE preference_conflicts SET status = ? WHERE id = ? AND status = 'open'")
        .run(winner, id).changes > 0
    );
  }

  declineTopic(projectId: string, topic: string): void {
    this.db
      .prepare('INSERT OR IGNORE INTO declined_topics (project_id, topic, at) VALUES (?, ?, ?)')
      .run(projectId, topic, this.now());
  }

  topicDeclined(projectId: string, topic: string): boolean {
    return (
      this.db
        .prepare('SELECT 1 FROM declined_topics WHERE project_id = ? AND topic = ?')
        .get(projectId, topic) !== undefined
    );
  }

  /** The project's trust level: Ask me until the client picks another. */
  trust(projectId: string): ProjectTrust {
    const row = this.db
      .prepare<
        [string],
        { level: TrustLevel; auto_start_usd: number | null }
      >('SELECT level, auto_start_usd FROM project_trust WHERE project_id = ?')
      .get(projectId);
    return row === undefined
      ? { level: 'ask', autoStartUsd: null }
      : { level: row.level, autoStartUsd: row.auto_start_usd };
  }

  setTrust(projectId: string, trust: ProjectTrust): void {
    this.db
      .prepare(
        `INSERT INTO project_trust (project_id, level, auto_start_usd, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(project_id) DO UPDATE SET level = excluded.level,
           auto_start_usd = excluded.auto_start_usd, updated_at = excluded.updated_at`
      )
      .run(projectId, trust.level, trust.autoStartUsd, this.now());
  }
}
