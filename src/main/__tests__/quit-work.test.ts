import { describe, it, expect } from 'vitest';
import { mainWorkItems } from '../quit-work';

describe('mainWorkItems', () => {
  it('lists running Admiral jobs by their display id and title', () => {
    expect(
      mainWorkItems({
        background: [],
        subagents: [],
        jobs: [{ id: 7, title: 'Add farewell()\n  to greet.js' }]
      })
    ).toEqual([{ kind: 'job', id: '7', label: 'j7 Add farewell() to greet.js' }]);
  });

  it('puts background commands and subagents before jobs', () => {
    const items = mainWorkItems({
      background: [{ id: 'b1', command: 'npm test' }],
      subagents: [{ taskId: 't1', agent: 'explorer', prompt: 'map the repo' }],
      jobs: [{ id: 1, title: 'Fix login' }]
    });
    expect(items.map((i) => i.kind)).toEqual(['background', 'subagent', 'job']);
    expect(items[1]?.label).toBe('explorer: map the repo');
  });

  it('keeps a row to one line of at most 80 characters', () => {
    const [item] = mainWorkItems({
      background: [],
      subagents: [],
      jobs: [{ id: 1, title: 'x'.repeat(200) }]
    });
    expect(item.label).toHaveLength(80 + 'j1 '.length);
    expect(item.label.endsWith('…')).toBe(true);
  });
});
