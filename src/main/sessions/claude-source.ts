// src/main/sessions/claude-source.ts
import { readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join, resolve, sep } from 'node:path';
import { z } from 'zod';
import { ChatMessageFold, MessageTail } from '../copilot/conversation-reader';
import { normalizeLine } from '../claude-sessions/transcript';
import { cwdToProjectDir } from '../claude-sessions/transcript-path';
import { SessionTail } from '../claude-sessions/session-tail';
import { UsageAccumulator } from '../claude-sessions/usage-accumulator';
import type { CopilotChatMessage } from '../../shared/types';
import type {
  SessionSummary,
  SessionTranscript,
  TranscriptBlock,
  TranscriptMessage
} from '../../shared/sessions';
import { estimateSessionCostUsd } from '../../shared/claude-pricing';
import { serialQueue } from '../../shared/serial-queue';
import { getPriceTable } from './pricing-source';

const cwdLineSchema = z.object({ cwd: z.string() }).passthrough();

export function claudeProjectsDir(): string {
  return join(homedir(), '.claude', 'projects');
}

/** The cwd a transcript line records, or '' when it has none. */
function lineCwd(line: string): string {
  if (!line.includes('"cwd"')) return '';
  try {
    const parsed = cwdLineSchema.safeParse(JSON.parse(line));
    return parsed.success ? parsed.data.cwd : '';
  } catch {
    return ''; // malformed line
  }
}

type FileState = { mtimeMs: number; size: number };

/**
 * A transcript's summary, kept current by reading only the lines its files
 * gained. It holds running totals, never the messages, so it stays small
 * however long the session runs.
 *
 * The sessions watcher fires on every transcript append. Re-reading a whole
 * transcript and its subagents' transcripts (hundreds of MB for a long
 * session) on each one held the main thread for hundreds of milliseconds per
 * refresh, and kept it busy for as long as an agent ran (#648).
 */
class SummaryTail {
  private readonly tail: SessionTail;
  private acc = new UsageAccumulator();
  private fold = new ChatMessageFold();
  private messageCount = 0;
  /** The first user text since the chat began or was last cleared. */
  private firstUserText: string | null = null;
  /** The first cwd the transcript records; a `/clear` does not change it. */
  cwd = '';
  /** The file as it was when last read; -1 before the first read. */
  readAt: FileState = { mtimeMs: -1, size: -1 };

  constructor(path: string) {
    this.tail = new SessionTail(path);
  }

  /** Read what the files gained since `st` was last read. */
  async update(st: FileState): Promise<void> {
    await this.tail.read(
      (line, fromSubagent) => {
        this.acc.addLine(line);
        if (!fromSubagent) this.addTranscriptLine(line);
      },
      () => this.reset()
    );
    // Set only once the read is through, so a failed one is tried again.
    this.readAt = { mtimeMs: st.mtimeMs, size: st.size };
  }

  /** The summary, or null while the transcript holds no message. */
  summary(id: string, cwd: string): SessionSummary | null {
    if (this.messageCount === 0) return null;
    const preview = this.firstUserText ?? '';
    return {
      id,
      title: preview || '(untitled)',
      project: basename(cwd),
      cwd,
      updatedAt: this.readAt.mtimeMs,
      messageCount: this.messageCount,
      preview: preview.slice(0, 140),
      ...this.costFields()
    };
  }

  private addTranscriptLine(line: string): void {
    if (!this.cwd) this.cwd = lineCwd(line);
    const msg = this.fold.add(normalizeLine(line));
    if (msg === 'clear') {
      this.messageCount = 0;
      this.firstUserText = null;
    } else if (msg) {
      this.messageCount++;
      this.firstUserText ??= userText(msg);
    }
  }

  /** A file was replaced by a shorter one: count the session again from the start. */
  private reset(): void {
    this.acc = new UsageAccumulator();
    this.fold = new ChatMessageFold();
    this.messageCount = 0;
    this.firstUserText = null;
    this.cwd = '';
  }

  /** Cost and usage from the transcript and its subagents' transcripts. */
  private costFields(): Partial<SessionSummary> {
    const agg = this.acc.result();
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
}

/** One per transcript path, so a refresh only reads the files that grew. */
const summaryTails = new Map<string, SummaryTail>();

/** The transcript open in the Sessions tab, so a refresh of it reads only what it gained. */
let openTranscript: { path: string; tail: MessageTail } | null = null;

/**
 * Listing and reading share the tails above, and a tail must not be read by
 * two callers at once, so they take turns.
 */
const inTurn = serialQueue();

/** Test-only: forget every transcript read so far. */
export function __clearClaudeSummaryCache(): void {
  summaryTails.clear();
  openTranscript = null;
}

/** The summary tail for a transcript, brought up to date with the file. */
async function summaryTailAt(path: string, st: FileState): Promise<SummaryTail> {
  let tail = summaryTails.get(path);
  if (tail?.readAt.mtimeMs === st.mtimeMs && tail.readAt.size === st.size) return tail;
  if (!tail) {
    tail = new SummaryTail(path);
    summaryTails.set(path, tail);
  }
  await tail.update(st);
  return tail;
}

export async function listClaudeSessions(): Promise<SessionSummary[]> {
  return inTurn(async () => {
    const paths = await transcriptPaths();
    const out: SessionSummary[] = [];
    for (const path of paths) {
      try {
        const tail = await summaryTailAt(path, await stat(path));
        // A transcript with no cwd is not a real session.
        const summary = tail.cwd ? tail.summary(basename(path, '.jsonl'), tail.cwd) : null;
        if (summary) out.push(summary);
      } catch {
        // skip malformed/unreadable file
      }
    }
    // Drop the tails of transcripts that no longer exist.
    const seen = new Set(paths);
    for (const key of summaryTails.keys()) {
      if (!seen.has(key)) summaryTails.delete(key);
    }
    return out;
  });
}

/** Every transcript in every project dir. */
async function transcriptPaths(): Promise<string[]> {
  const root = claudeProjectsDir();
  let projectDirs: string[];
  try {
    projectDirs = await readdir(root);
  } catch {
    return [];
  }
  const paths: string[] = [];
  for (const projectDir of projectDirs) {
    const dirPath = join(root, projectDir);
    try {
      for (const f of await readdir(dirPath))
        if (f.endsWith('.jsonl')) paths.push(join(dirPath, f));
    } catch {
      // not a dir, or unreadable
    }
  }
  return paths;
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
  return inTurn(async () => {
    let st: FileState;
    try {
      st = await stat(full);
    } catch {
      return null; // file missing or unreadable
    }
    const messages = await openMessages(full);
    const summary = (await summaryTailAt(full, st)).summary(id, cwd);
    if (messages.length === 0 || !summary) return null;
    return { summary, messages: claudeMessagesToTranscriptMessages(messages) };
  });
}

/** The messages of the open transcript, reading only what it gained since it was last opened. */
async function openMessages(path: string): Promise<CopilotChatMessage[]> {
  if (openTranscript?.path !== path) openTranscript = { path, tail: new MessageTail() };
  await openTranscript.tail.read(path);
  return openTranscript.tail.messages;
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

/** A user message's first text, trimmed, or null for any other message. */
function userText(m: CopilotChatMessage): string | null {
  if (m.role !== 'user') return null;
  const block = m.blocks.find((b) => b.type === 'text');
  return block?.type === 'text' ? block.text.trim() : null;
}
