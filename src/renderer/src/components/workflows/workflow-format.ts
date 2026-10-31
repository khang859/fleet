import type { WorkflowEntry } from '../../../../shared/workflows';
import { relativeTime } from '../agent/settings/format';

export function formatAgo(at: number | null): string {
  return at === null ? 'Never' : relativeTime(at);
}

export function formatSpan(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 1) return 'Under 1 min';
  if (minutes < 60) return `${minutes} min`;
  return `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}

/** A new-PR rule has no PR of its own, so its Run now must ask a person which one. */
export function hasPrInput(entry: WorkflowEntry | undefined): boolean {
  return entry?.def?.inputs.some((input) => input.type === 'pr') ?? false;
}
