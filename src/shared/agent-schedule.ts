import { z } from 'zod';

/**
 * A schedule the agent set for itself: what it is, what it costs, and what it
 * says when it arrives.
 *
 * Shared because both ends need it for different reasons. Main owns the record
 * and decides when it is due; the renderer draws the list and turns a due one
 * into a message. The prose lives here too, with the type it describes, since
 * the words a fire arrives in are as much a part of this feature as the record.
 */

/**
 * `pending` is waiting for its moment; `due` has had its moment claimed and is
 * waiting for a pane to come and collect it.
 *
 * Two states rather than one flag because the second one is what makes a fire
 * survive having nobody to deliver it to. A schedule that comes due while no
 * pane is open on its session does not fire into the void and does not fire
 * twice when one opens: it sits here, claimed exactly once, until somebody
 * pulls it.
 */
export type AgentScheduleState = 'pending' | 'due';

export type AgentScheduleRecord = {
  id: string;
  sessionId: string;
  /** Carried so a fire can be delivered without a session lookup, exactly as `AgentTaskDone.cwd` is. */
  cwd: string;
  cron: string;
  note: string;
  recurring: boolean;
  createdAt: string;
  /** `createdAt` plus a week, recurring only. Null for a one-shot, which expires by firing. */
  expiresAt: string | null;
  /** Chain-fire hops that produced this record. 0 for one an ordinary turn created. */
  depth: number;
  state: AgentScheduleState;
  /** This schedule's own idea of when it next needs claiming. Jitter already folded in. */
  nextDueAt: string;
  /** Frozen at claim time: the occurrence being delivered, so the message can say how late it is. */
  dueSince: string | null;
  /** Set at claim time: this due fire is the last one, so `pullDue` deletes rather than recycles. */
  terminal: boolean;
};

export const AgentScheduleRecordSchema: z.ZodType<AgentScheduleRecord> = z.object({
  id: z.string(),
  sessionId: z.string(),
  cwd: z.string(),
  cron: z.string(),
  note: z.string(),
  recurring: z.boolean(),
  createdAt: z.string(),
  expiresAt: z.string().nullable(),
  depth: z.number(),
  state: z.enum(['pending', 'due']),
  nextDueAt: z.string(),
  dueSince: z.string().nullable(),
  terminal: z.boolean()
});

/**
 * What a pane is told when one session's schedules change, however they changed.
 *
 * The whole list rather than a diff, because it is a handful of small records
 * and the alternative is a renderer that has to be right about applying every
 * kind of change - a create, a cancel, a tick claiming three at once, a delivery
 * emptying them.
 *
 * It doubles as the nudge to deliver: a pane that hears its own session changed
 * asks whether anything is due, which is how a fire reaches an idle pane without
 * main having to know which panes exist.
 */
export type AgentScheduleChanged = {
  sessionId: string;
  schedules: AgentScheduleRecord[];
};

/**
 * The file on disk.
 *
 * The version is informational and carries no migration machinery. Reminders
 * are disposable in a way conversations are not, so a file that no longer parses
 * is logged and started over rather than repaired - the same fallback the
 * session log already takes when it cannot read itself.
 */
export const SCHEDULE_FILE_VERSION = 1;

export const AgentScheduleFileSchema = z.object({
  version: z.number(),
  schedules: z.array(AgentScheduleRecordSchema)
});

/**
 * How many one conversation may hold at once.
 *
 * Ten is more than any honest use of this needs and few enough that a runaway
 * loop stops being one within a few minutes. It is per session rather than
 * app-wide because what it protects against is one conversation losing the plot,
 * which is not a reason to stop a different conversation setting a reminder.
 */
export const MAX_SCHEDULES_PER_SESSION = 10;

/**
 * How many times a schedule may beget a schedule.
 *
 * The failure this exists for is documented and shipped elsewhere: an agent that
 * re-schedules itself on every wakeup runs until somebody notices the bill. Three
 * hops is enough for a genuine "check again in an hour, and if it is still not
 * done, again tomorrow" and short of anything that could be called a loop.
 */
