/**
 * When a usage limit lifts, read from the text Claude Code shows with it:
 * `Claude AI usage limit reached|1760000000` (seconds) or `... resets 3pm`,
 * `resets at 3:30 pm`, `reset at 15:00`. A time of day is the next one after
 * `now`, in local time; a time zone after it is ignored. Null when the text
 * names no time.
 */
export function limitResetAt(text: string, now: number): number | null {
  const epoch = /\|(\d{10})\b/.exec(text);
  if (epoch !== null) return Number(epoch[1]) * 1000;
  const clock = /\bresets?\s+(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/i.exec(text);
  if (clock === null) return null;
  let hour = Number(clock[1]);
  // An unmatched group is undefined, which the index type does not say.
  const minutes = clock.at(2);
  const half = clock.at(3)?.toLowerCase();
  if (half === undefined && minutes === undefined) return null;
  const minute = Number(minutes ?? '0');
  if (half !== undefined) {
    if (hour < 1 || hour > 12) return null;
    hour = (hour % 12) + (half === 'pm' ? 12 : 0);
  }
  if (hour > 23 || minute > 59) return null;
  const at = new Date(now);
  at.setHours(hour, minute, 0, 0);
  if (at.getTime() <= now) at.setDate(at.getDate() + 1);
  return at.getTime();
}
