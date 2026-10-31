// src/main/sessions/pi-source.ts
import { stat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { ChatMessageFold, PiMessageTail } from '../copilot/conversation-reader';
import { piAgentDir } from '../claude-sessions/pi-extension';
import { normalizePiEntry, parsePiLine, PiUsage } from '../claude-sessions/pi-transcript';
import { SessionTail } from '../claude-sessions/session-tail';
import type { SessionSummary, SessionTranscript } from '../../shared/sessions';
import { serialQueue } from '../../shared/serial-queue';
import { claudeMessagesToTranscriptMessages, userText } from './claude-source';
import { jsonlFilesIn, TailCache, type FileState } from './session-files';

export function piSessionsDir(): string {
  return join(piAgentDir(), 'sessions');
}

type PiHeader = { id: string; cwd: string; startedAt?: number };

function timeOf(value: unknown): number | undefined {
  const time = typeof value === 'string' ? Date.parse(value) : Number.NaN;
  return Number.isNaN(time) ? undefined : time;
}

/** The first line of a session file, or null for any other line. */
function headerOf(entry: Record<string, unknown>): PiHeader | null {
  const { type, id, cwd, timestamp } = entry;
  if (type !== 'session' || typeof id !== 'string' || typeof cwd !== 'string') return null;
  return { id, cwd, startedAt: timeOf(timestamp) };
}

/**
 * A session file's summary, kept current by reading only the lines it gained.
 * It counts every branch in the file, so a session left by `/tree` lists more
 * messages than its open branch shows.
 */
class PiSummaryTail {
  private readonly tail: SessionTail;
  private usage = new PiUsage();
  private fold = new ChatMessageFold();
  private header: PiHeader | null = null;
  private messageCount = 0;
  private firstUserText: string | null = null;
  private endedAt: number | undefined;
  /** The file as it was when last read; -1 before the first read. */
  readAt: FileState = { mtimeMs: -1, size: -1 };

  constructor(path: string) {
    this.tail = new SessionTail(path);
  }

  async update(st: FileState): Promise<void> {
    await this.tail.read(
      (line) => this.addLine(line),
      () => this.reset()
    );
    this.readAt = { mtimeMs: st.mtimeMs, size: st.size };
  }

  /** The summary, or null for a file with no header or no message yet. */
  summary(): SessionSummary | null {
    if (!this.header || this.messageCount === 0) return null;
    const { id, cwd, startedAt } = this.header;
    const preview = this.firstUserText ?? '';
    return {
      id,
      source: 'pi',
      title: preview || '(untitled)',
      project: basename(cwd),
      cwd,
      updatedAt: this.readAt.mtimeMs,
      messageCount: this.messageCount,
      preview: preview.slice(0, 140),
      costUsd: this.usage.costUsd > 0 ? this.usage.costUsd : undefined,
      models: [...this.usage.models],
      startedAt,
      endedAt: this.endedAt
    };
  }

  private addLine(line: string): void {
    const entry = parsePiLine(line);
    if (!entry) return;
    this.header ??= headerOf(entry);
    this.usage.add(entry);

    this.endedAt = timeOf(entry['timestamp']) ?? this.endedAt;

    const message = this.fold.add(normalizePiEntry(entry));
    if (message && message !== 'clear') {
      this.messageCount++;
      this.firstUserText ??= userText(message);
    }
  }

  private reset(): void {
    this.usage = new PiUsage();
    this.fold = new ChatMessageFold();
    this.header = null;
    this.messageCount = 0;
    this.firstUserText = null;
    this.endedAt = undefined;
  }
}

const summaryTails = new TailCache((path) => new PiSummaryTail(path));
/** Each listed session's file: its name holds a time as well as the id. */
const pathsById = new Map<string, string>();
/** The session open in the Sessions tab, so a refresh of it reads only what it gained. */
let openTranscript: { path: string; tail: PiMessageTail } | null = null;

/** Listing and reading share the tails above, so they take turns. */
const inTurn = serialQueue();

/** Test-only: forget every session read so far. */
export function __clearPiSummaryCache(): void {
  summaryTails.clear();
  pathsById.clear();
  openTranscript = null;
}

async function listNow(): Promise<SessionSummary[]> {
  const paths = await jsonlFilesIn(piSessionsDir());
  const out: SessionSummary[] = [];
  pathsById.clear();
  for (const path of paths) {
    try {
      const summary = (await summaryTails.at(path, await stat(path))).summary();
      if (!summary) continue;
      out.push(summary);
      pathsById.set(summary.id, path);
    } catch {
      // skip malformed/unreadable file
    }
  }
  summaryTails.keepOnly(paths);
  return out;
}

export async function listPiSessions(): Promise<SessionSummary[]> {
  return inTurn(listNow);
}

/** A past session, found by the id a listing gave: never a path built from the request. */
export async function readPiSession(id: string): Promise<SessionTranscript | null> {
  return inTurn(async () => {
    if (!pathsById.has(id)) await listNow();
    const path = pathsById.get(id);
    if (!path) return null;

    if (openTranscript?.path !== path) openTranscript = { path, tail: new PiMessageTail() };
    await openTranscript.tail.read(path);
    const messages = openTranscript.tail.messages;

    const summary = (await summaryTails.at(path, await stat(path))).summary();
    if (messages.length === 0 || !summary) return null;
    return { summary, messages: claudeMessagesToTranscriptMessages(messages) };
  });
}
