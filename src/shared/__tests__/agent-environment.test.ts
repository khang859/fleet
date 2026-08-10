import { describe, expect, it } from 'vitest';
import {
  formatLocalTime,
  renderEnvBlock,
  renderTimeBlock,
  type AgentEnvironment
} from '../agent-environment';

const ENV: AgentEnvironment = {
  platform: 'darwin',
  osVersion: 'Darwin 25.5.0',
  shell: '/bin/zsh',
  isGitRepo: true,
  timeZone: 'Asia/Ho_Chi_Minh',
  model: 'anthropic/claude-sonnet-4.5'
};

/** A fixed instant, so every assertion below is about formatting and not about now. */
const INSTANT = new Date('2026-08-10T07:32:07Z');

describe('renderEnvBlock', () => {
  it('states every fact it was given', () => {
    const block = renderEnvBlock('/repo', ENV);
    expect(block).toContain('Working folder: /repo');
    expect(block).toContain('Platform: darwin');
    expect(block).toContain('OS version: Darwin 25.5.0');
    expect(block).toContain('Shell: /bin/zsh');
    expect(block).toContain('Timezone: Asia/Ho_Chi_Minh');
    expect(block).toContain('Model: anthropic/claude-sonnet-4.5');
  });

  it('answers the git question in words rather than in a boolean', () => {
    expect(renderEnvBlock('/repo', ENV)).toContain('Is a git repo: yes');
    expect(renderEnvBlock('/downloads', { ...ENV, isGitRepo: false })).toContain(
      'Is a git repo: no'
    );
  });

  /*
   * The reason the split exists. A clock here would be rewriting the request's
   * cache prefix on every turn, and would be stale by the second one.
   */
  it('carries no clock', () => {
    const block = renderEnvBlock('/repo', ENV);
    expect(block).not.toContain('Current time');
    expect(block).not.toMatch(/\d{2}:\d{2}:\d{2}/);
  });

  /*
   * Prose and indentation, like every other block Fleet assembles. A turn here
   * can be answered by whichever model OpenRouter routes it to, and a tag one of
   * them has never seen is either ignored or read out loud - the reasoning
   * `FLEET_WIRE_PREFIX` sets out.
   */
  it('frames itself in prose rather than in a tag', () => {
    expect(renderEnvBlock('/repo', ENV)).not.toMatch(/[<>]/);
    expect(renderTimeBlock(INSTANT, ENV.timeZone)).not.toMatch(/[<>]/);
  });
});

describe('formatLocalTime', () => {
  it('reads the clock the developer is looking at, offset and all', () => {
    expect(formatLocalTime(INSTANT, 'Asia/Ho_Chi_Minh')).toBe('2026-08-10 14:32:07 +07:00');
    expect(formatLocalTime(INSTANT, 'America/New_York')).toBe('2026-08-10 03:32:07 -04:00');
  });

  // The formatter writes a bare `GMT` here, which would otherwise leave the
  // reading with no offset on it at all.
  it('spells UTC out as the zero offset it is', () => {
    expect(formatLocalTime(INSTANT, 'UTC')).toBe('2026-08-10 07:32:07 +00:00');
  });

  // The offset is not a property of the machine, which is why it travels with
  // the clock rather than sitting in the cached block beside the zone name.
  it('follows the zone across daylight saving', () => {
    const january = new Date('2026-01-15T12:00:00Z');
    const july = new Date('2026-07-15T12:00:00Z');
    expect(formatLocalTime(january, 'Europe/Berlin')).toContain('+01:00');
    expect(formatLocalTime(july, 'Europe/Berlin')).toContain('+02:00');
  });

  // `hour12: false` renders this as hour 24 in V8, which is why the formatter
  // asks for `h23` instead.
  it('calls midnight hour zero', () => {
    const midnight = new Date('2026-08-10T00:00:00Z');
    expect(formatLocalTime(midnight, 'UTC')).toBe('2026-08-10 00:00:00 +00:00');
  });
});

describe('renderTimeBlock', () => {
  // Bare, because the caller puts it out under `FLEET_WIRE_PREFIX` like every
  // other block Fleet pushes onto a round.
  it('is the reading and nothing else', () => {
    expect(renderTimeBlock(INSTANT, 'Asia/Ho_Chi_Minh')).toBe(
      'Current time: 2026-08-10 14:32:07 +07:00'
    );
  });
});
