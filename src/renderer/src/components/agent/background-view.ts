import type { AgentBackgroundJob } from '../../../../shared/agent-tools';
import { fitsSideColumn } from './side-column';

/**
 * What the running background commands look like, worked out apart from what
 * draws them.
 *
 * The same shape as `subagent-view` and `schedule-view`: a card in the column
 * beside the conversation when the pane is wide, one chip above the composer
 * when it is not, and the rules in neither of them.
 */

/**
 * How much of a command either place shows.
 *
 * A command can be a paragraph of `&&`s. The row is a glance at which one this
 * is, and the whole of it is on the `bash` call in the transcript.
 */
export const BACKGROUND_COMMAND_PREVIEW_CHARS = 120;

/** One running command, and everything either place needs to say about it. */
export type BackgroundRow = {
  id: string;
  /** The command, on one line and cut short. */
  command: string;
  startedAt: number;
  lastLine: string | null;
};

/** The running commands in the order they were started, which is main's order. */
export function backgroundRows(jobs: AgentBackgroundJob[]): BackgroundRow[] {
  return jobs.map((job) => ({
    id: job.id,
    command: preview(job.command),
    startedAt: job.startedAt,
    lastLine: job.lastLine
  }));
}

function preview(command: string): string {
  const line = command.replace(/\s+/g, ' ').trim();
  if (line.length <= BACKGROUND_COMMAND_PREVIEW_CHARS) return line;
  return `${line.slice(0, BACKGROUND_COMMAND_PREVIEW_CHARS - 1).trimEnd()}…`;
}

/**
 * Whether the commands get a card in the column.
 *
 * Only that something is running and that there is room, the rule the subagent
 * card follows: a background command outlives the turn that started it by
 * design, so an idle composer over a running server is the ordinary case.
 */
export function showBackgroundPanel(
  rows: BackgroundRow[],
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
 * The command when there is one, and only the count when there are several -
 * the same split the subagent chip makes, because naming one of three would
 * read as the only thing running. The count is drawn beside the label already,
 * so the label does not repeat it. The title buys back what the collapse costs.
 */
export function backgroundChip(rows: BackgroundRow[]): { label: string; title: string } {
  return {
    label: rows.length === 1 ? rows[0].command : 'running',
    title: rows
      .map((row) => (row.lastLine === null ? row.command : `${row.command}\n  ${row.lastLine}`))
      .join('\n')
  };
}
