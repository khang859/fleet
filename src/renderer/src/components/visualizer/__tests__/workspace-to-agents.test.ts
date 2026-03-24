import { describe, it, expect } from 'vitest';
import { workspaceToAgents } from '../space-canvas-utils';

describe('workspaceToAgents', () => {
  it('maps a single tab with one pane to an agent with no subAgents', () => {
    const tabs = [
      {
        id: 'tab-1',
        label: 'Tab 1',
        splitRoot: { type: 'leaf' as const, id: 'pane-1', cwd: '/tmp' }
      }
    ];

    const agents = workspaceToAgents(tabs);

    expect(agents).toHaveLength(1);
    expect(agents[0].paneId).toBe('tab-1');
    expect(agents[0].label).toBe('Tab 1');
    expect(agents[0].state).toBe('idle');
    expect(agents[0].subAgents).toEqual([]);
  });

  it('maps a tab with split panes to an agent with subAgents', () => {
    const tabs = [
      {
        id: 'tab-2',
        label: 'Tab 2',
        splitRoot: {
          type: 'split' as const,
          direction: 'horizontal' as const,
          ratio: 0.5,
          children: [
            { type: 'leaf' as const, id: 'pane-a', cwd: '/tmp' },
            { type: 'leaf' as const, id: 'pane-b', cwd: '/tmp' }
          ] as [
            { type: 'leaf'; id: string; cwd: string },
            { type: 'leaf'; id: string; cwd: string }
          ]
        }
      }
    ];

    const agents = workspaceToAgents(tabs);

    expect(agents).toHaveLength(1);
    expect(agents[0].subAgents).toHaveLength(2);
    expect(agents[0].subAgents[0].paneId).toBe('pane-a');
    expect(agents[0].subAgents[1].paneId).toBe('pane-b');
  });

  it('returns stable output for the same input', () => {
    const tabs = [
      {
        id: 'tab-1',
        label: 'Tab 1',
        splitRoot: { type: 'leaf' as const, id: 'pane-1', cwd: '/tmp' }
      }
    ];

    const result1 = workspaceToAgents(tabs);
    const result2 = workspaceToAgents(tabs);

    expect(result1).toEqual(result2);
  });
});
