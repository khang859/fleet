# Copilot Chat History & Input Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Display real-time chat history and allow sending messages to Claude Code sessions from the copilot panel, like Claude Island does.

**Architecture:** Read Claude Code's JSONL conversation files (`~/.claude/projects/{projectDir}/{sessionId}.jsonl`) with incremental file watching for real-time updates. Send messages by writing directly to the session's TTY device. The JSONL path is derived from CWD by replacing `/` and `.` with `-`.

**Tech Stack:** Node.js fs + chokidar-style file watching, IPC channels, React components with auto-scrolling message list.

---

## File Structure

| File | Action | Responsibility |
|------|--------|---------------|
| `src/shared/types.ts` | Modify | Add `CopilotChatMessage` and `CopilotMessageBlock` types |
| `src/shared/ipc-channels.ts` | Modify | Add `COPILOT_CHAT_HISTORY` and `COPILOT_SEND_MESSAGE` channels |
| `src/main/copilot/conversation-reader.ts` | Create | Read + incrementally parse JSONL files, watch for changes |
| `src/main/copilot/ipc-handlers.ts` | Modify | Register chat history and send message handlers |
| `src/main/copilot/index.ts` | Modify | Initialize ConversationReader, wire up to session store |
| `src/preload/copilot.ts` | Modify | Expose `getChatHistory`, `onChatHistory`, `sendMessage` APIs |
| `src/renderer/copilot/src/store/copilot-store.ts` | Modify | Add chat messages state and actions |
| `src/renderer/copilot/src/components/SessionDetail.tsx` | Modify | Replace placeholder with message list + input bar |
| `src/renderer/copilot/src/components/ChatMessage.tsx` | Create | Render individual user/assistant/tool messages |

---

### Task 1: Add shared types for chat messages

**Files:**
- Modify: `src/shared/types.ts`
- Modify: `src/shared/ipc-channels.ts`

- [ ] **Step 1: Add chat message types to types.ts**

Add after the `CopilotPosition` type (around line 176):

```typescript
// ── Copilot Chat Messages ────────────────────────────────────────────────────

export type CopilotMessageBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; inputPreview: string }
  | { type: 'thinking'; text: string }
  | { type: 'interrupted' };

export type CopilotChatMessage = {
  id: string;
  role: 'user' | 'assistant';
  timestamp: string;
  blocks: CopilotMessageBlock[];
};
```

- [ ] **Step 2: Add IPC channels to ipc-channels.ts**

Add after `COPILOT_EXPANDED_CHANGED` line:

```typescript
  COPILOT_CHAT_HISTORY: 'copilot:chat-history',
  COPILOT_CHAT_UPDATED: 'copilot:chat-updated',
  COPILOT_SEND_MESSAGE: 'copilot:send-message',
```

- [ ] **Step 3: Run typecheck**

Run: `npm run typecheck`
Expected: PASS (types are only added, not consumed yet)

- [ ] **Step 4: Commit**

```bash
git add src/shared/types.ts src/shared/ipc-channels.ts
git commit -m "feat(copilot): add chat message types and IPC channels"
```

---

### Task 2: Create conversation reader (main process)

**Files:**
- Create: `src/main/copilot/conversation-reader.ts`

This module reads JSONL files incrementally and watches for changes. It follows Claude Island's `ConversationParser` approach but in TypeScript/Node.js.

- [ ] **Step 1: Create conversation-reader.ts**

