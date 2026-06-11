import { describe, it, expect } from 'vitest';
import { DEFAULT_SETTINGS } from '../constants';

describe('kanban dispatcher defaults', () => {
  it('defaults autoAssign and autoIntegrate to on', () => {
    expect(DEFAULT_SETTINGS.kanban.dispatcher.autoAssign).toBe(true);
    expect(DEFAULT_SETTINGS.kanban.dispatcher.autoIntegrate).toBe(true);
  });
});
