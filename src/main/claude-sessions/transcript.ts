import { closeSync, openSync, readSync, statSync } from 'fs';
import { open, type FileHandle } from 'fs/promises';
import { isRecord } from '../../shared/is-record';

/**
 * Reading Claude Code transcripts (`<session>.jsonl`): one JSON object per
 * line, appended as the session runs.
 *
 * `normalizeLine` turns a line into events that every reader shares, so the
 * copilot chat, the session brief and the Orchestrator's reads agree on what
 * a transcript says. `TranscriptTail` reads a transcript a chunk at a time,
 * remembering where each turn and each tool result sits in the file, so a
 * later read can go back to one without keeping it in memory.
 *
 * Shapes observed on Claude Code 2.1.285.
 */

/** Who wrote a prompt line. */
export type PromptSource =
  /** Typed by the user, or by Fleet on their behalf. */
  | 'human'
  /** A background task finished and Claude Code queued its result as a turn. */
  | 'task'
  /** The summary a compaction starts the conversation over with. */
  | 'compact'
  /** No origin recorded, as older Claude Code versions write. */
  | 'other';

type LineInfo = {
  /** The line's `uuid`; null on lines that are not conversation messages. */
  uuid: string | null;
  timestamp: string | null;
  /** Whose message the line is; null on lines that are not conversation messages. */
  role: 'user' | 'assistant' | null;
};

export type TranscriptEvent = LineInfo &
  (
    | { kind: 'user_prompt'; text: string; source: PromptSource }
    | { kind: 'assistant_text'; text: string }
    | { kind: 'thinking'; text: string }
    | { kind: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
    | {
        kind: 'tool_result';
        toolUseId: string;
        isError: boolean;
        /** The user answered the tool's permission request with "No". */
        rejected: boolean;
        text: string;
      }
    /** The user pressed Esc; `forToolUse` when it cancelled a permission request. */
    | { kind: 'interrupted'; forToolUse: boolean }
    /** `/clear`: what came before is no longer the conversation. */
    | { kind: 'clear' }
    /** A prompt was queued while a turn ran (`enqueue`), started from the queue (`dequeue`), or folded into the running turn (`remove`). */
    | { kind: 'queue'; operation: string }
    /** Bookkeeping lines worth knowing about, such as `compact_boundary` and `turn_duration`. */
    | { kind: 'meta'; subtype: string }
  );

export type TranscriptEventKind = TranscriptEvent['kind'];

const CLEAR_COMMAND = '<command-name>/clear</command-name>';
const INTERRUPTED = '[Request interrupted by user';
const INTERRUPTED_FOR_TOOL = '[Request interrupted by user for tool use]';
const REJECTED_TOOL_USE = 'User rejected tool use';

/** Local command echoes and caveats Claude Code writes as user lines; not prompts. */
function isCommandNoise(text: string): boolean {
  return (
    text.startsWith('<command-name>') ||
    text.startsWith('<local-command') ||
    text.startsWith('Caveat:')
  );
}

function stringOr(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback;
}

function promptSource(json: Record<string, unknown>): PromptSource {
  if (json['isCompactSummary'] === true) return 'compact';
  const origin = json['origin'];
  const kind = isRecord(origin) ? origin['kind'] : undefined;
  if (kind === 'human') return 'human';
  if (kind === 'task-notification') return 'task';
  return 'other';
}

/** A tool result's text: a string, or its text blocks joined. */
function resultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const block of content) {
    if (isRecord(block) && block['type'] === 'text' && typeof block['text'] === 'string') {
      parts.push(block['text']);
    }
  }
  return parts.join('\n');
}

function interruption(text: string, info: LineInfo): TranscriptEvent {
  return { ...info, kind: 'interrupted', forToolUse: text.startsWith(INTERRUPTED_FOR_TOOL) };
}

