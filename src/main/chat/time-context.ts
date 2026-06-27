/**
 * Current date/time grounding for the chat agent. The model has no clock, so we
 * inject the wall-clock time every turn (a fresh system block placed AFTER the
 * prompt-cache breakpoint, so it never busts the cached prefix) and also expose
 * a `get_current_time` tool for when the model wants the exact time mid-turn.
 *
 * The same `formatTimeContext` feeds both, so the injected block and the tool
 * result never drift. Times are the host's local time (what the user means by
 * "now"), with the IANA zone + offset and a UTC line for unambiguous ordering.
 */

export const GET_CURRENT_TIME_TOOL_NAME = 'get_current_time';

export const CURRENT_TIME_TOOL = {
  type: 'function',
  function: {
    name: GET_CURRENT_TIME_TOOL_NAME,
    description:
      "Get the current date and time. Call this when you need the exact, up-to-the-second time (the time noted in context is from the turn's start). Returns local time with timezone plus the UTC time.",
    parameters: { type: 'object', properties: {} }
  }
} as const;

/** Local ISO-8601 with the host's UTC offset, e.g. 2026-06-27T14:30:00-07:00. */
function localIso(d: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0');
  const offsetMin = -d.getTimezoneOffset(); // minutes east of UTC
  const sign = offsetMin >= 0 ? '+' : '-';
  const abs = Math.abs(offsetMin);
  const offset = `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}${offset}`
  );
}

/**
 * A human-readable timestamp plus machine-readable ISO/UTC lines, e.g.:
 *   Current date and time: Saturday, June 27, 2026 at 2:30 PM Pacific Daylight Time (America/Los_Angeles).
 *   ISO 8601: 2026-06-27T14:30:00-07:00 (UTC: 2026-06-27T21:30:00Z).
 */
export function formatTimeContext(now: Date): string {
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const human = now.toLocaleString('en-US', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'long'
  });
  const utc = now.toISOString().replace(/\.\d{3}Z$/, 'Z');
  return (
    `Current date and time: ${human} (${zone}).\n` + `ISO 8601: ${localIso(now)} (UTC: ${utc}).`
  );
}

/**
 * The system-message content injected each turn. Adds a one-line instruction so
 * the model treats this as the present moment for relative-date reasoning.
 */
export function buildTimeContextBlock(now: Date): string {
  return (
    `${formatTimeContext(now)}\n` +
    `Treat this as the current moment when the user refers to "now", "today", or relative dates.`
  );
}
