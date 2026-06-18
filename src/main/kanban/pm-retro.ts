import type { Feature, Task, TaskRun, TaskEvent } from '../../shared/kanban-types';

/** Event kinds that signal friction worth a retro mention. */
const FRICTION_EVENTS = new Set([
  'blocked',
  'verify_failed',
  'gave_up',
  'review_changes_requested'
]);

/**
 * Build the prompt for a post-ship retro PM turn (#235). Pure: callers inject the
 * run/event accessors so this stays trivially testable and store-free.
 */
export function buildRetroBriefing(
  feature: Feature,
  tasks: Task[],
  runsFor: (taskId: string) => TaskRun[],
  eventsFor: (taskId: string) => TaskEvent[]
): string {
  const taskLines: string[] = [];
  for (const t of tasks) {
    const runs = runsFor(t.id);
    const lastSummary = [...runs].reverse().find((r) => r.summary)?.summary ?? '(no summary)';
    const friction = eventsFor(t.id)
      .map((e) => e.kind)
      .filter((k) => FRICTION_EVENTS.has(k));
    const parts = [
      `- ${t.title} (${t.id}): ${t.status}`,
      t.reviewVerdict ? `review=${t.reviewVerdict} (attempts=${t.reviewAttempts})` : null,
      t.verifyAttempts > 0 ? `verify_attempts=${t.verifyAttempts}` : null,
      friction.length ? `friction=[${friction.join(', ')}]` : null
    ].filter(Boolean);
    taskLines.push(parts.join('  '));
    taskLines.push(`    summary: ${lastSummary}`);
  }

  return [
    `A feature just shipped: "${feature.name}" (${feature.id}).`,
    `qa: ${feature.qaVerdict ?? 'n/a'}    pr: ${feature.prUrl ?? 'none'}`,
    '',
    'Member tasks and how they went:',
    ...(taskLines.length ? taskLines : ['(no member tasks recorded)']),
    '',
    'Run a retrospective:',
    '1. Before writing anything, call learnings_search and re-read MEMORY.md for',
    '   entries related to what you see above — recognize anything recurring.',
    '2. Capture durable TECHNICAL learnings (a gotcha, a discovered constraint, a',
    `   pattern that worked) with kanban_learning_create — pass feature_id="${feature.id}".`,
    '3. Append concise BOARD-PROCESS notes (recurring blockers, profile/prompt',
    '   friction) to MEMORY.md. When something recurs, escalate the note',
    '   ("this has now bitten N features") rather than duplicating it.',
    '4. Reply with a short retro summary: what went well, what kept failing, and any',
    '   SUGGESTED profile/prompt/doc improvements. Suggestions only — do not apply',
    '   profile or prompt changes yourself.'
  ].join('\n');
}
