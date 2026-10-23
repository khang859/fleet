import {
  jobDisplayId,
  type AgencyJob,
  type AgencySettings,
  type BudgetRaise,
  type WakeupPull
} from '../../../shared/agency';
import type { CrewRuntime } from '../../../shared/agency-crew';
import {
  monthStart,
  nextMonthStart,
  pctText,
  SPEND_WARN_AT,
  usdText,
  type ClaudeUsage,
  type JobSpend,
  type SpendMeter,
  type UsageWindow
} from '../../../shared/agency-spend';
import type { SessionSpend } from '../../claude-sessions';
import { Ticker } from '../ticker';
import type { AgencyStore, AgencyTouched } from '../store/agency-store';
import { CREW_ENDED, type CrewRecord } from '../store/crew-store';
import type { CrewBilling } from '../store/spend-store';

/** How long an estimate stays reserved for an act that never reports. */
const RESERVE_TTL_MS = 30 * 60_000;
/** What an act about to start is taken to cost until it reports. */
const ESTIMATE = { admiralUsd: 0.05, crewUsd: 0.25, crewWeekPct: 0.5 };
const TICK_MS = 30_000;
/** How soon an Admiral held back by work under way looks again. */
const BUSY_RETRY_MS = 60_000;

/** What a crew member's runtime reported of its spend: a Claude Code status line, or an eva Stop. */
export type UsageReport = SessionSpend;

/** A crew member's prompt or hire, which costs money; `crewId` is null for a hire not made yet. */
export type SpendAct = { runtime: CrewRuntime; crewId: number | null };

/**
 * Why work may not start: the monthly cap reached, the work
 * under way already reserving what is left (`busy`), or the subscription at
 * the reserve kept for the user.
 */
export type SpendRefusal = {
  ok: false;
  reason: 'cap' | 'busy' | 'reserve';
  text: string;
};

export type SpendGate = { ok: true; reservationId: number } | SpendRefusal;

/** Why new Claude crew work waits for the user's reserve, and until when. */
export type ReserveWait = { until: number; why: string };

export type SpendServiceDeps = {
  store: AgencyStore;
  settings: () => AgencySettings['admiral'];
  changed: (touched: AgencyTouched[]) => void;
  now: () => number;
  /** Whether a crew member's session is in a turn now. */
  working: (sessionId: string) => boolean;
  /** Queued steps may go again, as the reserve cleared. */
  admitQueued: () => void;
};

/**
 * Spend on both meters, the monthly cap check before work starts, and the
 * one note to the Admiral as a job's spend passes 80% of its budget, which
 * is a guide only.
 *
 * Every check and its reservation run in one transaction, so two jobs that
 * act at the same moment cannot both pass a cap there is room for only once.
 */
export class SpendService {
  private readonly ticker = new Ticker();
  /** Whether the reserve held Claude crew back at the last look, to admit queued steps once it clears. */
  private reserveHeld = false;
  /** The reset each job's Admiral is already woken for, so a refused prompt does not queue another. */
  private readonly reserveWakeups = new Map<number, number>();

  constructor(private readonly deps: SpendServiceDeps) {}

  private get store(): AgencyStore {
    return this.deps.store;
  }

  // ── Samples ──────────────────────────────────────────────────────────────

  /** A crew member's runtime reported its spend. */
  usage(report: UsageReport): void {
    const crew = this.store.crew.live().find((c) => c.sessionId === report.sessionId) ?? null;
    if (report.runtime === 'claude' && report.rateLimits !== null) {
      this.subscriptionUsage(report.rateLimits, crew);
    }
    if (crew === null) return;
    const touched = this.store.tx(() => this.sessionCost(crew, report));
    if (touched) this.afterSpend(crew.jobId);
  }

