import type Database from 'better-sqlite3';
import { z } from 'zod';
import { normText, type PreferenceConflict } from '../../../shared/agency-client-file';
import { MEET_QUESTION_IDS, type MeetQuestionId } from '../../../shared/agency-meet';
import { parseJsonAs } from '../../../shared/parse-json';

/** Ids no longer asked, such as the old trust question, are dropped on read. */
const Seen = z.array(z.string());
const isMeetId = (id: string): id is MeetQuestionId =>
  (MEET_QUESTION_IDS as readonly string[]).includes(id);

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
 * topics the client said not to remember, and Meet you progress. A
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

  /** The topics declined on a project that start with `prefix`, oldest first. */
  declinedTopics(projectId: string, prefix: string): string[] {
    return this.db
      .prepare<[string, number, string], { topic: string }>(
        'SELECT topic FROM declined_topics WHERE project_id = ? AND substr(topic, 1, ?) = ? ORDER BY at'
      )
      .all(projectId, prefix.length, prefix)
      .map((row) => row.topic);
  }

  topicDeclined(projectId: string, topic: string): boolean {
    return (
      this.db
        .prepare('SELECT 1 FROM declined_topics WHERE project_id = ? AND topic = ?')
        .get(projectId, topic) !== undefined
    );
  }

  /**
   * The Meet you questions a layer has been through, answered or skipped, or
   * null when Meet you never ran for it.
   */
  meetSeen(layer: string): MeetQuestionId[] | null {
    const json = this.db
      .prepare<[string], string>('SELECT seen_json FROM meet_progress WHERE layer = ?')
      .pluck()
      .get(layer);
    return json === undefined ? null : (parseJsonAs(Seen, json) ?? []).filter(isMeetId);
  }

  /** Note Meet you questions as gone through; with none, only that Meet you ran for the layer. */
  markMeetSeen(layer: string, ids: MeetQuestionId[]): void {
    const seen = [...new Set([...(this.meetSeen(layer) ?? []), ...ids])];
    this.db
      .prepare(
        `INSERT INTO meet_progress (layer, seen_json, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(layer) DO UPDATE SET seen_json = excluded.seen_json, updated_at = excluded.updated_at`
      )
      .run(layer, JSON.stringify(seen), this.now());
  }
}
