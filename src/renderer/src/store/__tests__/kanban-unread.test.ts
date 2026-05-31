import { describe, it, expect, beforeEach } from 'vitest';
import { useKanbanStore } from '../kanban-store';

describe('kanban unread badge state', () => {
  beforeEach(() => {
    useKanbanStore.setState({ unreadCount: 0 });
  });

  it('increments and clears', () => {
    useKanbanStore.getState().incrementUnread();
    useKanbanStore.getState().incrementUnread();
    expect(useKanbanStore.getState().unreadCount).toBe(2);
    useKanbanStore.getState().markSeen();
    expect(useKanbanStore.getState().unreadCount).toBe(0);
  });
});
