import { describe, it, expect } from 'vitest';
import { DEFAULT_SETTINGS } from '../../shared/constants';

describe('DEFAULT_SETTINGS.kanban.profiles', () => {
  it('seeds the SDLC roles required by the full_feature pipeline', () => {
    const byName = new Map(DEFAULT_SETTINGS.kanban.profiles.map((p) => [p.name, p.role]));
    expect(byName.get('explorer')).toBe('explorer');
    expect(byName.get('architect')).toBe('architect');
    expect(byName.get('reviewer')).toBe('reviewer');
    expect(byName.get('qa')).toBe('qa');
  });

  it('has the expected total profile count with no duplicate names', () => {
    const names = DEFAULT_SETTINGS.kanban.profiles.map((p) => p.name);
    expect(names).toHaveLength(6);
    expect(new Set(names).size).toBe(names.length);
  });
});
