import { describe, it, expect } from 'vitest';
import {
  formatTimeContext,
  buildTimeContextBlock,
  CURRENT_TIME_TOOL,
  GET_CURRENT_TIME_TOOL_NAME
} from '../time-context';

describe('formatTimeContext', () => {
  // A fixed instant; the UTC line below is host-timezone-independent.
  const NOW = new Date('2026-06-27T21:30:45.123Z');

  it('emits a human-readable line and ISO + UTC lines', () => {
    const out = formatTimeContext(NOW);
    expect(out).toContain('Current date and time:');
    expect(out).toContain('ISO 8601:');
    // UTC is deterministic regardless of where the test runs, seconds preserved,
    // milliseconds stripped.
    expect(out).toContain('(UTC: 2026-06-27T21:30:45Z).');
  });

  it('includes a weekday, the IANA zone, and an offset-bearing local ISO', () => {
    const out = formatTimeContext(NOW);
    expect(out).toMatch(/Sunday|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday/);
    // IANA zone in parentheses on line 1: "UTC", "America/Los_Angeles", or a
    // three-part zone like "America/Argentina/Buenos_Aires".
    expect(out).toMatch(/\([A-Za-z]+(?:\/[A-Za-z_]+)*\)\.\n/);
    // Local ISO carries an explicit offset (+/-HH:MM or Z-equivalent +00:00).
    expect(out).toMatch(/ISO 8601: \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}/);
  });
});

describe('buildTimeContextBlock', () => {
  it('appends the relative-date grounding instruction', () => {
    const block = buildTimeContextBlock(new Date('2026-06-27T21:30:00Z'));
    expect(block).toContain('Current date and time:');
    expect(block).toContain('Treat this as the current moment');
  });
});

describe('CURRENT_TIME_TOOL', () => {
  it('is a no-argument function tool named get_current_time', () => {
    expect(GET_CURRENT_TIME_TOOL_NAME).toBe('get_current_time');
    expect(CURRENT_TIME_TOOL.function.name).toBe('get_current_time');
    expect(CURRENT_TIME_TOOL.function.parameters.properties).toEqual({});
  });
});
