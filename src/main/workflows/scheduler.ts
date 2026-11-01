import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type {
  AwayEntry,
  StartRunResult,
  WorkflowLimits,
  WorkflowRule
} from '../../shared/workflows';
import { createLogger } from '../logger';
import type { SignedFile } from './approval';
import type { OpenPr } from './pr';

const log = createLogger('workflows:scheduler');

export const TICK_MS = 15_000;
export const SHORTEST_REPEAT_MINUTES = 5;
export const POLL_MS = 5 * 60_000;
export const DEFAULT_DAILY_LIMIT = 100;
const MAX_AWAY = 50;
const MAX_CLOSED_SEEN = 500;
const DEFAULT_MAX_AGENTS = 12;

const Time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
const Days = z.array(z.number().int().min(0).max(6));

const Trigger = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('time'), at: Time, days: Days }),
  z.object({
    kind: z.literal('interval'),
    minutes: z.number().int().min(SHORTEST_REPEAT_MINUTES),
    days: Days,
    window: z.object({ from: Time, to: Time }).nullable()
  }),
  z.object({
    kind: z.literal('new-pr'),
    includeStrangers: z.boolean(),
    includeDrafts: z.boolean()
  })
]);

export const Rule = z.object({
  id: z.string(),
  name: z.string().min(1).max(80),
  projectPath: z.string(),
  workflowId: z.string(),
  inputs: z.record(z.string(), z.string()),
  trigger: Trigger,
  missed: z.enum(['run-once', 'skip']),
  enabled: z.boolean(),
  pausedReason: z.string().nullable(),
  dailyLimit: z.number().int().min(1),
  lastStart: z.number().nullable(),
  createdAt: z.number()
});

const RulesFile = z.object({
  rules: z.array(Rule),
  /** Each rule's starts on one local day, for the daily limit. */
  starts: z.record(z.string(), z.object({ day: z.string(), count: z.number() })),
  /** PRs a new-PR rule has seen, so an old one never starts a run. */
  seen: z.record(z.string(), z.array(z.number())),
  /** PRs waiting for their run. */
  queue: z.record(z.string(), z.array(z.number())),
  limits: z.object({ maxAgents: z.number().int().min(1), runOnBattery: z.boolean() }),
  /** What rules did while nobody was here. */
  away: z.array(
    z.object({
      id: z.string(),
      at: z.number(),
      ruleId: z.string().nullable(),
      ruleName: z.string(),
      text: z.string(),
      canRun: z.boolean()
    })
  )
});
type RulesFile = z.infer<typeof RulesFile>;

function minutesOf(time: string): number {
  const [hours, minutes] = time.split(':').map(Number);
  return hours * 60 + minutes;
}

function localMinutes(date: Date): number {
  return date.getHours() * 60 + date.getMinutes();
}

function dayOn(days: number[], date: Date): boolean {
  return days.includes(date.getDay());
}

/** Whether a moment is inside an "only between" window. A window can cross midnight. */
export function inWindow(window: { from: string; to: string }, date: Date): boolean {
  const from = minutesOf(window.from);
  const to = minutesOf(window.to);
  const now = localMinutes(date);
  // The same time twice is a whole day, as `runsPerDay` counts it.
  if (from === to) return true;
  return from < to ? now >= from && now < to : now >= from || now < to;
}

/**
 * A clock time on one day. In a skipped hour it is the first valid minute after
 * the gap. In a repeated hour, JavaScript takes the first pass, which is the rule.
 */
export function wallTime(day: Date, at: string): Date {
  const [hours, minutes] = at.split(':').map(Number);
  const date = new Date(day.getFullYear(), day.getMonth(), day.getDate(), hours, minutes);
  if (date.getHours() === hours && date.getMinutes() === minutes) return date;
  const beforeGap = new Date(day.getFullYear(), day.getMonth(), day.getDate(), hours - 1, 59);
  return new Date(beforeGap.getTime() + 60_000);
}

/** The next clock start after a moment. */
export function nextClockStart(at: string, days: number[], after: Date): Date | null {
  if (days.length === 0) return null;
  for (let offset = 0; offset <= 7; offset++) {
    const day = new Date(after.getFullYear(), after.getMonth(), after.getDate() + offset);
    if (!dayOn(days, day)) continue;
    const start = wallTime(day, at);
    if (start.getTime() > after.getTime()) return start;
  }
  return null;
}

export type Due = { due: boolean; missed: boolean };

