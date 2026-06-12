import { describe, it, expect } from 'vitest';
import {
  classifyKanbanEvent,
  kanbanNotifyChannel,
  KANBAN_NOTIFY_CATEGORIES
} from '../kanban-notifications';

describe('classifyKanbanEvent', () => {
  it('maps source kinds to categories', () => {
    expect(classifyKanbanEvent('blocked')).toBe('blocked');
    expect(classifyKanbanEvent('gave_up')).toBe('failed');
    expect(classifyKanbanEvent('spawn_failed')).toBe('failed');
    expect(classifyKanbanEvent('completed')).toBe('completed');
    expect(classifyKanbanEvent('schedule_fired')).toBe('scheduleFired');
  });

  it('treats a gated task reaching review (verify pass/skip) like a completion', () => {
    // Parity with the ungated 'completed' event: a verify-gated task that lands
    // in review must still fire the review-ready notification.
    expect(classifyKanbanEvent('verify_passed')).toBe('completed');
    expect(classifyKanbanEvent('verify_skipped')).toBe('completed');
  });

  it('does not notify on an in-flight verify retry', () => {
    // verify_failed under cap auto-retries; no user-facing notification yet.
    expect(classifyKanbanEvent('verify_failed')).toBeNull();
    expect(classifyKanbanEvent('verify_started')).toBeNull();
  });

  it('returns null for non-attention kinds', () => {
    for (const kind of [
      'comment',
      'heartbeat',
      'promoted',
      'task_created',
      'spawned',
      'reclaimed'
    ]) {
      expect(classifyKanbanEvent(kind)).toBeNull();
    }
  });

  it('exposes all four categories', () => {
    expect([...KANBAN_NOTIFY_CATEGORIES].sort()).toEqual(
      ['blocked', 'completed', 'failed', 'scheduleFired'].sort()
    );
  });
});

describe('kanbanNotifyChannel', () => {
  const settings = {
    blocked: { os: true, badge: false },
    failed: { os: false, badge: true },
    completed: { os: true, badge: true },
    scheduleFired: { os: false, badge: false }
  };

  it('returns the channel flag for the classified category', () => {
    expect(kanbanNotifyChannel('blocked', settings, 'os')).toBe(true);
    expect(kanbanNotifyChannel('blocked', settings, 'badge')).toBe(false);
    expect(kanbanNotifyChannel('gave_up', settings, 'badge')).toBe(true);
    expect(kanbanNotifyChannel('schedule_fired', settings, 'os')).toBe(false);
  });

  it('returns false for unclassified kinds', () => {
    expect(kanbanNotifyChannel('heartbeat', settings, 'os')).toBe(false);
    expect(kanbanNotifyChannel('heartbeat', settings, 'badge')).toBe(false);
  });
});
