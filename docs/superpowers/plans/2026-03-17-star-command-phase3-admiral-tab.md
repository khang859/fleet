# Star Command Phase 3: Star Command Tab + Admiral — Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a pinned Star Command tab with a chat interface to the Admiral — an AI agent that translates natural language into Bridge Control calls (deploy, recall, status, etc.).

**Architecture:** The Admiral is a main-process service that maintains a Claude conversation via the Anthropic SDK. It has Bridge Controls as tools that map to Phase 1/2 services. The renderer shows a chat UI with a status panel. IPC channels handle streaming responses.

**Tech Stack:** @anthropic-ai/sdk, React, Zustand, existing IPC infrastructure

**Spec:** `docs/superpowers/specs/2026-03-17-star-command-phase3-admiral-tab.md`

---

## File Structure

**New files:**
- `src/main/starbase/admiral.ts` — Admiral AI service: conversation management, tool dispatch
- `src/main/starbase/admiral-system-prompt.ts` — System prompt template function
- `src/main/starbase/admiral-tools.ts` — Tool definitions for Bridge Controls
- `src/main/starbase/comms-service.ts` — Comms CRUD: send, resolve, getUnread, markRead
- `src/main/__tests__/comms-service.test.ts` — CommsService unit tests
- `src/main/__tests__/admiral-tools.test.ts` — Admiral tool dispatch tests
- `src/renderer/src/components/StarCommandTab.tsx` — Star Command tab UI
- `src/renderer/src/store/star-command-store.ts` — Zustand store for Star Command state

**Modified files:**
- `package.json` — Add `@anthropic-ai/sdk`
- `src/shared/types.ts` — Add `type` field to Tab type
- `src/shared/constants.ts` — Add admiral/comms IPC channels
- `src/shared/ipc-api.ts` — Add admiral/comms payload types
- `src/main/ipc-handlers.ts` — Register admiral IPC handlers
- `src/main/index.ts` — Initialize Admiral, CommsService, wire streaming
- `src/renderer/src/components/Sidebar.tsx` — Star Command tab icon at position 0
- `src/renderer/src/App.tsx` — Render StarCommandTab for star-command type tabs
- `src/main/layout-store.ts` — Auto-create Star Command tab on workspace load

---

## Chunk 1: Dependencies + CommsService

### Task 1: Install Anthropic SDK

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Install @anthropic-ai/sdk**

```bash
cd /Users/khangnguyen/Development/fleet && npm install @anthropic-ai/sdk
```

- [ ] **Step 2: Verify**

```bash
npm ls @anthropic-ai/sdk
```

- [ ] **Step 3: Commit**

```bash
git add package.json package-lock.json
git commit -m "chore: add @anthropic-ai/sdk for Admiral AI"
```

---

### Task 2: Write CommsService

**Files:**
- Create: `src/main/starbase/comms-service.ts`
- Create: `src/main/__tests__/comms-service.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { StarbaseDB } from '../starbase/db';
import { CommsService } from '../starbase/comms-service';
import { rmSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const TEST_DIR = join(tmpdir(), 'fleet-test-comms');
let db: StarbaseDB;
let svc: CommsService;

beforeEach(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
  mkdirSync(TEST_DIR, { recursive: true });
  db = new StarbaseDB('/tmp/comms-test', join(TEST_DIR, 'starbases'));
  db.open();
  svc = new CommsService(db.getDb());
});

afterEach(() => {
  db.close();
  rmSync(TEST_DIR, { recursive: true, force: true });
});

describe('CommsService', () => {
  it('should send a transmission', () => {
    const id = svc.send({ from: 'crew-1', to: 'admiral', type: 'mission_complete', payload: '{}' });
    expect(id).toBeGreaterThan(0);
  });

  it('should get unread transmissions', () => {
    svc.send({ from: 'crew-1', to: 'admiral', type: 'hailing', payload: '{}' });
    svc.send({ from: 'crew-2', to: 'admiral', type: 'hailing', payload: '{}' });
    const unread = svc.getUnread('admiral');
    expect(unread).toHaveLength(2);
  });

  it('should mark a transmission as read', () => {
    const id = svc.send({ from: 'crew-1', to: 'admiral', type: 'hailing', payload: '{}' });
    svc.markRead(id);
    const unread = svc.getUnread('admiral');
    expect(unread).toHaveLength(0);
  });

  it('should resolve a transmission with reply', () => {
    const id = svc.send({ from: 'crew-1', to: 'admiral', type: 'hailing', payload: '{"question":"help"}' });
    svc.resolve(id, 'Here is your answer');
    const unread = svc.getUnread('admiral');
    expect(unread).toHaveLength(0); // original marked read
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd /Users/khangnguyen/Development/fleet && npx vitest run src/main/__tests__/comms-service.test.ts
```

