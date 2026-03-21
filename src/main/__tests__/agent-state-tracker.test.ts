import { describe, it, expect, beforeEach } from 'vitest';
import { AgentStateTracker } from '../agent-state-tracker';
import { EventBus } from '../event-bus';

describe('AgentStateTracker', () => {
  let eventBus: EventBus;
  let tracker: AgentStateTracker;

  beforeEach(() => {
    eventBus = new EventBus();
    tracker = new AgentStateTracker(eventBus);
  });

  it('creates agent entry when pane-created fires', () => {
    eventBus.emit('pane-created', { type: 'pane-created', paneId: 'pane-1' });

    const state = tracker.getState('pane-1');
    expect(state).toBeDefined();
    expect(state?.state).toBe('not-agent');
  });

  it('transitions to working when tool_use Write is detected', () => {
    eventBus.emit('pane-created', { type: 'pane-created', paneId: 'pane-1' });

    tracker.handleJsonlRecord('pane-1', {
      type: 'assistant',
      message: {
        content: [{ type: 'tool_use', name: 'Write' }]
      }
    });

    expect(tracker.getState('pane-1')?.state).toBe('working');
  });

  it('transitions to reading when tool_use Read is detected', () => {
    eventBus.emit('pane-created', { type: 'pane-created', paneId: 'pane-1' });

    tracker.handleJsonlRecord('pane-1', {
      type: 'assistant',
      message: {
        content: [{ type: 'tool_use', name: 'Read' }]
      }
    });

    expect(tracker.getState('pane-1')?.state).toBe('reading');
  });

  it('transitions to needs-permission on permission event', () => {
    eventBus.emit('pane-created', { type: 'pane-created', paneId: 'pane-1' });

    eventBus.emit('notification', {
      type: 'notification',
      paneId: 'pane-1',
      level: 'permission',
      timestamp: Date.now()
    });

    expect(tracker.getState('pane-1')?.state).toBe('needs-permission');
  });

  it('removes agent entry when pane-closed fires', () => {
    eventBus.emit('pane-created', { type: 'pane-created', paneId: 'pane-1' });
    eventBus.emit('pane-closed', { type: 'pane-closed', paneId: 'pane-1' });

    expect(tracker.getState('pane-1')).toBeUndefined();
  });

  it('detects sub-agents from progress records', () => {
    eventBus.emit('pane-created', { type: 'pane-created', paneId: 'pane-1' });

    tracker.handleJsonlRecord('pane-1', {
      type: 'assistant',
      message: { content: [{ type: 'tool_use', name: 'Edit' }] }
    });

    tracker.handleJsonlRecord('pane-1', {
      type: 'progress',
      data: {
        type: 'agent_progress',
        parentToolUseID: 'tool-abc'
      },
      message: {
        content: [{ type: 'tool_use', name: 'Read' }]
      }
    });

    const state = tracker.getState('pane-1');
    expect(state?.subAgents).toHaveLength(1);
    expect(state?.subAgents[0].state).toBe('reading');
  });

  it('returns all states', () => {
    eventBus.emit('pane-created', { type: 'pane-created', paneId: 'pane-1' });
    eventBus.emit('pane-created', { type: 'pane-created', paneId: 'pane-2' });

    expect(tracker.getAllStates()).toHaveLength(2);
  });

  it('caps sub-agents at 100 per agent, evicting the oldest', () => {
    const eventBus = new EventBus();
    const tracker = new AgentStateTracker(eventBus);

    eventBus.emit('pane-created', { type: 'pane-created', paneId: 'pane-1' });

    // Feed 150 sub-agent progress records
    for (let i = 0; i < 150; i++) {
      tracker.handleJsonlRecord('pane-1', {
        type: 'progress',
        data: {
          type: 'agent_progress',
          parentToolUseID: `sub-${i}`
        },
        message: {
          content: [{ type: 'tool_use', name: 'Read' }]
        }
      });
    }

    const state = tracker.getState('pane-1');
    expect(state?.subAgents.length).toBe(100);
  });
});