/** Whether a clock or repeat rule should start now, and whether it missed a start. */
export function dueNow(rule: WorkflowRule, now: Date, tickMs: number = TICK_MS): Due {
  const { trigger } = rule;
  const from = rule.lastStart ?? rule.createdAt;
  if (trigger.kind === 'time') {
    const start = nextClockStart(trigger.at, trigger.days, new Date(from));
    if (start === null || start.getTime() > now.getTime()) return { due: false, missed: false };
    return { due: true, missed: now.getTime() - start.getTime() > 4 * tickMs };
  }
  if (trigger.kind === 'interval') return intervalDue(trigger, from, rule.lastStart, now, tickMs);
  return { due: false, missed: false };
}

function intervalDue(
  trigger: Extract<WorkflowRule['trigger'], { kind: 'interval' }>,
  from: number,
  lastStart: number | null,
  now: Date,
  tickMs: number
): Due {
  // Real elapsed time, so a clock change does not move it.
  const period = trigger.minutes * 60_000;
  const elapsed = now.getTime() - from;
  if (lastStart !== null && elapsed < period) return { due: false, missed: false };
  if (lastStart === null && elapsed < tickMs) return { due: false, missed: false };
  const late = 4 * tickMs;
  if (!intervalOpen(trigger, now)) return { due: false, missed: false };
  // The first start after the days or window open is on time, however long they were shut.
  const wasOpen = intervalOpen(trigger, new Date(now.getTime() - late));
  return { due: true, missed: wasOpen && elapsed > period + late };
}

function intervalOpen(
  trigger: Extract<WorkflowRule['trigger'], { kind: 'interval' }>,
  date: Date
): boolean {
  return dayOn(trigger.days, date) && (!trigger.window || inWindow(trigger.window, date));
}

function dayKey(date: Date): string {
  return `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`;
}

/** Which of the open PRs a new-PR rule should take. */
export function wantedPrs(
  rule: Extract<WorkflowRule['trigger'], { kind: 'new-pr' }>,
  prs: OpenPr[]
): OpenPr[] {
  return prs.filter(
    (pr) => !pr.bot && (rule.includeDrafts || !pr.draft) && (rule.includeStrangers || pr.team)
  );
}

export type StartOutcome =
  | { ok: true }
  /** Busy with this target, or its PR closed. The start is recorded as skipped. */
  | { ok: false; busy: true; reason: string }
  /** The start cannot work unattended. Fleet records it once and pauses the rule. */
  | { ok: false; busy: false; reason: string };

/**
 * A PR can close while it waits on the queue, and that needs no person.
 * A rule that names a closed PR itself would fail each time, so that pauses it.
 */
export function startOutcome(started: StartRunResult, pr: number | null): StartOutcome {
  if (started.ok) return { ok: true };
  const skipped = started.code === 'duplicate' || (started.code === 'pr-closed' && pr !== null);
  return { ok: false, busy: skipped, reason: started.message };
}

export type SchedulerDeps = {
  file: SignedFile<RulesFile>;
  now: () => number;
  /** Why a rule cannot use its workflow, or null. */
  ruleProblem: (rule: WorkflowRule) => string | null;
  /** Start a run for a rule. `pr` is set for a new-PR rule. */
  start: (rule: WorkflowRule, pr: number | null) => Promise<StartOutcome>;
  busy: (rule: WorkflowRule) => boolean;
  onBattery: () => boolean;
  listPrs: (rule: WorkflowRule) => Promise<OpenPr[]>;
  onChange: () => void;
};

export const EMPTY_RULES: RulesFile = {
  rules: [],
  starts: {},
  seen: {},
  queue: {},
  limits: { maxAgents: DEFAULT_MAX_AGENTS, runOnBattery: false },
  away: []
};
export const RULES_SCHEMA = RulesFile;

/**
 * Starts runs from personal rules while Fleet is open. It reads the clock every
 * 15 seconds, because a long timer is not reliable across sleep, and it saves
 * the last start before it starts a run.
 */
export class WorkflowScheduler {
  private timer: ReturnType<typeof setInterval> | null = null;
  private data: RulesFile;
  private lastPoll = new Map<string, number>();
  private ticking = false;

  constructor(private readonly deps: SchedulerDeps) {
    this.data = deps.file.read();
  }

  start(): void {
    if (this.timer !== null) return;
    void this.tick();
    this.timer = setInterval(() => void this.tick(), TICK_MS);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
  }

  rules(): WorkflowRule[] {
    return this.data.rules;
  }

