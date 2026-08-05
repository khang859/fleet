import { z } from 'zod';
import type { AgentMessage } from './agent-types';

/**
 * A session on disk: one append-only JSONL file per agent thread.
 *
 * An event log rather than a snapshot of the transcript, because the two things
 * that happen to a transcript are not the same shape. Turns are appended, and
 * an append-only file survives a crash with everything up to the last complete
 * line intact. Compaction *replaces* what came before, which a snapshot would
 * record by silently overwriting the old turns - here it is one more line
 * saying what replaced what, and the turns it folded up are still in the file.
 *
 * Rewriting is never necessary, so the writer only ever opens the file to
 * append, and a reader that stops early is left with a valid earlier state
 * rather than half of a JSON document.
 */

/** Bumped when the event shape changes in a way a reader has to know about. */
export const SESSION_LOG_VERSION = 2;

const ToolCallSchema = z.object({
  id: z.string(),
  name: z.string(),
  args: z.string(),
  result: z.string().nullable(),
  error: z.string().nullable(),
  summary: z.string().nullable()
});

const MessageSchema = z.object({
  id: z.string(),
  role: z.enum(['user', 'assistant', 'summary']),
  content: z.string(),
  reasoning: z.string(),
  reasoningMs: z.number().nullable(),
  // Version 1 wrote no tool calls at all. Defaulted rather than required so a
  // session recorded before there were tools still replays as what it was.
  toolCalls: z.array(ToolCallSchema).default([])
});

const EventSchema = z.discriminatedUnion('t', [
  /** Always the first line: what this session is, and what wrote it. */
  z.object({
    t: z.literal('session'),
    version: z.number(),
    id: z.string(),
    cwd: z.string(),
    createdAt: z.string()
  }),
  /** One completed message, appended when it stops changing. */
  z.object({ t: z.literal('message'), message: MessageSchema }),
  /**
   * Compaction: everything before is replaced by `summary`, except the
   * messages named in `keep`. Named by id rather than by count so replay
   * cannot drift from what the pane actually did.
   */
  z.object({ t: z.literal('compact'), summary: MessageSchema, keep: z.array(z.string()) }),
  /** What the provider said the context costs now. Last one wins. */
  z.object({ t: z.literal('context'), tokens: z.number() })
]);

export type AgentSessionEvent = z.infer<typeof EventSchema>;

/**
 * One event on its way to disk. `cwd` rides along because it is what the
 * header records, and the header is only written when the file is created.
 */
export type AgentSessionAppend = {
  sessionId: string;
  cwd: string;
  event: AgentSessionEvent;
};

export type AgentSessionReplay = {
  messages: AgentMessage[];
  /** `null` when the log never recorded one, same as a thread that has not run a turn. */
  contextTokens: number | null;
  cwd: string | null;
  /**
   * Lines that were not valid events. Expected to be 0 or 1: a crash during an
   * append truncates the line it was writing, and nothing else can produce one.
   * Anything higher means the file is not what we think it is.
   */
  skipped: number;
};

export function sessionHeader(id: string, cwd: string, createdAt: string): AgentSessionEvent {
  return { t: 'session', version: SESSION_LOG_VERSION, id, cwd, createdAt };
}

/** One event as the line that goes in the file. */
export function encodeEvent(event: AgentSessionEvent): string {
  return `${JSON.stringify(event)}\n`;
}

/**
 * Rebuild a thread from its log.
 *
 * Unreadable lines are skipped rather than fatal. A session whose last write
 * was interrupted is still worth every turn before it, and refusing to open it
 * would lose the whole conversation to protect the part that was never written.
 */
export function replaySession(contents: string): AgentSessionReplay {
  const replay: AgentSessionReplay = { messages: [], contextTokens: null, cwd: null, skipped: 0 };

  for (const line of contents.split('\n')) {
    if (line.trim() === '') continue;
    const event = parseLine(line);
    if (event === null) {
      replay.skipped += 1;
      continue;
    }
    apply(replay, event);
  }
  return replay;
}

function parseLine(line: string): AgentSessionEvent | null {
  let json: unknown;
  try {
    json = JSON.parse(line);
  } catch {
    return null;
  }
  const parsed = EventSchema.safeParse(json);
  return parsed.success ? parsed.data : null;
}

function apply(replay: AgentSessionReplay, event: AgentSessionEvent): void {
  switch (event.t) {
    case 'session':
      replay.cwd = event.cwd;
      return;
    case 'message':
      replay.messages.push(event.message);
      return;
    case 'compact': {
      const keep = new Set(event.keep);
      replay.messages = [event.summary, ...replay.messages.filter((m) => keep.has(m.id))];
      return;
    }
    case 'context':
      replay.contextTokens = event.tokens;
      return;
  }
}
