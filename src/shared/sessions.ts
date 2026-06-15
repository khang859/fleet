// src/shared/sessions.ts
// Normalized, agent-agnostic session model shared by main + renderer.

export type SessionAgent = 'rune' | 'claude';

/** Persisted in settings as sessions.preferredAgent; also the list filter value. */
export type SessionAgentFilter = 'all' | 'rune' | 'claude';

export type TranscriptBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; name: string; argsPreview: string; id?: string }
  | { type: 'tool_result'; toolCallId?: string; output: string; isError?: boolean }
  | { type: 'image' };

export type TranscriptMessage = {
  role: 'user' | 'assistant' | 'tool';
  blocks: TranscriptBlock[];
  createdAt?: number;
};

export type SessionSummary = {
  agent: SessionAgent;
  id: string;
  title: string;
  project: string; // display name for the cwd group
  cwd: string;
  model?: string;
  provider?: string; // Rune only
  updatedAt: number; // epoch ms
  messageCount: number;
  preview: string;
};

export type TokenUsage = { input: number; output: number; cacheRead: number };

/** A single node in a Rune session's branching DAG. The empty root node is not included. */
export type SessionTreeNode = {
  id: string;
  /** Nearest message-bearing ancestor; null when the node hangs directly off the root. */
  parentId: string | null;
  childIds: string[];
  role: TranscriptMessage['role'];
  blocks: TranscriptBlock[];
  createdAt?: number; // epoch ms
  usage?: TokenUsage;
  compactedCount?: number; // >0 marks a compaction summary node
  preview: string; // short text label for the graph row
};

export type SubagentSummary = {
  id: string;
  name: string;
  agentType?: string;
  status: string;
  summary?: string;
};

/** The full branching graph of a Rune session. Present only when the session has branches. */
export type SessionTree = {
  /** Leaf of the live branch; always present in `nodes`. Graph roots are nodes with parentId null. */
  activeId: string;
  nodes: SessionTreeNode[];
};

export type SessionTranscript = {
  summary: SessionSummary;
  messages: TranscriptMessage[];
  /** Branch graph; only set for Rune sessions that actually fork. */
  tree?: SessionTree;
  /** Session-level subagents; Rune only. Not linked to individual nodes. */
  subagents?: SubagentSummary[];
};

export type SessionGroup = {
  project: string;
  cwd: string;
  sessions: SessionSummary[];
};

/**
 * Messages on the path root -> nodeId (chronological, root-first). Shared by the
 * transcript view and the branch-node distill so both scope a tree the same way.
 */
export function pathMessagesToNode(tree: SessionTree, nodeId: string | null): TranscriptMessage[] {
  const byId = new Map(tree.nodes.map((n) => [n.id, n]));
  const chain: SessionTreeNode[] = [];
  const guard = new Set<string>();
  let current = nodeId ? byId.get(nodeId) : undefined;
  while (current && !guard.has(current.id)) {
    guard.add(current.id);
    chain.push(current);
    current = current.parentId ? byId.get(current.parentId) : undefined;
  }
  return chain.reverse().map((n) => ({ role: n.role, blocks: n.blocks, createdAt: n.createdAt }));
}
