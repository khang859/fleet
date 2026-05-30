import type { TaskStatus } from '../../../../shared/kanban-types';

export const COLUMNS: { status: TaskStatus; label: string }[] = [
  { status: 'triage', label: 'Triage' },
  { status: 'todo', label: 'Todo' },
  { status: 'ready', label: 'Ready' },
  { status: 'running', label: 'Running' },
  { status: 'blocked', label: 'Blocked' },
  { status: 'done', label: 'Done' }
];

// Manual drag targets exclude 'running' (dispatcher-owned) and 'archived'.
export const DRAG_TARGETS: TaskStatus[] = ['triage', 'todo', 'ready', 'blocked', 'done'];

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