  limits(): WorkflowLimits {
    return this.data.limits;
  }

  setLimits(limits: WorkflowLimits): void {
    this.data.limits = limits;
    this.save();
  }

  awayList(): AwayEntry[] {
    return this.data.away;
  }

  clearAway(): void {
    this.data.away = [];
    this.save();
  }

  private save(): void {
    this.deps.file.write(this.data);
    this.deps.onChange();
  }

  saveRule(
    input: Omit<WorkflowRule, 'id' | 'createdAt' | 'lastStart'> & { id?: string }
  ): WorkflowRule {
    const existing = this.data.rules.find((rule) => rule.id === input.id);
    if (input.id !== undefined && !existing) throw new Error('This rule was deleted.');
    const rule: WorkflowRule = {
      ...input,
      // The form does not edit these. They can change while it is open.
      enabled: existing?.enabled ?? input.enabled,
      pausedReason: existing ? existing.pausedReason : input.pausedReason,
      id: existing?.id ?? randomUUID(),
      createdAt: existing?.createdAt ?? this.deps.now(),
      lastStart: existing?.lastStart ?? null
    };
    const problem = this.deps.ruleProblem(rule);
    if (problem) throw new Error(problem);
    const parsed = Rule.parse(rule);
    this.data.rules = existing
      ? this.data.rules.map((other) => (other.id === rule.id ? parsed : other))
      : [...this.data.rules, parsed];
    this.save();
    return parsed;
  }

  deleteRule(id: string): void {
    this.data.rules = this.data.rules.filter((rule) => rule.id !== id);
    delete this.data.starts[id];
    delete this.data.seen[id];
    delete this.data.queue[id];
    this.save();
  }

  setEnabled(id: string, enabled: boolean): void {
    this.update(id, { enabled, pausedReason: null });
  }

  private update(id: string, change: Partial<WorkflowRule>): void {
    this.data.rules = this.data.rules.map((rule) =>
      rule.id === id ? { ...rule, ...change } : rule
    );
    this.save();
  }

  /** Fix a paused rule: a person approved its file, so it goes on with no extra step. */
  resumePaused(match: (rule: WorkflowRule) => boolean): void {
    for (const rule of this.data.rules) {
      if (rule.pausedReason !== null && match(rule)) this.update(rule.id, { pausedReason: null });
    }
  }

  pause(id: string, reason: string): void {
    this.update(id, { pausedReason: reason });
  }

  raiseDailyLimit(id: string, limit: number): void {
    this.update(id, { dailyLimit: limit });
  }

  private startsToday(rule: WorkflowRule, now: Date): number {
    const entry = this.data.starts[rule.id] as { day: string; count: number } | undefined;
    return entry?.day === dayKey(now) ? entry.count : 0;
  }

  private countStart(rule: WorkflowRule, now: Date): void {
    this.data.starts[rule.id] = { day: dayKey(now), count: this.startsToday(rule, now) + 1 };
  }

  private away(rule: WorkflowRule, text: string, canRun: boolean): void {
    const entry = {
      id: randomUUID(),
      at: this.deps.now(),
      ruleId: rule.id,
      ruleName: rule.name,
      text,
      canRun
    };
    this.data.away = [...this.data.away, entry].slice(-MAX_AWAY);
    this.save();
  }