  /**
   * Dollars from the session's own cost: eva's, and a Claude Code member's
   * paid by API key. A cost lower than the last is a new conversation
   * (`/clear`), counted from zero.
   */
  private sessionCost(crew: CrewRecord, report: UsageReport): boolean {
    const { billing, costSeen } = this.costBefore(crew);
    let paidBy: CrewBilling | null = billing;
    if (report.runtime === 'claude') {
      if (report.rateLimits !== null) paidBy = 'subscription';
      // No windows once a reply came: Claude Code runs on an API key.
      else if (billing === null && (report.costUsd ?? 0) > 0) paidBy = 'api';
    }
    const cost = report.costUsd;
    if (cost === null) {
      if (paidBy !== billing && paidBy !== null)
        this.store.spend.setCrewCost(crew.id, { billing: paidBy });
      return false;
    }
    const delta = costSeen !== null && cost >= costSeen ? cost - costSeen : cost;
    this.store.spend.setCrewCost(crew.id, { billing: paidBy ?? undefined, costSeen: cost });
    const dollars = report.runtime === 'eva' || paidBy === 'api';
    if (!dollars || !(delta > 0)) return false;
    this.store.spend.record({
      jobId: crew.jobId,
      crewId: crew.id,
      source: 'crew',
      meter: 'usd',
      amount: delta
    });
    return true;
  }

  /**
   * How the member is billed and the cost it reported last. A member that
   * resumed a session starts from the one it took over: `--resume` shows the
   * conversation's cost so far before a reply brings the subscription windows.
   */
  private costBefore(crew: CrewRecord): { billing: CrewBilling | null; costSeen: number | null } {
    const own = this.store.spend.crewCost(crew.id);
    if (own.billing !== null || own.costSeen !== null || crew.replaces === null) return own;
    const resumed = this.store.crew.get(crew.replaces);
    return resumed?.sessionId === crew.sessionId ? this.store.spend.crewCost(resumed.id) : own;
  }

  /**
   * The subscription's windows, kept for the reserve, and a rise in the weekly
   * one split evenly across the jobs with Claude crew working now: the
   * reporting member's, and any other's. The percentage is account-wide, so
   * each share is an estimate.
   */
  private subscriptionUsage(
    windows: NonNullable<UsageReport['rateLimits']>,
    reporter: CrewRecord | null
  ): void {
    const touched = this.store.tx(() => {
      const before = this.store.spend.claudeUsage();
      const next: ClaudeUsage = {
        fiveHour: windows.fiveHour ?? before?.fiveHour ?? null,
        sevenDay: windows.sevenDay ?? before?.sevenDay ?? null,
        at: this.deps.now()
      };
      this.store.spend.setClaudeUsage(next);
      const rise = weeklyRise(before?.sevenDay ?? null, windows.sevenDay);
      return rise > 0 ? this.splitRise(rise, reporter) : [];
    });
    for (const jobId of touched) this.afterSpend(jobId);
  }

  private splitRise(rise: number, reporter: CrewRecord | null): number[] {
    const working = this.store.crew
      .live()
      .filter(
        (c) =>
          c.runtime === 'claude' &&
          (c.id === reporter?.id ||
            (c.sessionId !== null &&
              this.store.spend.crewCost(c.id).billing !== 'api' &&
              this.deps.working(c.sessionId)))
      );
    const byJob = new Map<number, CrewRecord[]>();
    for (const c of working) byJob.set(c.jobId, [...(byJob.get(c.jobId) ?? []), c]);
    for (const [jobId, crew] of byJob) {
      const share = rise / byJob.size / crew.length;
      for (const c of crew) {
        this.store.spend.record({
          jobId,
          crewId: c.id,
          source: 'crew',
          meter: 'week_pct',
          amount: share,
          estimate: true
        });
      }
    }
    return [...byJob.keys()];
  }

