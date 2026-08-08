import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { jitterMs, nextFireAfter, parseCron } from '../../shared/agent-schedule-cron';
import {
  AgentScheduleFileSchema,
  MAX_SCHEDULES_PER_SESSION,
  MAX_SCHEDULE_CHAIN_DEPTH,
  MIN_SCHEDULE_DELAY_MS,
  SCHEDULE_EXPIRY_MS,
  SCHEDULE_FILE_VERSION,
  type AgentScheduleRecord
} from '../../shared/agent-schedule';
import { createLogger } from '../logger';

const log = createLogger('agent:schedules');

const SCHEDULE_FILE = join(homedir(), '.fleet', 'agent', 'schedules.json');

/**
 * A create declined because the conversation is already holding as many
 * schedules as Fleet will hold for it.
 *
 * Its own type because it is the one refusal here that does not mean the model
 * got something wrong. Every other refusal is a mistake in the call itself; this
 * one is a full shelf, and the answer to it is to cancel something. Told apart
 * by type rather than by its sentence, so the wording stays free to change - the
 * same reasoning `SubagentCapReached` already gives.
 */
export class ScheduleCapReached extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ScheduleCapReached';
  }
}

type Deps = {
  file?: string;
  /**
   * Called after anything changes, with the session it changed for.
   *
   * The store is the only thing that knows what the set of schedules is, and
   * three different callers change it: a tool call, a tick, and the user's stop
   * button. Rather than have each of them remember to tell the renderer, the
   * telling happens here, once, wherever the change came from.
   */
  onChanged?: (sessionId: string, schedules: AgentScheduleRecord[]) => void;
};

/**
 * Every schedule any conversation has set, and the two operations that matter.
 *
 * **Claiming and delivering are different operations and neither may do the
 * other's job.** `claimDue` decides that a schedule's moment has arrived and
 * flips it to `due` in the same synchronous call, so a second tick cannot claim
 * it again. `pullDue` turns a due record into something a pane can deliver, and
 * deletes or re-arms it in the same synchronous call, so a second pull returns
 * nothing. One producer, several idempotent consumers, and the asymmetry is what
 * makes double delivery impossible rather than unlikely.
 *
 * One file for every session rather than one per session, because the question a
 * tick asks - what is due anywhere right now - cannot be answered by reading a
 * session's own log without reading all of them.
 *
 * Every mutating method is fully synchronous from reading the array to writing
 * it back, with no `await` in between, so two panes acting in the same instant
 * are two serialized calls rather than an interleaving. This is the reasoning
 * `SubagentManager.dispatch` already gives for its own cap.
 */
export class ScheduleStore {
  private readonly file: string;
  private readonly onChanged: (sessionId: string, schedules: AgentScheduleRecord[]) => void;
  /** Read once on first use, then kept: every write goes through here too. */
  private records: AgentScheduleRecord[] | null = null;

  constructor(deps: Deps = {}) {
    this.file = deps.file ?? SCHEDULE_FILE;
    this.onChanged = deps.onChanged ?? ((): void => {});
  }

  /** What one conversation has set, soonest first. */
  list(sessionId: string): AgentScheduleRecord[] {
    return this.load()
      .filter((record) => record.sessionId === sessionId)
      .sort((a, b) => a.nextDueAt.localeCompare(b.nextDueAt))
      .map(copy);
  }

