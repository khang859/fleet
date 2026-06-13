import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { KanbanNotifier, type KanbanNotificationPayload } from '../kanban/kanban-notifier';
import type { TaskEvent } from '../../shared/kanban-types';
import type { KanbanNotifyCategory } from '../../shared/kanban-notifications';

function evt(kind: string, taskId = 't1'): TaskEvent {
  return { id: 1, taskId, runId: null, kind, payload: null, createdAt: 0 };
}

describe('KanbanNotifier', () => {
  let present: ReturnType<typeof vi.fn<(payload: KanbanNotificationPayload) => void>>;
  let tasks: Record<string, { title: string; boardId: string }>;
  let features: Record<string, { name: string; boardId: string }>;
  let enabled: Record<KanbanNotifyCategory, boolean>;
  let autoReview: boolean;
  let notifier: KanbanNotifier;

  beforeEach(() => {
    vi.useFakeTimers();
    present = vi.fn<(payload: KanbanNotificationPayload) => void>();
    tasks = {
      t1: { title: 'Fix login', boardId: 'default' },
      t2: { title: 'Write docs', boardId: 'default' }
    };
    features = {
      feat1: { name: 'My Feature', boardId: 'default' }
    };
    enabled = { blocked: true, failed: true, completed: true, scheduleFired: true };
    autoReview = false;
    notifier = new KanbanNotifier({
      isOsEnabled: (c) => enabled[c],
      isAutoReviewOn: () => autoReview,
      getTask: (id) => tasks[id] ?? null,
      getFeature: (id) => features[id] ?? null,
      present,
      batchMs: 500
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('fires a single notification deep-linking to the task', () => {
    notifier.enqueue(evt('blocked', 't1'));
    vi.advanceTimersByTime(500);
    expect(present).toHaveBeenCalledTimes(1);
    expect(present).toHaveBeenCalledWith({
      body: 'Blocked: Fix login',
      boardSlug: 'default',
      taskId: 't1'
    });
  });

  it('coalesces a burst into one notification with counts and no taskId', () => {
    notifier.enqueue(evt('completed', 't1'));
    notifier.enqueue(evt('completed', 't2'));
    notifier.enqueue(evt('blocked', 't1'));
    vi.advanceTimersByTime(500);
    expect(present).toHaveBeenCalledTimes(1);
    const arg = present.mock.calls[0][0];
    expect(arg.body).toBe('3 task updates: 1 blocked, 2 completed');
    expect(arg.boardSlug).toBe('default');
    expect(arg.taskId).toBeUndefined();
  });

  it('does not fire when the category OS toggle is off', () => {
    enabled.completed = false;
    notifier.enqueue(evt('completed', 't1'));
    vi.advanceTimersByTime(500);
    expect(present).not.toHaveBeenCalled();
  });

  it('ignores non-attention kinds', () => {
    notifier.enqueue(evt('heartbeat', 't1'));
    vi.advanceTimersByTime(500);
    expect(present).not.toHaveBeenCalled();
  });

  it('skips items whose task no longer exists', () => {
    notifier.enqueue(evt('completed', 'gone'));
    vi.advanceTimersByTime(500);
    expect(present).not.toHaveBeenCalled();
  });

  it('suppresses gate-pass events when autoReview is on', () => {
    autoReview = true;
    notifier.enqueue(evt('review_ready', 't1'));
    notifier.enqueue(evt('verify_passed', 't1'));
    notifier.enqueue(evt('verify_skipped', 't1'));
    vi.advanceTimersByTime(500);
    expect(present).not.toHaveBeenCalled();
  });

  it('still fires gate-pass events when autoReview is off', () => {
    autoReview = false;
    notifier.enqueue(evt('verify_passed', 't1'));
    vi.advanceTimersByTime(500);
    expect(present).toHaveBeenCalledTimes(1);
  });

  it('still fires review verdict events when autoReview is on', () => {
    autoReview = true;
    notifier.enqueue(evt('review_passed', 't1'));
    vi.advanceTimersByTime(500);
    expect(present).toHaveBeenCalledTimes(1);
  });

  it('feature_pr_ready notifies as completed using the feature name', () => {
    notifier.enqueue(evt('feature_pr_ready', 'feat1'));
    vi.advanceTimersByTime(500);
    expect(present).toHaveBeenCalledTimes(1);
    const arg = present.mock.calls[0][0];
    expect(arg.body).toContain('My Feature');
    expect(arg.boardSlug).toBe('default');
    expect(arg.taskId).toBe('feat1');
  });
});
