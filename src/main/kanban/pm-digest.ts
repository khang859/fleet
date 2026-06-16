import type { TaskEvent } from '../../shared/kanban-types';

const COMPLETED = new Set(['completed', 'merged', 'accepted']);
const FAILURES = new Set(['verify_failed', 'gave_up', 'spawn_failed', 'merge_failed', 'pr_failed']);

export interface DigestInput {
  events: TaskEvent[];
  pendingProposals: number;
  resolveTitle: (taskId: string) => string | null;
}

/** Build the standup-digest prompt from activity since the last digest. */
export function buildDigestContext(input: DigestInput): string {
  const { events, pendingProposals, resolveTitle } = input;
  const labelIds = (ids: Set<string>): string[] =>
    [...ids].map((id) => {
      const t = resolveTitle(id);
      return t ? `${id} "${t}"` : id;
    });
  const pick = (set: Set<string>): string[] =>
    labelIds(new Set(events.filter((e) => set.has(e.kind)).map((e) => e.taskId)));
  const completed = pick(COMPLETED);
  const blocked = labelIds(
    new Set(
      events
        .filter(
          (e) =>
            e.kind === 'blocked' || (e.kind === 'status_changed' && e.payload?.['to'] === 'blocked')
        )
        .map((e) => e.taskId)
    )
  );
  const failures = pick(FAILURES);

  if (events.length === 0 && pendingProposals === 0) {
    return 'No board activity since the last standup. Give a one-line all-quiet note.';
  }

  const lines: string[] = ['Board activity since the last standup:'];
  if (completed.length) lines.push(`- Completed (${completed.length}): ${completed.join(', ')}`);
  if (blocked.length) lines.push(`- Blocked (${blocked.length}): ${blocked.join(', ')}`);
  if (failures.length) lines.push(`- Failures (${failures.length}): ${failures.join(', ')}`);
  if (pendingProposals > 0)
    lines.push(`- ${pendingProposals} proposal(s) awaiting your confirmation.`);
  lines.push(
    '',
    'Write a short standup: what shipped, what is stuck, and what needs a human decision.'
  );
  return lines.join('\n');
}
