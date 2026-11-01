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

function rows(ratio: number, top: PaneNode, bottom: PaneNode): PaneSplit {
  return { type: 'split', direction: 'vertical', ratio, children: [top, bottom] };
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

type Box = { left: number; top: number; width: number; height: number };

/** Where each pane sits in the tab, from 0 to 1, as the panes draw it. */
function boxes(
  node: PaneNode,
  box: Box = { left: 0, top: 0, width: 1, height: 1 }
): Record<string, Box> {
  if (node.type === 'leaf') return { [node.id]: box };
  const { left, top, width, height } = box;
  const [first, second] = node.children;
  if (node.direction === 'horizontal') {
    const split = width * node.ratio;
    return {
      ...boxes(first, { ...box, width: split }),
      ...boxes(second, { ...box, left: left + split, width: width - split })
    };
  }
  const split = height * node.ratio;
  return {
    ...boxes(first, { ...box, height: split }),
    ...boxes(second, { ...box, top: top + split, height: height - split })
  };
}

function expectGrid(root: PaneNode | null, grid: string[][]): void {
  if (!root) throw new Error('The tab has no panes.');
  const placed = boxes(root);

  expect(Object.keys(placed)).toEqual(grid.flat());
  grid.forEach((row, rowIndex) => {
    row.forEach((id, column) => {
      expect(placed[id].top).toBeCloseTo(rowIndex / grid.length);
      expect(placed[id].height).toBeCloseTo(1 / grid.length);
      expect(placed[id].left).toBeCloseTo(column / row.length);
      expect(placed[id].width).toBeCloseTo(1 / row.length);
    });
  });
}

describe('runTabRoot', () => {
  it('gives null for a tab with no panes', () => {
    expect(runTabRoot(null, tab())).toBeNull();
  });

  it('makes one leaf with the cwd of the run', () => {
    expect(runTabRoot(null, tab('a'))).toEqual(leaf('a'));
  });

  it('makes even columns for up to three panes', () => {
    expectEvenColumns(runTabRoot(null, tab('a', 'b', 'c')), ['a', 'b', 'c']);
  });

  it('starts a second row with the fourth pane', () => {
    expectGrid(runTabRoot(null, tab('a', 'b', 'c', 'd')), [['a', 'b', 'c'], ['d']]);
  });

  it('fills a row before it starts the next one', () => {
    const ids = ['a', 'b', 'c', 'd', 'e', 'f', 'g'];

    expectGrid(runTabRoot(null, tab(...ids)), [ids.slice(0, 3), ids.slice(3, 6), ids.slice(6)]);
  });

  it('builds the same grid when panes open one at a time', () => {
    const ids = ['a', 'b', 'c', 'd', 'e', 'f', 'g'];

    const root = ids.reduce<PaneNode | null>(
      (current, _id, index) => runTabRoot(current, tab(...ids.slice(0, index + 1))),
      null
    );

    expectGrid(root, [ids.slice(0, 3), ids.slice(3, 6), ids.slice(6)]);
  });

  it('keeps a row that a person resized when a pane joins the next row', () => {
    const resized = rows(0.7, split(0.8, leaf('a'), split(0.5, leaf('b'), leaf('c'))), leaf('d'));

    const root = runTabRoot(resized, tab('a', 'b', 'c', 'd', 'e'));

    expect(root).toEqual(rows(0.7, resized.children[0], split(0.5, leaf('d'), leaf('e'))));
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

  it('gives each of several new leaves its own place', () => {
    const resized = split(0.8, leaf('a'), leaf('b'));

    const root = runTabRoot(resized, tab('a', 'b', 'c', 'd'));

    expect(root).toEqual(rows(1 / 2, split(2 / 3, resized, leaf('c')), leaf('d')));
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

  describe('with a builder', () => {
    const builder = (...paneIds: string[]): RunTab => ({ ...tab(...paneIds), builderId: 'b1' });
    const draft: PaneLeaf = {
      ...leaf('draft-b1'),
      paneType: 'workflow-draft',
      builderId: 'b1'
    };

    it('puts the draft beside the terminal', () => {
      expect(runTabRoot(null, builder('a'))).toEqual(split(0.5, leaf('a'), draft));
    });

    it('keeps the draft and its size when the tree comes back', () => {
      const resized = split(0.7, leaf('a'), draft);

      expect(runTabRoot(resized, builder('a'))).toEqual(resized);
    });

    it('has no draft before the terminal is there', () => {
      expect(runTabRoot(null, builder())).toBeNull();
    });

    it('takes the draft away with the terminal', () => {
      expect(runTabRoot(split(0.5, leaf('a'), draft), builder())).toBeNull();
    });
  });
});