export const MAX_SCHEDULE_CHAIN_DEPTH = 3;

/**
 * The soonest a schedule may fire, counted from when it was created and also
 * between consecutive occurrences.
 *
 * Five minutes rather than one, so that a mistyped `* * * * *` is refused
 * outright rather than turned into a turn every sixty seconds. Note honestly
 * that this floor does less than its name suggests: it stops one schedule being
 * too eager, and does nothing about a chain of distinct one-shots each re-arming
 * just past it. That shape is what the chain-depth and per-session caps are for.
 */
export const MIN_SCHEDULE_DELAY_MS = 5 * 60 * 1000;

/**
 * How long a recurring schedule lives before expiring itself.
 *
 * A week, matching what every other harness that has shipped this settled on. It
 * bounds how long a forgotten loop can run without needing anyone to remember it
 * exists, and it fires one final time on the way out rather than vanishing, so
 * the conversation is told rather than left wondering.
 */
export const SCHEDULE_EXPIRY_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * How long a note may be.
 *
 * Generous, because the whole design of this feature is that the note is the
 * entire brief for a turn with no memory of today, and a limit that made a
 * complete brief impossible would be arguing with its own tool description.
 */
export const SCHEDULE_NOTE_MAX_CHARS = 2_000;

/**
 * How a fire is introduced when the transcript goes back on the wire.
 *
 * A `scheduled` message has no counterpart in any provider's API, so it goes
 * across as a user message and this line is what stops the model reading it as
 * the person speaking. Same reasoning as `SUMMARY_WIRE_PREFIX`, which has the
 * same problem.
 */
export const SCHEDULE_WIRE_PREFIX =
  'A schedule you set for yourself has come due. Fleet is delivering it; the user has not said anything:';

/**
 * What the delivered message says.
 *
 * The note verbatim, under one sentence of framing, and nothing else. The
 * framing is doing real work: the turn that reads this has no memory of the turn
 * that wrote it, and the single most common way self-scheduling goes wrong is a
 * model treating the note as a hint about a conversation it can still see. Saying
 * plainly that this is all there is turns a vague note into an obvious problem
 * now rather than a confused turn later.
 *
 * Lateness is said rather than implied, because a check-in that was due three
 * hours ago is often a different question from one that was due now - and for a
 * recurring schedule it is also where the model is told that the missed
 * intervals coalesced, so it does not go looking for the ones that never
 * arrived.
 */
export function renderScheduleFire(input: {
  note: string;
  /** The occurrence being delivered, frozen when it was claimed. */
  dueSince: string | null;
  deliveredAt: Date;
  recurring: boolean;
}): string {
  return [`${opening(input)} Everything you have to go on is below.`, '', input.note].join('\n');
}

/**
 * The two halves of a delivered fire: the sentence that frames it, and the note
 * itself.
 *
 * Here rather than in the card that draws them, because the shape being split
 * on is the one `renderScheduleFire` builds three lines above - and a card that
 * knew the layout of prose written in another file would be wrong the first time
 * anyone reworded it. A message that does not have the shape is handed back
 * whole as the note, which is the half worth keeping.
 */
export function splitScheduleFire(text: string): { opening: string; note: string } {
  const at = text.indexOf('\n\n');
  if (at === -1) return { opening: '', note: text };
  return { opening: text.slice(0, at), note: text.slice(at + 2) };
}

function opening(input: {
  dueSince: string | null;
  deliveredAt: Date;
  recurring: boolean;
}): string {
  const late = input.dueSince === null ? null : overdueLabel(input.deliveredAt, input.dueSince);
  if (late === null) {
    return 'You set this check-in for yourself, and it has just come due.';
  }
  return input.recurring
    ? `You set this recurring check-in for yourself. It came due ${late} ago and nothing was open to run it until now, so this is the one catch-up rather than one message per interval it missed.`
    : `You set this check-in for yourself. It came due ${late} ago and nothing was open to run it until now.`;
}

