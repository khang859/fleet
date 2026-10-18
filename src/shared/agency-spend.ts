/**
 * What agency jobs spend, on two meters that are never mixed:
 *
 * - `usd`: real dollars. The Admiral's model cost, Claude Code crew paid
 *   through an API key, and eva crew whose server reports cost. The job
 *   budget and the monthly cap count these.
 * - `week_pct`: Claude Code crew on the user's subscription, as a share of
 *   the weekly limit. The percentage Claude Code reports is account-wide, so
 *   a job's share is an estimate.
 */
export type SpendMeter = 'usd' | 'week_pct';

/** At this share of a budget the client is told, and SPEND turns to a warning color. */
export const SPEND_WARN_AT = 0.8;
/** At this share of a budget running crew turns and Admiral turns are interrupted. */
export const SPEND_HARD_AT = 1.2;

/** Dollar presets for a job budget; the second is the Admiral's pick. */
export const BUDGET_USD_PRESETS = [5, 10, 25, 50] as const;
/** Presets for the share of the weekly Claude limit a job may use, in percent. */
export const BUDGET_SHARE_PRESETS = [5, 10, 25, 50] as const;

/** One of Claude Code's usage windows, as its status line reports it. */
export type UsageWindow = {
  /** 0 to 100. */
  usedPct: number;
  /** When the window resets, in epoch milliseconds. */
  resetsAt: number;
};

/** The subscription usage Claude Code last reported, for the reserve. */
export type ClaudeUsage = {
  fiveHour: UsageWindow | null;
  sevenDay: UsageWindow | null;
  at: number;
};

/** One line of a job's SPEND section: the Admiral, or one crew member. */
export type SpendLine = {
  /** Null for the Admiral. */
  crewId: number | null;
  label: string;
  usd: number;
  weekPct: number;
  /** Part of it is an estimate: a share of an account-wide percentage. */
  estimate: boolean;
};

/** What a job spent against its budgets, for the job sheet. */
export type JobSpend = {
  usd: number;
  weekPct: number;
  budgetUsd: number | null;
  budgetWeekPct: number | null;
  /** The Admiral first, then crew in hiring order. */
  lines: SpendLine[];
  /** While the usage reserve keeps the job's Claude crew from starting, when the window resets. */
  reserveUntil: number | null;
};

export const NO_JOB_SPEND: JobSpend = {
  usd: 0,
  weekPct: 0,
  budgetUsd: null,
  budgetWeekPct: null,
  lines: [],
  reserveUntil: null
};

/** How far spend is through a budget; `none` when there is no budget to measure against. */
export type SpendLevel = 'none' | 'ok' | 'warn' | 'over' | 'hard';

export function spendLevel(spent: number, budget: number | null): SpendLevel {
  if (budget === null || !(budget > 0)) return 'none';
  const share = spent / budget;
  if (share >= SPEND_HARD_AT) return 'hard';
  if (share >= 1) return 'over';
  if (share >= SPEND_WARN_AT) return 'warn';
  return 'ok';
}

/** 00:00 on the 1st of the month `now` is in, in local time: when the monthly cap starts over. */
export function monthStart(now: number): number {
  const d = new Date(now);
  return new Date(d.getFullYear(), d.getMonth(), 1).getTime();
}

/** 00:00 on the 1st of the next month, in local time. */
export function nextMonthStart(now: number): number {
  const d = new Date(now);
  return new Date(d.getFullYear(), d.getMonth() + 1, 1).getTime();
}

/** `$4.20`, or `$0.004` below a cent so a small spend does not read as nothing. */
export function usdText(usd: number): string {
  if (usd > 0 && usd < 0.01) return `$${usd.toFixed(3)}`;
  return `$${usd.toFixed(2)}`;
}

/** `3.5%`, with one decimal only when it is not whole. */
export function pctText(pct: number): string {
  const rounded = Math.round(pct * 10) / 10;
  return `${Number.isInteger(rounded) ? rounded.toFixed(0) : rounded.toFixed(1)}%`;
}

/**
 * Why a budget the client typed cannot be used, or null when it can: it has
 * to be a positive number, and a dollar budget no more than the monthly cap.
 */
export function budgetProblem(
  value: number,
  meter: SpendMeter,
  monthlyCapUsd: number | null
): string | null {
  if (!Number.isFinite(value)) return 'Enter a number.';
  if (value <= 0) return 'The budget has to be more than zero.';
  if (meter === 'week_pct' && value > 100) return 'A share of the week is at most 100%.';
  if (meter === 'usd' && monthlyCapUsd !== null && value > monthlyCapUsd) {
    return `The budget cannot be more than the monthly cap of ${usdText(monthlyCapUsd)}.`;
  }
  return null;
}