- [ ] **Step 3: Write CommsService implementation**

Create `src/main/starbase/comms-service.ts`:

```typescript
import type Database from 'better-sqlite3';

type TransmissionRow = {
  id: number;
  from_crew: string | null;
  to_crew: string | null;
  thread_id: string | null;
  in_reply_to: number | null;
  type: string;
  payload: string;
  read: number;
  created_at: string;
};

type SendOpts = {
  from: string;
  to: string;
  type: string;
  payload: string;
  threadId?: string;
  inReplyTo?: number;
};

export class CommsService {
  constructor(private db: Database.Database) {}

  send(opts: SendOpts): number {
    const result = this.db
      .prepare(
        'INSERT INTO comms (from_crew, to_crew, type, payload, thread_id, in_reply_to) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run(opts.from, opts.to, opts.type, opts.payload, opts.threadId ?? null, opts.inReplyTo ?? null);
    return result.lastInsertRowid as number;
  }

  resolve(transmissionId: number, response: string): number {
    const original = this.db.prepare('SELECT * FROM comms WHERE id = ?').get(transmissionId) as TransmissionRow | undefined;
    if (!original) throw new Error(`Transmission not found: ${transmissionId}`);

    this.markRead(transmissionId);

    return this.send({
      from: original.to_crew ?? 'admiral',
      to: original.from_crew ?? 'unknown',
      type: 'directive',
      payload: response,
      threadId: original.thread_id ?? String(transmissionId),
      inReplyTo: transmissionId,
    });
  }

  getUnread(crewId: string): TransmissionRow[] {
    return this.db
      .prepare('SELECT * FROM comms WHERE to_crew = ? AND read = 0 ORDER BY created_at ASC')
      .all(crewId) as TransmissionRow[];
  }

  markRead(transmissionId: number): void {
    this.db.prepare('UPDATE comms SET read = 1 WHERE id = ?').run(transmissionId);
  }

  getThread(threadId: string): TransmissionRow[] {
    return this.db
      .prepare('SELECT * FROM comms WHERE thread_id = ? ORDER BY created_at ASC')
      .all(threadId) as TransmissionRow[];
  }

  getRecent(opts?: { crewId?: string; limit?: number }): TransmissionRow[] {
    const limit = opts?.limit ?? 50;
    if (opts?.crewId) {
      return this.db
        .prepare('SELECT * FROM comms WHERE from_crew = ? OR to_crew = ? ORDER BY created_at DESC LIMIT ?')
        .all(opts.crewId, opts.crewId, limit) as TransmissionRow[];
    }
    return this.db
      .prepare('SELECT * FROM comms ORDER BY created_at DESC LIMIT ?')
      .all(limit) as TransmissionRow[];
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd /Users/khangnguyen/Development/fleet && npx vitest run src/main/__tests__/comms-service.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add src/main/starbase/comms-service.ts src/main/__tests__/comms-service.test.ts
git commit -m "feat(starbase): add CommsService for Transmission management"
```

---

## Chunk 2: Admiral Backend

### Task 3: Write Admiral system prompt and tool definitions

**Files:**
- Create: `src/main/starbase/admiral-system-prompt.ts`
- Create: `src/main/starbase/admiral-tools.ts`
- Create: `src/main/__tests__/admiral-tools.test.ts`

- [ ] **Step 1: Write the system prompt template**

Create `src/main/starbase/admiral-system-prompt.ts` — a function that takes live state (sectors, crew, missions) and returns the system prompt string. Include the space terminology glossary, behavioral instructions for Mission scoping, and current Starbase state.

- [ ] **Step 2: Write tool definitions**

Create `src/main/starbase/admiral-tools.ts` — export an array of Anthropic tool definitions matching the Bridge Controls table from the spec. Each tool has `name`, `description`, and `input_schema`.

- [ ] **Step 3: Write tool dispatch tests**

Create `src/main/__tests__/admiral-tools.test.ts` — mock the underlying services, dispatch tool calls, verify correct service methods are called with correct args.

- [ ] **Step 4: Run tests**

```bash
cd /Users/khangnguyen/Development/fleet && npx vitest run src/main/__tests__/admiral-tools.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add src/main/starbase/admiral-system-prompt.ts src/main/starbase/admiral-tools.ts src/main/__tests__/admiral-tools.test.ts
git commit -m "feat(starbase): add Admiral system prompt and tool definitions"
```

---

### Task 4: Write Admiral service with streaming conversation

**Files:**
- Create: `src/main/starbase/admiral.ts`

- [ ] **Step 1: Write Admiral class**

