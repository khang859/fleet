import type { QuitWorkItem } from '../shared/quit-confirm';

// eslint-disable-next-line no-control-regex -- terminal colour codes are what it removes
const ANSI = /\u001b\[[0-9;?]*[A-Za-z]/g;

function oneLine(text: string, max: number): string {
  const one = text.replace(ANSI, '').replace(/\s+/g, ' ').trim();
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
}

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