  /** An Admiral turn of a job (null: a lobby) ended, having cost `costUsd`. */
  admiralTurn(jobId: number | null, costUsd: number | null): void {
    this.store.tx(() => {
      this.store.spend.releaseAdmiral(jobId);
      this.store.spend.record({
        jobId,
        crewId: null,
        source: 'admiral',
        meter: 'usd',
        amount: costUsd ?? 0
      });
    });
    if (jobId !== null && (costUsd ?? 0) > 0) this.afterSpend(jobId);
  }

  /**
   * Hold the estimate of an Admiral call that belongs to no job, such as Read
   * your work, or say why the monthly cap does not let it run.
   */
  reserveAdmiralCall(): SpendGate {
    return this.store.tx(() => {
      this.store.spend.purgeExpired();
      const refused = this.capRefusal(null);
      if (refused !== null) return refused;
      const reservationId = this.store.spend.reserve({
        jobId: null,
        crewId: null,
        meter: 'usd',
        amount: ESTIMATE.admiralUsd,
        ttlMs: RESERVE_TTL_MS
      });
      return { ok: true, reservationId };
    });
  }

  /** That call ended, having cost `costUsd`: Admiral spend with no job. */
  admiralCallDone(reservationId: number, costUsd: number | null): void {
    this.store.tx(() => {
      this.store.spend.cancel(reservationId);
      if (costUsd === null || !(costUsd > 0)) return;
      this.store.spend.record({
        jobId: null,
        crewId: null,
        source: 'admiral',
        meter: 'usd',
        amount: costUsd
      });
    });
  }

  /** A crew member's turn ended or it left: what it cost is in the samples now. */
  crewSettled(crewId: number): void {
    this.store.spend.releaseCrew(crewId);
  }

  // ── Checks ───────────────────────────────────────────────────────────────

  /**
   * Check the monthly cap before a crew member's prompt or hire, and reserve
   * its estimate in the same transaction, so two jobs acting at once cannot
   * both take the last of the cap. A job at the cap is held and asks the
   * client to raise it or stop.
   */
  gate(job: AgencyJob, act: SpendAct): SpendGate {
    const gate = this.store.tx((): SpendGate => {
      this.store.spend.purgeExpired();
      const refused = this.capRefusal(job.id);
      if (refused !== null) return refused;
      const meter = this.meterOf(act);
      if (act.runtime === 'claude' && meter === 'week_pct') {
        const wait = this.reserveWait();
        if (wait !== null) return { ok: false, reason: 'reserve', text: wait.why };
      }
      const reservationId = this.store.spend.reserve({
        jobId: job.id,
        crewId: act.crewId,
        meter,
        amount: meter === 'usd' ? ESTIMATE.crewUsd : ESTIMATE.crewWeekPct,
        ttlMs: RESERVE_TTL_MS
      });
      return { ok: true, reservationId };
    });
    if (!gate.ok && gate.reason === 'reserve') this.wakeAfterReserve(job);
    else if (!gate.ok && gate.reason !== 'busy') this.holdForBudget(job.id);
    return gate;
  }

  /**
   * Claim the wakeups due for a job's (null: the lobby's) automatic Admiral
   * turn, with the monthly cap checked and the turn's estimate reserved in
   * the same transaction. At the cap, only the client's own answers and
   * actions are claimed: those turns run, nothing else does.
   */
  admiralPull(jobId: number | null, pull: (clientOnly: boolean) => WakeupPull): WakeupPull {
    const { pulled, held } = this.store.tx(() => {
      this.store.spend.purgeExpired();
      const job = jobId === null ? null : this.store.getJob(jobId);
      const refused = this.capRefusal(jobId);
      const clientOnly = refused !== null || job?.holds.includes('budget') === true;
      const claimed = pull(clientOnly);
      const over = job !== null && refused?.reason === 'cap';
      // Room comes back as the work under way ends, which nothing announces: look again soon.
      if (refused?.reason === 'busy') {
        const soon = this.deps.now() + BUSY_RETRY_MS;
        return {
          pulled: { ...claimed, nextDueAt: Math.min(claimed.nextDueAt ?? soon, soon) },
          held: null
        };
      }
      if (!clientOnly && claimed.ids.length > 0) {
        this.store.spend.releaseAdmiral(jobId);
        this.store.spend.reserve({
          jobId,
          crewId: null,
          meter: 'usd',
          amount: ESTIMATE.admiralUsd,
          ttlMs: RESERVE_TTL_MS
        });
      }
      return { pulled: claimed, held: over ? job.id : null };
    });
    if (held !== null) this.holdForBudget(held);
    return pulled;
  }

