import { describe, it, expect } from 'vitest';
import { summarizeRune, readRuneTranscript } from '../rune-source';

const RAW = {
  id: 'a1b2c3d4e5f6g7h8',
  name: 'Fix auth bug',
  created: '2026-04-30T09:08:07Z',
  provider: 'groq',
  model: 'mixtral-8x7b-32768',
  cwd: '/Users/khang/projects/myapp',
  root_id: 'root',
  active_id: 'n2',
  nodes: [
    {
      id: 'root',
      parent_id: '',
      children: ['n1'],
      has_message: false,
      created: '2026-04-30T09:08:07Z'
    },
    {
      id: 'n1',
      parent_id: 'root',
      children: ['n2'],
      has_message: true,
      message: {
        role: 'user',
        content: [{ type: 'text', text: 'fix the login issue in auth.go' }]
      },
      created: '2026-04-30T09:08:08Z'
    },
    {
      id: 'n2',
      parent_id: 'n1',
      children: [],
      has_message: true,
      message: {
        role: 'assistant',
        content: [
          { type: 'text', text: 'I found it in auth.go' },
          { type: 'tool_use', id: 't1', name: 'read', args: '{"path":"auth.go"}' }
        ]
      },
      created: '2026-04-30T09:08:12Z'
    }
  ],
  subagents: [],
  files_read: ['/Users/khang/projects/myapp/auth.go']
};

describe('summarizeRune', () => {
  it('builds a summary from the active path', () => {
    const s = summarizeRune(RAW, 1700000000000);
    expect(s).not.toBeNull();
    expect(s!.agent).toBe('rune');
    expect(s!.id).toBe('a1b2c3d4e5f6g7h8');
    expect(s!.title).toBe('Fix auth bug');
    expect(s!.model).toBe('mixtral-8x7b-32768');
    expect(s!.provider).toBe('groq');
    expect(s!.cwd).toBe('/Users/khang/projects/myapp');
    expect(s!.project).toBe('myapp');
    expect(s!.messageCount).toBe(2);
    expect(s!.preview).toBe('fix the login issue in auth.go');
    expect(s!.updatedAt).toBe(1700000000000);
  });

  it('falls back to preview when name is missing', () => {
    const s = summarizeRune({ ...RAW, name: undefined }, 1);
    expect(s!.title).toBe('fix the login issue in auth.go');
  });

  it('returns null for malformed input', () => {
    expect(summarizeRune({ nope: true }, 1)).toBeNull();
  });

  // Rune writes `message: { role: '', content: null }` on nodes without content
  // (e.g. the root/system node). `content: null` must not fail the whole session.
  it('parses sessions whose nodes have null message content', () => {
    const withNullContent = {
      ...RAW,
      nodes: [
        {
          id: 'root',
          parent_id: '',
          children: ['n1'],
          has_message: false,
          message: { role: '', content: null }
        },
        ...RAW.nodes.slice(1)
      ]
    };
    const s = summarizeRune(withNullContent, 1);
    expect(s).not.toBeNull();
    expect(s!.messageCount).toBe(2);
    expect(s!.preview).toBe('fix the login issue in auth.go');
  });
});