function userEvents(
  json: Record<string, unknown>,
  content: unknown,
  info: LineInfo
): TranscriptEvent[] {
  if (typeof content === 'string') {
    if (content.includes(CLEAR_COMMAND)) return [{ ...info, kind: 'clear' }];
    if (isCommandNoise(content)) return [];
    if (content.startsWith(INTERRUPTED)) return [interruption(content, info)];
    return [{ ...info, kind: 'user_prompt', text: content, source: promptSource(json) }];
  }
  if (!Array.isArray(content)) return [];
  const events: TranscriptEvent[] = [];
  for (const block of content) {
    if (!isRecord(block)) continue;
    if (block['type'] === 'text') {
      const text = stringOr(block['text'], '');
      if (text.startsWith(INTERRUPTED)) events.push(interruption(text, info));
      else if (text)
        events.push({ ...info, kind: 'user_prompt', text, source: promptSource(json) });
    } else if (block['type'] === 'tool_result') {
      events.push({
        ...info,
        kind: 'tool_result',
        toolUseId: stringOr(block['tool_use_id'], ''),
        isError: block['is_error'] === true,
        rejected: json['toolUseResult'] === REJECTED_TOOL_USE,
        text: resultText(block['content'])
      });
    }
  }
  return events;
}

function assistantEvents(content: unknown, info: LineInfo): TranscriptEvent[] {
  if (typeof content === 'string') {
    if (isCommandNoise(content)) return [];
    if (content.startsWith(INTERRUPTED)) return [interruption(content, info)];
    return [{ ...info, kind: 'assistant_text', text: content }];
  }
  if (!Array.isArray(content)) return [];
  const events: TranscriptEvent[] = [];
  for (const block of content) {
    if (!isRecord(block)) continue;
    switch (block['type']) {
      case 'text': {
        const text = stringOr(block['text'], '');
        if (text.startsWith(INTERRUPTED)) events.push(interruption(text, info));
        else if (text) events.push({ ...info, kind: 'assistant_text', text });
        break;
      }
      case 'thinking': {
        const text = stringOr(block['thinking'], '');
        if (text) events.push({ ...info, kind: 'thinking', text });
        break;
      }
      case 'tool_use': {
        const input = block['input'];
        events.push({
          ...info,
          kind: 'tool_use',
          id: stringOr(block['id'], ''),
          name: stringOr(block['name'], 'Unknown'),
          input: isRecord(input) ? input : {}
        });
        break;
      }
    }
  }
  return events;
}

/** Line types that can carry an event; anything else is skipped without parsing. */
const INTERESTING = /"type":\s*"(user|assistant|queue-operation|system)"/;

/**
 * The events one transcript line holds, in order; empty for lines no reader
 * cares about, blank lines, and lines that are not valid JSON (such as one
 * still being written).
 */
export function normalizeLine(line: string): TranscriptEvent[] {
  if (!line.trim() || !INTERESTING.test(line)) return [];
  let json: unknown;
  try {
    json = JSON.parse(line);
  } catch {
    return [];
  }
  if (!isRecord(json)) return [];
  const timestamp = typeof json['timestamp'] === 'string' ? json['timestamp'] : null;
  const type = json['type'];

  if (type === 'queue-operation') {
    const operation = json['operation'];
    return typeof operation === 'string'
      ? [{ uuid: null, timestamp, role: null, kind: 'queue', operation }]
      : [];
  }
  if (type === 'system') {
    const subtype = json['subtype'];
    return typeof subtype === 'string'
      ? [{ uuid: null, timestamp, role: null, kind: 'meta', subtype }]
      : [];
  }
  if (type !== 'user' && type !== 'assistant') return [];

  const message = json['message'];
  if (!isRecord(message)) return [];
  const uuid = typeof json['uuid'] === 'string' && json['uuid'] ? json['uuid'] : null;
  const info: LineInfo = { uuid, timestamp, role: type };

  if (type === 'user') {
    // `/clear` is recognised before the other checks: its line has no uuid.
    const events = userEvents(json, message['content'], info);
    if (events.some((e) => e.kind === 'clear')) return events;
    // Meta lines are context Claude Code adds for the model, such as skill text.
    if (json['isMeta'] === true || !uuid) return [];
    return events;
  }
  if (json['isMeta'] === true || !uuid) return [];
  return assistantEvents(message['content'], info);
}