```typescript
import { readFileSync, existsSync, statSync, watch, type FSWatcher } from 'fs';
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

  /** Read (or incrementally update) chat history for a session */
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

  /** Start watching a session's JSONL file for changes */
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

  /** Stop watching a session */
  unwatch(sessionId: string): void {
    const watcher = this.watchers.get(sessionId);
    if (watcher) {
      watcher.close();
      this.watchers.delete(sessionId);
    }
    this.states.delete(sessionId);
  }

  /** Stop all watchers */
  dispose(): void {
    for (const [id, watcher] of this.watchers) {
      watcher.close();
      this.watchers.delete(id);
    }
    this.states.clear();
  }

  private parseNewLines(state: SessionParseState): void {
    if (!existsSync(state.filePath)) return;

    const stats = statSync(state.filePath);
    const fileSize = stats.size;

    // File was truncated / rewritten — reset
    if (fileSize < state.lastOffset) {
      state.lastOffset = 0;
      state.messages = [];
      state.seenToolIds = new Set();
    }

    if (fileSize === state.lastOffset) return;

    // Read only new bytes
    const buf = Buffer.alloc(fileSize - state.lastOffset);
    const fd = require('fs').openSync(state.filePath, 'r');
    try {
      require('fs').readSync(fd, buf, 0, buf.length, state.lastOffset);
    } finally {
      require('fs').closeSync(fd);
    }

    const newContent = buf.toString('utf-8');
    const lines = newContent.split('\n');

    for (const line of lines) {
      if (!line.trim()) continue;

      // Detect /clear
      if (line.includes('<command-name>/clear</command-name>')) {
        state.messages = [];
        state.seenToolIds = new Set();
        continue;
      }

      // Only parse user/assistant lines
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
```

