import type { TaskStatus, Task, ChecksState } from '../../../../shared/kanban-types';

export const COLUMNS: Array<{ status: TaskStatus; label: string }> = [
  { status: 'scheduled', label: 'Scheduled' },
  { status: 'triage', label: 'Triage' },
  { status: 'todo', label: 'Todo' },
  { status: 'ready', label: 'Ready' },
  { status: 'running', label: 'Running' },
  { status: 'blocked', label: 'Blocked' },
  { status: 'review', label: 'Review' },
  { status: 'done', label: 'Done' }
];

// Manual drag targets exclude 'running' (dispatcher-owned) and 'archived'.
export const DRAG_TARGETS: TaskStatus[] = ['triage', 'todo', 'ready', 'blocked', 'review', 'done'];

export function relativeTime(epochMs: number): string {
  const diff = Date.now() - epochMs;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(epochMs).toLocaleDateString();
}

export function formatDuration(startMs: number, endMs: number | null): string {
  const end = endMs ?? Date.now();
  const secs = Math.max(0, Math.floor((end - startMs) / 1000));
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ${secs % 60}s`;
  const hours = Math.floor(mins / 60);
  return `${hours}h ${mins % 60}m`;
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/** Compact human label for an interval period (input is ms). */
export function formatInterval(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.round(h / 24)}d`;
}

/** One-line recurrence summary for a scheduled card. */
export function scheduleSummary(
  task: Pick<Task, 'scheduleKind' | 'scheduleCron' | 'scheduleIntervalMs'>
): string {
  if (task.scheduleKind === 'cron') return task.scheduleCron ?? 'cron';
  if (task.scheduleKind === 'interval')
    return `every ${formatInterval(task.scheduleIntervalMs ?? 0)}`;
  if (task.scheduleKind === 'once') return 'once';
  return '';
}

/** Localized absolute time for a next-fire timestamp. */
export function formatNextRun(epochMs: number | null): string {
  if (epochMs == null) return '';
  return new Date(epochMs).toLocaleString();
}

export type FeatureProgress = {
  total: number;
  todo: number;
  running: number;
  review: number;
  done: number;
  archived: number;
  openPr: number;
  mergedPr: number;
  checks: ChecksState | null;
};

/**
 * Roll a feature's member cards up to status + PR counts, entirely client-side
 * (the board already holds every task for the active board, so no extra fetch).
 */
export function featureProgress(cards: Array<Pick<Task, 'status' | 'prInfo'>>): FeatureProgress {
  const p: FeatureProgress = {
    total: cards.length,
    todo: 0,
    running: 0,
    review: 0,
    done: 0,
    archived: 0,
    openPr: 0,
    mergedPr: 0,
    checks: null
  };
  let failing = false;
  let pending = false;
  let passing = false;
  for (const c of cards) {
    if (c.status === 'running') p.running += 1;
    else if (c.status === 'blocked' || c.status === 'review') p.review += 1;
    else if (c.status === 'done') p.done += 1;
    else if (c.status === 'archived') p.archived += 1;
    else p.todo += 1; // triage | scheduled | todo | ready
    const pr = c.prInfo;
    if (pr?.state === 'open' || pr?.state === 'draft') p.openPr += 1;
    else if (pr?.state === 'merged') p.mergedPr += 1;
    if (pr?.checksState === 'failing') failing = true;
    else if (pr?.checksState === 'pending') pending = true;
    else if (pr?.checksState === 'passing') passing = true;
  }
  p.checks = failing ? 'failing' : pending ? 'pending' : passing ? 'passing' : null;
  return p;
}
