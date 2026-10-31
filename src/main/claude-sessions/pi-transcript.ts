import { isRecord } from '../../shared/is-record';
import { evaToolInput } from './eva-tools';
import { piToolName } from './pi-tools';
import type { TranscriptEvent } from './transcript';

/**
 * Reading Pi session files (`<time>_<id>.jsonl`): a `session` header line, then
 * one entry per line. Entries form a tree through `parentId`, because `/tree`
 * goes back to an earlier entry and continues from it in the same file.
 *
 * Shapes observed on Pi 1.4.0.
 */

/** One line of a session file; `type` says which of Pi's entries it is. */
export type PiEntry = Record<string, unknown>;

/** The entry on a line, or null for a blank or unfinished line. */
export function parsePiLine(line: string): PiEntry | null {
  if (!line.trim()) return null;
  try {
    const json: unknown = JSON.parse(line);
    return isRecord(json) ? json : null;
  } catch {
    return null;
  }
}

function stringOr(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback;
}

/** A message's text: a string, or its text blocks joined. */
function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((block) => isRecord(block) && block['type'] === 'text')
    .map((block: Record<string, unknown>) => stringOr(block['text'], ''))
    .join('\n');
}

type LineInfo = Pick<TranscriptEvent, 'uuid' | 'parentUuid' | 'timestamp' | 'role'>;

function assistantBlock(block: unknown, info: LineInfo): TranscriptEvent | null {
  if (!isRecord(block)) return null;
  switch (block['type']) {
    case 'text':
      return { ...info, kind: 'assistant_text', text: stringOr(block['text'], '') };
    case 'thinking':
      return { ...info, kind: 'thinking', text: stringOr(block['thinking'], '') };
    case 'toolCall': {
      const input = block['arguments'];
      return {
        ...info,
        kind: 'tool_use',
        id: stringOr(block['id'], ''),
        name: piToolName(stringOr(block['name'], 'Unknown')),
        input: isRecord(input) ? evaToolInput(input) : {}
      };
    }
    default:
      return null;
  }
}

function messageEvents(message: Record<string, unknown>, base: LineInfo): TranscriptEvent[] {
  const content = message['content'];
  switch (message['role']) {
    case 'user': {
      const text = textOf(content);
      if (!text) return [];
      return [{ ...base, role: 'user', kind: 'user_prompt', text, source: 'human' }];
    }
    case 'assistant': {
      if (!Array.isArray(content)) return [];
      const info: LineInfo = { ...base, role: 'assistant' };
      return content.flatMap((block) => assistantBlock(block, info) ?? []);
    }
    case 'toolResult':
      return [
        {
          ...base,
          role: 'user',
          kind: 'tool_result',
          toolUseId: stringOr(message['toolCallId'], ''),
          isError: message['isError'] === true,
          rejected: false,
          text: textOf(content)
        }
      ];
    default:
      return [];
  }
}

/**
 * The events one entry holds, in the shape every transcript reader shares.
 * Every entry with an id gives at least a `meta` event, so the chain through
 * `parentUuid` has no gaps.
 */
export function normalizePiEntry(entry: PiEntry | null): TranscriptEvent[] {
  if (!entry) return [];
  const uuid = typeof entry['id'] === 'string' && entry['type'] !== 'session' ? entry['id'] : null;
  if (!uuid) return [];
  const info: LineInfo = {
    uuid,
    parentUuid: typeof entry['parentId'] === 'string' ? entry['parentId'] : null,
    timestamp: typeof entry['timestamp'] === 'string' ? entry['timestamp'] : null,
    role: null
  };
  const message = entry['message'];
  const events =
    entry['type'] === 'message' && isRecord(message) ? messageEvents(message, info) : [];
  return events.length > 0
    ? events
    : [{ ...info, kind: 'meta', subtype: stringOr(entry['type'], '') }];
}

export function normalizePiLine(line: string): TranscriptEvent[] {
  return normalizePiEntry(parsePiLine(line));
}

/** The assistant's `usage` an entry carries, if it is an assistant message. */
function assistantOf(entry: PiEntry): Record<string, unknown> | null {
  const message = entry['message'];
  if (entry['type'] !== 'message' || !isRecord(message)) return null;
  return message['role'] === 'assistant' ? message : null;
}

function numberAt(record: unknown, key: string): number {
  const value = isRecord(record) ? record[key] : undefined;
  return typeof value === 'number' ? value : 0;
}

/**
 * What a session has spent and how full its context is. Pi prices each message
 * itself, so no price table is needed. Spend counts every branch, because
 * leaving a branch does not refund it.
 */
export class PiUsage {
  costUsd = 0;
  /** Tokens at the latest message that reported any; a failed request reports none. */
  contextTokens: number | null = null;
  readonly models = new Set<string>();

  add(entry: PiEntry | null): void {
    const message = entry && assistantOf(entry);
    if (!message) return;
    const usage = message['usage'];
    this.costUsd += numberAt(isRecord(usage) ? usage['cost'] : undefined, 'total');
    const tokens = numberAt(usage, 'totalTokens');
    if (tokens > 0) this.contextTokens = tokens;
    if (typeof message['model'] === 'string') this.models.add(message['model']);
  }
}
