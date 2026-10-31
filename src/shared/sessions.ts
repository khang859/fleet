// src/shared/sessions.ts
// Normalized session model shared by main + renderer.

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

/** The programs whose past sessions Fleet lists. */
export type SessionSource = 'claude' | 'pi';

export type SessionSummary = {
  id: string;
  /** Which program wrote it; Claude Code when absent. */
  source?: SessionSource;
  title: string;
  project: string; // display name for the cwd group
  cwd: string;
  updatedAt: number; // epoch ms
  messageCount: number;
  preview: string;
  // Cost + metadata; undefined for transcripts without usage:
  costUsd?: number; // undefined when a model in the session is unpriced
  claudeUsage?: ClaudeUsage;
  models?: string[]; // distinct models, first-appearance order
  gitBranch?: string;
  startedAt?: number; // epoch ms of first timestamped entry
  endedAt?: number; // epoch ms of last timestamped entry
};

/** What picks out one past session. */
export type SessionKey = Pick<SessionSummary, 'id' | 'cwd' | 'source'>;

/** The command that continues a past session in a terminal. */
export function resumeCommand(s: Pick<SessionSummary, 'id' | 'source'>): string {
  return s.source === 'pi' ? `pi --session ${s.id}` : `claude --resume ${s.id}`;
}

export type SessionTranscript = {
  summary: SessionSummary;
  messages: TranscriptMessage[];
};

export type SessionGroup = {
  project: string;
  cwd: string;
  sessions: SessionSummary[];
};
