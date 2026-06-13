# Rune File Assistant Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A right-docked panel that runs Rune on-demand against the file open in Fleet, answering questions (Ask mode) and editing the file (Agent mode), with auto-reload + diff highlight + revert.

**Architecture:** Mirror the existing PM chat stack end-to-end. A main-process `RuneFileChatService` (clone of `PmChatService`, no kanban MCP) spawns `rune --prompt` / `--resume` in the workspace root, parses the session id from stdout, and reads the transcript back via `readRuneSession`. IPC (channels → handlers → preload) carries send/state/reset/stop calls and status/transcript events. A zustand store drives a `RuneAssistPanel` React component; the active file + selection come from `workspace-store` and a new `editor-context-registry` (clone of `file-save-registry`). After Agent turns, open file panes reload from disk and flash the changed lines.

**Tech Stack:** Electron (main/preload/renderer), electron-vite, React + TypeScript, zustand, CodeMirror 6, vitest. Rune CLI (`rune` binary on PATH). Zod for IPC payload validation (project rule: no unsafe `as` casts).

**Reference spec:** `docs/superpowers/specs/2026-06-13-rune-file-assistant-design.md`
**Branch:** `feat/rune-file-assistant` (already created)

**Key design simplification vs. spec:** mode (`ask`/`agent`) is carried on each `send` request and persisted renderer-side, so there is **no** separate `setMode` IPC channel. Ask mode is enforced via a prompt preamble (a verified-buildable mechanism; a future Rune flag/profile can harden it — tracked as a spec open question). Queue-while-running lives in the renderer store, so the service stays strictly one-in-flight-per-cwd.

---

## File Structure

**Create:**
- `src/main/rune-assist/rune-file-chat-service.ts` — service + exported pure helpers (`composeAssistPrompt`, `buildAssistArgs`, `parseRuneSessionId`, `buildContextLine`).
- `src/main/rune-assist/__tests__/rune-file-chat-service.test.ts` — unit tests.
- `src/renderer/src/lib/editor-context-registry.ts` — paneId → `{ getSelection, reloadFromDisk }` handle registry.
- `src/renderer/src/lib/__tests__/editor-context-registry.test.ts` — unit tests.
- `src/renderer/src/store/rune-assist-store.ts` — zustand store (state, actions, queue).
- `src/renderer/src/components/rune-assist/RuneAssistPanel.tsx` — the panel UI.
- `src/renderer/src/components/rune-assist/transcript-helpers.ts` — `messageText`, `toolCards`, `reasoningText` + tests.
- `src/renderer/src/components/rune-assist/__tests__/transcript-helpers.test.ts`

**Modify:**
- `src/shared/ipc-channels.ts` — add `RUNE_ASSIST_*` channel constants.
- `src/shared/ipc-api.ts` — add `RuneAssist*` types.
- `src/main/index.ts` — construct `RuneFileChatService`, register handlers, wire emit callbacks.
- `src/preload/index.ts` — expose `window.fleet.runeAssist`.
- `src/renderer/src/components/FileEditorPane.tsx` — register an editor-context handle (selection getter + reload-from-disk + line-flash).
- `src/renderer/src/App.tsx` — mount `RuneAssistPanel` + toggle button; derive active file/cwd.

---

## Task 1: Shared IPC channels + types

**Files:**
- Modify: `src/shared/ipc-channels.ts`
- Modify: `src/shared/ipc-api.ts`

- [ ] **Step 1: Add channel constants**

In `src/shared/ipc-channels.ts`, find the `KANBAN_PM_*` block (around line 211) and add a sibling block after it:

```typescript
  // Rune file assistant (docked editor panel)
  RUNE_ASSIST_SEND: 'rune-assist:send',
  RUNE_ASSIST_STATE: 'rune-assist:state',
  RUNE_ASSIST_RESET: 'rune-assist:reset',
  RUNE_ASSIST_STOP: 'rune-assist:stop',
  RUNE_ASSIST_STATUS: 'rune-assist:status',
  RUNE_ASSIST_TRANSCRIPT: 'rune-assist:transcript',
```

- [ ] **Step 2: Add API types**

In `src/shared/ipc-api.ts`, near the `PmChat*` types (around line 407), add:

```typescript
export type RuneAssistMode = 'ask' | 'agent';

export type RuneAssistSelection = { fromLine: number; toLine: number };

export type RuneAssistSendRequest = {
  /** Workspace root the rune turn runs in; also the conversation key. */
  cwd: string;
  text: string;
  mode: RuneAssistMode;
  /** Absolute path of the file shown in the active pane, if any. */
  contextFile?: string;
  /** 1-based inclusive selected line range, if any. */
  selection?: RuneAssistSelection | null;
  /** Rune model override (e.g. a model id). */
  model?: string;
};

export type RuneAssistState = {
  cwd: string;
  inFlight: boolean;
  error: string | null;
  messages: TranscriptMessage[];
};

export type RuneAssistStatusPayload = {
  cwd: string;
  status: 'thinking' | 'idle' | 'error';
  error?: string;
};

export type RuneAssistTranscriptPayload = {
  cwd: string;
  messages: TranscriptMessage[];
};
```

`TranscriptMessage` is already imported at the top of this file (used by `PmChatState`). If not, add `TranscriptMessage` to the existing import from `'./sessions'`.

- [ ] **Step 3: Verify it compiles**

Run: `npm run typecheck`
Expected: PASS (no errors). These are type-only additions.

- [ ] **Step 4: Commit**

```bash
git add src/shared/ipc-channels.ts src/shared/ipc-api.ts
git commit -m "feat(rune-assist): IPC channels and shared types"
```

---

## Task 2: Service pure helpers (prompt, args, session-id)

These are pure, side-effect-free functions extracted so the spawn logic is unit-testable (mirrors how `buildWorkerInvocation` is split out in `spawn-worker.ts`).