/**
 * How overdue a fire is, in the largest unit that still says something useful,
 * or `null` when it arrived on time.
 *
 * Rounded down, so "2 hours" means at least two rather than nearly two. Anything
 * under a minute is on time: the tick that claims a fire runs every fifteen
 * seconds and the jitter spreads it over the following minute, so a delivery a
 * few seconds after its slot is the mechanism working, not lateness.
 */
export function overdueLabel(deliveredAt: Date, dueSince: string): string | null {
  const ms = deliveredAt.getTime() - new Date(dueSince).getTime();
  if (!Number.isFinite(ms) || ms < 60_000) return null;

  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return plural(minutes, 'minute');
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return plural(hours, 'hour');
  return plural(Math.floor(hours / 24), 'day');
}

function plural(count: number, unit: string): string {
  return `${count} ${unit}${count === 1 ? '' : 's'}`;
}

/**
 * What the agent is told about schedules, appended to the system prompt.
 *
 * Separate from the per-round reminder for the reason the todo instructions are:
 * this says what the tools are and when they are worth reaching for, once, while
 * the reminder says what is currently set, every round.
 */
export const AGENT_SCHEDULE_INSTRUCTIONS = [
  '`schedule_create` wakes you up later. Reach for it when the thing you need to know cannot be known yet - a build that is still running, a deploy that lands in an hour, a review nobody has left yet - and the honest answer is to look again later rather than to wait or to ask the user to remind you.',
  '',
  'Never sleep or poll inside a turn to wait for something. A turn that spins is a turn the user cannot use, and it ends when the turn ends whether the thing happened or not. Set a schedule and stop.',
  '',
  'The note you leave is the whole of what the woken turn will have: no conversation, no memory of what you were doing, nothing but those words. Write it for a stranger who has your tools and none of your context.',
  '',
  '`schedule_cancel` once the thing is no longer worth watching. A schedule outliving its purpose is a turn nobody asked for, and the user is the one who pays for it.'
].join('\n');

/**
 * The block that rides into the conversation on every round, or `null` when the
 * conversation has nothing set.
 *
 * Pushed for the reason the subagent roster is pushed rather than the reason the
 * task list is: for most turns of most conversations there is nothing here, and a
 * line saying "no schedules" every round would be the whole cost of the feature
 * paid on the turns where it has nothing to say.
 *
 * The ids are in it because they are the one thing a model cannot guess and
 * `schedule_cancel` needs exactly.
 */
export function renderScheduleBlock(records: AgentScheduleRecord[], now: Date): string | null {
  if (records.length === 0) return null;

  const lines = records.map((record) => {
    const when = record.state === 'due' ? 'due now' : `next ${nextFireLabel(record, now)}`;
    return `- \`${record.id}\` (${record.cron}, ${record.recurring ? 'recurring' : 'once'}, ${when}): ${record.note}`;
  });

  return [
    `Schedules you have set in this conversation, ${records.length === 1 ? 'one' : `all ${records.length}`} of which will wake you up on ${records.length === 1 ? 'its' : 'their'} own:`,
    '',
    ...lines,
    '',
    'Cancel any that no longer need watching, and do not set a second schedule for something one of these already covers.'
  ].join('\n');
}

/**
 * When a schedule next fires, as a person would say it.
 *
 * A time of day for today and tomorrow, and a date for anything further out.
 * Shared with the panel because the model and the user should not be told two
 * different things about the same schedule.
 */
export function nextFireLabel(record: AgentScheduleRecord, now: Date): string {
  const at = new Date(record.nextDueAt);
  if (Number.isNaN(at.getTime())) return record.cron;

  const time = at.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  const days = calendarDaysBetween(now, at);
  if (days === 0) return `today ${time}`;
  if (days === 1) return `tomorrow ${time}`;
  return `${at.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} ${time}`;
}

/** Whole calendar days from one local date to another, ignoring the time of day. */
function calendarDaysBetween(from: Date, to: Date): number {
  const midnight = (at: Date): number =>
    new Date(at.getFullYear(), at.getMonth(), at.getDate()).getTime();
  return Math.round((midnight(to) - midnight(from)) / (24 * 60 * 60 * 1000));
}
