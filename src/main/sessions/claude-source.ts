// src/main/sessions/claude-source.ts
import { readFile, readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { z } from 'zod';
import { cwdToProjectDir, parseClaudeTranscript } from '../copilot/conversation-reader';
import type { CopilotChatMessage } from '../../shared/types';
import type {
  ClaudeUsage,
  SessionSummary,
  SessionTranscript,
  TranscriptBlock,
  TranscriptMessage
} from '../../shared/sessions';
import type { ClaudeUsageInput } from '../../shared/claude-pricing';
import { estimateSessionCostUsd } from '../../shared/claude-pricing';
import { getPriceTable } from './pricing-source';

const cwdLineSchema = z.object({ cwd: z.string() }).passthrough();

const usageSchema = z
  .object({
    input_tokens: z.number().optional(),
    output_tokens: z.number().optional(),
    cache_read_input_tokens: z.number().optional(),
    cache_creation_input_tokens: z.number().optional(),
    cache_creation: z
      .object({
        ephemeral_5m_input_tokens: z.number().optional(),
        ephemeral_1h_input_tokens: z.number().optional()
      })
      .partial()
      .optional()
  })
  .passthrough();

const assistantLineSchema = z
  .object({
    type: z.literal('assistant'),
    timestamp: z.string().optional(),
    gitBranch: z.string().optional(),
    message: z
      .object({
        id: z.string().optional(),
        model: z.string().optional(),
        usage: usageSchema.optional()
      })
      .passthrough()
  })
  .passthrough();

const tsLineSchema = z
  .object({ timestamp: z.string().optional(), gitBranch: z.string().optional() })
  .passthrough();

export type ClaudeAggregate = {
  total: ClaudeUsage;
  perModel: Map<string, ClaudeUsageInput>;
  models: string[];
  gitBranch?: string;
  startedAt?: number;
  endedAt?: number;
  hasUsage: boolean;
};

function emptyUsage(): ClaudeUsage {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 };
}

/**
 * Scan raw transcript JSONL and aggregate assistant token usage. Dedups by
 * message.id (Claude Code writes one line per content block, all repeating the
 * same usage object). Sidechain/subagent entries are included — they cost money.
 */
export function aggregateClaudeUsage(content: string): ClaudeAggregate {
  const total = emptyUsage();
  const perModel = new Map<string, ClaudeUsageInput>();
  const models: string[] = [];
  const seenIds = new Set<string>();
  let gitBranch: string | undefined;
  let startedAt: number | undefined;
  let endedAt: number | undefined;
  let hasUsage = false;

  for (const line of content.split('\n')) {
    if (!line) continue;
    let json: unknown;
    try {
      json = JSON.parse(line);
    } catch {
      continue;
    }

    const tsParsed = tsLineSchema.safeParse(json);
    if (tsParsed.success) {
      if (gitBranch === undefined && tsParsed.data.gitBranch) gitBranch = tsParsed.data.gitBranch;
      if (tsParsed.data.timestamp) {
        const t = Date.parse(tsParsed.data.timestamp);
        if (!Number.isNaN(t)) {
          if (startedAt === undefined || t < startedAt) startedAt = t;
          if (endedAt === undefined || t > endedAt) endedAt = t;
        }
      }
    }

    const parsed = assistantLineSchema.safeParse(json);
    if (!parsed.success) continue;
    const { message } = parsed.data;
    const u = message.usage;
    if (!u) continue;
    const id = message.id;
    if (id && seenIds.has(id)) continue; // dedup repeated content-block lines
    if (id) seenIds.add(id);

    const model = message.model ?? '';
    if (model && !models.includes(model)) models.push(model);

    const input = u.input_tokens ?? 0;
    const output = u.output_tokens ?? 0;
    const cacheRead = u.cache_read_input_tokens ?? 0;
    let write5m = 0;
    let write1h = 0;
    if (u.cache_creation) {
      write5m = u.cache_creation.ephemeral_5m_input_tokens ?? 0;
      write1h = u.cache_creation.ephemeral_1h_input_tokens ?? 0;
    } else {
      write5m = u.cache_creation_input_tokens ?? 0;
    }

    if (input || output || cacheRead || write5m || write1h) hasUsage = true;

    total.input += input;
    total.output += output;
    total.cacheRead += cacheRead;
    total.cacheWrite5m += write5m;
    total.cacheWrite1h += write1h;

    const bucket = perModel.get(model) ?? {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite5m: 0,
      cacheWrite1h: 0
    };
    bucket.input += input;
    bucket.output += output;
    bucket.cacheRead += cacheRead;
    bucket.cacheWrite5m += write5m;
    bucket.cacheWrite1h += write1h;
    perModel.set(model, bucket);
  }

  return { total, perModel, models, gitBranch, startedAt, endedAt, hasUsage };
}

/** Build the Claude-only cost/metadata fields for a SessionSummary. */
function claudeCostFields(content: string): Partial<SessionSummary> {
  const agg = aggregateClaudeUsage(content);
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

export async function listClaudeSessions(): Promise<SessionSummary[]> {
  const root = claudeProjectsDir();
  let projectDirs: string[];
  try {
    projectDirs = await readdir(root);
  } catch {
    return [];
  }
  const out: SessionSummary[] = [];
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
        const id = basename(file, '.jsonl');
        // Read each transcript once, asynchronously; parse without caching so a large
        // history doesn't accumulate state or block the main thread on every refresh.
        const [content, st] = await Promise.all([readFile(full, 'utf8'), stat(full)]);
        const cwd = cwdFromTranscript(content);
        if (!cwd) continue;
        const messages = parseClaudeTranscript(content);
        if (messages.length === 0) continue;
        const preview = claudePreview(messages);
        out.push({
          agent: 'claude',
          id,
          title: preview || '(untitled)',
          project: basename(cwd),
          cwd,
          updatedAt: st.mtimeMs,
          messageCount: messages.length,
          preview: preview.slice(0, 140),
          ...claudeCostFields(content)
        });
      } catch {
        // skip malformed file
      }
    }
  }
  return out;
}

export async function readClaudeSession(
  id: string,
  cwd: string
): Promise<SessionTranscript | null> {
  const full = join(claudeProjectsDir(), cwdToProjectDir(cwd), `${id}.jsonl`);
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
  return {
    summary: {
      agent: 'claude',
      id,
      title: preview || '(untitled)',
      project: basename(cwd),
      cwd,
      updatedAt,
      messageCount: messages.length,
      preview: preview.slice(0, 140),
      ...claudeCostFields(content)
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