  /** One reading of the clock. Work from an earlier tick is never doubled. */
  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const now = new Date(this.deps.now());
      for (const { id } of this.data.rules) await this.checkRule(id, now);
    } catch (err) {
      // A tick that throws must not stop every rule for the rest of the run.
      log.warn('workflow rule tick failed', { error: String(err) });
    } finally {
      this.ticking = false;
    }
  }

  /** The rule as it is now, if it may start. A person can change it during any wait. */
  private live(id: string): WorkflowRule | null {
    const rule = this.data.rules.find((candidate) => candidate.id === id);
    return rule?.enabled && rule.pausedReason === null ? rule : null;
  }

  private async checkRule(id: string, now: Date): Promise<void> {
    const rule = this.live(id);
    if (!rule) return;
    if (rule.trigger.kind === 'new-pr') {
      await this.checkNewPrs(rule, now);
      return;
    }
    const { due, missed } = dueNow(rule, now);
    if (!due) return;
    if (missed && rule.missed === 'skip') {
      this.update(rule.id, { lastStart: now.getTime() });
      this.away(rule, 'A start was missed while Fleet was away, and this rule skips those.', true);
      return;
    }
    await this.fire(rule, null, now, missed);
  }

  /** Whether power and limits allow a start. A refusal is recorded once, with a way on. */
  private allowed(rule: WorkflowRule, now: Date): boolean {
    if (this.deps.onBattery() && !this.data.limits.runOnBattery) return false;
    if (this.startsToday(rule, now) >= rule.dailyLimit) {
      if (this.startsToday(rule, now) === rule.dailyLimit) {
        this.away(rule, `This rule reached its daily limit of ${rule.dailyLimit} runs.`, true);
        this.countStart(rule, now);
        this.save();
      }
      return false;
    }
    return true;
  }

  private async fire(
    rule: WorkflowRule,
    pr: number | null,
    now: Date,
    missed: boolean
  ): Promise<boolean> {
    if (!this.allowed(rule, now)) return false;
    if (this.deps.busy(rule)) {
      this.update(rule.id, { lastStart: now.getTime() });
      this.away(rule, 'A start was skipped, because the last run was still busy.', true);
      return false;
    }
    // Saved first, so a crash during the start can never double it.
    this.countStart(rule, now);
    this.update(rule.id, { lastStart: now.getTime() });
    const outcome = await this.deps.start(rule, pr);
    if (outcome.ok) {
      if (missed) this.away(rule, 'A missed start ran when Fleet came back.', false);
      return true;
    }
    if (outcome.busy) {
      this.away(rule, `A start was skipped: ${outcome.reason}`, true);
      // A PR with a run on it, or a closed one, needs no run. It leaves the queue.
      return pr !== null;
    }
    this.pause(rule.id, outcome.reason);
    this.away(rule, `This rule paused: ${outcome.reason}`, false);
    return false;
  }

  private async checkNewPrs(rule: WorkflowRule, now: Date): Promise<void> {
    await this.pollPrs(rule, now);
    const current = this.live(rule.id);
    if (!current) return;
    const queue = this.data.queue[rule.id] as number[] | undefined;
    const next = queue?.[0];
    if (next === undefined || this.deps.busy(current)) return;
    // Taken off the queue only when it started, so no PR is lost.
    if (await this.fire(current, next, now, false)) this.dropFromQueue(rule.id, next);
  }

  private dropFromQueue(id: string, pr: number): void {
    const queue = this.data.queue[id] as number[] | undefined;
    if (!queue) return;
    this.data.queue[id] = queue.filter((other) => other !== pr);
    this.save();
  }

  private async pollPrs(rule: WorkflowRule, now: Date): Promise<void> {
    if (rule.trigger.kind !== 'new-pr') return;
    const last = this.lastPoll.get(rule.id) ?? 0;
    if (now.getTime() - last < POLL_MS) return;
    this.lastPoll.set(rule.id, now.getTime());

    let open: OpenPr[];
    try {
      open = await this.deps.listPrs(rule);
    } catch (err) {
      log.warn('could not list PRs', { ruleId: rule.id, error: String(err) });
      return;
    }
    const current = this.live(rule.id);
    if (current?.trigger.kind !== 'new-pr') return;
    const known = this.data.seen[rule.id] as number[] | undefined;
    const numbers = open.map((pr) => pr.number);
    // The first check only records what exists.
    if (known === undefined) {
      this.data.seen[rule.id] = numbers;
      this.save();
      return;
    }
    const wanted = wantedPrs(current.trigger, open).map((pr) => pr.number);
    // Pages can repeat a PR when one opens during the read.
    const fresh = [...new Set(wanted)].filter((number) => !known.includes(number));
    // Only closed PRs can fall off the list, so an open one is never new twice.
    const closed = known.filter((number) => !numbers.includes(number));
    this.data.seen[rule.id] = [...closed.slice(-MAX_CLOSED_SEEN), ...new Set(numbers)];
    if (fresh.length > 0) {
      this.data.queue[rule.id] = [
        ...(this.data.queue[rule.id] ?? []),
        ...fresh.sort((a, b) => a - b)
      ];
    }
    this.save();
  }

  /** Run now, from a person. A start counts as the rule's last start, so the wait starts over. */
  async runNow(id: string): Promise<StartOutcome> {
    const rule = this.data.rules.find((candidate) => candidate.id === id);
    if (!rule) return { ok: false, busy: false, reason: 'This rule no longer exists.' };
    const outcome = await this.deps.start(rule, null);
    if (outcome.ok) this.update(rule.id, { lastStart: this.deps.now() });
    return outcome;
  }
}