  /** Drop a reservation for an act that did not start after all. */
  cancel(reservationId: number): void {
    this.store.spend.cancel(reservationId);
  }

  /** Tie a hire's reservation to the member it made. */
  attach(reservationId: number, crewId: number): void {
    this.store.spend.attach(reservationId, crewId);
  }

  /** Wake the job's Admiral once the reserve that refused its prompt resets, one wakeup per reset. */
  private wakeAfterReserve(job: AgencyJob): void {
    const wait = this.reserveWait();
    if (wait === null || this.reserveWakeups.get(job.id) === wait.until) return;
    this.reserveWakeups.set(job.id, wait.until);
    this.store.enqueueWakeup({
      repoId: job.repoId,
      jobId: job.id,
      kind: 'event',
      payload: { line: 'The Claude usage reserve reset; Claude crew may work again', body: null },
      notBefore: wait.until
    });
  }

  private meterOf(act: SpendAct): SpendMeter {
    if (act.runtime === 'eva') return 'usd';
    const billing =
      (act.crewId === null ? null : this.store.spend.crewCost(act.crewId).billing) ??
      this.store.spend.lastClaudeBilling();
    return billing === 'api' ? 'usd' : 'week_pct';
  }

  private capRefusal(jobId: number | null): SpendRefusal | null {
    const cap = this.deps.settings().monthlyCapUsd;
    const now = this.deps.now();
    const spent = this.store.spend.usdSince(monthStart(now));
    const who = jobId === null ? 'The Admiral' : jobDisplayId(jobId);
    if (spent < cap) {
      if (spent + this.store.spend.reserved('usd', null) < cap) return null;
      return {
        ok: false,
        reason: 'busy',
        text: `${who} cannot start more work while the work under way finishes: it would pass the ${usdText(cap)} monthly cap. Try again after a crew member ends its turn.`
      };
    }
    const next = new Date(nextMonthStart(now)).toLocaleDateString(undefined, {
      month: 'long',
      day: 'numeric'
    });
    return {
      ok: false,
      reason: 'cap',
      text: `${who} cannot start more work: agency jobs reached the ${usdText(cap)} monthly cap (${usdText(spent)} spent this month). The cap starts over on ${next}.`
    };
  }

  /**
   * The reserve wait for Claude crew not known to run on an API key, which
   * the reserve does not hold back.
   */
  claudeWait(): ReserveWait | null {
    return this.store.spend.lastClaudeBilling() === 'api' ? null : this.reserveWait();
  }

  /**
   * While the subscription's 5-hour window or weekly limit is at the reserve
   * kept for the user, no new Claude crew work starts: until the later of the
   * windows that are over it resets. Null when there is room.
   */
  reserveWait(): ReserveWait | null {
    const usage = this.store.spend.claudeUsage();
    if (usage === null) return null;
    const { reserveFiveHourPct, reserveSevenDayPct } = this.deps.settings();
    const now = this.deps.now();
    const over = [
      { window: usage.fiveHour, limit: reserveFiveHourPct, name: '5-hour window' },
      { window: usage.sevenDay, limit: reserveSevenDayPct, name: 'weekly limit' }
    ].filter(
      (w): w is typeof w & { window: UsageWindow } =>
        w.window !== null && w.window.usedPct >= w.limit && w.window.resetsAt > now
    );
    if (over.length === 0) return null;
    const until = Math.max(...over.map((w) => w.window.resetsAt));
    const at = new Date(until).toLocaleString(undefined, {
      weekday: 'short',
      hour: 'numeric',
      minute: '2-digit'
    });
    const why = over
      .map((w) => `the Claude ${w.name} is at ${pctText(w.window.usedPct)}`)
      .join(' and ');
    return {
      until,
      why: `Claude crew wait: ${why}, at or over the reserve kept for you. They start again after it resets at ${at}.`
    };
  }

