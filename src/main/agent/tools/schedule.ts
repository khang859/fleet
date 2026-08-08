import type {
  AgentScheduleCapability,
  AgentToolContext,
  AgentToolResult,
  ScheduleCancelArgs,
  ScheduleCreateArgs
} from '../../../shared/agent-tools';
import { nextFireLabel, type AgentScheduleRecord } from '../../../shared/agent-schedule';
import { ScheduleCapReached } from '../schedule-store';

/**
 * The three tools that let a conversation wake itself up.
 *
 * `schedule_create` is the one with anything to it; the other two exist so the
 * model can see and undo what it set. All three answer with the list rather than
 * with "ok", for the reason the todo tools do: two calls in one round then
 * cannot disagree about what is set, and a model that has misremembered an id
 * finds out here rather than a round later.
 */

/**
 * What the row says when the conversation is already holding as many schedules
 * as it may.
 *
 * Reads as a state rather than as an outcome, the same way a subagent waiting
 * for a slot does, because that is what it is: nothing went wrong, there is
 * simply no room until something is cancelled.
 */
const SHELF_FULL = 'no room';

export function runScheduleCreate(
  args: ScheduleCreateArgs,
  ctx: AgentToolContext
): AgentToolResult {
  const schedule = available(ctx);

  let made: AgentScheduleRecord;
  try {
    made = schedule.create({ cron: args.cron, note: args.note, recurring: args.recurring });
  } catch (err) {
    // The cap is the one refusal here that is not a mistake, so it is the one
    // that does not draw a red row. Everything else - an expression that will
    // not parse, a chain that has gone on too long - is something the model got
    // wrong or should stop doing, and a person reading the transcript later
    // should be able to see it. See `ScheduleCapReached`, and section 6.6 of the
    // design: the asymmetry is deliberate.
    if (!(err instanceof ScheduleCapReached)) throw err;
    return { text: err.message, summary: SHELF_FULL };
  }

  const now = new Date();
  return {
    text: [
      `Set. \`${made.id}\` fires ${nextFireLabel(made, now)}${made.recurring ? ` and every ${made.cron} after that, until it expires in a week` : ' and is then gone'}.`,
      '',
      // Said again at the moment of setting rather than only in the tool
      // description, because this is the last point at which the model can still
      // fix a note that will not make sense on its own.
      'When it fires you will be given the note and nothing else, so if it does not stand up without this conversation, cancel it and set it again with a fuller one.',
      '',
      renderList(schedule.list(), now)
    ].join('\n'),
    // When rather than the expression: the row already carries the expression
    // as its subject, and saying it twice on one line says nothing twice.
    summary: nextFireLabel(made, now)
  };
}

export function runScheduleList(ctx: AgentToolContext): AgentToolResult {
  const schedule = available(ctx);
  const records = schedule.list();

  return {
    text:
      records.length === 0
        ? 'This conversation has no schedules set.'
        : renderList(records, new Date()),
    summary: records.length === 1 ? '1 schedule' : `${records.length} schedules`
  };
}

export function runScheduleCancel(
  args: ScheduleCancelArgs,
  ctx: AgentToolContext
): AgentToolResult {
  const schedule = available(ctx);
  if (!schedule.cancel(args.id)) {
    const records = schedule.list();
    throw new Error(
      records.length === 0
        ? `There is no schedule \`${args.id}\`, and this conversation has none set at all - it may have already fired.`
        : `There is no schedule \`${args.id}\` in this conversation. What there is:\n\n${renderList(records, new Date())}`
    );
  }

  const left = schedule.list();
  return {
    text:
      left.length === 0
        ? `Cancelled \`${args.id}\`. Nothing is scheduled in this conversation now.`
        : [`Cancelled \`${args.id}\`. Still set:`, '', renderList(left, new Date())].join('\n'),
    // What is left rather than what went, for the same reason: the row's
    // subject is the id that was cancelled.
    summary: left.length === 0 ? 'none left' : `${left.length} left`
  };
}

/**
 * The capability, or the sentence that explains why there is not one.
 *
 * Only ever reached by a subagent, whose tool list does not include these at
 * all - so getting here means an invented name or an old transcript, and the
 * honest answer is what it would have to do instead. See `AgentToolContext`,
 * where the same double enforcement is described for `task`.
 */
function available(ctx: AgentToolContext): AgentScheduleCapability {
  if (ctx.schedule === null) {
    throw new Error(
      'A subagent cannot schedule anything. Your conversation ends when you report back, so there would be nothing for it to wake up. Say in your report what needs checking later and let the conversation that sent you decide.'
    );
  }
  return ctx.schedule;
}

/** The list as the model reads it, ids first because those are what it needs. */
function renderList(records: AgentScheduleRecord[], now: Date): string {
  return [
    'Scheduled in this conversation:',
    ...records.map(
      (record) =>
        `- \`${record.id}\` ${record.cron} (${record.recurring ? 'recurring' : 'once'}, ${
          record.state === 'due' ? 'due now' : `next ${nextFireLabel(record, now)}`
        }): ${record.note}`
    )
  ].join('\n');
}
