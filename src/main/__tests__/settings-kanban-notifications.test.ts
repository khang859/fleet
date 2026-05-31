import { describe, it, expect } from 'vitest';
import { DEFAULT_SETTINGS } from '../../shared/constants';
import { KANBAN_NOTIFY_CATEGORIES } from '../../shared/kanban-notifications';

describe('kanban notification defaults', () => {
  it('defines all four categories defaulting to os+badge on', () => {
    const n = DEFAULT_SETTINGS.kanban.notifications;
    for (const cat of KANBAN_NOTIFY_CATEGORIES) {
      expect(n[cat]).toEqual({ os: true, badge: true });
    }
  });
});
