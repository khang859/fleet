import { describe, it, expect } from 'vitest';
import type { SessionTree, SessionTreeNode } from '../../../../../shared/sessions';
import { flattenTree, pathIds, pathToNode } from '../tree-utils';

function node(id: string, parentId: string | null, childIds: string[]): SessionTreeNode {
  return {
    id,
    parentId,
    childIds,
    role: 'assistant',
    blocks: [{ type: 'text', text: id }],
    preview: id
  };
}

// n1 (top-level) -> { a1 (active), b1 }; a1 -> a2
const TREE: SessionTree = {
  activeId: 'a2',
  nodes: [
    node('n1', null, ['a1', 'b1']),
    node('a1', 'n1', ['a2']),
    node('a2', 'a1', []),
    node('b1', 'n1', [])
  ]
};

describe('pathIds', () => {
  it('returns the ids on root -> node inclusive', () => {
    expect(pathIds(TREE, 'a2')).toEqual(new Set(['a2', 'a1', 'n1']));
    expect(pathIds(TREE, 'b1')).toEqual(new Set(['b1', 'n1']));
  });

  it('returns an empty set for a null selection', () => {
    expect(pathIds(TREE, null).size).toBe(0);
  });
});

describe('pathToNode', () => {
  it('returns messages in chronological (root-first) order', () => {
    expect(pathToNode(TREE, 'a2').map((m) => m.blocks[0])).toEqual([
      { type: 'text', text: 'n1' },
      { type: 'text', text: 'a1' },
      { type: 'text', text: 'a2' }
    ]);
  });

  it('walks the abandoned branch when that node is selected', () => {
    expect(pathToNode(TREE, 'b1').map((m) => m.blocks[0])).toEqual([
      { type: 'text', text: 'n1' },
      { type: 'text', text: 'b1' }
    ]);
  });
});

describe('flattenTree', () => {
  it('emits depth-first pre-order rows with connector metadata', () => {
    const rows = flattenTree(TREE);
    expect(rows.map((r) => r.node.id)).toEqual(['n1', 'a1', 'a2', 'b1']);

    const byId = Object.fromEntries(rows.map((r) => [r.node.id, r]));
    // Top-level node: no connector, no ancestor bars.
    expect(byId.n1.isRoot).toBe(true);
    expect(byId.n1.ancestorBars).toEqual([]);
    // a1 is the first (non-last) child of root -> elbow but no leading bar column.
    expect(byId.a1.isRoot).toBe(false);
    expect(byId.a1.isLast).toBe(false);
    expect(byId.a1.ancestorBars).toEqual([]);
    // a2 is the last child of a1; a1 still has a following sibling (b1), so a bar continues.
    expect(byId.a2.ancestorBars).toEqual([true]);
    expect(byId.a2.isLast).toBe(true);
    // b1 is the last child of root.
    expect(byId.b1.isLast).toBe(true);
    expect(byId.b1.ancestorBars).toEqual([]);
  });
});