The Admiral class manages the Anthropic conversation. Key methods:
- `sendMessage(content)` — sends user message, returns async iterator of response chunks
- `getHistory()` — returns conversation messages
- `resetSession()` — clears history

It should handle tool calls in a loop: send message → if tool_use in response → execute tool → feed result back → continue until text response.

- [ ] **Step 2: Add error handling**

Handle: missing API key (throw descriptive error), 429 rate limit (retry with backoff), network errors (throw with message), tool execution errors (return as tool_result with is_error=true).

- [ ] **Step 3: Add context management**

When conversation history exceeds ~160k tokens (estimated), summarize older messages and truncate.

- [ ] **Step 4: Commit**

```bash
git add src/main/starbase/admiral.ts
git commit -m "feat(starbase): add Admiral AI service with streaming and tool dispatch"
```

---

## Chunk 3: Tab Type Extension + Star Command UI

### Task 5: Extend Tab type and add Star Command tab

**Files:**
- Modify: `src/shared/types.ts`
- Modify: `src/main/layout-store.ts`

- [ ] **Step 1: Add `type` field to Tab**

In `src/shared/types.ts`, add `type?: 'terminal' | 'star-command'` to the Tab type. Default is `'terminal'` (backward compatible — existing tabs don't have this field).

- [ ] **Step 2: Add auto-creation logic**

In `src/main/layout-store.ts`, add a method `ensureStarCommandTab(workspaceId)` that checks if the workspace has a Star Command tab and creates one at position 0 if not.

- [ ] **Step 3: Commit**

```bash
git add src/shared/types.ts src/main/layout-store.ts
git commit -m "feat(starbase): extend Tab type with star-command type and auto-creation"
```

---

### Task 6: Write StarCommandStore and StarCommandTab component

**Files:**
- Create: `src/renderer/src/store/star-command-store.ts`
- Create: `src/renderer/src/components/StarCommandTab.tsx`
- Modify: `src/renderer/src/components/Sidebar.tsx`
- Modify: `src/renderer/src/App.tsx`

- [ ] **Step 1: Create StarCommandStore**

Zustand store with: `messages`, `isStreaming`, `crewList`, `missionQueue`, `sectors`, `unreadCount`. Actions: `sendMessage()`, `refreshStatus()`, `jumpToCrewTab()`.

- [ ] **Step 2: Create StarCommandTab component**

Split layout: chat panel (70%) with message list, input bar, streaming indicator. Status panel (30%, collapsible) with Crew cards, Mission queue, Sectors overview.

- [ ] **Step 3: Update Sidebar to show Star Command tab**

Star Command tab renders at position 0 with a star icon. Always pinned, not closeable.

- [ ] **Step 4: Update App.tsx to render StarCommandTab**

When a tab has `type: 'star-command'`, render `StarCommandTab` instead of `TerminalPane`.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/store/star-command-store.ts src/renderer/src/components/StarCommandTab.tsx src/renderer/src/components/Sidebar.tsx src/renderer/src/App.tsx
git commit -m "feat(starbase): add Star Command tab UI with chat and status panel"
```

---

## Chunk 4: IPC Wiring + Integration

### Task 7: Wire Admiral IPC and integrate everything

**Files:**
- Modify: `src/shared/constants.ts`
- Modify: `src/main/ipc-handlers.ts`
- Modify: `src/main/index.ts`
- Modify: `src/preload/index.ts` (if needed for new IPC channels)

- [ ] **Step 1: Add IPC constants**

Add to `IPC_CHANNELS`: `ADMIRAL_SEND`, `ADMIRAL_STREAM_CHUNK`, `ADMIRAL_STREAM_END`, `ADMIRAL_STREAM_ERROR`, `ADMIRAL_GET_HISTORY`, `ADMIRAL_RESET`, `STARBASE_COMMS_UNREAD`, `STARBASE_STATUS_UPDATE`.

- [ ] **Step 2: Register Admiral IPC handlers**

In `ipc-handlers.ts`: `admiral:send-message` invokes `admiral.sendMessage()`, streams chunks via `webContents.send`. Handle errors with `admiral:stream-error`.

- [ ] **Step 3: Initialize Admiral in main process**

In `index.ts`: create Admiral with dependencies on all services. Wire status update events through EventBus to push to renderer.

- [ ] **Step 4: Run typecheck and all tests**

```bash
cd /Users/khangnguyen/Development/fleet && npm run typecheck && npm test
```

- [ ] **Step 5: Commit**

```bash
git add src/shared/constants.ts src/main/ipc-handlers.ts src/main/index.ts src/preload/index.ts
git commit -m "feat(starbase): wire Admiral IPC streaming and integrate Phase 3"
```
