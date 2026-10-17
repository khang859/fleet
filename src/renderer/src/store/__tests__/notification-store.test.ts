import { beforeEach, describe, expect, it } from 'vitest';
import type { ActivityState } from '../../../../shared/types';
import { useNotificationStore } from '../notification-store';

function report(paneId: string, state: ActivityState, timestamp: number): void {
  useNotificationStore
    .getState()
    .setActivity({ paneId, state, lastOutputAt: timestamp, timestamp });
}

describe('getTabActivity', () => {
  beforeEach(() => {
    useNotificationStore.setState({ activities: new Map(), notifications: new Map() });
  });

  it('is the most recent activity across the tab', () => {
    report('a', 'working', 1);
    report('b', 'done', 2);
    expect(useNotificationStore.getState().getTabActivity(['a', 'b'])?.paneId).toBe('b');
  });

  it('keeps a pane waiting on the user on top of a newer one that is not', () => {
    report('agent', 'needs_me', 1);
    report('shell', 'idle', 2);
    expect(useNotificationStore.getState().getTabActivity(['agent', 'shell'])?.paneId).toBe(
      'agent'
    );
    expect(useNotificationStore.getState().getTabActivity(['shell', 'agent'])?.paneId).toBe(
      'agent'
    );
  });

  it('is undefined for a tab with no activity', () => {
    expect(useNotificationStore.getState().getTabActivity(['x'])).toBeUndefined();
  });
});