- [ ] **Step 2: Run typecheck**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/main/copilot/conversation-reader.ts
git commit -m "feat(copilot): add conversation JSONL reader with incremental parsing"
```

---

### Task 3: Wire up conversation reader to IPC and session lifecycle

**Files:**
- Modify: `src/main/copilot/ipc-handlers.ts`
- Modify: `src/main/copilot/index.ts`

- [ ] **Step 1: Add ConversationReader to ipc-handlers.ts**

Import `ConversationReader` and add two new handlers. Add the import at the top:

```typescript
import type { ConversationReader } from './conversation-reader';
```

Update the function signature to accept `conversationReader`:

```typescript
export function registerCopilotIpcHandlers(
  sessionStore: CopilotSessionStore,
  socketServer: CopilotSocketServer,
  copilotWindow: CopilotWindow,
  settingsStore: SettingsStore,
  conversationReader: ConversationReader,
  onSettingsChanged?: () => Promise<void>
): void {
```

Add before the `log.info('IPC handlers registered')` line:

```typescript
  ipcMain.handle(
    IPC_CHANNELS.COPILOT_CHAT_HISTORY,
    (_event, args: { sessionId: string; cwd: string }) => {
      const messages = conversationReader.getMessages(args.sessionId, args.cwd);
      conversationReader.watch(args.sessionId, args.cwd);
      return messages;
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.COPILOT_SEND_MESSAGE,
    async (_event, args: { sessionId: string; message: string }) => {
      const session = sessionStore.getSession(args.sessionId);
      if (!session?.tty) {
        log.warn('no TTY for session, cannot send message', { sessionId: args.sessionId });
        return false;
      }
      try {
        const { openSync, writeSync, closeSync } = await import('fs');
        const fd = openSync(session.tty, 'w');
        try {
          writeSync(fd, args.message + '\n');
        } finally {
          closeSync(fd);
        }
        log.info('message sent to TTY', { sessionId: args.sessionId, tty: session.tty });
        return true;
      } catch (err) {
        log.error('failed to send message', { error: String(err) });
        return false;
      }
    }
  );
```

- [ ] **Step 2: Initialize ConversationReader in index.ts**

Read the current `src/main/copilot/index.ts` to understand its structure, then:

Add import:
```typescript
import { ConversationReader } from './conversation-reader';
```

Create the instance alongside the other services (after `CopilotSessionStore` and before `registerCopilotIpcHandlers`):
```typescript
const conversationReader = new ConversationReader();
```

Wire up the `onChange` callback to push updates to the renderer:
```typescript
conversationReader.setOnChange((sessionId, messages) => {
  const win = copilotWindow.getWindow();
  if (win && !win.isDestroyed()) {
    win.webContents.send(IPC_CHANNELS.COPILOT_CHAT_UPDATED, { sessionId, messages });
  }
});
```

Pass `conversationReader` to `registerCopilotIpcHandlers` (add it as the 5th argument).

Clean up watchers when the session ends — in the `sessionStore.setOnChange` callback, after ended sessions are cleaned up, call `conversationReader.unwatch(sessionId)` for ended sessions. Alternatively, add cleanup in the dispose path:
```typescript
// In the cleanup/dispose section:
conversationReader.dispose();
```

- [ ] **Step 3: Run typecheck**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/main/copilot/ipc-handlers.ts src/main/copilot/index.ts
git commit -m "feat(copilot): wire conversation reader to IPC and session lifecycle"
```

---

### Task 4: Expose chat APIs in preload bridge

**Files:**
- Modify: `src/preload/copilot.ts`

- [ ] **Step 1: Add chat history and send message methods**

Add the import for `CopilotChatMessage`:
```typescript
import type {
  CopilotSession,
  CopilotSettings,
  CopilotPosition,
  CopilotChatMessage,
} from '../shared/types';
```

Add these methods to the `copilotApi` object, before the closing `}`:

```typescript
  getChatHistory: (sessionId: string, cwd: string): Promise<CopilotChatMessage[]> =>
    ipcRenderer.invoke(IPC_CHANNELS.COPILOT_CHAT_HISTORY, { sessionId, cwd }),

  onChatUpdated: (
    cb: (data: { sessionId: string; messages: CopilotChatMessage[] }) => void
  ): (() => void) => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      data: { sessionId: string; messages: CopilotChatMessage[] }
    ): void => {
      cb(data);
    };
    ipcRenderer.on(IPC_CHANNELS.COPILOT_CHAT_UPDATED, handler);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.COPILOT_CHAT_UPDATED, handler);
  },

  sendMessage: (sessionId: string, message: string): Promise<boolean> =>
    ipcRenderer.invoke(IPC_CHANNELS.COPILOT_SEND_MESSAGE, { sessionId, message }),
```

- [ ] **Step 2: Run typecheck**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/preload/copilot.ts
git commit -m "feat(copilot): expose chat history and send message in preload API"
```

---

### Task 5: Add chat state to Zustand store

**Files:**
- Modify: `src/renderer/copilot/src/store/copilot-store.ts`

- [ ] **Step 1: Add chat messages state and actions**

Add the `CopilotChatMessage` import:
```typescript
import type {
  CopilotSession,
  CopilotSettings,
  CopilotChatMessage,
} from '../../../../shared/types';
```

Add to the `CopilotStoreState` type:
```typescript
  chatMessages: CopilotChatMessage[];
  chatLoading: boolean;
  loadChatHistory: (sessionId: string, cwd: string) => Promise<void>;
  setChatMessages: (sessionId: string, messages: CopilotChatMessage[]) => void;
  sendMessage: (sessionId: string, message: string) => Promise<boolean>;
```

Add initial state values:
```typescript
  chatMessages: [],
  chatLoading: false,
```

Add the action implementations:
```typescript
  loadChatHistory: async (sessionId, cwd) => {
    set({ chatLoading: true });
    const messages = await window.copilot.getChatHistory(sessionId, cwd);
    if (get().selectedSessionId === sessionId) {
      set({ chatMessages: messages, chatLoading: false });
    } else {
      set({ chatLoading: false });
    }
  },

  setChatMessages: (sessionId, messages) => {
    if (get().selectedSessionId === sessionId) {
      set({ chatMessages: messages });
    }
  },

  sendMessage: async (sessionId, message) => {
    return window.copilot.sendMessage(sessionId, message);
  },
```

Also update `backToList` to clear chat messages:
```typescript
  backToList: () => set({ view: 'sessions', selectedSessionId: null, chatMessages: [] }),
```

- [ ] **Step 2: Run typecheck**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/renderer/copilot/src/store/copilot-store.ts
git commit -m "feat(copilot): add chat messages state and actions to store"
```

---

### Task 6: Create ChatMessage component

**Files:**
- Create: `src/renderer/copilot/src/components/ChatMessage.tsx`

- [ ] **Step 1: Create the ChatMessage component**

```tsx
import type { CopilotChatMessage } from '../../../../shared/types';

function TextBlock({ text }: { text: string }): React.JSX.Element {
  return <div className="text-[11px] text-neutral-200 whitespace-pre-wrap break-words">{text}</div>;
}

function ToolUseBlock({
  name,
  inputPreview,
}: {
  name: string;
  inputPreview: string;
}): React.JSX.Element {
  return (
    <div className="flex items-center gap-1 text-[10px] text-neutral-400 bg-neutral-800/50 rounded px-1.5 py-0.5">
      <span className="text-blue-400 font-medium">{name}</span>
      {inputPreview && (
        <span className="truncate opacity-70">{inputPreview}</span>
      )}
    </div>
  );
}

function ThinkingBlock({ text }: { text: string }): React.JSX.Element {
  return (
    <details className="text-[10px] text-neutral-500">
      <summary className="cursor-pointer hover:text-neutral-400">Thinking...</summary>
      <div className="mt-1 whitespace-pre-wrap break-words pl-2 border-l border-neutral-700">
        {text.slice(0, 500)}{text.length > 500 ? '...' : ''}
      </div>
    </details>
  );
}

export function ChatMessageItem({ message }: { message: CopilotChatMessage }): React.JSX.Element {
  const isUser = message.role === 'user';

  return (
    <div className={`flex flex-col gap-0.5 ${isUser ? 'items-end' : 'items-start'}`}>
      {message.blocks.map((block, i) => {
        const key = `${message.id}-${i}`;
        switch (block.type) {
          case 'text':
            return (
              <div
                key={key}
                className={`max-w-[90%] rounded-lg px-2 py-1 ${
                  isUser
                    ? 'bg-blue-600/30 text-blue-100'
                    : 'bg-neutral-800 text-neutral-200'
                }`}
              >
                <TextBlock text={block.text} />
              </div>
            );
          case 'tool_use':
            return (
              <div key={key} className="max-w-[90%]">
                <ToolUseBlock name={block.name} inputPreview={block.inputPreview} />
              </div>
            );
          case 'thinking':
            return (
              <div key={key} className="max-w-[90%]">
                <ThinkingBlock text={block.text} />
              </div>
            );
          case 'interrupted':
            return (
              <div key={key} className="text-[10px] text-amber-500 italic">
                Interrupted by user
              </div>
            );
        }
      })}
    </div>
  );
}
```

- [ ] **Step 2: Run typecheck**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/renderer/copilot/src/components/ChatMessage.tsx
git commit -m "feat(copilot): add ChatMessage renderer component"
```

---

### Task 7: Update SessionDetail with chat history and input

**Files:**
- Modify: `src/renderer/copilot/src/components/SessionDetail.tsx`
- Modify: `src/renderer/copilot/src/App.tsx` (subscribe to chat updates)

- [ ] **Step 1: Rewrite SessionDetail.tsx**

Replace the entire file content:

```tsx
import { useEffect, useRef, useState } from 'react';
import { useCopilotStore } from '../store/copilot-store';
import { ChatMessageItem } from './ChatMessage';

export function SessionDetail(): React.JSX.Element | null {
  const selectedSessionId = useCopilotStore((s) => s.selectedSessionId);
  const sessions = useCopilotStore((s) => s.sessions);
  const backToList = useCopilotStore((s) => s.backToList);
  const respondPermission = useCopilotStore((s) => s.respondPermission);
  const chatMessages = useCopilotStore((s) => s.chatMessages);
  const chatLoading = useCopilotStore((s) => s.chatLoading);
  const loadChatHistory = useCopilotStore((s) => s.loadChatHistory);
  const sendMessage = useCopilotStore((s) => s.sendMessage);

  const [inputText, setInputText] = useState('');
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);

  const session = sessions.find((s) => s.sessionId === selectedSessionId);

  // Load chat history when session is selected
  useEffect(() => {
    if (session) {
      loadChatHistory(session.sessionId, session.cwd);
    }
  }, [session?.sessionId, session?.cwd, loadChatHistory]);

  // Auto-scroll to bottom on new messages
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [chatMessages.length]);

  const handleSend = async (): Promise<void> => {
    const text = inputText.trim();
    if (!text || !session) return;
    setInputText('');
    await sendMessage(session.sessionId, text);
  };

  const handleKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  if (!session) {
    return (
      <div className="flex flex-col h-full bg-neutral-900 rounded-lg border border-neutral-700">
        <div className="flex items-center px-3 py-2 border-b border-neutral-700">
          <button onClick={backToList} className="text-xs text-neutral-400 hover:text-neutral-200">
            ← Back
          </button>
        </div>
        <div className="flex-1 flex items-center justify-center text-neutral-500 text-xs">
          Session not found
        </div>
      </div>
    );
  }

  const canSendMessage = session.phase === 'waitingForInput';

  return (
    <div className="flex flex-col h-full bg-neutral-900 rounded-lg border border-neutral-700 overflow-hidden">
      {/* Header */}
      <div className="flex items-center gap-2 px-3 py-2 border-b border-neutral-700">
        <button onClick={backToList} className="text-xs text-neutral-400 hover:text-neutral-200">
          ←
        </button>
        <span className="text-xs font-medium text-neutral-200 truncate">
          {session.projectName}
        </span>
        <span className="text-[9px] text-neutral-500 ml-auto">{session.phase}</span>
      </div>

      {/* Pending permissions */}
      {session.pendingPermissions.length > 0 && (
        <div className="px-3 py-2 border-b border-neutral-800">
          <div className="text-[10px] font-medium text-amber-400 mb-1">
            Pending Permissions
          </div>
          {session.pendingPermissions.map((perm) => (
            <div key={perm.toolUseId} className="mb-2 p-2 bg-neutral-800/50 rounded border border-amber-500/20">
              <div className="text-xs text-neutral-200 font-medium">
                {perm.tool.toolName}
              </div>
              {Object.keys(perm.tool.toolInput).length > 0 && (
                <pre className="mt-1 text-[10px] text-neutral-400 overflow-x-auto max-h-24 overflow-y-auto">
                  {JSON.stringify(perm.tool.toolInput, null, 2)}
                </pre>
              )}
              <div className="flex gap-1 mt-2">
                <button
                  onClick={() => respondPermission(perm.toolUseId, 'allow')}
                  className="px-2 py-1 text-[10px] bg-green-600/30 text-green-400 rounded hover:bg-green-600/50"
                >
                  Allow
                </button>
                <button
                  onClick={() => respondPermission(perm.toolUseId, 'deny')}
                  className="px-2 py-1 text-[10px] bg-red-600/30 text-red-400 rounded hover:bg-red-600/50"
                >
                  Deny
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Chat messages */}
      <div ref={scrollContainerRef} className="flex-1 overflow-y-auto px-3 py-2 space-y-2">
        {chatLoading && chatMessages.length === 0 && (
          <div className="text-[10px] text-neutral-500 text-center mt-4">Loading...</div>
        )}
        {!chatLoading && chatMessages.length === 0 && (
          <div className="text-[10px] text-neutral-500 text-center mt-4">No messages yet</div>
        )}
        {chatMessages.map((msg) => (
          <ChatMessageItem key={msg.id} message={msg} />
        ))}
        <div ref={messagesEndRef} />
      </div>

      {/* Input bar */}
      <div className="px-3 py-2 border-t border-neutral-800">
        <div className="flex gap-1.5 items-end">
          <input
            type="text"
            value={inputText}
            onChange={(e) => setInputText(e.target.value)}
            onKeyDown={handleKeyDown}
            disabled={!canSendMessage}
            placeholder={
              canSendMessage
                ? 'Message Claude...'
                : session.tty
                  ? `Claude is ${session.phase}...`
                  : 'No TTY — cannot send messages'
            }
            className="flex-1 bg-neutral-800 border border-neutral-700 rounded px-2 py-1 text-[11px] text-neutral-200 placeholder:text-neutral-500 outline-none focus:border-blue-500/50 disabled:opacity-50"
          />
          <button
            onClick={handleSend}
            disabled={!canSendMessage || !inputText.trim()}
            className="px-2 py-1 text-[10px] bg-blue-600/30 text-blue-400 rounded hover:bg-blue-600/50 disabled:opacity-30 disabled:cursor-not-allowed"
          >
            ↑
          </button>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Subscribe to chat updates in App.tsx**

In `src/renderer/copilot/src/App.tsx`, add a `useEffect` to subscribe to chat update events from the main process. Add this alongside existing effect hooks:

```tsx
  // Subscribe to real-time chat updates
  useEffect(() => {
    const setChatMessages = useCopilotStore.getState().setChatMessages;
    const unsub = window.copilot.onChatUpdated(({ sessionId, messages }) => {
      setChatMessages(sessionId, messages);
    });
    return unsub;
  }, []);
```

- [ ] **Step 3: Run typecheck**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 4: Test manually**

Run: `npm run dev`

1. Open the copilot panel
2. Start a Claude Code session in the project directory
3. Verify chat messages appear in the copilot detail view
4. Verify the input field is enabled when Claude is waiting for input
5. Send a test message and verify it reaches the Claude Code session

- [ ] **Step 5: Commit**

```bash
git add src/renderer/copilot/src/components/SessionDetail.tsx src/renderer/copilot/src/components/ChatMessage.tsx src/renderer/copilot/src/App.tsx
git commit -m "feat(copilot): add chat history display and message input to session detail"
```

---

### Task 8: Handle session ended cleanup for conversation reader

**Files:**
- Modify: `src/main/copilot/index.ts`

- [ ] **Step 1: Clean up watchers when sessions end**

In `index.ts`, when processing session state changes, detect ended sessions and unwatch them. The exact approach depends on how `index.ts` is structured, but the key change is:

After `sessionStore.processHookEvent(event)` or in the `onChange` callback, check for ended sessions:

```typescript
// In the sessionStore onChange handler, after pushing sessions to renderer:
// Clean up watchers for sessions that have ended
const activeSessions = sessionStore.getSessions();
const activeIds = new Set(activeSessions.map(s => s.sessionId));
// The ConversationReader should expose a method to clean up stale watchers
// For now, ended sessions are cleaned up by the 30-second timeout in session-store
```

Actually, the simplest approach: in the `session-store.ts` where it deletes ended sessions after 30 seconds, the conversation reader's `unwatch` gets called from `index.ts`'s onChange callback since `getSessions()` filters out ended sessions. So we just need to track which sessions we're watching and unwatch ones no longer in the active list.

Add to the `onChange` callback in index.ts:

```typescript
const currentSessionIds = new Set(sessionStore.getSessions().map(s => s.sessionId));
for (const watchedId of conversationReader.getWatchedSessionIds()) {
  if (!currentSessionIds.has(watchedId)) {
    conversationReader.unwatch(watchedId);
  }
}
```

And add a `getWatchedSessionIds()` method to `ConversationReader`:

```typescript
getWatchedSessionIds(): string[] {
  return Array.from(this.watchers.keys());
}
```

- [ ] **Step 2: Run typecheck**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/main/copilot/index.ts src/main/copilot/conversation-reader.ts
git commit -m "feat(copilot): clean up JSONL watchers when sessions end"
```
