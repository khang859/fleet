import type Database from 'better-sqlite3';
import { z } from 'zod';
import {
  settingLabel,
  settingTarget,
  type SettingChange,
  type SettingChangeStatus,
  type SettingValue,
  type SettingsCard
} from '../../../shared/agency-settings';
import { parseJsonAs } from '../../../shared/parse-json';

const Value = z.union([z.string(), z.number(), z.boolean(), z.array(z.string()), z.null()]);

/** One change on a card: `settings_proposals`, where `group_id` is the card. */
type ProposalRow = {
  id: number;
  project_id: string;
  job_id: number | null;
  group_id: string;
  key: string;
  value_json: string;
  before_json: string;
  reason: string;
  status: SettingChangeStatus;
  created_at: number;
};

/** One write to a setting: `settings_history`. */
type HistoryRow = {
  id: number;
  project_id: string;
  at: number;
  actor: 'admiral' | 'client';
  key: string;
  before: string;
  after: string;
  reason: string;
  proposal_id: number | null;
};

export type SettingWrite = {
  key: string;
  before: SettingValue;
  after: SettingValue;
};

export type LastSettingWrite = SettingWrite & {
  actor: 'admiral' | 'client';
  at: number;
  reason: string;
  changeId: number | null;
};

const value = (json: string): SettingValue => parseJsonAs(Value, json) ?? null;

function toChange(row: ProposalRow): SettingChange {
  return {
    id: row.id,
    key: row.key,
    label: settingLabel(row.key),
    before: value(row.before_json),
    after: value(row.value_json),
    status: row.status
  };
}

/**
 * The Admiral's settings cards and the history of every write to a setting.
 * A card's changes share a `group_id`, its number as text. Agency keys are the
 * same for every project, so their history is read across projects; a
 * member's key belongs to its project.
 */
export class SettingChangeStore {
  constructor(
    private readonly db: Database.Database,
    private readonly now: () => number
  ) {}

  /** Put up a card for one `settings_change` call: every change written, with its history. */
  addCard(input: {
    repoId: string;
    jobId: number | null;
    reason: string;
    /** In the order the Admiral sent them. */
    changes: SettingWrite[];
  }): number {
    return this.db.transaction(() => {
      const card =
        (this.db
          .prepare<
            [],
            { last: number | null }
          >('SELECT MAX(CAST(group_id AS INTEGER)) AS last FROM settings_proposals')
          .get()?.last ?? 0) + 1;
      const at = this.now();
      const insert = this.db.prepare(
        `INSERT INTO settings_proposals
           (project_id, job_id, group_id, key, value_json, before_json, reason, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      );
      const add = (w: SettingWrite): number =>
        Number(
          insert.run(
            input.repoId,
            input.jobId,
            String(card),
            w.key,
            JSON.stringify(w.after),
            JSON.stringify(w.before),
            input.reason,
            'applied',
            at
          ).lastInsertRowid
        );
      for (const w of input.changes) this.record(input.repoId, 'admiral', w, input.reason, add(w));
      return card;
    })();
  }

  card(id: number): SettingsCard | null {
    const rows = this.db
      .prepare<
        [string],
        ProposalRow
      >('SELECT * FROM settings_proposals WHERE group_id = ? ORDER BY id')
      .all(String(id));
    return rows.length === 0 ? null : toCard(id, rows);
  }

  /** A repository's newest cards, oldest first. */
  cards(repoId: string, limit: number): SettingsCard[] {
    const ids = this.db
      .prepare<[string, number], { group_id: string }>(
        `SELECT group_id FROM settings_proposals WHERE project_id = ?
         GROUP BY group_id ORDER BY MAX(id) DESC LIMIT ?`
      )
      .all(repoId, limit)
      .map((r) => Number(r.group_id))
      .reverse();
    return ids.flatMap((id) => this.card(id) ?? []);
  }

  change(
    id: number
  ): (SettingChange & { cardId: number; repoId: string; jobId: number | null }) | null {
    const row = this.db
      .prepare<[number], ProposalRow>('SELECT * FROM settings_proposals WHERE id = ?')
      .get(id);
    if (!row) return null;
    return {
      ...toChange(row),
      cardId: Number(row.group_id),
      repoId: row.project_id,
      jobId: row.job_id
    };
  }

  /** The client put a change back: a new history row with the old value. */
  undo(id: number, write: SettingWrite): void {
    this.db.transaction(() => {
      const change = this.change(id);
      if (change === null) return;
      this.setStatus(id, 'undone');
      this.record(change.repoId, 'client', write, `undid change ${id}`, id);
    })();
  }

  /** The newest write to a key: agency keys from any project, a member's from its own. */
  lastWrite(repoId: string, key: string): LastSettingWrite | null {
    const global = settingTarget(key)?.scope === 'agency';
    const row = this.db
      .prepare<unknown[], HistoryRow>(
        `SELECT * FROM settings_history WHERE key = ? ${global ? '' : 'AND project_id = ?'}
         ORDER BY id DESC LIMIT 1`
      )
      .get(...(global ? [key] : [key, repoId]));
    if (!row) return null;
    return {
      key: row.key,
      before: value(row.before),
      after: value(row.after),
      actor: row.actor,
      at: row.at,
      reason: row.reason,
      changeId: row.proposal_id
    };
  }

  private setStatus(id: number, status: SettingChangeStatus): void {
    this.db
      .prepare('UPDATE settings_proposals SET status = ?, decided_at = ? WHERE id = ?')
      .run(status, this.now(), id);
  }

  private record(
    repoId: string,
    actor: 'admiral' | 'client',
    w: SettingWrite,
    reason: string,
    proposalId: number
  ): void {
    this.db
      .prepare(
        `INSERT INTO settings_history (project_id, at, actor, key, before, after, reason, proposal_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        repoId,
        this.now(),
        actor,
        w.key,
        JSON.stringify(w.before),
        JSON.stringify(w.after),
        reason,
        proposalId
      );
  }
}

function toCard(id: number, rows: ProposalRow[]): SettingsCard {
  const first = rows[0];
  return {
    id,
    repoId: first.project_id,
    jobId: first.job_id,
    at: first.created_at,
    reason: first.reason,
    changes: rows.map(toChange)
  };
}