**Files:**
- Create: `src/main/rune-assist/rune-file-chat-service.ts`
- Test: `src/main/rune-assist/__tests__/rune-file-chat-service.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/main/rune-assist/__tests__/rune-file-chat-service.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import {
  buildContextLine,
  composeAssistPrompt,
  buildAssistArgs,
  parseRuneSessionId,
  ASK_MODE_PREAMBLE
} from '../rune-file-chat-service';

describe('buildContextLine', () => {
  it('returns empty string when no file', () => {
    expect(buildContextLine(undefined, null)).toBe('');
  });
  it('names the file with no selection', () => {
    expect(buildContextLine('/repo/src/auth.ts', null)).toBe(
      '[context: file /repo/src/auth.ts]\n'
    );
  });
  it('includes the selected line range', () => {
    expect(buildContextLine('/repo/src/auth.ts', { fromLine: 11, toLine: 14 })).toBe(
      '[context: file /repo/src/auth.ts, lines 11-14 selected]\n'
    );
  });
});

describe('composeAssistPrompt', () => {
  it('agent mode: context line + text, no preamble', () => {
    const out = composeAssistPrompt({
      text: 'finish this',
      mode: 'agent',
      contextFile: '/repo/a.ts',
      selection: null
    });
    expect(out).toBe('[context: file /repo/a.ts]\nfinish this');
  });
  it('ask mode: prepends the read-only preamble', () => {
    const out = composeAssistPrompt({
      text: 'what does this do?',
      mode: 'ask',
      contextFile: undefined,
      selection: null
    });
    expect(out).toBe(`${ASK_MODE_PREAMBLE}\n\nwhat does this do?`);
  });
});

describe('buildAssistArgs', () => {
  it('first turn: only --prompt', () => {
    expect(buildAssistArgs({ promptBody: 'hi', sessionId: null })).toEqual(['--prompt', 'hi']);
  });
  it('resume turn appends --resume', () => {
    expect(buildAssistArgs({ promptBody: 'hi', sessionId: 'sess-1' })).toEqual([
      '--prompt',
      'hi',
      '--resume',
      'sess-1'
    ]);
  });
  it('appends --model when set', () => {
    expect(buildAssistArgs({ promptBody: 'hi', sessionId: null, model: 'opus' })).toEqual([
      '--prompt',
      'hi',
      '--model',
      'opus'
    ]);
  });
});

describe('parseRuneSessionId', () => {
  it('extracts the session id line', () => {
    expect(parseRuneSessionId('noise\nsession-id: abc_123-XYZ\nmore')).toBe('abc_123-XYZ');
  });
  it('returns null when absent', () => {
    expect(parseRuneSessionId('no marker here')).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/main/rune-assist/__tests__/rune-file-chat-service.test.ts`
Expected: FAIL — cannot find module `../rune-file-chat-service`.

- [ ] **Step 3: Write the helpers (minimal)**

Create `src/main/rune-assist/rune-file-chat-service.ts` with just the helpers for now:

```typescript
import type { RuneAssistMode, RuneAssistSelection } from '../../shared/ipc-api';

/** Read-only guardrail injected ahead of the user's text in Ask mode. */
export const ASK_MODE_PREAMBLE =
  'Answer only. Do not edit files, write files, or run commands that modify the ' +
  'workspace. Read and explain.';

export function buildContextLine(
  contextFile: string | undefined,
  selection: RuneAssistSelection | null | undefined
): string {
  if (!contextFile) return '';
  if (selection) {
    return `[context: file ${contextFile}, lines ${selection.fromLine}-${selection.toLine} selected]\n`;
  }
  return `[context: file ${contextFile}]\n`;
}

export function composeAssistPrompt(input: {
  text: string;
  mode: RuneAssistMode;
  contextFile?: string;
  selection?: RuneAssistSelection | null;
}): string {
  const ctx = buildContextLine(input.contextFile, input.selection);
  const preamble = input.mode === 'ask' ? `${ASK_MODE_PREAMBLE}\n\n` : '';
  return `${ctx}${preamble}${input.text}`;
}

export function buildAssistArgs(input: {
  promptBody: string;
  sessionId: string | null;
  model?: string;
}): string[] {
  const args = ['--prompt', input.promptBody];
  if (input.sessionId) args.push('--resume', input.sessionId);
  if (input.model) args.push('--model', input.model);
  return args;
}

export function parseRuneSessionId(output: string): string | null {
  return /^session-id: ([A-Za-z0-9_-]+)$/m.exec(output)?.[1] ?? null;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/main/rune-assist/__tests__/rune-file-chat-service.test.ts`
Expected: PASS (all 10 assertions).

- [ ] **Step 5: Commit**

```bash
git add src/main/rune-assist/
git commit -m "feat(rune-assist): prompt/args/session-id helpers"
```

---

## Task 3: `RuneFileChatService` class

Clone the runtime behavior of `PmChatService` (`src/main/kanban/pm-chat-service.ts`): one in-flight turn per cwd, stdout/stderr tail capped at 64KB, turn timeout, auth-failure classification, ENOENT → not-installed message, persisted cwd→sessionId, transcript read back via `readRuneSession`. Add a `stop(cwd)`.

**Files:**
- Modify: `src/main/rune-assist/rune-file-chat-service.ts`
- Test: `src/main/rune-assist/__tests__/rune-file-chat-service.test.ts`

- [ ] **Step 1: Add the failing test (spawn mocked)**

Append to the test file. Mock `child_process.spawn` the way `kanban-spawn-worker.test.ts` does. Add at the top of the file:

```typescript
import { EventEmitter } from 'events';
import { vi } from 'vitest';

const spawnMock = vi.fn();
vi.mock('child_process', () => ({ spawn: (...a: unknown[]) => spawnMock(...a) }));
vi.mock('../../sessions/rune-source', () => ({
  readRuneSession: vi.fn(async () => ({ messages: [{ role: 'assistant', blocks: [] }] }))
}));

function fakeChild() {
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
    kill: ReturnType<typeof vi.fn>;
    pid: number;
  };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = vi.fn();
  child.pid = 4242;
  return child;
}
```

Then add this describe block:

```typescript
describe('RuneFileChatService', () => {
  it('first send spawns rune --prompt with cwd, captures session id, emits idle', async () => {
    const { RuneFileChatService } = await import('../rune-file-chat-service');
    const child = fakeChild();
    spawnMock.mockReturnValue(child);

    const statuses: string[] = [];
    const svc = new RuneFileChatService({
      sessionsDir: '/tmp/does-not-matter',
      emitStatus: (p) => statuses.push(p.status),
      emitTranscript: vi.fn()
    });

    svc.sendMessage({ cwd: '/repo', text: 'hi', mode: 'agent' });

    expect(spawnMock).toHaveBeenCalledTimes(1);
    const [cmd, args, opts] = spawnMock.mock.calls[0];
    expect(cmd).toBe('rune');
    expect(args).toEqual(['--prompt', '[context: file undefined]\nhi'.replace('[context: file undefined]\n', '')]);
    expect(opts.cwd).toBe('/repo');

    child.stdout.emit('data', Buffer.from('session-id: sess-9\n'));
    child.emit('exit', 0, null);
    await new Promise((r) => setTimeout(r, 0));

    expect(statuses).toEqual(['thinking', 'idle']);
    const state = await svc.getState('/repo');
    expect(state.messages.length).toBe(1);
  });

  it('rejects a second send while one is in flight', () => {
    const { RuneFileChatService } = require('../rune-file-chat-service');
    spawnMock.mockReturnValue(fakeChild());
    const svc = new RuneFileChatService({
      sessionsDir: '/tmp/x',
      emitStatus: vi.fn(),
      emitTranscript: vi.fn()
    });
    svc.sendMessage({ cwd: '/repo', text: 'one', mode: 'agent' });
    expect(() => svc.sendMessage({ cwd: '/repo', text: 'two', mode: 'agent' })).toThrow();
  });

  it('stop() kills the in-flight child', () => {
    const { RuneFileChatService } = require('../rune-file-chat-service');
    const child = fakeChild();
    spawnMock.mockReturnValue(child);
    const svc = new RuneFileChatService({
      sessionsDir: '/tmp/x',
      emitStatus: vi.fn(),
      emitTranscript: vi.fn()
    });
    svc.sendMessage({ cwd: '/repo', text: 'go', mode: 'agent' });
    svc.stop('/repo');
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
  });
});
```

