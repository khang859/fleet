import type Database from 'better-sqlite3';
import { z } from 'zod';
import type { ClaudeUsage, SpendMeter } from '../../../shared/agency-spend';
import { parseJsonAs } from '../../../shared/parse-json';

/** Who spent it: the Admiral's model, or a crew member's runtime. */
export type SpendSource = 'admiral' | 'crew';

/** How a Claude Code crew member is paid for: the user's subscription, or an API key. */
export type CrewBilling = 'subscription' | 'api';

/** What one source spent of a job, on both meters. */
export type SpendTotals = {
  crewId: number | null;
  usd: number;
  weekPct: number;
  estimate: boolean;
};

const Window = z.object({ usedPct: z.number(), resetsAt: z.number() }).nullable();
const Usage = z.object({ fiveHour: Window, sevenDay: Window, at: z.number() });

const USAGE_KEY = 'claude_usage';

/**
 * Spend samples on both meters, the estimates reserved before work starts,
 * and the budget levels already acted on. A sample is what a source spent
 * since its last one, so a job's spend is a sum.
 */
export class SpendStore {
  constructor(
    private readonly db: Database.Database,
    private readonly now: () => number
  ) {}

  /** Add what a source spent. Nothing is written for nothing spent. */
  record(input: {
    jobId: number | null;
    crewId: number | null;
    source: SpendSource;
    meter: SpendMeter;
    amount: number;
    estimate?: boolean;
  }): void {
    if (!(input.amount > 0)) return;
    this.db
      .prepare(
        `INSERT INTO spend_samples (job_id, crew_id, source, meter, amount, estimate, at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        input.jobId,
        input.crewId,
        input.source,
        input.meter,
        input.amount,
        input.estimate === true ? 1 : 0,
        this.now()
      );
  }

  /** What a job spent on each meter. */
  jobTotals(jobId: number): { usd: number; weekPct: number } {
    const row = this.db
      .prepare<[number], { usd: number | null; week: number | null }>(
        `SELECT SUM(CASE WHEN meter = 'usd' THEN amount END) AS usd,
                SUM(CASE WHEN meter = 'week_pct' THEN amount END) AS week
         FROM spend_samples WHERE job_id = ?`
      )
      .get(jobId);
    return { usd: row?.usd ?? 0, weekPct: row?.week ?? 0 };
  }

  /** What each source of a job spent: the Admiral as `crewId` null, then each crew member. */
  bySource(jobId: number): SpendTotals[] {
    return this.db
      .prepare<
        [number],
        { crew_id: number | null; usd: number | null; week: number | null; estimate: number }
      >(
        `SELECT crew_id,
                SUM(CASE WHEN meter = 'usd' THEN amount END) AS usd,
                SUM(CASE WHEN meter = 'week_pct' THEN amount END) AS week,
                MAX(estimate) AS estimate
         FROM spend_samples WHERE job_id = ? GROUP BY crew_id ORDER BY crew_id IS NOT NULL, crew_id`
      )
      .all(jobId)
      .map((r) => ({
        crewId: r.crew_id,
        usd: r.usd ?? 0,
        weekPct: r.week ?? 0,
        estimate: r.estimate === 1
      }));
  }

  /** Dollars spent by every job and lobby since `since`, for the monthly cap. */
  usdSince(since: number): number {
    return (
      this.db
        .prepare<
          [number],
          { usd: number | null }
        >(`SELECT SUM(amount) AS usd FROM spend_samples WHERE meter = 'usd' AND at >= ?`)
        .get(since)?.usd ?? 0
    );
  }

  // ── Reservations ─────────────────────────────────────────────────────────

  /** Hold an estimate of what an act about to start will cost, until it reports or expires. */
  reserve(input: {
    jobId: number | null;
    crewId: number | null;
    meter: SpendMeter;
    amount: number;
    ttlMs: number;
  }): number {
    const at = this.now();
    const { lastInsertRowid } = this.db
      .prepare(
        `INSERT INTO spend_reservations (job_id, crew_id, meter, amount, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(input.jobId, input.crewId, input.meter, input.amount, at, at + input.ttlMs);
    return Number(lastInsertRowid);
  }

  /** Tie a hire's reservation to the crew member it made, once there is one. */
  attach(reservationId: number, crewId: number): void {
    this.db
      .prepare('UPDATE spend_reservations SET crew_id = ? WHERE id = ?')
      .run(crewId, reservationId);
  }

  cancel(reservationId: number): void {
    this.db.prepare('DELETE FROM spend_reservations WHERE id = ?').run(reservationId);
  }

  /** A crew member's turn ended, or it left: what it spent is in the samples now. */
  releaseCrew(crewId: number): void {
    this.db.prepare('DELETE FROM spend_reservations WHERE crew_id = ?').run(crewId);
  }

  /** An Admiral turn of a job (null: a lobby) ended. Only one runs for a job at a time. */
  releaseAdmiral(jobId: number | null): void {
    this.db
      .prepare('DELETE FROM spend_reservations WHERE job_id IS ? AND crew_id IS NULL')
      .run(jobId);
  }

  /** What is reserved and not yet expired on a meter: for one job, or for all with `null`. */
  reserved(meter: SpendMeter, jobId: number | null): number {
    return (
      this.db
        .prepare<[string, number, number | null, number | null], { amount: number | null }>(
          `SELECT SUM(amount) AS amount FROM spend_reservations
           WHERE meter = ? AND expires_at > ? AND (? IS NULL OR job_id = ?)`
        )
        .get(meter, this.now(), jobId, jobId)?.amount ?? 0
    );
  }

  /** Drop reservations past their expiry, which an act that never reported leaves. */
  purgeExpired(): void {
    this.db.prepare('DELETE FROM spend_reservations WHERE expires_at <= ?').run(this.now());
  }

  // ── Levels acted on ──────────────────────────────────────────────────────

  /**
   * Note that a job reached `level` on `meter` at this budget. True the first
   * time, so each level is acted on once per budget; a raised budget is a new one.
   */
  markOnce(jobId: number, meter: SpendMeter, level: 'warn' | 'hard', budget: number): boolean {
    const existing = this.db
      .prepare<
        [number, string, string],
        { budget: number }
      >('SELECT budget FROM spend_marks WHERE job_id = ? AND meter = ? AND level = ?')
      .get(jobId, meter, level);
    if (existing?.budget === budget) return false;
    this.db
      .prepare(
        `INSERT INTO spend_marks (job_id, meter, level, budget, at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(job_id, meter, level) DO UPDATE SET budget = excluded.budget, at = excluded.at`
      )
      .run(jobId, meter, level, budget, this.now());
    return true;
  }

  // ── Crew billing ─────────────────────────────────────────────────────────

  /** How a crew member is billed, and the session cost it reported last. */
  crewCost(crewId: number): { billing: CrewBilling | null; costSeen: number | null } {
    const row = this.db
      .prepare<
        [number],
        { billing: string | null; cost_seen: number | null }
      >('SELECT billing, cost_seen FROM crew_members WHERE id = ?')
      .get(crewId);
    return { billing: asBilling(row?.billing ?? null), costSeen: row?.cost_seen ?? null };
  }

  setCrewCost(crewId: number, input: { billing?: CrewBilling; costSeen?: number }): void {
    this.db
      .prepare(
        'UPDATE crew_members SET billing = COALESCE(?, billing), cost_seen = COALESCE(?, cost_seen) WHERE id = ?'
      )
      .run(input.billing ?? null, input.costSeen ?? null, crewId);
  }

  /** How the newest Claude Code crew member that said so is billed, for one not yet heard from. */
  lastClaudeBilling(): CrewBilling | null {
    const row = this.db
      .prepare<
        [],
        { billing: string }
      >(`SELECT billing FROM crew_members WHERE runtime = 'claude' AND billing IS NOT NULL ORDER BY id DESC LIMIT 1`)
      .get();
    return asBilling(row?.billing ?? null);
  }

  // ── Subscription usage ───────────────────────────────────────────────────

  /** What Claude Code last reported of the subscription's usage windows. */
  claudeUsage(): ClaudeUsage | null {
    const row = this.db
      .prepare<[string], { value: string }>('SELECT value FROM agency_meta WHERE key = ?')
      .get(USAGE_KEY);
    return row ? parseJsonAs(Usage, row.value) : null;
  }

  setClaudeUsage(usage: ClaudeUsage): void {
    this.db
      .prepare(
        `INSERT INTO agency_meta (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`
      )
      .run(USAGE_KEY, JSON.stringify(usage));
  }
}

function asBilling(value: string | null): CrewBilling | null {
  return value === 'subscription' || value === 'api' ? value : null;
}
