import { describe, expect, it } from 'vitest';
import { matches } from '../layer-search';

describe('LayerPicker search', () => {
  const keywords = ['journey', '/Users/me/ws2/journey'];

  it('matches a project by its name or folder, in any case', () => {
    expect(matches('id', 'JOUR', keywords)).toBe(1);
    expect(matches('id', 'ws2/', keywords)).toBe(1);
    expect(matches('id', '  ', keywords)).toBe(1);
  });

  it('does not match scattered letters', () => {
    expect(matches('id', 'jy', keywords)).toBe(0);
    expect(matches('id', 'crew', keywords)).toBe(0);
  });
});