/** A short, one-line description of a tool call's input, for lists of tool calls. */
export function toolInputPreview(toolName: string, input: Record<string, unknown>): string {
  switch (toolName) {
    case 'Read':
    case 'Write':
    case 'Edit': {
      const fp = input['file_path'];
      if (typeof fp === 'string') {
        return fp.split('/').pop() ?? fp;
      }
      return '';
    }
    case 'Bash': {
      const cmd = input['command'];
      if (typeof cmd === 'string') {
        const firstLine = cmd.split('\n')[0] ?? cmd;
        return firstLine.slice(0, 60);
      }
      return '';
    }
    case 'Grep':
    case 'Glob': {
      const pattern = input['pattern'];
      return typeof pattern === 'string' ? pattern : '';
    }
    case 'Task':
    case 'Agent': {
      const desc = input['description'];
      return typeof desc === 'string' ? desc : '';
    }
    case 'WebFetch': {
      const url = input['url'];
      return typeof url === 'string' ? url : '';
    }
    case 'WebSearch': {
      const query = input['query'];
      return typeof query === 'string' ? query : '';
    }
    case 'Skill': {
      const skill = input['skill'];
      return typeof skill === 'string' ? skill : '';
    }
    case 'ToolSearch': {
      const q = input['query'];
      return typeof q === 'string' ? q.slice(0, 60) : '';
    }
    case 'SendMessage': {
      const to = input['to'];
      return typeof to === 'string' ? `→ ${to}` : '';
    }
    case 'EnterPlanMode':
      return 'Planning…';
    case 'ExitPlanMode':
      return 'Done planning';
    case 'TaskCreate': {
      const subject = input['subject'];
      return typeof subject === 'string' ? subject.slice(0, 60) : '';
    }
    case 'TaskUpdate': {
      const status = input['status'];
      const id = input['taskId'] ?? input['id'];
      const parts: string[] = [];
      if (typeof id === 'string') parts.push(id.slice(0, 8));
      if (typeof status === 'string') parts.push(status);
      return parts.join(' → ');
    }
    case 'TaskList':
    case 'TaskGet':
    case 'TaskStop':
    case 'TaskOutput': {
      const id = input['taskId'] ?? input['task_id'] ?? input['id'];
      return typeof id === 'string' ? id.slice(0, 8) : '';
    }
    case 'NotebookEdit': {
      const fp = input['notebook_path'] ?? input['file_path'];
      if (typeof fp === 'string') return fp.split('/').pop() ?? fp;
      return '';
    }
    case 'LSP': {
      const cmd = input['command'];
      return typeof cmd === 'string' ? cmd : '';
    }
    case 'EnterWorktree': {
      const branch = input['branch'];
      return typeof branch === 'string' ? branch : '';
    }
    case 'ExitWorktree':
      return '';
    default: {
      // Strip MCP prefix for cleaner display: mcp__server__tool → tool
      if (toolName.startsWith('mcp__')) {
        const parts = toolName.split('__');
        const mcpTool = parts.length >= 3 ? parts.slice(2).join('__') : parts.at(-1);
        for (const val of Object.values(input)) {
          if (typeof val === 'string' && val.length > 0) return `${mcpTool}: ${val.slice(0, 50)}`;
        }
        return mcpTool ?? '';
      }
      for (const val of Object.values(input)) {
        if (typeof val === 'string' && val.length > 0) return val.slice(0, 60);
      }
      return '';
    }
  }
}

/** Where some bytes sit in a transcript: `[start, end)`. */
export type ByteRange = { start: number; end: number };

/** One line of a transcript and the events it holds. */
export type TailLine = ByteRange & { events: TranscriptEvent[] };

/**
 * A turn: from a prompt to the next one. `end` is null while it is the
 * latest, which runs to wherever the transcript has been read up to.
 */
export type TurnEntry = {
  /** Counts from 1 since the transcript began or was last cleared. */
  n: number;
  start: number;
  end: number | null;
  timestamp: string | null;
  uuid: string | null;
  source: PromptSource;
  /** The start of the prompt, for listing turns without reading them. */
  preview: string;
};