describe('readRuneTranscript', () => {
  it('flattens the root->active path into messages', () => {
    const t = readRuneTranscript(RAW, 1)!;
    expect(t.messages.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(t.messages[0].blocks).toEqual([
      { type: 'text', text: 'fix the login issue in auth.go' }
    ]);
    expect(t.messages[1].blocks).toEqual([
      { type: 'text', text: 'I found it in auth.go' },
      { type: 'tool_use', id: 't1', name: 'read', argsPreview: '{"path":"auth.go"}' }
    ]);
  });

  it('normalizes tool_result blocks', () => {
    const fixture = {
      id: 'tr1',
      name: 'Tool result',
      cwd: '/Users/khang/projects/myapp',
      root_id: 'root',
      active_id: 'n2',
      nodes: [
        { id: 'root', parent_id: '', children: ['n1'], has_message: false },
        {
          id: 'n1',
          parent_id: 'root',
          children: ['n2'],
          has_message: true,
          message: { role: 'user', content: [{ type: 'text', text: 'read it' }] }
        },
        {
          id: 'n2',
          parent_id: 'n1',
          children: ['leaf'],
          has_message: true,
          message: {
            role: 'tool',
            content: [
              { type: 'tool_result', tool_call_id: 't1', output: 'package auth', is_error: false }
            ]
          }
        }
      ]
    };
    const t = readRuneTranscript(fixture, 1)!;
    const last = t.messages[t.messages.length - 1];
    expect(last.role).toBe('tool');
    expect(last.blocks).toEqual([
      { type: 'tool_result', toolCallId: 't1', output: 'package auth', isError: false }
    ]);
  });
});

// A branching DAG: root -> n1(user) -> { a1 (active branch), b1 (abandoned branch) }.
// active_id points at the a-branch, so the b-branch must be excluded from the path.
const BRANCHING = {
  id: 'branch1',
  name: 'Branched',
  cwd: '/Users/khang/projects/myapp',
  root_id: 'root',
  active_id: 'a1',
  nodes: [
    { id: 'root', parent_id: '', children: ['n1'], has_message: false },
    {
      id: 'n1',
      parent_id: 'root',
      children: ['a1', 'b1'],
      has_message: true,
      message: { role: 'user', content: [{ type: 'text', text: 'do the thing' }] }
    },
    {
      id: 'a1',
      parent_id: 'n1',
      children: [],
      has_message: true,
      message: { role: 'assistant', content: [{ type: 'text', text: 'active branch' }] }
    },
    {
      id: 'b1',
      parent_id: 'n1',
      children: [],
      has_message: true,
      message: { role: 'assistant', content: [{ type: 'text', text: 'abandoned branch' }] }
    }
  ]
};

describe('branching sessions', () => {
  it('walks only the active branch from active_id to root', () => {
    const t = readRuneTranscript(BRANCHING, 1)!;
    expect(t.messages.map((m) => m.blocks[0])).toEqual([
      { type: 'text', text: 'do the thing' },
      { type: 'text', text: 'active branch' }
    ]);
    expect(t.summary.messageCount).toBe(2); // abandoned branch excluded
  });
});

describe('compacted sessions', () => {
  it('parses despite unknown compaction fields and counts only message nodes', () => {
    const compacted = {
      ...BRANCHING,
      compacted_count: 3,
      nodes: BRANCHING.nodes.map((n) =>
        n.id === 'n1' ? { ...n, compacted_count: 3, summary: 'earlier turns elided' } : n
      )
    };
    const s = summarizeRune(compacted, 1)!;
    expect(s.messageCount).toBe(2);
    expect(s.preview).toBe('do the thing');
  });
});

describe('session tree (branch DAG)', () => {
  it('omits the tree for a single-branch (linear) session', () => {
    const t = readRuneTranscript(RAW, 1)!;
    expect(t.tree).toBeUndefined();
  });

  it('builds a tree for a branching session, dropping the empty root', () => {
    const t = readRuneTranscript(BRANCHING, 1)!;
    expect(t.tree).toBeDefined();
    const tree = t.tree!;
    expect(tree.activeId).toBe('a1');
    // Root has no message and must not appear as a node.
    expect(tree.nodes.map((n) => n.id).sort()).toEqual(['a1', 'b1', 'n1']);
    // n1 hangs off the (omitted) root -> parentId null; a1/b1 are its children.
    const n1 = tree.nodes.find((n) => n.id === 'n1')!;
    expect(n1.parentId).toBeNull();
    expect(n1.childIds.sort()).toEqual(['a1', 'b1']);
    const a1 = tree.nodes.find((n) => n.id === 'a1')!;
    expect(a1.parentId).toBe('n1');
    expect(a1.role).toBe('assistant');
    expect(a1.preview).toBe('active branch');
  });

  it('resolves a message-less active_id so the tree never points outside its nodes', () => {
    // active_id points at the empty root; the resolved activeId must be a real node.
    const tree = readRuneTranscript({ ...BRANCHING, active_id: 'root' }, 1)!.tree!;
    expect(tree.nodes.some((n) => n.id === tree.activeId)).toBe(true);
  });

  it('maps usage (capitalized rune keys) and compacted_count onto tree nodes', () => {
    const withMeta = {
      ...BRANCHING,
      nodes: BRANCHING.nodes.map((n) =>
        n.id === 'a1'
          ? {
              ...n,
              usage: { Input: 100, Output: 20, CacheRead: 5 },
              compacted_count: 3,
              created: '2026-04-30T09:08:12Z'
            }
          : n
      )
    };
    const tree = readRuneTranscript(withMeta, 1)!.tree!;
    const a1 = tree.nodes.find((n) => n.id === 'a1')!;
    expect(a1.usage).toEqual({ input: 100, output: 20, cacheRead: 5 });
    expect(a1.compactedCount).toBe(3);
    expect(a1.createdAt).toBe(Date.parse('2026-04-30T09:08:12Z'));
  });

  it('parses session-level subagents', () => {
    const withSubagents = {
      ...BRANCHING,
      subagents: [
        {
          task_id: 's1',
          name: 'explorer',
          agent_type: 'code-explorer',
          status: 'completed',
          summary: 'mapped the data layer'
        }
      ]
    };
    const t = readRuneTranscript(withSubagents, 1)!;
    expect(t.subagents).toEqual([
      {
        id: 's1',
        name: 'explorer',
        agentType: 'code-explorer',
        status: 'completed',
        summary: 'mapped the data layer'
      }
    ]);
  });
});
