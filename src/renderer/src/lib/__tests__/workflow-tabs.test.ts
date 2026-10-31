import { describe, expect, it } from 'vitest';
import type { PaneLeaf, PaneNode, PaneSplit } from '../../../../shared/types';
import type { RunTab } from '../../../../shared/workflows';
import { runTabRoot } from '../workflow-tabs';

const CWD = '/repo';

function leaf(id: string): PaneLeaf {
  return { type: 'leaf', id, cwd: CWD };
}

function split(ratio: number, left: PaneNode, right: PaneNode): PaneSplit {
  return { type: 'split', direction: 'horizontal', ratio, children: [left, right] };
}

function tab(...paneIds: string[]): RunTab {
  return { runId: 'run-1', label: 'Review', cwd: CWD, projectPath: CWD, paneIds, focus: false };
}

/** The share of the width each leaf gets, as the panes draw it. */
function widths(node: PaneNode, share = 1): Record<string, number> {
  if (node.type === 'leaf') return { [node.id]: share };
  return {
    ...widths(node.children[0], share * node.ratio),
    ...widths(node.children[1], share * (1 - node.ratio))
  };
}

function expectEvenColumns(root: PaneNode | null, ids: string[]): void {
  if (!root) throw new Error('The tab has no panes.');
  const shares = widths(root);

  expect(Object.keys(shares)).toEqual(ids);
  for (const share of Object.values(shares)) expect(share).toBeCloseTo(1 / ids.length);
}

describe('runTabRoot', () => {
  it('gives null for a tab with no panes', () => {
    expect(runTabRoot(null, tab())).toBeNull();
  });

  it('makes one leaf with the cwd of the run', () => {
    expect(runTabRoot(null, tab('a'))).toEqual(leaf('a'));
  });

  it('makes even columns for a new tab', () => {
    expectEvenColumns(runTabRoot(null, tab('a', 'b', 'c', 'd')), ['a', 'b', 'c', 'd']);
  });

  it('adds a new leaf to an even tree as an even column', () => {
    const start = runTabRoot(null, tab('a', 'b'));

    expectEvenColumns(runTabRoot(start, tab('a', 'b', 'c')), ['a', 'b', 'c']);
  });

  it('keeps a tree with the same panes as it is', () => {
    const resized = split(0.8, leaf('a'), split(0.25, leaf('b'), leaf('c')));

    expect(runTabRoot(resized, tab('a', 'b', 'c'))).toEqual(resized);
  });

  it('keeps a vertical split that a person made', () => {
    const moved: PaneSplit = { ...split(0.3, leaf('a'), leaf('b')), direction: 'vertical' };

    expect(runTabRoot(moved, tab('a', 'b'))).toEqual(moved);
  });

  it('keeps the resized part when a new leaf arrives', () => {
    const resized = split(0.8, leaf('a'), leaf('b'));

    const root = runTabRoot(resized, tab('a', 'b', 'c'));

    expect(root).toEqual(split(2 / 3, resized, leaf('c')));
  });

  it('gives each of several new leaves its own column', () => {
    const resized = split(0.8, leaf('a'), leaf('b'));

    const root = runTabRoot(resized, tab('a', 'b', 'c', 'd'));

    expect(root).toEqual(split(3 / 4, split(2 / 3, resized, leaf('c')), leaf('d')));
  });

  it('takes out a leaf that left the run and keeps the other ratios', () => {
    const resized = split(0.8, leaf('a'), split(0.25, leaf('b'), leaf('c')));

    expect(runTabRoot(resized, tab('a', 'c'))).toEqual(split(0.8, leaf('a'), leaf('c')));
  });

  it('gives null when every leaf left the run', () => {
    expect(runTabRoot(split(0.5, leaf('a'), leaf('b')), tab())).toBeNull();
  });

  it('replaces a leaf and keeps the rest of the tree', () => {
    const resized = split(0.8, leaf('a'), split(0.25, leaf('b'), leaf('c')));

    const root = runTabRoot(resized, tab('a', 'c', 'retry'));

    expect(root).toEqual(split(2 / 3, split(0.8, leaf('a'), leaf('c')), leaf('retry')));
  });

  it('does not change the tree it was given', () => {
    const resized = split(0.8, leaf('a'), split(0.25, leaf('b'), leaf('c')));
    const before = structuredClone(resized);

    runTabRoot(resized, tab('a', 'd'));

    expect(resized).toEqual(before);
  });

  it('keeps the fields of a leaf that stays', () => {
    const typed: PaneLeaf = { ...leaf('a'), ptyPid: 42, shell: '/bin/zsh' };

    expect(runTabRoot(split(0.5, typed, leaf('b')), tab('a'))).toEqual(typed);
  });
});