/** Where a tool call and its result sit, so the result can be read back when asked for. */
export type ToolEntry = {
  name: string;
  use: ByteRange;
  result: ByteRange | null;
};

export type TranscriptTailOptions = {
  /** Called for each complete line, in order. */
  onLine?: (line: TailLine) => void;
  /** Called when the transcript was replaced by a shorter file and is read again from the start. */
  onReset?: () => void;
  /** How many tool calls to remember where to find. */
  toolLimit?: number;
  /** How many turns to remember. */
  turnLimit?: number;
};

const READ_CHUNK_BYTES = 4 * 1024 * 1024;
const DEFAULT_TOOL_LIMIT = 5_000;
const DEFAULT_TURN_LIMIT = 5_000;
const PREVIEW_CHARS = 200;
const NEWLINE = 0x0a;

/** A prompt that starts a turn. A compaction summary continues the turn it interrupted. */
function startsTurn(event: TranscriptEvent): event is TranscriptEvent & { kind: 'user_prompt' } {
  return event.kind === 'user_prompt' && event.source !== 'compact';
}

/**
 * Follows a transcript as it grows, reading only bytes it has not seen.
 *
 * Lines are split on bytes, so offsets are exact file positions and a
 * multi-byte character split across two reads is never mangled; an
 * unfinished last line waits for the rest. A file that got shorter was
 * replaced, and is read again from the start.
 *
 * It keeps a turn index and a bounded map from tool use id to byte ranges,
 * never the text itself, so memory stays flat however long the session runs.
 */
export class TranscriptTail {
  private readonly turnList: TurnEntry[] = [];
  private readonly toolMap = new Map<string, ToolEntry>();
  private readonly toolLimit: number;
  private readonly turnLimit: number;
  /** Bytes consumed, including an unfinished last line held in `partial`. */
  private offset = 0;
  private partial: Buffer[] = [];
  private partialStart = 0;
  private turnCount = 0;

  constructor(private readonly opts: TranscriptTailOptions = {}) {
    this.toolLimit = opts.toolLimit ?? DEFAULT_TOOL_LIMIT;
    this.turnLimit = opts.turnLimit ?? DEFAULT_TURN_LIMIT;
  }

  /** How many bytes of the file have been read. */
  get position(): number {
    return this.offset;
  }

  /** Where the complete lines read so far end; an unfinished line starts here. */
  get lineEnd(): number {
    return this.partial.length > 0 ? this.partialStart : this.offset;
  }

  /** Turns since the transcript began or was last cleared, oldest first. */
  get turns(): readonly TurnEntry[] {
    return this.turnList;
  }

  tool(toolUseId: string): ToolEntry | undefined {
    return this.toolMap.get(toolUseId);
  }

  /** Read whatever the file gained since the last read. */
  async read(path: string): Promise<void> {
    let handle: FileHandle;
    try {
      handle = await open(path, 'r');
    } catch {
      return; // not written yet
    }
    try {
      const { size } = await handle.stat();
      if (size < this.offset) this.restart();
      const buffer = Buffer.alloc(Math.min(READ_CHUNK_BYTES, Math.max(0, size - this.offset)));
      while (this.offset < size) {
        const { bytesRead } = await handle.read(
          buffer,
          0,
          Math.min(buffer.length, size - this.offset),
          this.offset
        );
        if (bytesRead === 0) break;
        this.feed(buffer.subarray(0, bytesRead));
      }
    } finally {
      await handle.close();
    }
  }

  /** `read` for callers that cannot wait, such as a file watcher that answers at once. */
  readSync(path: string): void {
    let size: number;
    try {
      size = statSync(path).size;
    } catch {
      return;
    }
    if (size < this.offset) this.restart();
    if (size === this.offset) return;
    const fd = openSync(path, 'r');
    try {
      const buffer = Buffer.alloc(Math.min(READ_CHUNK_BYTES, size - this.offset));
      while (this.offset < size) {
        const bytesRead = readSync(
          fd,
          buffer,
          0,
          Math.min(buffer.length, size - this.offset),
          this.offset
        );
        if (bytesRead === 0) break;
        this.feed(buffer.subarray(0, bytesRead));
      }
    } finally {
      closeSync(fd);
    }
  }

