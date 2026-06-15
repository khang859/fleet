import { describe, it, expect } from 'vitest';
import { pathMessagesToNode, type SessionTree, type SessionTreeNode } from '../sessions';

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

// n1 -> { a1 -> a2 (active), b1 }
const TREE: SessionTree = {
  activeId: 'a2',
  nodes: [
    node('n1', null, ['a1', 'b1']),
    node('a1', 'n1', ['a2']),
    node('a2', 'a1', []),
    node('b1', 'n1', [])
  ]
};

describe('pathMessagesToNode', () => {
  it('returns the root-first path to the active leaf', () => {
    expect(pathMessagesToNode(TREE, 'a2').map((m) => m.blocks[0])).toEqual([
      { type: 'text', text: 'n1' },
      { type: 'text', text: 'a1' },
      { type: 'text', text: 'a2' }
    ]);
  });

  it('scopes to an abandoned branch when that node is given', () => {
    expect(pathMessagesToNode(TREE, 'b1').map((m) => m.blocks[0])).toEqual([
      { type: 'text', text: 'n1' },
      { type: 'text', text: 'b1' }
    ]);
  });

  it('returns no messages for a null selection', () => {
    expect(pathMessagesToNode(TREE, null)).toEqual([]);
  });
});