  // ── Levels ───────────────────────────────────────────────────────────────

  /**
   * After a job spent more: note it to the Admiral once past 80% of a
   * budget, and hold the job behind a raise-or-stop card at the monthly cap.
   */
  private afterSpend(jobId: number): void {
    const job = this.store.getJob(jobId);
    if (!job) return;
    const spent = this.store.spend.jobTotals(jobId);
    for (const [meter, used, budget] of [
      ['usd', spent.usd, job.budgetUsd],
      ['week_pct', spent.weekPct, job.budgetWeekPct]
    ] as const) {
      if (budget === null || used < budget * SPEND_WARN_AT) continue;
      if (this.store.spend.markOnce(jobId, meter, 'warn', budget)) {
        this.warn(job, meter, used, budget);
      }
    }
    if (this.capRefusal(jobId) !== null) this.holdForBudget(jobId);
    this.deps.changed([{ repoId: job.repoId, jobId }]);
  }

  private warn(job: AgencyJob, meter: SpendMeter, used: number, budget: number): void {
    const text =
      meter === 'usd'
        ? `${usdText(used)} of its ${usdText(budget)} budget`
        : `about ${pctText(used)} of its ${pctText(budget)} share of the weekly Claude limit`;
    this.store.plans.log({ jobId: job.id, kind: 'spend', text: `Spend passed 80%: ${text}` });
    this.store.enqueueWakeup({
      repoId: job.repoId,
      jobId: job.id,
      kind: 'event',
      payload: {
        line: `${jobDisplayId(job.id)} has spent ${text}`,
        body: 'The budget is a guide only. Keep going if the work needs it; do not tell the client.'
      }
    });
  }

  /**
   * Hold a job that reached the monthly cap, and put up one card that asks
   * the client to raise it or stop the job.
   */
  private holdForBudget(jobId: number): void {
    const job = this.store.getJob(jobId);
    if (!job) return;
    const card = this.budgetCard(job);
    if (card === null) return;
    this.store.tx(() => {
      if (this.store.openFleetCards(jobId, 'budget').length === 0) {
        this.store.askQuestion({
          repoId: job.repoId,
          jobId,
          kind: 'budget',
          question: card.question,
          context: card.context,
          options: [
            { label: card.raiseLabel, detail: card.raiseDetail },
            { label: 'Stop the job', detail: 'cancel it and clean up' }
          ],
          recommended: null,
          raise: card.raise
        });
      }
      this.store.addHold(jobId, 'budget', card.question);
    });
    this.deps.changed([{ repoId: job.repoId, jobId }]);
  }

  /** What the raise-or-stop card says once agency jobs reach the monthly cap. */
  private budgetCard(job: AgencyJob): {
    question: string;
    context: string;
    raiseLabel: string;
    raiseDetail: string;
    raise: BudgetRaise;
  } | null {
    const cap = this.capRefusal(job.id);
    // Work under way that would pass the cap only waits; the cap is not reached yet.
    if (cap?.reason !== 'cap') return null;
    const monthly = this.deps.settings().monthlyCapUsd;
    const to = raiseTo(monthly, this.store.spend.usdSince(monthStart(this.deps.now())));
    return {
      question: `Agency jobs reached the ${usdText(monthly)} monthly cap`,
      context: `${cap.text} No new crew work or automatic Admiral turn starts until you choose.`,
      raiseLabel: `Raise the cap to ${usdText(to)}`,
      raiseDetail: 'for every job, in Settings › Agency › Admiral',
      raise: { target: 'cap', to }
    };
  }

