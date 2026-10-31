import { describe, it, expect } from 'vitest';
import { mainWorkItems } from '../quit-work';

describe('mainWorkItems', () => {
  it('puts background commands before subagents', () => {
    const items = mainWorkItems({
      background: [{ id: 'b1', command: 'npm test' }],
      subagents: [{ taskId: 't1', agent: 'explorer', prompt: 'map the repo' }]
    });
    expect(items.map((i) => i.kind)).toEqual(['background', 'subagent']);
    expect(items[1]?.label).toBe('explorer: map the repo');
  });

  it('keeps a row to one line of at most 80 characters', () => {
    const [item] = mainWorkItems({
      background: [],
      subagents: [{ taskId: 't1', agent: 'explorer', prompt: 'x'.repeat(200) }]
    });
    expect(item.label).toHaveLength(80 + 'explorer: '.length);
    expect(item.label.endsWith('…')).toBe(true);
  });
});
