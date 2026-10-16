import { existsSync, watch, type FSWatcher } from 'fs';
import { createLogger } from '../logger';
import {
  normalizeLine,
  toolInputPreview,
  TranscriptTail,
  type TranscriptEvent
} from '../claude-sessions/transcript';
import type { CopilotChatMessage, CopilotMessageBlock } from '../../shared/types';

const log = createLogger('copilot:conversation-reader');

type SessionParseState = {
  filePath: string;
  tail: MessageTail;
};

/**
 * Turn one transcript line's events into a chat message, or null when the line
 * shows nothing in the chat. Tool calls already shown are dropped by id.
 */
function messageFromLine(
  events: TranscriptEvent[],
  seenToolIds: Set<string>
): CopilotChatMessage | null {
  const first = events.at(0);
  if (!first?.uuid || !first.role) return null;
  const blocks: CopilotMessageBlock[] = [];
  for (const event of events) {
    switch (event.kind) {
      case 'user_prompt':
      case 'assistant_text':
        blocks.push({ type: 'text', text: event.text });
        break;
      case 'thinking':
        blocks.push({ type: 'thinking', text: event.text });
        break;
      case 'interrupted':
        blocks.push({ type: 'interrupted' });
        break;
      case 'tool_use': {
        if (event.id && seenToolIds.has(event.id)) break;
        if (event.id) seenToolIds.add(event.id);
        const block: CopilotMessageBlock = {
          type: 'tool_use',
          id: event.id,
          name: event.name,
          inputPreview: toolInputPreview(event.name, event.input)
        };
        // Include full input for interactive tools so the UI can render options
        if (event.name === 'AskUserQuestion') block.input = event.input;
        blocks.push(block);
        break;
      }
      case 'tool_result':
      case 'clear':
      case 'queue':
      case 'meta':
        // Tool results, queue and bookkeeping lines are not shown in the chat.
        break;
    }
  }
  if (blocks.length === 0) return null;
  return {
    id: first.uuid,
    role: first.role,
    timestamp: first.timestamp ?? new Date().toISOString(),
    blocks
  };
}

/**
 * Turns transcript lines into chat messages one line at a time, carrying the
 * tool calls already shown so a repeated one is dropped.
 */
export class ChatMessageFold {
  private readonly seenToolIds = new Set<string>();

  /** The line's message, `'clear'` when `/clear` empties the chat, or null when it shows nothing. */
  add(events: TranscriptEvent[]): CopilotChatMessage | 'clear' | null {
    if (events.some((e) => e.kind === 'clear')) {
      this.seenToolIds.clear();
      return 'clear';
    }
    return messageFromLine(events, this.seenToolIds);
  }
}

/** Fold one line into an accumulating message list: `/clear` empties it. */
function applyLine(
  events: TranscriptEvent[],
  messages: CopilotChatMessage[],
  fold: ChatMessageFold
): void {
  const msg = fold.add(events);
  if (msg === 'clear') messages.length = 0;
  else if (msg) messages.push(msg);
}

/**
 * Parse a full `.jsonl` transcript string into messages. Pure and allocation-only —
 * no caching, no file handles — so callers can scan many sessions without the
 * unbounded state growth of {@link ConversationReader}. Produces the same messages
 * (and therefore the same count) as the incremental reader.
 */
export function parseClaudeTranscript(content: string): CopilotChatMessage[] {
  const messages: CopilotChatMessage[] = [];
  const fold = new ChatMessageFold();
  for (const line of content.split('\n')) {
    applyLine(normalizeLine(line), messages, fold);
  }
  return messages;
}

/**
 * A transcript's chat messages, followed as the file grows: each read takes
 * only the lines added since the last one.
 */
export class MessageTail {
  private list: CopilotChatMessage[] = [];
  private fold = new ChatMessageFold();
  private readonly tail = new TranscriptTail({
    onLine: (line) => applyLine(line.events, this.list, this.fold),
    // The file was replaced by a shorter one: its messages start over.
    onReset: () => {
      this.list = [];
      this.fold = new ChatMessageFold();
    }
  });

  get messages(): CopilotChatMessage[] {
    return this.list;
  }

  async read(path: string): Promise<void> {
    await this.tail.read(path);
  }

  readSync(path: string): void {
    this.tail.readSync(path);
  }
}

export class ConversationReader {
  private states = new Map<string, SessionParseState>();
  private watchers = new Map<string, FSWatcher>();
  private onChange: ((sessionId: string, messages: CopilotChatMessage[]) => void) | null = null;

  setOnChange(cb: (sessionId: string, messages: CopilotChatMessage[]) => void): void {
    this.onChange = cb;
  }

  /** `filePath` is the session's transcript, from `transcriptPathFor`. */
  getMessages(sessionId: string, filePath: string): CopilotChatMessage[] {
    if (!existsSync(filePath)) return [];

    let state = this.states.get(sessionId);
    if (!state) {
      state = this.newState(filePath);
      this.states.set(sessionId, state);
    }

    this.parseNewLines(state);
    return state.tail.messages;
  }

  watch(sessionId: string, filePath: string): void {
    if (this.watchers.has(sessionId)) return;

    if (!existsSync(filePath)) return;

    const watcher = watch(filePath, { persistent: false }, (eventType) => {
      log.debug('fs.watch fired', { sessionId, eventType });
      const state = this.states.get(sessionId);
      if (!state) return;
      const prevCount = state.tail.messages.length;
      this.parseNewLines(state);
      if (state.tail.messages.length !== prevCount) {
        log.debug('new messages detected via watcher', {
          sessionId,
          count: state.tail.messages.length - prevCount
        });
        this.onChange?.(sessionId, state.tail.messages);
      }
    });

    this.watchers.set(sessionId, watcher);
    log.debug('watching JSONL', { sessionId, filePath });
  }

  unwatch(sessionId: string): void {
    const watcher = this.watchers.get(sessionId);
    if (watcher) {
      watcher.close();
      this.watchers.delete(sessionId);
    }
    this.states.delete(sessionId);
  }

  /** Re-parse a watched session's JSONL and emit onChange if new messages found */
  refresh(sessionId: string): void {
    const state = this.states.get(sessionId);
    if (!state) return;
    const prevCount = state.tail.messages.length;
    this.parseNewLines(state);
    if (state.tail.messages.length !== prevCount) {
      log.debug('new messages detected via refresh', {
        sessionId,
        count: state.tail.messages.length - prevCount
      });
      this.onChange?.(sessionId, state.tail.messages);
    }
  }

  getWatchedSessionIds(): string[] {
    return Array.from(this.watchers.keys());
  }

  dispose(): void {
    for (const [, watcher] of this.watchers) {
      watcher.close();
    }
    this.watchers.clear();
    this.states.clear();
  }

  private newState(filePath: string): SessionParseState {
    return { filePath, tail: new MessageTail() };
  }

  private parseNewLines(state: SessionParseState): void {
    state.tail.readSync(state.filePath);
  }
}