> Note: the first test's `args` assertion is awkward because `contextFile` is undefined. Simplify it to: `expect(args[0]).toBe('--prompt'); expect(args[1]).toBe('hi');` — when no `contextFile` is passed, `composeAssistPrompt` yields just `'hi'`. Use that simpler form.

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/main/rune-assist/__tests__/rune-file-chat-service.test.ts`
Expected: FAIL — `RuneFileChatService` is not exported.

- [ ] **Step 3: Implement the class**

Append to `src/main/rune-assist/rune-file-chat-service.ts` (the helpers stay at the top of the file):

```typescript
import { spawn, type ChildProcess } from 'child_process';
import { mkdirSync, writeFileSync, readFileSync, renameSync } from 'fs';
import { join } from 'path';
import { z } from 'zod';
import { createLogger } from '../logger';
import { CodedError } from '../errors';
import { RUNE_NOT_INSTALLED_MESSAGE } from '../../shared/rune';
import { isAuthFailureText } from '../kanban/spawn-worker';
import { readRuneSession } from '../sessions/rune-source';
import type { TranscriptMessage } from '../../shared/sessions';
import type {
  RuneAssistSendRequest,
  RuneAssistState,
  RuneAssistStatusPayload,
  RuneAssistTranscriptPayload
} from '../../shared/ipc-api';

const log = createLogger('rune-assist');
const TURN_TIMEOUT_MS = 5 * 60 * 1000;
const OUTPUT_CAP = 64 * 1024;
const sessionsFileSchema = z.record(z.string(), z.string());

interface Conversation {
  sessionId: string | null;
  inFlight: boolean;
  error: string | null;
  child?: ChildProcess;
}

export interface RuneFileChatServiceOptions {
  /** Directory holding the persisted cwd→sessionId map (e.g. app userData). */
  sessionsDir: string;
  emitStatus: (payload: RuneAssistStatusPayload) => void;
  emitTranscript: (payload: RuneAssistTranscriptPayload) => void;
}

export class RuneFileChatService {
  private convos = new Map<string, Conversation>();
  private opts: RuneFileChatServiceOptions;
  private loaded = false;

  constructor(opts: RuneFileChatServiceOptions) {
    this.opts = opts;
  }

  dispose(): void {
    for (const c of this.convos.values()) c.child?.kill('SIGTERM');
  }

  private sessionsPath(): string {
    return join(this.opts.sessionsDir, 'rune-assist-sessions.json');
  }

  private convo(cwd: string): Conversation {
    if (!this.loaded) {
      this.loaded = true;
      try {
        const raw = sessionsFileSchema.parse(JSON.parse(readFileSync(this.sessionsPath(), 'utf-8')));
        for (const [k, v] of Object.entries(raw)) {
          this.convos.set(k, { sessionId: v, inFlight: false, error: null });
        }
      } catch {
        // first run / unreadable
      }
    }
    let c = this.convos.get(cwd);
    if (!c) {
      c = { sessionId: null, inFlight: false, error: null };
      this.convos.set(cwd, c);
    }
    return c;
  }

