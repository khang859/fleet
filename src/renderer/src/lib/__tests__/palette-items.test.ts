import { describe, it, expect } from 'vitest';
import { findPaneLocation, selectNeedsMePaneIds, paneLabel } from '../palette-items';
import type { Tab } from '../../../../shared/types';

function leaf(id: string, label?: string): Tab['splitRoot'] {
  return { type: 'leaf', id, cwd: `/work/${id}`, label };
}

const tabs: Tab[] = [
  { id: 't1', label: 'One', labelIsCustom: false, cwd: '/work', splitRoot: leaf('p1', 'Editor') },
  {
    id: 't2',
    label: 'Two',
    labelIsCustom: false,
    cwd: '/work',
    splitRoot: {
      type: 'split',
      direction: 'horizontal',
      ratio: 0.5,
      children: [leaf('p2'), leaf('p3', 'Logs')]
    }
  }
];

describe('findPaneLocation', () => {
  it('finds a pane nested inside a split', () => {
    const loc = findPaneLocation(tabs, 'p3');
    expect(loc?.tabId).toBe('t2');
    expect(loc?.leaf.id).toBe('p3');
  });

  it('returns null for an unknown pane', () => {
    expect(findPaneLocation(tabs, 'nope')).toBeNull();
  });
});

describe('paneLabel', () => {
  it('prefers the leaf label', () => {
    const loc = findPaneLocation(tabs, 'p3')!;
    expect(paneLabel(loc)).toBe('Logs');
  });

  it('falls back to the cwd basename when no leaf label', () => {
    const loc = findPaneLocation(tabs, 'p2')!;
    expect(paneLabel(loc)).toBe('p2');
  });
});

describe('selectNeedsMePaneIds', () => {
  it('returns only panes in the needs_me state', () => {
    const activities = new Map([
      ['p1', { state: 'working' as const }],
      ['p2', { state: 'needs_me' as const }],
      ['p3', { state: 'needs_me' as const }]
    ]);
    expect(selectNeedsMePaneIds(activities).sort()).toEqual(['p2', 'p3']);
  });
});
