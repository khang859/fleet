import { describe, it, expect } from 'vitest';
import { slashMenu, type SlashCommand } from '../composer-slash';

const skill = (name: string): SlashCommand => ({
  kind: 'skill',
  name,
  description: `${name} desc`
});

describe('slashMenu', () => {
  it('is closed when the text is not a lone slash token', () => {
    expect(slashMenu('hello', [skill('create-goal')], false).open).toBe(false);
    expect(slashMenu('/create-goal now', [skill('create-goal')], false).open).toBe(false);
    expect(slashMenu('', [skill('create-goal')], false).open).toBe(false);
  });

  it('is closed when dismissed', () => {
    expect(slashMenu('/', [skill('create-goal')], true).open).toBe(false);
  });

  it('opens with all commands on a bare slash', () => {
    const r = slashMenu('/', [skill('create-goal'), skill('code-review')], false);
    expect(r.open).toBe(true);
    expect(r.matches.map((m) => m.name)).toEqual(['create-goal', 'code-review']);
    expect(r.emptyLabel).toBeNull();
  });

  it('filters by prefix, case-insensitively', () => {
    const r = slashMenu('/CRE', [skill('create-goal'), skill('code-review')], false);
    expect(r.matches.map((m) => m.name)).toEqual(['create-goal']);
    expect(r.emptyLabel).toBeNull();
  });

  it('opens with a "no skills yet" label when nothing is installed', () => {
    const r = slashMenu('/', [], false);
    expect(r.open).toBe(true);
    expect(r.matches).toEqual([]);
    expect(r.emptyLabel).toBe('No skills yet — manage in Settings');
  });

  it('opens with a "no matching" label when the filter excludes everything', () => {
    const r = slashMenu('/zzz', [skill('create-goal')], false);
    expect(r.open).toBe(true);
    expect(r.matches).toEqual([]);
    expect(r.emptyLabel).toBe('No matching skills');
  });
});
