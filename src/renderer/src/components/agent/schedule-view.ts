import type { AgentScheduleRecord } from '../../../../shared/agent-schedule';
import { nextFireLabel } from '../../../../shared/agent-schedule';
import { fitsSideColumn } from './side-column';

/**
 * What the schedules look like, worked out apart from what draws them.
 *
 * The same shape as `subagent-view`, and for the same reason: two places show
 * this list - a card in the column beside the conversation when the pane is
 * wide, one chip above the composer when it is not - and neither should be the
 * place the rules live.
 */

/**
 * How much of a note either place shows.
 *
 * A note may be two thousand characters, because it is the entire brief for a
 * turn with no memory. None of that belongs in a 272px column or in a hover
 * title, and the whole of it is on the tool call in the transcript, which is
 * where what was set is written down.
 */
export const SCHEDULE_NOTE_PREVIEW_CHARS = 100;

/** One schedule, and everything either place needs to say about it. */
export type ScheduleRow = {
  id: string;
  /** The note, on one line and cut short. See `SCHEDULE_NOTE_PREVIEW_CHARS`. */
  note: string;
  cron: string;
  /** When it fires next, as a person would say it. */
  when: string;
  /** Its moment has been claimed and a pane is about to be handed it. */
  due: boolean;
  recurring: boolean;
};

/**
 * The schedules a conversation has set, due ones first and then by when they
 * fire.
 *
 * Due first because a due schedule is a turn about to start, which is a
 * different thing to know than a reminder set for Thursday - and it can only be
 * on screen at all while the pane is busy, which is exactly when the user is
 * most entitled to know what is queued behind what they are watching.
 */
export function scheduleRows(records: AgentScheduleRecord[], now: Date): ScheduleRow[] {
  return [...records]
    .sort((a, b) => rank(a) - rank(b) || fireAt(a) - fireAt(b))
    .map((record) => ({
      id: record.id,
      note: preview(record.note),
      cron: record.cron,
      when: record.state === 'due' ? 'due now' : nextFireLabel(record, now),
      due: record.state === 'due',
      recurring: record.recurring
    }));
}

const rank = (record: AgentScheduleRecord): number => (record.state === 'due' ? 0 : 1);

/** Unreadable dates sort last rather than throwing the whole list into disorder. */
function fireAt(record: AgentScheduleRecord): number {
  const at = new Date(record.nextDueAt).getTime();
  return Number.isNaN(at) ? Number.POSITIVE_INFINITY : at;
}

/** One line of it, cut on a word where there is one to cut on. */
function preview(note: string): string {
  const line = note.replace(/\s+/g, ' ').trim();
  if (line.length <= SCHEDULE_NOTE_PREVIEW_CHARS) return line;
  const cut = line.slice(0, SCHEDULE_NOTE_PREVIEW_CHARS);
  const space = cut.lastIndexOf(' ');
  return `${(space > SCHEDULE_NOTE_PREVIEW_CHARS / 2 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

/**
 * Whether the schedules get a card in the column.
 *
 * Only that something is set, and that there is room - no clause about the
 * turn, the same rule the subagent card follows. A schedule outlives every turn
 * of the conversation by design, and an idle pane holding one is the ordinary
 * case rather than a stale one.
 */
export function showSchedulePanel(
  rows: ScheduleRow[],
  pane: {
    width: number | null;
    /** Whether the column is up now, which is what the two widths are about. */
    shown: boolean;
  }
): boolean {
  if (rows.length === 0) return false;
  return fitsSideColumn(pane.width, pane.shown);
}

/**
 * The chip, for a pane too narrow for the column.
 *
 * The next fire when there is one schedule, a count when there are several: at
 * this width the useful fact is when the pane is going to start working on its
 * own, and with three set the only honest short answer is how many.
 */
export function scheduleChip(rows: ScheduleRow[]): { label: string; title: string } {
  const only = rows.length === 1 ? rows[0] : null;
  return {
    label: only !== null ? only.when : `${rows.length} schedules`,
    title: rows.map((row) => `${row.when} (${row.cron}): ${row.note}`).join('\n')
  };
}
