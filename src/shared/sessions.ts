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

export type SessionTranscript = {
  summary: SessionSummary;
  messages: TranscriptMessage[];
};

export type SessionGroup = {
  project: string;
  cwd: string;
  sessions: SessionSummary[];
};
