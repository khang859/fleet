import { describe, it, expect } from 'vitest';
import { neighbourTabId } from '../use-pane-navigation';

describe('neighbourTabId', () => {
  const rows = ['a', 'b', 'c'];

  it('steps to the row below and the row above', () => {
    expect(neighbourTabId(rows, 'b', 1)).toBe('c');
    expect(neighbourTabId(rows, 'b', -1)).toBe('a');
  });

  it('stops at both ends instead of wrapping', () => {
    expect(neighbourTabId(rows, 'a', -1)).toBeUndefined();
    expect(neighbourTabId(rows, 'c', 1)).toBeUndefined();
  });

  it('goes nowhere from a tab the sidebar is not showing', () => {
    expect(neighbourTabId(rows, 'hidden', 1)).toBeUndefined();
  });
});