  /**
   * Take the next bytes of the file. Exposed for tests; `read` and `readSync`
   * are the way in otherwise.
   */
  feed(chunk: Buffer): void {
    let from = 0;
    while (from < chunk.length) {
      const nl = chunk.indexOf(NEWLINE, from);
      if (nl === -1) {
        if (this.partial.length === 0) this.partialStart = this.offset;
        this.partial.push(Buffer.from(chunk.subarray(from)));
        this.offset += chunk.length - from;
        return;
      }
      const piece = chunk.subarray(from, nl);
      const start = this.partial.length > 0 ? this.partialStart : this.offset;
      const bytes = this.partial.length > 0 ? Buffer.concat([...this.partial, piece]) : piece;
      this.partial = [];
      this.offset += nl + 1 - from;
      from = nl + 1;
      this.line({ start, end: this.offset, events: normalizeLine(bytes.toString('utf8')) });
    }
  }

  private line(line: TailLine): void {
    for (const event of line.events) {
      if (event.kind === 'clear') {
        this.turnList.length = 0;
        this.toolMap.clear();
        this.turnCount = 0;
      } else if (startsTurn(event)) {
        // Several text blocks on one line are one prompt.
        const last = this.turnList.at(-1);
        if (last?.start === line.start) continue;
        if (last) last.end = line.start;
        this.turnList.push({
          n: ++this.turnCount,
          start: line.start,
          end: null,
          timestamp: event.timestamp,
          uuid: event.uuid,
          source: event.source,
          preview: event.text.slice(0, PREVIEW_CHARS)
        });
        if (this.turnList.length > this.turnLimit) this.turnList.shift();
      } else if (event.kind === 'tool_use' && event.id) {
        this.toolMap.delete(event.id);
        this.toolMap.set(event.id, { name: event.name, use: range(line), result: null });
        if (this.toolMap.size > this.toolLimit) {
          const oldest = this.toolMap.keys().next().value;
          if (oldest !== undefined) this.toolMap.delete(oldest);
        }
      } else if (event.kind === 'tool_result') {
        const entry = this.toolMap.get(event.toolUseId);
        if (entry) entry.result = range(line);
      }
    }
    this.opts.onLine?.(line);
  }

  private restart(): void {
    this.offset = 0;
    this.partial = [];
    this.partialStart = 0;
    this.turnList.length = 0;
    this.toolMap.clear();
    this.turnCount = 0;
    this.opts.onReset?.();
  }
}

function range(line: ByteRange): ByteRange {
  return { start: line.start, end: line.end };
}

/**
 * Read one stretch of a transcript back, such as a turn or a tool result the
 * tail recorded. Returns the events of the whole lines in it; empty when the
 * file is gone.
 */
export async function readTranscriptRange(path: string, span: ByteRange): Promise<TailLine[]> {
  let handle: FileHandle;
  try {
    handle = await open(path, 'r');
  } catch {
    return [];
  }
  const lines: TailLine[] = [];
  try {
    const length = Math.max(0, span.end - span.start);
    const tail = new TranscriptTail({
      onLine: (line) =>
        lines.push({
          start: line.start + span.start,
          end: line.end + span.start,
          events: line.events
        })
    });
    const buffer = Buffer.alloc(Math.min(READ_CHUNK_BYTES, length));
    let read = 0;
    while (read < length) {
      const { bytesRead } = await handle.read(
        buffer,
        0,
        Math.min(buffer.length, length - read),
        span.start + read
      );
      if (bytesRead === 0) break;
      read += bytesRead;
      tail.feed(buffer.subarray(0, bytesRead));
    }
    // A range the tail recorded ends at a newline; one that does not is cut
    // short, and its last line is read as it is.
    tail.feed(Buffer.from('\n'));
  } finally {
    await handle.close();
  }
  return lines.filter((l) => l.events.length > 0);
}