  /**
   * Look again at jobs held for the cap, as the cap changed or a month began:
   * one with room again runs, and its card comes down, and one still at the
   * cap gets a card if none is up. `tell` wakes the Admiral of a job that may
   * go on; the client's raise tells it itself.
   */
  recheck(jobId?: number, tell = true): void {
    const held = this.store
      .jobsIn(['running', 'waiting', 'planned'])
      .filter((j) => j.holds.includes('budget') && (jobId === undefined || j.id === jobId));
    for (const job of held) {
      if (this.budgetCard(job) !== null) {
        this.holdForBudget(job.id);
        continue;
      }
      this.store.tx(() => {
        this.store.withdrawFleetCards(job.id, 'budget', 'the budget has room again');
        this.store.releaseHold(job.id, 'budget');
        if (tell) {
          this.store.enqueueWakeup({
            repoId: job.repoId,
            jobId: job.id,
            kind: 'event',
            payload: { line: `${jobDisplayId(job.id)} has budget left again`, body: null }
          });
        }
      });
      this.deps.changed([{ repoId: job.repoId, jobId: job.id }]);
    }
  }

  // ── The job sheet ────────────────────────────────────────────────────────

  /** What a job spent, by the Admiral and each crew member, against its budgets. */
  jobSpend(job: AgencyJob): JobSpend {
    const totals = this.store.spend.jobTotals(job.id);
    const sources = new Map(this.store.spend.bySource(job.id).map((s) => [s.crewId, s]));
    const admiral = sources.get(null);
    const crew = this.store.crew.all(job.id);
    const waits =
      crew.some((c) => c.runtime === 'claude' && c.status !== CREW_ENDED) ||
      this.store.plans.steps(job.id).some((s) => s.status === 'queued');
    const wait = waits ? this.claudeWait() : null;
    return {
      usd: totals.usd,
      weekPct: totals.weekPct,
      budgetUsd: job.budgetUsd,
      budgetWeekPct: job.budgetWeekPct,
      lines: [
        {
          crewId: null,
          label: 'Admiral',
          usd: admiral?.usd ?? 0,
          weekPct: 0,
          estimate: false
        },
        ...crew.map((c) => {
          const s = sources.get(c.id);
          return {
            crewId: c.id,
            label: c.label,
            usd: s?.usd ?? 0,
            weekPct: s?.weekPct ?? 0,
            estimate: s?.estimate ?? false
          };
        })
      ],
      reserveUntil: wait?.until ?? null
    };
  }

  // ── Ticking ──────────────────────────────────────────────────────────────

  startTicking(intervalMs = TICK_MS): void {
    this.ticker.start(() => this.tick(), intervalMs);
  }

  stopTicking(): void {
    this.ticker.stop();
  }

  /** Drop stale reservations, free jobs a new month or a raise left room for, and admit steps the reserve held. */
  tick(): void {
    this.store.spend.purgeExpired();
    this.recheck();
    const held = this.reserveWait() !== null;
    if (this.reserveHeld && !held) this.deps.admitQueued();
    this.reserveHeld = held;
  }
}

/** The rise in the weekly percentage since the last report, within the same week. */
function weeklyRise(before: UsageWindow | null, now: UsageWindow | null): number {
  if (before === null || now === null) return 0;
  // A new week, or Claude Code's reset time moved by more than a minute: a new window.
  if (Math.abs(now.resetsAt - before.resetsAt) > 60_000) return 0;
  return Math.max(0, now.usedPct - before.usedPct);
}

/** Half again the cap, or a quarter past what is spent if that is more, in whole dollars. */
function raiseTo(cap: number, spent: number): number {
  return Math.ceil(Math.max(cap * 1.5, spent * 1.25));
}