  /**
   * Set one, or refuse to.
   *
   * Every refusal throws, and the caller decides which of them deserves to look
   * like a failure - see `runScheduleCreate`. What they have in common is that
   * nothing was written: a schedule either exists after this returns or it does
   * not, and there is no half-created state to reconcile.
   */
  create(input: {
    sessionId: string;
    cwd: string;
    cron: string;
    note: string;
    recurring: boolean;
    depth: number;
    now: Date;
  }): AgentScheduleRecord {
    if (input.depth > MAX_SCHEDULE_CHAIN_DEPTH) {
      throw new Error(
        `This would be hop ${input.depth} of a chain of schedules setting schedules, and Fleet stops at ${MAX_SCHEDULE_CHAIN_DEPTH}. A loop this long is not something to keep going on your own: say in your reply what you are trying to watch and let the user decide whether it is worth a standing schedule.`
      );
    }

    const fields = parseCron(input.cron);
    if (fields === null) {
      throw new Error(
        `"${input.cron}" is not a cron expression Fleet can read. It takes exactly five fields - minute hour day-of-month month day-of-week - as in "0 9 * * MON-FRI".`
      );
    }

    const first = nextFireAfter(fields, input.now);
    if (first === null) {
      throw new Error(
        `"${input.cron}" is a valid expression that never comes round - the day, month and weekday cannot all be true at once. Check the date fields against each other.`
      );
    }
    if (first.getTime() - input.now.getTime() < MIN_SCHEDULE_DELAY_MS) {
      throw new Error(
        `"${input.cron}" would fire in under ${minutes(MIN_SCHEDULE_DELAY_MS)}, and that is the soonest Fleet will schedule anything. Pick a later time.`
      );
    }
    if (input.recurring) {
      const second = nextFireAfter(fields, first);
      if (second !== null && second.getTime() - first.getTime() < MIN_SCHEDULE_DELAY_MS) {
        throw new Error(
          `"${input.cron}" repeats more often than every ${minutes(MIN_SCHEDULE_DELAY_MS)}, which is as often as a recurring schedule may run. Widen the interval - "*/15 * * * *" every quarter hour, "0 * * * *" hourly.`
        );
      }
    }

    // Counted and claimed with nothing awaited in between, for the reason the
    // class comment gives: a cap that only holds when nothing happens at once is
    // not a cap.
    const records = this.load();
    if (
      records.filter((record) => record.sessionId === input.sessionId).length >=
      MAX_SCHEDULES_PER_SESSION
    ) {
      throw new ScheduleCapReached(
        `This conversation already has ${MAX_SCHEDULES_PER_SESSION} schedules set, which is as many as Fleet will hold for one conversation. Cancel one you no longer need with \`schedule_cancel\` and set this again.`
      );
    }

    const id = this.freshId();
    const record: AgentScheduleRecord = {
      id,
      sessionId: input.sessionId,
      cwd: input.cwd,
      cron: input.cron,
      note: input.note,
      recurring: input.recurring,
      createdAt: input.now.toISOString(),
      expiresAt: input.recurring
        ? new Date(input.now.getTime() + SCHEDULE_EXPIRY_MS).toISOString()
        : null,
      depth: input.depth,
      state: 'pending',
      nextDueAt: new Date(first.getTime() + jitterMs(id)).toISOString(),
      dueSince: null,
      terminal: false
    };
    records.push(record);
    this.flush(input.sessionId);
    return copy(record);
  }

  /**
   * Drop one. `false` means there was nothing by that id to drop.
   *
   * `sessionId` is the ownership check, and it is present exactly when the
   * caller is the model: a conversation may only cancel its own. The user's stop
   * button passes `null`, because a person clicking in their own pane is already
   * looking at the schedule they mean.
   */
  cancel(id: string, sessionId: string | null): boolean {
    const records = this.load();
    const found = records.find((record) => record.id === id);
    if (found === undefined) return false;
    if (sessionId !== null && found.sessionId !== sessionId) return false;

    this.records = records.filter((record) => record.id !== id);
    this.flush(found.sessionId);
    return true;
  }

  /**
   * Drop everything one session had.
   *
   * Called when the session is deleted, and a correctness requirement rather
   * than tidiness: a fire delivered into a deleted session would write a message
   * event, and the session log recreates a file it cannot find when it is asked
   * to write a message. The session would come back from the dead holding one
   * message nobody wrote.
   */
  cancelAllFor(sessionId: string): void {
    const records = this.load();
    const kept = records.filter((record) => record.sessionId !== sessionId);
    if (kept.length === records.length) return;

    this.records = kept;
    this.flush(sessionId);
  }

  /**
   * Everything whose moment has arrived, claimed so that it cannot arrive twice.
   *
   * The only place due-ness is decided. Called by the tick and once eagerly at
   * launch - the same function both times, which is the whole of the
   * app-was-closed catch-up: nothing distinguishes a schedule that came due
   * fifteen seconds ago from one that came due last Tuesday.
   *
   * However many intervals a recurring schedule missed, this claims it once. The
   * next occurrence is computed from `now` rather than from the slot that was
   * missed, so a laptop that slept through the night wakes to one message rather
   * than to eight.
   */
  claimDue(now: Date): AgentScheduleRecord[] {
    const claimed: AgentScheduleRecord[] = [];

    for (const record of this.load()) {
      if (record.state !== 'pending') continue;
      if (new Date(record.nextDueAt).getTime() > now.getTime()) continue;

      const expired =
        record.expiresAt !== null && new Date(record.expiresAt).getTime() <= now.getTime();
      const next = record.recurring && !expired ? this.arm(record, now) : null;

      record.dueSince = record.nextDueAt;
      record.state = 'due';
      // A one-shot, an expired recurring schedule, and one whose expression has
      // stopped coming round all end the same way: this fire is the last, and
      // `pullDue` deletes rather than recycles. A recurring schedule firing its
      // way out is why expiry is not simply a delete.
      record.terminal = next === null;
      if (next !== null) record.nextDueAt = next.toISOString();

      claimed.push(copy(record));
    }

    if (claimed.length > 0) {
      this.write();
      for (const sessionId of new Set(claimed.map((record) => record.sessionId))) {
        this.onChanged(sessionId, this.list(sessionId));
      }
    }
    return claimed;
  }

