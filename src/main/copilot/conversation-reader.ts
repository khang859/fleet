import { existsSync, statSync, watch, openSync, readSync, closeSync, type FSWatcher } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { createLogger } from '../logger';
import type { CopilotChatMessage, CopilotMessageBlock } from '../../shared/types';

const log = createLogger('copilot:conversation-reader');

type SessionParseState = {
  filePath: string;
  lastOffset: number;
  messages: CopilotChatMessage[];
  seenToolIds: Set<string>;
};

function cwdToProjectDir(cwd: string): string {
  return cwd.replace(/[/.]/g, '-');
}

function sessionFilePath(sessionId: string, cwd: string): string {
  const projectDir = cwdToProjectDir(cwd);
  return join(homedir(), '.claude', 'projects', projectDir, `${sessionId}.jsonl`);
}

function formatToolInputPreview(
  toolName: string,
  input: Record<string, unknown>
): string {
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
    default: {
      for (const val of Object.values(input)) {
        if (typeof val === 'string' && val.length > 0) return val.slice(0, 60);
      }
      return '';
    }
  }
}

function parseMessageLine(
  json: Record<string, unknown>,
  seenToolIds: Set<string>
): CopilotChatMessage | null {
  const type = json['type'] as string;
  if (type !== 'user' && type !== 'assistant') return null;
  if (json['isMeta'] === true) return null;

  const uuid = json['uuid'] as string | undefined;
  if (!uuid) return null;

  const messageDict = json['message'] as Record<string, unknown> | undefined;
  if (!messageDict) return null;

  const timestamp = (json['timestamp'] as string) ?? new Date().toISOString();
  const blocks: CopilotMessageBlock[] = [];
  const content = messageDict['content'];

  if (typeof content === 'string') {
    if (
      content.startsWith('<command-name>') ||
      content.startsWith('<local-command') ||
      content.startsWith('Caveat:')
    ) {
      return null;
    }
    if (content.startsWith('[Request interrupted by user')) {
      blocks.push({ type: 'interrupted' });
    } else {
      blocks.push({ type: 'text', text: content });
    }
  } else if (Array.isArray(content)) {
    for (const block of content as Record<string, unknown>[]) {
      const blockType = block['type'] as string;
      switch (blockType) {
        case 'text': {
          const text = block['text'] as string;
          if (text?.startsWith('[Request interrupted by user')) {
            blocks.push({ type: 'interrupted' });
          } else if (text) {
            blocks.push({ type: 'text', text });
          }
          break;
        }
        case 'tool_use': {
          const toolId = block['id'] as string;
          if (toolId && seenToolIds.has(toolId)) continue;
          if (toolId) seenToolIds.add(toolId);
          const name = (block['name'] as string) ?? 'Unknown';
          const input = (block['input'] as Record<string, unknown>) ?? {};
          blocks.push({
            type: 'tool_use',
            id: toolId ?? '',
            name,
            inputPreview: formatToolInputPreview(name, input),
          });
          break;
        }
        case 'thinking': {
          const thinking = block['thinking'] as string;
          if (thinking) {
            blocks.push({ type: 'thinking', text: thinking });
          }
          break;
        }
        case 'tool_result':
          // Skip tool results (they're user messages containing output)
          break;
      }
    }
  }

  if (blocks.length === 0) return null;

  return {
    id: uuid,
    role: type as 'user' | 'assistant',
    timestamp,
    blocks,
  };
}

export class ConversationReader {
  private states = new Map<string, SessionParseState>();
  private watchers = new Map<string, FSWatcher>();
  private onChange: ((sessionId: string, messages: CopilotChatMessage[]) => void) | null = null;

  setOnChange(cb: (sessionId: string, messages: CopilotChatMessage[]) => void): void {
    this.onChange = cb;
  }

  getMessages(sessionId: string, cwd: string): CopilotChatMessage[] {
    const filePath = sessionFilePath(sessionId, cwd);
    if (!existsSync(filePath)) return [];

    let state = this.states.get(sessionId);
    if (!state) {
      state = { filePath, lastOffset: 0, messages: [], seenToolIds: new Set() };
      this.states.set(sessionId, state);
    }

    this.parseNewLines(state);
    return state.messages;
  }

  watch(sessionId: string, cwd: string): void {
    if (this.watchers.has(sessionId)) return;

    const filePath = sessionFilePath(sessionId, cwd);
    if (!existsSync(filePath)) return;

    const watcher = watch(filePath, { persistent: false }, () => {
      const state = this.states.get(sessionId);
      if (!state) return;
      const prevCount = state.messages.length;
      this.parseNewLines(state);
      if (state.messages.length !== prevCount) {
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

  private parseNewLines(state: SessionParseState): void {
    if (!existsSync(state.filePath)) return;

    const stats = statSync(state.filePath);
    const fileSize = stats.size;

    if (fileSize < state.lastOffset) {
      state.lastOffset = 0;
      state.messages = [];
      state.seenToolIds = new Set();
    }

    if (fileSize === state.lastOffset) return;

    const bytesToRead = fileSize - state.lastOffset;
    const buf = Buffer.alloc(bytesToRead);
    const fd = openSync(state.filePath, 'r');
    try {
      readSync(fd, buf, 0, bytesToRead, state.lastOffset);
    } finally {
      closeSync(fd);
    }

    const newContent = buf.toString('utf-8');
    const lines = newContent.split('\n');

    for (const line of lines) {
      if (!line.trim()) continue;

      if (line.includes('<command-name>/clear</command-name>')) {
        state.messages = [];
        state.seenToolIds = new Set();
        continue;
      }

      if (!line.includes('"type":"user"') && !line.includes('"type":"assistant"')) {
        continue;
      }

      try {
        const json = JSON.parse(line) as Record<string, unknown>;
        const msg = parseMessageLine(json, state.seenToolIds);
        if (msg) {
          state.messages.push(msg);
        }
      } catch {
        // Skip malformed lines
      }
    }

    state.lastOffset = fileSize;
  }
}