  private persist(): void {
    const data: Record<string, string> = {};
    for (const [k, c] of this.convos) if (c.sessionId) data[k] = c.sessionId;
    mkdirSync(this.opts.sessionsDir, { recursive: true });
    const path = this.sessionsPath();
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, JSON.stringify(data, null, 2));
    renameSync(tmp, path);
  }

  async getState(cwd: string): Promise<RuneAssistState> {
    const c = this.convo(cwd);
    return { cwd, inFlight: c.inFlight, error: c.error, messages: await this.readMessages(c.sessionId) };
  }

  reset(cwd: string): void {
    const c = this.convo(cwd);
    if (c.inFlight) throw new CodedError('wait for rune to finish first', 'BAD_REQUEST');
    c.sessionId = null;
    c.error = null;
    this.persist();
  }

  stop(cwd: string): void {
    this.convo(cwd).child?.kill('SIGTERM');
  }

  sendMessage(req: RuneAssistSendRequest): void {
    const body = composeAssistPrompt(req).trim();
    if (body === '') throw new CodedError('message is empty', 'BAD_REQUEST');
    const c = this.convo(req.cwd);
    if (c.inFlight) throw new CodedError('rune is still responding', 'BAD_REQUEST');
    c.inFlight = true;
    c.error = null;
    this.opts.emitStatus({ cwd: req.cwd, status: 'thinking' });

    const args = buildAssistArgs({ promptBody: body, sessionId: c.sessionId, model: req.model });
    const child = spawn('rune', args, { cwd: req.cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    c.child = child;

    let output = '';
    let sessionId = c.sessionId;
    const collect = (chunk: Buffer): void => {
      output = (output + chunk.toString('utf-8')).slice(-OUTPUT_CAP);
      if (!sessionId) sessionId = parseRuneSessionId(output);
    };
    child.stdout?.on('data', collect);
    child.stderr?.on('data', collect);

    let finished = false;
    const finish = (error: string | null): void => {
      if (finished) return;
      finished = true;
      clearTimeout(timeout);
      c.inFlight = false;
      c.child = undefined;
      c.error = error;
      if (sessionId && sessionId !== c.sessionId) {
        c.sessionId = sessionId;
        this.persist();
      }
      void this.readMessages(c.sessionId).then((messages) => {
        if (messages.length > 0) this.opts.emitTranscript({ cwd: req.cwd, messages });
        this.opts.emitStatus(
          error ? { cwd: req.cwd, status: 'error', error } : { cwd: req.cwd, status: 'idle' }
        );
      });
    };

    const timeout = setTimeout(() => {
      log.warn('rune assist turn timed out; killing', { cwd: req.cwd, pid: child.pid });
      child.kill('SIGTERM');
    }, TURN_TIMEOUT_MS);

    child.on('error', (err: NodeJS.ErrnoException) => {
      finish(err.code === 'ENOENT' ? RUNE_NOT_INSTALLED_MESSAGE : err.message);
    });
    child.on('exit', (code, signal) => {
      if (code === 0) return finish(null);
      if (signal) return finish('the rune run was interrupted; try again');
      if (isAuthFailureText(output)) {
        return finish('rune authentication failed — fix the provider credentials (e.g. `rune login`) and retry');
      }
      const lastLine = output.split('\n').map((l) => l.trim()).filter(Boolean).pop();
      finish(lastLine ? lastLine.slice(0, 300) : `the rune run failed (exit ${code ?? '?'})`);
    });
  }

  private async readMessages(sessionId: string | null): Promise<TranscriptMessage[]> {
    if (!sessionId) return [];
    const transcript = await readRuneSession(sessionId);
    return transcript?.messages ?? [];
  }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/main/rune-assist/__tests__/rune-file-chat-service.test.ts`
Expected: PASS. If `isAuthFailureText` import path differs, confirm it is exported from `src/main/kanban/spawn-worker.ts` (it is, per the PM chat service which imports it the same way).

- [ ] **Step 5: Typecheck + commit**

Run: `npm run typecheck`
Expected: PASS

```bash
git add src/main/rune-assist/
git commit -m "feat(rune-assist): RuneFileChatService (spawn, resume, stop, persist)"
```

---

## Task 4: Wire service + IPC handlers into main

**Files:**
- Modify: `src/main/index.ts`

- [ ] **Step 1: Import and construct the service**

Near the top imports of `src/main/index.ts` add:

```typescript
import { RuneFileChatService } from './rune-assist/rune-file-chat-service';
```

Find where `pmChat` is constructed (around line 1133). After that block, add (use the same `mainWindow` guard pattern and `app.getPath('userData')` for the sessions dir):

```typescript
const runeAssist = new RuneFileChatService({
  sessionsDir: app.getPath('userData'),
  emitStatus: (payload) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send(IPC_CHANNELS.RUNE_ASSIST_STATUS, payload);
    }
  },
  emitTranscript: (payload) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send(IPC_CHANNELS.RUNE_ASSIST_TRANSCRIPT, payload);
    }
  }
});
```

Ensure `app` and `IPC_CHANNELS` are already imported in this file (they are).

- [ ] **Step 2: Register IPC handlers**

In the same file, where other `ipcMain.handle(...)` calls live (search for an existing `ipcMain.handle(IPC_CHANNELS.` block, e.g. near app-level handlers), add:

```typescript
ipcMain.handle(IPC_CHANNELS.RUNE_ASSIST_SEND, (_e, req: RuneAssistSendRequest) => {
  runeAssist.sendMessage(req);
});
ipcMain.handle(IPC_CHANNELS.RUNE_ASSIST_STATE, async (_e, cwd: string) => runeAssist.getState(cwd));
ipcMain.handle(IPC_CHANNELS.RUNE_ASSIST_RESET, (_e, cwd: string) => runeAssist.reset(cwd));
ipcMain.handle(IPC_CHANNELS.RUNE_ASSIST_STOP, (_e, cwd: string) => runeAssist.stop(cwd));
```

Add `RuneAssistSendRequest` to the existing type import from `'../shared/ipc-api'` (or add an import if none exists).

- [ ] **Step 3: Dispose on shutdown**

Find where `pmChat.dispose()` or other cleanup runs on app quit / `before-quit`. Add alongside it:

```typescript
runeAssist.dispose();
```

- [ ] **Step 4: Typecheck**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/main/index.ts
git commit -m "feat(rune-assist): construct service + register IPC handlers"
```

---

## Task 5: Preload exposure

**Files:**
- Modify: `src/preload/index.ts`

- [ ] **Step 1: Add the `runeAssist` API**

Find the PM chat preload block (`pmSend`, `pmState`, `onPmStatus`, around line 639). Mirror its `typedInvoke` / `onChannel` helpers. Add a new namespaced object on `window.fleet` (place it as a top-level key `runeAssist`, alongside `kanban`):

```typescript
runeAssist: {
  send: async (req: RuneAssistSendRequest): Promise<void> =>
    typedInvoke<void>(IPC_CHANNELS.RUNE_ASSIST_SEND, req),
  state: async (cwd: string): Promise<RuneAssistState> =>
    typedInvoke<RuneAssistState>(IPC_CHANNELS.RUNE_ASSIST_STATE, cwd),
  reset: async (cwd: string): Promise<void> =>
    typedInvoke<void>(IPC_CHANNELS.RUNE_ASSIST_RESET, cwd),
  stop: async (cwd: string): Promise<void> =>
    typedInvoke<void>(IPC_CHANNELS.RUNE_ASSIST_STOP, cwd),
  onStatus: (cb: (p: RuneAssistStatusPayload) => void): Unsubscribe =>
    onChannel<RuneAssistStatusPayload>(IPC_CHANNELS.RUNE_ASSIST_STATUS, cb),
  onTranscript: (cb: (p: RuneAssistTranscriptPayload) => void): Unsubscribe =>
    onChannel<RuneAssistTranscriptPayload>(IPC_CHANNELS.RUNE_ASSIST_TRANSCRIPT, cb)
},
```

Add the four `RuneAssist*` types to the existing import from `'../shared/ipc-api'`. `Unsubscribe`, `typedInvoke`, `onChannel` are already defined in this file (used by PM chat).

- [ ] **Step 2: Update the renderer's window typing**

Find the `window.fleet` type declaration the renderer uses (search for `pmState` in `src/preload/index.ts` or a `.d.ts`; the PM API type lives in the same `FleetApi`-style interface in this file). Add the `runeAssist` member with the same method signatures so `window.fleet.runeAssist` is typed in the renderer.

- [ ] **Step 3: Typecheck (both projects)**

Run: `npm run typecheck`
Expected: PASS (`typecheck:node` covers preload, `typecheck:web` covers renderer usage).

- [ ] **Step 4: Commit**

```bash
git add src/preload/index.ts
git commit -m "feat(rune-assist): expose window.fleet.runeAssist"
```

---

## Task 6: Editor-context registry

A module-level registry (clone of `file-save-registry.ts`) letting the panel read the active pane's selection and trigger a reload-from-disk at send-time only.

**Files:**
- Create: `src/renderer/src/lib/editor-context-registry.ts`
- Test: `src/renderer/src/lib/__tests__/editor-context-registry.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect } from 'vitest';
import {
  registerEditorHandle,
  unregisterEditorHandle,
  getEditorHandle
} from '../editor-context-registry';

describe('editor-context-registry', () => {
  it('registers, reads, and unregisters a handle', () => {
    const handle = { getSelection: () => ({ fromLine: 1, toLine: 2 }), reloadFromDisk: async () => true };
    registerEditorHandle('pane-1', handle);
    expect(getEditorHandle('pane-1')).toBe(handle);
    unregisterEditorHandle('pane-1');
    expect(getEditorHandle('pane-1')).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/renderer/src/lib/__tests__/editor-context-registry.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `src/renderer/src/lib/editor-context-registry.ts`:

```typescript
import type { RuneAssistSelection } from '../../../shared/ipc-api';

/** What an open file editor pane exposes to the Rune assist panel. */
export type EditorHandle = {
  /** 1-based inclusive selected line range, or null when there's no selection. */
  getSelection: () => RuneAssistSelection | null;
  /** Re-read the file from disk; replace the doc and flash changed lines. Returns true if content changed. */
  reloadFromDisk: () => Promise<boolean>;
};

const registry = new Map<string, EditorHandle>();

export function registerEditorHandle(paneId: string, handle: EditorHandle): void {
  registry.set(paneId, handle);
}
export function unregisterEditorHandle(paneId: string): void {
  registry.delete(paneId);
}
export function getEditorHandle(paneId: string): EditorHandle | undefined {
  return registry.get(paneId);
}
export function getAllEditorHandles(): Map<string, EditorHandle> {
  return registry;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/renderer/src/lib/__tests__/editor-context-registry.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/lib/editor-context-registry.ts src/renderer/src/lib/__tests__/editor-context-registry.test.ts
git commit -m "feat(rune-assist): editor-context registry"
```

---

## Task 7: FileEditorPane — selection getter, reload, line flash

Wire `FileEditorPane` into the registry: expose the current selection as 1-based line numbers, and a `reloadFromDisk` that re-reads the file, replaces the CodeMirror doc if it differs, and flashes the changed lines.

**Files:**
- Modify: `src/renderer/src/components/FileEditorPane.tsx`
- Test: `src/renderer/src/components/rune-assist/__tests__/transcript-helpers.test.ts` (the diff helper lives there; see Step 1)

- [ ] **Step 1: Write a failing test for the changed-line range helper**

Create `src/renderer/src/components/rune-assist/transcript-helpers.ts` will hold transcript helpers (Task 8). The line-diff helper belongs with the editor; put it in a small pure module. Create `src/renderer/src/lib/__tests__/line-diff.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { changedLineRange } from '../line-diff';

describe('changedLineRange', () => {
  it('returns null when identical', () => {
    expect(changedLineRange('a\nb\nc', 'a\nb\nc')).toBeNull();
  });
  it('finds the first and last differing line (1-based)', () => {
    // line 2 changed
    expect(changedLineRange('a\nb\nc', 'a\nX\nc')).toEqual({ fromLine: 2, toLine: 2 });
  });
  it('spans an inserted block', () => {
    expect(changedLineRange('a\nb', 'a\nNEW\nb')).toEqual({ fromLine: 2, toLine: 3 });
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/renderer/src/lib/__tests__/line-diff.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the helper**

Create `src/renderer/src/lib/line-diff.ts`:

```typescript
import type { RuneAssistSelection } from '../../../shared/ipc-api';

/**
 * Crude line-level diff: the first and last line indices that differ between
 * old and new text, as a 1-based inclusive range over the NEW text. Returns
 * null when the texts are identical. Good enough to flash "what rune changed".
 */
export function changedLineRange(oldText: string, newText: string): RuneAssistSelection | null {
  if (oldText === newText) return null;
  const a = oldText.split('\n');
  const b = newText.split('\n');
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length - 1;
  let endB = b.length - 1;
  while (endB > start - 1 && endA > start - 1 && a[endA] === b[endB]) {
    endA--;
    endB--;
  }
  const fromLine = start + 1;
  const toLine = Math.max(start, endB) + 1;
  return { fromLine, toLine };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/renderer/src/lib/__tests__/line-diff.test.ts`
Expected: PASS

- [ ] **Step 5: Add the CodeMirror flash extension + registry wiring to FileEditorPane**

In `src/renderer/src/components/FileEditorPane.tsx`:

Add imports at the top:

```typescript
import { StateEffect, StateField, RangeSetBuilder } from '@codemirror/state';
import { Decoration, type DecorationSet } from '@codemirror/view';
import {
  registerEditorHandle,
  unregisterEditorHandle
} from '../lib/editor-context-registry';
import { changedLineRange } from '../lib/line-diff';
```

> Note: `EditorView` and `keymap` etc. are already imported. `RangeSetBuilder` is from `@codemirror/state`.

Above the component, add a flash decoration field:

```typescript
const setFlash = StateEffect.define<{ from: number; to: number } | null>();
const flashLine = Decoration.line({ attributes: { class: 'cm-rune-flash' } });

const flashField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(deco, tr) {
    deco = deco.map(tr.changes);
    for (const e of tr.effects) {
      if (e.is(setFlash)) {
        if (!e.value) return Decoration.none;
        const builder = new RangeSetBuilder<Decoration>();
        for (let ln = e.value.from; ln <= e.value.to; ln++) {
          if (ln < 1 || ln > tr.state.doc.lines) continue;
          builder.add(tr.state.doc.line(ln).from, tr.state.doc.line(ln).from, flashLine);
        }
        return builder.finish();
      }
    }
    return deco;
  },
  provide: (f) => EditorView.decorations.from(f)
});
```

Add `flashField` to the editor's `extensions` array (anywhere in the list created in the `EditorState.create({ ... extensions: [...] })` call).

Add the `.cm-rune-flash` style to the `EditorView.theme({...})` block already present:

```typescript
'.cm-rune-flash': { backgroundColor: 'rgba(152, 195, 121, 0.18)', transition: 'background-color 1.5s ease-out' },
```

After the editor `view` is created (in the same `useEffect` where `viewRef.current = view`), register the handle:

```typescript
registerEditorHandle(paneId, {
  getSelection: () => {
    const v = viewRef.current;
    if (!v) return null;
    const sel = v.state.selection.main;
    if (sel.empty) return null;
    return {
      fromLine: v.state.doc.lineAt(sel.from).number,
      toLine: v.state.doc.lineAt(sel.to).number
    };
  },
  reloadFromDisk: async () => {
    const v = viewRef.current;
    if (!v) return false;
    const result = await window.fleet.file.read(filePath);
    if (!result.success || !result.data) return false;
    const next = result.data.content;
    const current = v.state.doc.toString();
    if (next === current) return false;
    const range = changedLineRange(current, next);
    v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: next } });
    savedContentRef.current = next;
    if (range) {
      v.dispatch({ effects: setFlash.of({ from: range.fromLine, to: range.toLine }) });
      setTimeout(() => viewRef.current?.dispatch({ effects: setFlash.of(null) }), 1600);
    }
    return true;
  }
});
```

In the existing cleanup `return () => { ... view.destroy(); ... }` of that effect, add:

```typescript
unregisterEditorHandle(paneId);
```

- [ ] **Step 6: Typecheck**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add src/renderer/src/lib/line-diff.ts src/renderer/src/lib/__tests__/line-diff.test.ts src/renderer/src/components/FileEditorPane.tsx
git commit -m "feat(rune-assist): editor selection getter + reload-with-flash"
```

---

## Task 8: Transcript helpers (text, tool cards, reasoning)

Pure functions that turn `TranscriptMessage[]` into render-ready pieces: plain answer text, collapsible tool-call cards, and (conditionally) reasoning text.

**Files:**
- Create: `src/renderer/src/components/rune-assist/transcript-helpers.ts`
- Test: `src/renderer/src/components/rune-assist/__tests__/transcript-helpers.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect } from 'vitest';
import { messageText, toolCards } from '../transcript-helpers';
import type { TranscriptMessage } from '../../../../../shared/sessions';

const msg: TranscriptMessage = {
  role: 'assistant',
  blocks: [
    { type: 'tool_use', name: 'read_file', argsPreview: 'auth.ts' },
    { type: 'text', text: 'Done — added jwtVerify.' }
  ]
};

describe('transcript-helpers', () => {
  it('messageText concatenates text blocks', () => {
    expect(messageText(msg)).toBe('Done — added jwtVerify.');
  });
  it('toolCards lists tool_use blocks with name + args', () => {
    expect(toolCards(msg)).toEqual([{ name: 'read_file', args: 'auth.ts' }]);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/renderer/src/components/rune-assist/__tests__/transcript-helpers.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `src/renderer/src/components/rune-assist/transcript-helpers.ts`:

```typescript
import type { TranscriptMessage } from '../../../../shared/sessions';

export type ToolCard = { name: string; args: string };

export function messageText(m: TranscriptMessage): string {
  return m.blocks
    .filter((b): b is Extract<typeof b, { type: 'text' }> => b.type === 'text')
    .map((b) => b.text)
    .join('')
    .trim();
}

export function toolCards(m: TranscriptMessage): ToolCard[] {
  return m.blocks
    .filter((b): b is Extract<typeof b, { type: 'tool_use' }> => b.type === 'tool_use')
    .map((b) => ({ name: b.name, args: b.argsPreview }));
}
```

> Reasoning blocks: `TranscriptBlock` (in `src/shared/sessions.ts`) currently has no `thinking`/`reasoning` variant. Before building the reasoning UI in Task 9, grep the Rune session JSON via `readRuneSession` output for a reasoning/thinking block type. If present, add a `reasoningText(m)` helper here and a `{ type: 'thinking'; text: string }` variant to `TranscriptBlock` + its mapping in `src/main/sessions/rune-source.ts`. If absent, the collapsible reasoning block renders nothing — note this in the commit and move on (matches the spec's open question).

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/renderer/src/components/rune-assist/__tests__/transcript-helpers.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/components/rune-assist/transcript-helpers.ts src/renderer/src/components/rune-assist/__tests__/transcript-helpers.test.ts
git commit -m "feat(rune-assist): transcript render helpers"
```

---

## Task 9: Renderer store (state, events, queue)

Zustand store mirroring `pm-chat-store.ts`, plus a renderer-side message queue (queue-while-running) and a post-turn reload trigger.

**Files:**
- Create: `src/renderer/src/store/rune-assist-store.ts`

- [ ] **Step 1: Implement the store**

Create `src/renderer/src/store/rune-assist-store.ts`:

```typescript
import { create } from 'zustand';
import type {
  RuneAssistMode,
  RuneAssistSelection,
  RuneAssistState as IpcState
} from '../../../shared/ipc-api';
import type { TranscriptMessage } from '../../../shared/sessions';
import { getAllEditorHandles } from '../lib/editor-context-registry';

type QueuedSend = {
  text: string;
  mode: RuneAssistMode;
  contextFile?: string;
  selection?: RuneAssistSelection | null;
  model?: string;
};

type RuneAssistStore = {
  panelOpen: boolean;
  cwd: string | null;
  mode: RuneAssistMode;
  status: 'idle' | 'thinking' | 'error';
  error: string | null;
  messages: TranscriptMessage[];
  lastSend: QueuedSend | null; // for Retry
  queue: QueuedSend[];

  togglePanel: () => void;
  setMode: (m: RuneAssistMode) => void;
  setCwd: (cwd: string) => Promise<void>;
  send: (s: QueuedSend) => Promise<void>;
  retry: () => Promise<void>;
  stop: () => Promise<void>;
  reset: () => Promise<void>;
  applyStatus: (status: 'idle' | 'thinking' | 'error', error?: string) => void;
  applyTranscript: (messages: TranscriptMessage[]) => void;
};

export const useRuneAssistStore = create<RuneAssistStore>((set, get) => ({
  panelOpen: false,
  cwd: null,
  mode: 'agent',
  status: 'idle',
  error: null,
  messages: [],
  lastSend: null,
  queue: [],

  togglePanel: () => set((s) => ({ panelOpen: !s.panelOpen })),
  setMode: (mode) => set({ mode }),

  setCwd: async (cwd) => {
    if (get().cwd === cwd) return;
    set({ cwd, messages: [], status: 'idle', error: null });
    const state: IpcState = await window.fleet.runeAssist.state(cwd);
    if (get().cwd === cwd) {
      set({ messages: state.messages, status: state.inFlight ? 'thinking' : 'idle', error: state.error });
    }
  },

  send: async (s) => {
    const { cwd, status } = get();
    if (!cwd) return;
    if (status === 'thinking') {
      set((st) => ({ queue: [...st.queue, s] }));
      return;
    }
    set({ status: 'thinking', error: null, lastSend: s });
    await window.fleet.runeAssist.send({ cwd, ...s });
  },

  retry: async () => {
    const last = get().lastSend;
    if (last) await get().send(last);
  },

  stop: async () => {
    const { cwd } = get();
    if (cwd) await window.fleet.runeAssist.stop(cwd);
  },

  reset: async () => {
    const { cwd } = get();
    if (!cwd) return;
    await window.fleet.runeAssist.reset(cwd);
    set({ messages: [], status: 'idle', error: null, queue: [] });
  },

  applyStatus: (status, error) => set({ status, error: error ?? null }),

  applyTranscript: (messages) => {
    set({ messages });
    // After a turn lands, reload any open editor panes (auto-reload + flash).
    for (const handle of getAllEditorHandles().values()) void handle.reloadFromDisk();
    // Drain one queued message if idle.
    const { queue } = get();
    if (queue.length > 0) {
      const [next, ...rest] = queue;
      set({ queue: rest });
      void get().send(next);
    }
  }
}));
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/renderer/src/store/rune-assist-store.ts
git commit -m "feat(rune-assist): renderer store with queue + reload trigger"
```

---

## Task 10: `RuneAssistPanel` component

The docked panel: header (label, reset), transcript (answer text + collapsible tool cards), composer (context chips, Ask/Agent toggle, slash commands, Send/Stop/Retry).

**Files:**
- Create: `src/renderer/src/components/rune-assist/RuneAssistPanel.tsx`

- [ ] **Step 1: Implement the component**

Create `src/renderer/src/components/rune-assist/RuneAssistPanel.tsx`. Follow `PmChatPanel.tsx` for styling/structure (fixed right-dock, dark theme classes). Key behaviors: subscribe to `onStatus`/`onTranscript` filtered by `cwd`; render messages with `messageText` + collapsible `toolCards`; composer with mode toggle, model input, Send (Enter), Stop (while thinking), Retry (on error), `/` slash-command expansion.

```tsx
import { useEffect, useRef, useState } from 'react';
import { Bot, ChevronRight, X } from 'lucide-react';
import { useRuneAssistStore } from '../../store/rune-assist-store';
import { messageText, toolCards } from './transcript-helpers';

type Props = {
  cwd: string;
  contextFile?: string;
  /** Reads the active pane's current selection at send-time. */
  getSelection: () => { fromLine: number; toLine: number } | null;
};

const SLASH: Record<string, string> = {
  '/explain': 'Explain what this code does.',
  '/fix': 'Find and fix the bug in this code.',
  '/tests': 'Write tests for this code.'
};

export function RuneAssistPanel({ cwd, contextFile, getSelection }: Props): React.JSX.Element {
  const {
    mode, status, error, messages, queue,
    setCwd, setMode, send, retry, stop, reset, applyStatus, applyTranscript
  } = useRuneAssistStore();
  const [text, setText] = useState('');
  const [selDropped, setSelDropped] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => { void setCwd(cwd); }, [cwd, setCwd]);

  useEffect(() => {
    const offStatus = window.fleet.runeAssist.onStatus((p) => {
      if (p.cwd === cwd) applyStatus(p.status, p.error);
    });
    const offTranscript = window.fleet.runeAssist.onTranscript((p) => {
      if (p.cwd === cwd) applyTranscript(p.messages);
    });
    return () => { offStatus(); offTranscript(); };
  }, [cwd, applyStatus, applyTranscript]);

  const submit = (): void => {
    const raw = text.trim();
    if (!raw) return;
    const body = SLASH[raw] ?? raw;
    void send({
      text: body,
      mode,
      contextFile,
      selection: selDropped ? null : getSelection()
    });
    setText('');
    setSelDropped(false);
  };

  const selection = selDropped ? null : getSelection();

  return (
    <div className="fixed bottom-0 top-9 right-0 z-30 flex w-[380px] flex-col border-l border-neutral-800 bg-neutral-950 text-sm text-neutral-200">
      {/* header */}
      <div className="flex items-center gap-2 border-b border-neutral-800 px-3 py-2">
        <Bot size={14} className="text-amber-400" />
        <span className="font-semibold">Rune</span>
        <button onClick={() => void reset()} className="ml-auto text-xs text-neutral-500 hover:text-neutral-300">
          New thread
        </button>
      </div>

      {/* transcript */}
      <div ref={scrollRef} className="flex-1 space-y-3 overflow-auto p-3">
        {messages.map((m, i) => {
          const cards = toolCards(m);
          const body = messageText(m);
          return (
            <div key={i} className={m.role === 'user' ? 'text-right' : ''}>
              {cards.length > 0 && (
                <details className="mb-1 rounded border border-neutral-800 bg-neutral-900 text-xs">
                  <summary className="cursor-pointer px-2 py-1 text-emerald-400">
                    {cards.length} step{cards.length > 1 ? 's' : ''}
                  </summary>
                  {cards.map((c, j) => (
                    <div key={j} className="border-t border-neutral-800 px-2 py-1 text-neutral-400">
                      {c.name} <span className="text-neutral-600">{c.args}</span>
                    </div>
                  ))}
                </details>
              )}
              {body && (
                <div className={`inline-block whitespace-pre-wrap rounded-lg px-3 py-2 ${
                  m.role === 'user' ? 'bg-neutral-800' : 'bg-neutral-900'
                }`}>
                  {body}
                </div>
              )}
            </div>
          );
        })}
        {status === 'thinking' && <div className="text-xs text-neutral-500">Thinking…</div>}
        {status === 'error' && error && (
          <div className="rounded border border-red-900 bg-red-950/40 px-2 py-1 text-xs text-red-300">
            {error}{' '}
            <button onClick={() => void retry()} className="underline">Retry</button>
          </div>
        )}
      </div>

      {/* composer */}
      <div className="border-t border-neutral-800 p-2">
        {/* context chips */}
        {contextFile && (
          <div className="mb-2 flex flex-wrap gap-1 text-xs">
            <span className="inline-flex items-center gap-1 rounded border border-neutral-700 bg-neutral-900 px-1.5 py-0.5">
              {contextFile.split('/').pop()}
              {selection && <span className="text-neutral-500">L{selection.fromLine}-{selection.toLine}</span>}
              <button onClick={() => setSelDropped(true)}><X size={10} /></button>
            </span>
          </div>
        )}
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); }
          }}
          placeholder="Ask or instruct…  (@ to add context, / for commands)"
          className="h-16 w-full resize-none rounded bg-neutral-900 p-2 text-sm outline-none"
        />
        <div className="mt-1 flex items-center gap-2 text-xs">
          <button
            onClick={() => setMode(mode === 'agent' ? 'ask' : 'agent')}
            className="rounded bg-neutral-800 px-2 py-0.5"
          >
            {mode === 'agent' ? 'Agent' : 'Ask'} ▾
          </button>
          {queue.length > 0 && <span className="text-neutral-500">{queue.length} queued</span>}
          {status === 'thinking' ? (
            <button onClick={() => void stop()} className="ml-auto rounded bg-neutral-800 px-3 py-0.5">
              ◼ Stop
            </button>
          ) : (
            <button onClick={submit} className="ml-auto rounded bg-neutral-700 px-3 py-0.5">
              Send ⏎
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
```

> `applyTranscript` already handles draining the queue and reloading editors (Task 9). `ChevronRight` import can be dropped if unused — remove any unused import before committing to satisfy lint.

- [ ] **Step 2: Typecheck + lint**

Run: `npm run typecheck && npm run lint`
Expected: PASS (remove unused imports if lint flags them).

- [ ] **Step 3: Commit**

```bash
git add src/renderer/src/components/rune-assist/RuneAssistPanel.tsx
git commit -m "feat(rune-assist): RuneAssistPanel UI"
```

---

## Task 11: Mount the panel + toggle button in App

Derive the active file path + workspace cwd from `workspace-store`, mount the panel, and add a toggle button.

**Files:**
- Modify: `src/renderer/src/App.tsx`

- [ ] **Step 1: Add a selector for the active file + cwd**

In `src/renderer/src/App.tsx`, import the store and registry helper:

```typescript
import { useRuneAssistStore } from './store/rune-assist-store';
import { RuneAssistPanel } from './components/rune-assist/RuneAssistPanel';
import { getEditorHandle } from './lib/editor-context-registry';
import { findLeaf } from './store/workspace-store'; // export it if not already (see Step 2)
```

Derive the active tab, active pane, file path, and cwd from the workspace store. Use the existing `useWorkspaceStore`. Compute inside the component body:

```typescript
const runeOpen = useRuneAssistStore((s) => s.panelOpen);
const toggleRune = useRuneAssistStore((s) => s.togglePanel);

const activeFile = useWorkspaceStore((s) => {
  const ws = s.workspaces.find((w) => w.id === s.activeWorkspaceId);
  const tab = ws?.tabs.find((t) => t.id === ws.activeTabId);
  if (!ws || !tab) return null;
  // activePaneId lives on Workspace (not Tab) — see src/shared/types.ts.
  const leaf = ws.activePaneId ? findLeaf(tab.splitRoot, ws.activePaneId) : null;
  const filePath = leaf?.paneType === 'file' || leaf?.paneType === 'markdown' ? leaf.filePath : undefined;
  return { cwd: tab.cwd, filePath, paneId: leaf?.id };
});
```

> Confirm the exact store field names (`workspaces`, `activeWorkspaceId`, `activeTabId`, `activePaneId`) against `src/renderer/src/store/workspace-store.ts`. The store tracks active tab/pane (lines ~192–201, 220–221). Adjust accessors to match (e.g. it may expose a `getActiveTab()` helper — prefer it if present).

- [ ] **Step 2: Export `findLeaf` from workspace-store**

In `src/renderer/src/store/workspace-store.ts`, the `findLeaf(node, paneId)` function exists (~line 352) but may be module-private. Add `export` to its declaration if it isn't already exported.

- [ ] **Step 3: Mount the panel + button**

Near the existing `<PaneGrid ... />` mount inside `<main>` (App.tsx ~line 949), add the panel as a sibling (it is fixed-position so placement in the tree is not layout-critical, but keep it inside the main app container):

```tsx
{runeOpen && activeFile && (
  <RuneAssistPanel
    cwd={activeFile.cwd}
    contextFile={activeFile.filePath}
    getSelection={() => (activeFile.paneId ? getEditorHandle(activeFile.paneId)?.getSelection() ?? null : null)}
  />
)}
```

Add a toggle button to the top chrome (near other top-bar buttons; search for an existing toolbar button cluster):

```tsx
<button
  onClick={toggleRune}
  className={`inline-flex items-center gap-1 rounded px-2 py-1 text-xs ${
    runeOpen ? 'bg-amber-700 text-white' : 'bg-neutral-800 text-neutral-200 hover:bg-neutral-700'
  }`}
  title="Ask Rune about the open file"
>
  <Bot size={12} /> Rune
</button>
```

Import `Bot` from `lucide-react` if not already imported in App.tsx.

- [ ] **Step 4: Typecheck + lint**

Run: `npm run typecheck && npm run lint`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/App.tsx src/renderer/src/store/workspace-store.ts
git commit -m "feat(rune-assist): mount panel + toggle in App"
```

---

## Task 12: Revert affordance (per-turn snapshot)

Snapshot the active file's on-disk content before an Agent-mode turn; expose a one-click Revert that writes the snapshot back (and reloads the pane).

**Files:**
- Modify: `src/renderer/src/store/rune-assist-store.ts`
- Modify: `src/renderer/src/components/rune-assist/RuneAssistPanel.tsx`

- [ ] **Step 1: Snapshot before an Agent send**

In `rune-assist-store.ts`, extend the store with `revert` state + action. Add to the store type:

```typescript
  snapshot: { file: string; content: string } | null;
  revert: () => Promise<void>;
```

In `send`, before calling `window.fleet.runeAssist.send`, when `s.mode === 'agent'` and `s.contextFile` is set, read and store the current content:

```typescript
let snapshot = null as RuneAssistStore['snapshot'];
if (s.mode === 'agent' && s.contextFile) {
  const r = await window.fleet.file.read(s.contextFile);
  if (r.success && r.data) snapshot = { file: s.contextFile, content: r.data.content };
}
set({ status: 'thinking', error: null, lastSend: s, snapshot });
```

Implement `revert`:

```typescript
revert: async () => {
  const snap = get().snapshot;
  if (!snap) return;
  await window.fleet.file.write(snap.file, snap.content);
  for (const h of getAllEditorHandles().values()) void h.reloadFromDisk();
  set({ snapshot: null });
}
```

Initialize `snapshot: null` in the store defaults.

- [ ] **Step 2: Add a Revert button after a turn**

In `RuneAssistPanel.tsx`, read `snapshot` and `revert` from the store, and render a small control under the transcript when `status === 'idle' && snapshot`:

```tsx
{status === 'idle' && useRuneAssistStore.getState().snapshot && (
  <button onClick={() => void revert()} className="text-xs text-amber-400 underline">
    Revert last change to {snapshot?.file.split('/').pop()}
  </button>
)}
```

> Prefer reading `snapshot`/`revert` via the destructured store hook (add them to the `useRuneAssistStore()` destructure at the top of the component) rather than `getState()` so the button re-renders correctly.

- [ ] **Step 3: Typecheck + lint**

Run: `npm run typecheck && npm run lint`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/renderer/src/store/rune-assist-store.ts src/renderer/src/components/rune-assist/RuneAssistPanel.tsx
git commit -m "feat(rune-assist): per-turn snapshot + revert"
```

---

## Task 13: Full verification + manual smoke

**Files:** none (verification only)

- [ ] **Step 1: Run the full test suite**

Run: `npx vitest run`
Expected: PASS (all new tests + existing suite green).

- [ ] **Step 2: Typecheck + lint + build**

Run: `npm run build`
Expected: PASS (build runs typecheck then electron-vite build).

- [ ] **Step 3: Manual smoke (documented, run by a human)**

In a dev run (`npm run dev`):
1. `fleet open src/main/index.ts` (or open any file) → file shows in a `FileEditorPane`.
2. Click the **Rune** toggle button → panel docks right.
3. **Ask mode:** select a function, type "what does this do?", Send → answer streams in; file is NOT modified.
4. **Agent mode:** type "add a doc comment to this function", Send → after the turn, the editor auto-reloads and the changed lines flash; a **Revert** control appears; clicking it restores the file.
5. Send a second message while one is in flight → it shows as "1 queued" and runs after.
6. With Rune not on PATH → the panel shows the not-installed message with a Settings hint.

- [ ] **Step 4: Final commit (if any cleanup)**

```bash
git add -A
git commit -m "chore(rune-assist): verification cleanup"
```

---

## Self-Review notes (for the implementer)

- **Spec coverage:** Ask/Agent (Tasks 2,9,10) · context chip + selection (Tasks 6,7,10,11) · `@`/slash (Task 10, slash done; `@`-mention picker is minimal in v1 — the chip + manual paths are covered, a full `@` picker can be a follow-up) · collapsible tool steps (Tasks 8,10) · collapsible reasoning (Task 8 note — conditional on Rune emitting reasoning) · streamed transcript + status (Tasks 3,9,10) · Stop/Retry (Tasks 3,9,10) · auto-reload + flash (Task 7) · Revert (Task 12) · humane errors (Task 3 classification + Task 10 display) · session persistence/resume (Task 3) · IPC surface (Tasks 1,4,5).
- **Deferred from spec (intentional):** full `@`-mention fuzzy picker, token/context indicator, multi-file review, per-hunk gate — all listed non-goals or follow-ups.
- **Open items to verify while building:** (a) `findLeaf` export + exact workspace-store active accessors (Task 11 Step 1–2); (b) Rune session JSON reasoning block presence (Task 8); (c) `isAuthFailureText` export from `spawn-worker.ts` (Task 3).