  /**
   * Take one session's due fires, consuming them.
   *
   * **This must stay synchronous.** Nothing in the signature enforces it, and
   * the whole design rests on it: `checkSchedules` can legitimately be called
   * twice in quick succession, and what makes the second call harmless is that
   * the first one has already emptied the store by the time it returns. An
   * `await` anywhere between the read and the write below would reopen the
   * double-delivery race this closes by construction.
   */
  pullDue(sessionId: string, now: Date = new Date()): AgentScheduleRecord[] {
    const records = this.load();
    const taken = records.filter(
      (record) => record.sessionId === sessionId && record.state === 'due'
    );
    if (taken.length === 0) return [];

    const delivered = taken.map(copy);
    this.records = records.filter((record) => !(taken.includes(record) && record.terminal));

    for (const record of taken) {
      if (record.terminal) continue;
      // Re-armed from now rather than trusted from claim time, because a fire
      // can sit `due` for hours waiting for a pane to open and the time claimed
      // for it may itself have passed by the time anyone comes for it.
      const next = this.arm(record, now);
      if (next === null) {
        this.records = this.records.filter((other) => other !== record);
        continue;
      }
      record.state = 'pending';
      record.dueSince = null;
      record.nextDueAt = next.toISOString();
    }

    this.flush(sessionId);
    return delivered;
  }

  /** When this schedule comes round next after `after`, jitter folded in. */
  private arm(record: AgentScheduleRecord, after: Date): Date | null {
    const fields = parseCron(record.cron);
    if (fields === null) return null;
    const next = nextFireAfter(fields, after);
    if (next === null) return null;
    if (record.expiresAt !== null && next.getTime() > new Date(record.expiresAt).getTime()) {
      return null;
    }
    return new Date(next.getTime() + jitterMs(record.id));
  }

  /** Short enough for the model to quote back, checked rather than assumed. */
  private freshId(): string {
    const records = this.load();
    for (;;) {
      const id = `sch_${randomUUID().replace(/-/g, '').slice(0, 8)}`;
      if (!records.some((record) => record.id === id)) return id;
    }
  }

  private load(): AgentScheduleRecord[] {
    this.records ??= this.read();
    return this.records;
  }

  /** Save, then say whose list just changed. */
  private flush(sessionId: string): void {
    this.write();
    this.onChanged(sessionId, this.list(sessionId));
  }

  /**
   * The whole file, through a temporary file and a rename, so a crash midway
   * leaves the previous file whole rather than a half-written one. The rename is
   * the only atomic step and it is last.
   */
  private write(): void {
    const temp = `${this.file}.${process.pid}.tmp`;
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      writeFileSync(
        temp,
        `${JSON.stringify({ version: SCHEDULE_FILE_VERSION, schedules: this.load() }, null, 2)}\n`,
        'utf8'
      );
      renameSync(temp, this.file);
    } catch (err) {
      log.warn('could not write schedules', err);
    }
  }

  /**
   * What is on disk, or nothing.
   *
   * A file that will not parse is logged and started over rather than repaired.
   * Reminders are disposable in a way a conversation is not, and the alternative
   * - refusing to start the scheduler at all - would take the feature down over
   * a file nobody would miss.
   */
  private read(): AgentScheduleRecord[] {
    if (!existsSync(this.file)) return [];
    try {
      const parsed = AgentScheduleFileSchema.safeParse(JSON.parse(readFileSync(this.file, 'utf8')));
      if (parsed.success) return parsed.data.schedules;
      log.warn('schedules file did not parse, starting empty', parsed.error);
    } catch (err) {
      log.warn('could not read schedules, starting empty', err);
    }
    return [];
  }
}

/**
 * A record as it leaves the store.
 *
 * Copied on the way out because the array here is the live one: a caller that
 * held a reference and changed a field would be editing what the next flush
 * writes to disk, from outside every check that makes those fields agree.
 */
function copy(record: AgentScheduleRecord): AgentScheduleRecord {
  return { ...record };
}

function minutes(ms: number): string {
  const count = Math.round(ms / 60_000);
  return `${count} minute${count === 1 ? '' : 's'}`;
}
