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
