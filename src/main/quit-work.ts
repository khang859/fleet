import { oneLine } from './claude-sessions/brief';
import type { QuitWorkItem } from '../shared/quit-confirm';

const LABEL_MAX = 80;

/** What main has running that no pane speaks for, as it stands. */
export type MainWork = {
  background: ReadonlyArray<{ id: string; command: string }>;
  subagents: ReadonlyArray<{ taskId: string; agent: string; prompt: string }>;
};

/** The quit dialog's rows for work main owns. */
export function mainWorkItems(work: MainWork): QuitWorkItem[] {
  const items: QuitWorkItem[] = [];
  for (const job of work.background) {
    items.push({ kind: 'background', id: job.id, label: job.command });
  }
  for (const live of work.subagents) {
    items.push({
      kind: 'subagent',
      id: live.taskId,
      label: `${live.agent}: ${oneLine(live.prompt, LABEL_MAX)}`
    });
  }
  return items;
}
