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
  tail: TranscriptTail;
  messages: CopilotChatMessage[];
  seenToolIds: Set<string>;
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

/** Apply one line's events to an accumulating message list: `/clear` empties it. */
function applyLine(
  events: TranscriptEvent[],
  messages: CopilotChatMessage[],
  seenToolIds: Set<string>
): void {
  if (events.some((e) => e.kind === 'clear')) {
    messages.length = 0;
    seenToolIds.clear();
    return;
  }
  const msg = messageFromLine(events, seenToolIds);
  if (msg) messages.push(msg);
}

/**
 * Parse a full `.jsonl` transcript string into messages. Pure and allocation-only —
 * no caching, no file handles — so callers can scan many sessions without the
 * unbounded state growth of {@link ConversationReader}. Produces the same messages
 * (and therefore the same count) as the incremental reader.
 */
export function parseClaudeTranscript(content: string): CopilotChatMessage[] {
  const messages: CopilotChatMessage[] = [];
  const seenToolIds = new Set<string>();
  for (const line of content.split('\n')) {
    applyLine(normalizeLine(line), messages, seenToolIds);
  }
  return messages;
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
    return state.messages;
  }

  watch(sessionId: string, filePath: string): void {
    if (this.watchers.has(sessionId)) return;

    if (!existsSync(filePath)) return;

    const watcher = watch(filePath, { persistent: false }, (eventType) => {
      log.debug('fs.watch fired', { sessionId, eventType });
      const state = this.states.get(sessionId);
      if (!state) return;
      const prevCount = state.messages.length;
      this.parseNewLines(state);
      if (state.messages.length !== prevCount) {
        log.debug('new messages detected via watcher', {
          sessionId,
          count: state.messages.length - prevCount
        });
        this.onChange?.(sessionId, state.messages);
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
    const prevCount = state.messages.length;
    this.parseNewLines(state);
    if (state.messages.length !== prevCount) {
      log.debug('new messages detected via refresh', {
        sessionId,
        count: state.messages.length - prevCount
      });
      this.onChange?.(sessionId, state.messages);
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
    const messages: CopilotChatMessage[] = [];
    const seenToolIds = new Set<string>();
    const state: SessionParseState = {
      filePath,
      messages,
      seenToolIds,
      tail: new TranscriptTail({
        onLine: (line) => applyLine(line.events, state.messages, state.seenToolIds),
        // The file was replaced by a shorter one: its messages start over.
        onReset: () => {
          state.messages = [];
          state.seenToolIds = new Set();
        }
      })
    };
    return state;
  }

  private parseNewLines(state: SessionParseState): void {
    state.tail.readSync(state.filePath);
  }
}
