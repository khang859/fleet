// src/main/sessions/claude-source.ts
import { readFile, readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join, resolve, sep } from 'node:path';
import { z } from 'zod';
import { parseClaudeTranscript } from '../copilot/conversation-reader';
import { cwdToProjectDir, listSubagentTranscripts } from '../claude-sessions/transcript-path';
import { UsageAccumulator } from '../claude-sessions/usage-accumulator';
import type { CopilotChatMessage } from '../../shared/types';
import type {
  SessionSummary,
  SessionTranscript,
  TranscriptBlock,
  TranscriptMessage
} from '../../shared/sessions';
import { estimateSessionCostUsd } from '../../shared/claude-pricing';
import { getPriceTable } from './pricing-source';

const cwdLineSchema = z.object({ cwd: z.string() }).passthrough();

/**
 * Build the Claude-only cost/metadata fields for a SessionSummary, from the
 * main transcript and its subagents' transcripts.
 */
function claudeCostFields(content: string, subagents: readonly string[]): Partial<SessionSummary> {
  const acc = new UsageAccumulator();
  for (const text of [content, ...subagents]) {
    acc.addText(text);
    acc.flush();
  }
  const agg = acc.result();
  if (!agg.hasUsage) return {};
  return {
    claudeUsage: agg.total,
    models: agg.models,
    gitBranch: agg.gitBranch,
    startedAt: agg.startedAt,
    endedAt: agg.endedAt,
    costUsd: estimateSessionCostUsd(agg.perModel, getPriceTable())
  };
}

export function claudeProjectsDir(): string {
  return join(homedir(), '.claude', 'projects');
}

/**
 * Read the cwd recorded in a transcript. Recent Claude Code versions prepend
 * metadata lines (`last-prompt`, `mode`, `file-history-snapshot`) that carry no
 * cwd, so scan for the first line that actually has a top-level cwd rather than
 * assuming it's on line 1.
 */
export function cwdFromTranscript(content: string): string {
  for (const line of content.split('\n')) {
    if (!line.includes('"cwd"')) continue;
    try {
      const parsed = cwdLineSchema.safeParse(JSON.parse(line));
      if (parsed.success && parsed.data.cwd) return parsed.data.cwd;
    } catch {
      // skip malformed line
    }
  }
  return '';
}

/** Build a session summary from raw transcript content, or null if it isn't a real session. */
function buildClaudeSummary(
  id: string,
  content: string,
  mtimeMs: number,
  subagents: readonly string[] = []
): SessionSummary | null {
  const cwd = cwdFromTranscript(content);
  if (!cwd) return null;
  const messages = parseClaudeTranscript(content);
  if (messages.length === 0) return null;
  const preview = claudePreview(messages);
  return {
    id,
    title: preview || '(untitled)',
    project: basename(cwd),
    cwd,
    updatedAt: mtimeMs,
    messageCount: messages.length,
    preview: preview.slice(0, 140),
    ...claudeCostFields(content, subagents)
  };
}

/** The text of each of a session's subagent transcripts, skipping any that cannot be read. */
async function readSubagentTranscripts(transcriptPath: string): Promise<string[]> {
  const paths = await listSubagentTranscripts(transcriptPath);
  return Promise.all(paths.map(async (path) => readFile(path, 'utf8').catch(() => '')));
}

type CachedSummary = { mtimeMs: number; size: number; summary: SessionSummary | null };

// Cache the parsed summary per transcript path keyed by (mtime, size). The sessions
// watcher fires on every transcript append, so a single active agent would otherwise
// force a full re-read + double-parse of the entire ~/.claude/projects corpus
// (hundreds of MB) every refresh. With this cache, an unchanged file costs one stat();
// only files that actually grew are re-read and re-parsed.
const summaryCache = new Map<string, CachedSummary>();

/** Test-only: reset the module-level summary cache. */
export function __clearClaudeSummaryCache(): void {
  summaryCache.clear();
}

export async function listClaudeSessions(): Promise<SessionSummary[]> {
  const root = claudeProjectsDir();
  let projectDirs: string[];
  try {
    projectDirs = await readdir(root);
  } catch {
    return [];
  }
  const out: SessionSummary[] = [];
  const seen = new Set<string>();
  for (const projectDir of projectDirs) {
    const dirPath = join(root, projectDir);
    let files: string[];
    try {
      files = (await readdir(dirPath)).filter((f) => f.endsWith('.jsonl'));
    } catch {
      continue;
    }
    for (const file of files) {
      try {
        const full = join(dirPath, file);
        seen.add(full);
        const st = await stat(full);
        const cached = summaryCache.get(full);
        if (cached !== undefined) {
          if (cached.mtimeMs === st.mtimeMs && cached.size === st.size) {
            if (cached.summary) out.push(cached.summary);
            continue;
          }
        }
        // New or changed file: read and parse once, then memoize the result (including
        // the "not a session" verdict) so unchanged files never get re-read.
        const id = basename(file, '.jsonl');
        const content = await readFile(full, 'utf8');
        const subagents = await readSubagentTranscripts(full);
        const summary = buildClaudeSummary(id, content, st.mtimeMs, subagents);
        summaryCache.set(full, { mtimeMs: st.mtimeMs, size: st.size, summary });
        if (summary) out.push(summary);
      } catch {
        // skip malformed/unreadable file
      }
    }
  }
  // Drop cache entries for transcripts that no longer exist.
  for (const key of summaryCache.keys()) {
    if (!seen.has(key)) summaryCache.delete(key);
  }
  return out;
}

export async function readClaudeSession(
  id: string,
  cwd: string
): Promise<SessionTranscript | null> {
  const dir = claudeProjectsDir();
  const full = join(dir, cwdToProjectDir(cwd), `${id}.jsonl`);
  // Guard against path traversal via a crafted id or cwd: the resolved path must
  // stay inside the claude projects directory.
  if (!resolve(full).startsWith(resolve(dir) + sep)) return null;
  let content: string;
  let updatedAt = 0;
  try {
    const [raw, st] = await Promise.all([readFile(full, 'utf8'), stat(full)]);
    content = raw;
    updatedAt = st.mtimeMs;
  } catch {
    return null; // file missing or unreadable
  }
  const messages = parseClaudeTranscript(content);
  if (messages.length === 0) return null;
  const preview = claudePreview(messages);
  const subagents = await readSubagentTranscripts(full);
  return {
    summary: {
      id,
      title: preview || '(untitled)',
      project: basename(cwd),
      cwd,
      updatedAt,
      messageCount: messages.length,
      preview: preview.slice(0, 140),
      ...claudeCostFields(content, subagents)
    },
    messages: claudeMessagesToTranscriptMessages(messages)
  };
}

export function claudeMessagesToTranscriptMessages(
  messages: CopilotChatMessage[]
): TranscriptMessage[] {
  return messages.map((m): TranscriptMessage => {
    const blocks: TranscriptBlock[] = [];
    for (const b of m.blocks) {
      if (b.type === 'text' || b.type === 'thinking') {
        blocks.push({ type: 'text', text: b.text });
      } else if (b.type === 'tool_use') {
        blocks.push({ type: 'tool_use', name: b.name, argsPreview: b.inputPreview, id: b.id });
      }
      // 'interrupted' blocks are dropped from the transcript view.
    }
    return { role: m.role, blocks };
  });
}

export function claudePreview(messages: CopilotChatMessage[]): string {
  for (const m of messages) {
    if (m.role === 'user') {
      const block = m.blocks.find((b) => b.type === 'text');
      if (block?.type === 'text') return block.text.trim();
    }
  }
  return '';
}
