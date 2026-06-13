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

/** Aggregated Claude token usage for a session (summed across models). */
export type ClaudeUsage = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
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
  // Claude-only cost + metadata (all undefined for Rune and for transcripts without usage):
  costUsd?: number; // undefined when a model in the session is unpriced
  claudeUsage?: ClaudeUsage;
  models?: string[]; // distinct models, first-appearance order
  gitBranch?: string;
  startedAt?: number; // epoch ms of first timestamped entry
  endedAt?: number; // epoch ms of last timestamped entry
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
