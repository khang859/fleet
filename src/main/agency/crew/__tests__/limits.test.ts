import { describe, expect, it } from 'vitest';
import { clockTime } from '../../../../shared/agency-crew';
import { limitResetAt } from '../limits';

const at = (h: number, m = 0, dayOffset = 0): number => {
  const d = new Date(2026, 9, 17, h, m, 0, 0);
  d.setDate(d.getDate() + dayOffset);
  return d.getTime();
};

describe('limitResetAt', () => {
  const now = at(13, 20);

  it('reads the unix time Claude Code puts after a pipe', () => {
    expect(limitResetAt('Claude AI usage limit reached|1760720400', now)).toBe(1760720400000);
  });

  it('reads a time of day as the next one, in local time', () => {
    expect(limitResetAt("You've hit your limit · resets 3pm (Europe/London)", now)).toBe(at(15));
    expect(limitResetAt('5-hour limit reached ∙ resets at 3:30 pm', now)).toBe(at(15, 30));
    expect(limitResetAt('Limit reached, resets 12am', now)).toBe(at(0, 0, 1));
    expect(limitResetAt('usage limit; reset at 09:15', now)).toBe(at(9, 15, 1));
  });

  it('finds no time in text without one, or in a bare number', () => {
    expect(limitResetAt('API Error: Rate limit reached', now)).toBeNull();
    expect(limitResetAt('resets 3', now)).toBeNull();
    expect(limitResetAt('resets 13pm', now)).toBeNull();
  });

  it('writes a time as a 24-hour clock', () => {
    expect(clockTime(at(9, 5))).toBe('09:05');
  });
});
