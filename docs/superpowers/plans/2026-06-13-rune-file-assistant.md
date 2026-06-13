# Rune Quick-Assist Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A transient, summoned-at-cursor overlay that runs Rune on-demand against a `fleet open` file — auto-detecting Ask (read-only answer in a popover) vs Edit (writes to disk, then auto-reload + changed-line flash + one-click Revert), with a non-blocking "working" pill while Rune runs.

**Architecture:** The main-process / IPC / preload layers mirror the proven PM-chat stack: a `RuneFileChatService` (clone of `src/main/kanban/pm-chat-service.ts`, no kanban MCP) spawns `rune --prompt` / `--resume` in the workspace root, parses the session id from stdout, reads the transcript back via `readRuneSession`, and emits `status` + `result` events. The renderer is **not** a panel: an overlay/pill/popover layer is mounted **inside each file pane** (`FileEditorPane`), driven by a small zustand store keyed by pane id, and reconciles edits through a new `editor-context-registry` (sibling of `file-save-registry`). All pure logic lives in one tested shared module, `src/shared/rune-assist.ts`.

**Tech Stack:** Electron (main/preload/renderer), electron-vite, React + TypeScript, zustand, CodeMirror 6, vitest. Rune CLI (`rune` on PATH). Zod is used by existing IPC validation; new payload types are plain TS types matching the PM-chat convention (see Task 2). Project rule: **no unsafe `as` casts** in `src/` (tests may cast).

**Reference spec:** `docs/superpowers/specs/2026-06-13-rune-file-assistant-design.md`
**Branch:** `feat/rune-file-assistant` (already created)

---

## Concurrency model (read before starting)

A single Rune session per workspace **cannot** be `--resume`d by two turns at once without corrupting the session file. Therefore:

- The in-flight guard is **per workspace `cwd`** (exactly like PM chat's per-board guard), not literally per-pane.
- Each request carries the originating **`paneId`** so the renderer can route the working pill / answer / reload to the right pane.
- "Several files at once" means **across different workspace roots** (different `cwd`). Two file panes in the *same* workspace serialize: a second summon while that `cwd` is busy is **rejected** with a gentle inline note.

This tightens the spec's "per pane" wording to the only correct interpretation given Rune's resumable-session model. The spec already flags this in its Architecture "Keying" note.

## Intent detection (read before starting)

The renderer classifies intent locally with `detectIntent(text)`; the resulting `mode` is sent with the request and **selects the prompt preamble**:

- `'ask'` → a read-only preamble instructs Rune to answer without editing/writing.
- `'edit'` → no read-only preamble; Rune may write to disk.

A false **edit** (detected edit, user only wanted an answer) is recoverable via the changed-line flash + one-click Revert. A false **ask** (wanted an edit, classified ask) just requires rephrasing with a leading imperative. A future Rune-side read-only flag could harden Ask mode (spec open question) — not in v1.

## File structure

**Created:**
- `src/shared/rune-assist.ts` — pure helpers + constants (intent, prompt, args, parse, changed-file extraction, line-diff). Renderer-safe (no Node imports).
- `src/shared/__tests__/rune-assist.test.ts` — tests for the above.
- `src/main/rune-assist/rune-file-chat-service.ts` — the spawn/resume/stop service.
- `src/main/rune-assist/rune-assist-ipc.ts` — `registerRuneAssistIpc(service)`.
- `src/renderer/src/lib/editor-context-registry.ts` — per-pane `EditorHandle` registry.
- `src/renderer/src/lib/__tests__/editor-context-registry.test.ts` — tests for the registry.
- `src/renderer/src/store/rune-assist-store.ts` — zustand store keyed by pane id.
- `src/renderer/src/store/__tests__/rune-assist-store.test.ts` — store transition tests.
- `src/renderer/src/components/rune-assist/RuneAssistLayer.tsx` — host that renders overlay/pill/popover/revert for one pane.
- `src/renderer/src/components/rune-assist/RuneAssistOverlay.tsx` — the summoned input.
- `src/renderer/src/components/rune-assist/RuneWorkingPill.tsx` — inline working indicator.
- `src/renderer/src/components/rune-assist/RuneAnswerPopover.tsx` — one-shot Ask answer.

**Modified:**
- `src/shared/ipc-channels.ts` — add `RUNE_ASSIST_*` channels.
- `src/shared/ipc-api.ts` — add payload types.
- `src/main/index.ts` — construct service + emit callbacks + register IPC + dispose.
- `src/preload/index.ts` — add `runeAssist` namespace.
- `src/renderer/src/components/FileEditorPane.tsx` — register `EditorHandle`, add `Mod-i` keymap, mount `RuneAssistLayer`.

---

### Task 1: Shared pure helpers + tests

**Files:**
- Create: `src/shared/rune-assist.ts`
- Test: `src/shared/__tests__/rune-assist.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/shared/__tests__/rune-assist.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import {
  detectIntent,
  buildContextLine,
  composeAssistPrompt,
  buildAssistArgs,
  parseRuneSessionId,
  lastAssistantText,
  extractChangedFiles,
  changedLineRange,
  ASK_PREAMBLE
} from '../rune-assist';
import type { TranscriptMessage } from '../sessions';

describe('detectIntent', () => {
  it('classifies leading imperatives as edit', () => {
    expect(detectIntent('finish this function')).toBe('edit');
    expect(detectIntent('Refactor the loop')).toBe('edit');
    expect(detectIntent('  add a null guard')).toBe('edit');
  });
  it('classifies questions/everything else as ask', () => {
    expect(detectIntent('what does this do?')).toBe('ask');
    expect(detectIntent('where is validateToken used')).toBe('ask');
    expect(detectIntent('')).toBe('ask');
  });
});

describe('buildContextLine', () => {
  it('renders a selection range', () => {
    expect(buildContextLine('src/auth.ts', { fromLine: 11, toLine: 14 })).toBe(
      '[context: file src/auth.ts, lines 11-14 selected]'
    );
  });
  it('renders a single cursor line when from === to', () => {
    expect(buildContextLine('src/auth.ts', { fromLine: 12, toLine: 12 })).toBe(
      '[context: file src/auth.ts, line 12]'
    );
  });
  it('renders file only when no selection', () => {
    expect(buildContextLine('src/auth.ts', undefined)).toBe('[context: file src/auth.ts]');
  });
});

describe('composeAssistPrompt', () => {
  it('prepends the read-only preamble in ask mode', () => {
    const out = composeAssistPrompt('ask', '[context: file a.ts]', 'what is this');
    expect(out.startsWith(ASK_PREAMBLE)).toBe(true);
    expect(out).toContain('[context: file a.ts]');
    expect(out).toContain('what is this');
  });
  it('omits the preamble in edit mode', () => {
    const out = composeAssistPrompt('edit', '[context: file a.ts]', 'finish it');
    expect(out.startsWith(ASK_PREAMBLE)).toBe(false);
    expect(out).toBe('[context: file a.ts]\n\nfinish it');
  });
});

describe('buildAssistArgs', () => {
  it('builds prompt-only args on the first turn', () => {
    expect(buildAssistArgs('hello', null)).toEqual(['--prompt', 'hello']);
  });
  it('appends --resume when a session id exists', () => {
    expect(buildAssistArgs('hello', 'sess-1')).toEqual(['--prompt', 'hello', '--resume', 'sess-1']);
  });
});

describe('parseRuneSessionId', () => {
  it('extracts the id from a session-id line', () => {
    expect(parseRuneSessionId('blah\nsession-id: abc_DEF-123\nmore')).toBe('abc_DEF-123');
  });
  it('returns null when absent', () => {
    expect(parseRuneSessionId('no id here')).toBeNull();
  });
});

describe('lastAssistantText', () => {
  it('returns the concatenated text of the last assistant message', () => {
    const messages: TranscriptMessage[] = [
      { role: 'user', blocks: [{ type: 'text', text: 'q' }] },
      { role: 'assistant', blocks: [{ type: 'text', text: 'first' }] },
      { role: 'tool', blocks: [{ type: 'tool_result', output: 'x' }] },
      { role: 'assistant', blocks: [{ type: 'text', text: 'final ' }, { type: 'text', text: 'answer' }] }
    ];
    expect(lastAssistantText(messages)).toBe('final answer');
  });
  it('returns empty string when there is no assistant text', () => {
    expect(lastAssistantText([{ role: 'user', blocks: [{ type: 'text', text: 'q' }] }])).toBe('');
  });
});

describe('extractChangedFiles', () => {
  it('collects file paths from write-like tool calls', () => {
    const messages: TranscriptMessage[] = [
      {
        role: 'assistant',
        blocks: [
          { type: 'tool_use', name: 'write_file', argsPreview: JSON.stringify({ path: 'src/a.ts' }) },
          { type: 'tool_use', name: 'edit_file', argsPreview: JSON.stringify({ file_path: 'src/b.ts' }) },
          { type: 'tool_use', name: 'read_file', argsPreview: JSON.stringify({ path: 'src/c.ts' }) }
        ]
      }
    ];
    expect(extractChangedFiles(messages)).toEqual(['src/a.ts', 'src/b.ts']);
  });
  it('dedupes and ignores unparseable args', () => {
    const messages: TranscriptMessage[] = [
      {
        role: 'assistant',
        blocks: [
          { type: 'tool_use', name: 'write_file', argsPreview: JSON.stringify({ path: 'src/a.ts' }) },
          { type: 'tool_use', name: 'write_file', argsPreview: JSON.stringify({ path: 'src/a.ts' }) },
          { type: 'tool_use', name: 'write_file', argsPreview: 'not json' }
        ]
      }
    ];
    expect(extractChangedFiles(messages)).toEqual(['src/a.ts']);
  });
});

describe('changedLineRange', () => {
  it('returns the 1-based inclusive range of changed lines', () => {
    const before = 'a\nb\nc\nd';
    const after = 'a\nB\nC\nd';
    expect(changedLineRange(before, after)).toEqual({ fromLine: 2, toLine: 3 });
  });
  it('handles added lines', () => {
    expect(changedLineRange('a\nb', 'a\nx\nb')).toEqual({ fromLine: 2, toLine: 2 });
  });
  it('returns null when identical', () => {
    expect(changedLineRange('a\nb', 'a\nb')).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/shared/__tests__/rune-assist.test.ts`
Expected: FAIL — `Cannot find module '../rune-assist'`.

- [ ] **Step 3: Write the implementation**

Create `src/shared/rune-assist.ts`:

```ts
// Pure, renderer-safe helpers for the Rune Quick-Assist overlay. No Node imports.
import type { TranscriptMessage } from './sessions';

export type RuneAssistMode = 'ask' | 'edit';
export type RuneAssistSelection = { fromLine: number; toLine: number };

/** Read-only instruction prepended in Ask mode so Rune answers without writing to disk. */
export const ASK_PREAMBLE =
  'Answer the following question about the code. Do NOT edit, write, or create any ' +
  'files — respond with an explanation only.';

const IMPERATIVE_RE =
  /^\s*(finish|implement|complete|refactor|add|rename|fix|write|create|remove|delete|replace|update|change|make|generate|extract|inline|convert|move|sort|format|optimi[sz]e|simplify|wrap|split|merge|document|comment|annotate)\b/i;

/** Heuristic: a leading imperative verb => edit; otherwise ask. Authoritative mode is the caller's. */
export function detectIntent(text: string): RuneAssistMode {
  return IMPERATIVE_RE.test(text) ? 'edit' : 'ask';
}

/** Machine-readable context line prepended to every prompt. Rune reads the file itself. */
export function buildContextLine(filePath: string, selection: RuneAssistSelection | undefined): string {
  if (!selection) return `[context: file ${filePath}]`;
  if (selection.fromLine === selection.toLine) {
    return `[context: file ${filePath}, line ${selection.fromLine}]`;
  }
  return `[context: file ${filePath}, lines ${selection.fromLine}-${selection.toLine} selected]`;
}

/** Final prompt body: optional read-only preamble, the context line, then the user's text. */
export function composeAssistPrompt(
  mode: RuneAssistMode,
  contextLine: string,
  text: string
): string {
  const head = mode === 'ask' ? `${ASK_PREAMBLE}\n\n` : '';
  return `${head}${contextLine}\n\n${text}`;
}

/** rune CLI args: `--prompt <body>` on the first turn, plus `--resume <id>` thereafter. */
export function buildAssistArgs(prompt: string, sessionId: string | null): string[] {
  const args = ['--prompt', prompt];
  if (sessionId) args.push('--resume', sessionId);
  return args;
}

/** Parse the `session-id: <id>` line rune prints on stdout. */
export function parseRuneSessionId(output: string): string | null {
  return /^session-id: ([A-Za-z0-9_-]+)$/m.exec(output)?.[1] ?? null;
}

/** Concatenated text of the last assistant message — the Ask answer. */
export function lastAssistantText(messages: TranscriptMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== 'assistant') continue;
    const text = m.blocks
      .map((b) => (b.type === 'text' ? b.text : ''))
      .join('')
      .trim();
    if (text) return text;
  }
  return '';
}

// Tool-call names that indicate a file write. NOTE: tune against a real rune session JSON
// during the manual smoke (Task 10) — rune's exact write-tool names drive multi-file reload.
const WRITE_TOOL_RE = /(write|edit|create|replace|patch|append)/i;
const PATH_KEYS = ['path', 'file_path', 'filepath', 'filename', 'file'];

/** Best-effort list of files rune wrote, from write-like tool calls. Active-pane reload does
 * not depend on this (see store reconcile) — this only reloads *other* already-open panes. */
export function extractChangedFiles(messages: TranscriptMessage[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const m of messages) {
    for (const b of m.blocks) {
      if (b.type !== 'tool_use' || !WRITE_TOOL_RE.test(b.name)) continue;
      let args: unknown;
      try {
        args = JSON.parse(b.argsPreview);
      } catch {
        continue;
      }
      if (typeof args !== 'object' || args === null) continue;
      const record = args as Record<string, unknown>;
      for (const key of PATH_KEYS) {
        const v = record[key];
        if (typeof v === 'string' && v && !seen.has(v)) {
          seen.add(v);
          out.push(v);
          break;
        }
      }
    }
  }
  return out;
}

/** 1-based inclusive range of lines that differ between two file contents, or null if identical. */
export function changedLineRange(before: string, after: string): RuneAssistSelection | null {
  if (before === after) return null;
  const a = before.split('\n');
  const b = after.split('\n');
  let top = 0;
  while (top < a.length && top < b.length && a[top] === b[top]) top++;
  let bottom = 0;
  while (
    bottom < a.length - top &&
    bottom < b.length - top &&
    a[a.length - 1 - bottom] === b[b.length - 1 - bottom]
  ) {
    bottom++;
  }
  const fromLine = top + 1;
  const toLine = Math.max(fromLine, b.length - bottom);
  return { fromLine, toLine };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/shared/__tests__/rune-assist.test.ts`
Expected: PASS (all cases green).

- [ ] **Step 5: Commit**

```bash
git add src/shared/rune-assist.ts src/shared/__tests__/rune-assist.test.ts
git commit -m "feat(rune-assist): pure helpers for prompt/intent/reconcile

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Shared IPC channels + payload types

**Files:**
- Modify: `src/shared/ipc-channels.ts:215` (after the `KANBAN_PM_TRANSCRIPT` line)
- Modify: `src/shared/ipc-api.ts:429` (after the `PmChatTranscriptPayload` block)

No test (type/constant declarations only; consumed and verified by later tasks + typecheck).

- [ ] **Step 1: Add the channel constants**

In `src/shared/ipc-channels.ts`, immediately after the line `KANBAN_PM_TRANSCRIPT: 'kanban:pm-transcript',` (line 215), add:

```ts
  // Rune Quick-Assist (cursor overlay)
  RUNE_ASSIST_SEND: 'rune-assist:send',
  RUNE_ASSIST_STOP: 'rune-assist:stop',
  RUNE_ASSIST_RESET: 'rune-assist:reset',
  RUNE_ASSIST_STATE: 'rune-assist:state',
  RUNE_ASSIST_STATUS: 'rune-assist:status',
  RUNE_ASSIST_RESULT: 'rune-assist:result',
```

- [ ] **Step 2: Add the payload types**

In `src/shared/ipc-api.ts`, after the `PmChatTranscriptPayload` type (ends at line 429), add:

```ts
// --- Rune Quick-Assist ---
import type { RuneAssistMode, RuneAssistSelection } from './rune-assist';

export type RuneAssistSendRequest = {
  cwd: string;
  paneId: string;
  text: string;
  mode: RuneAssistMode;
  contextFile?: string;
  selection?: RuneAssistSelection;
};

export type RuneAssistStopRequest = { cwd: string; paneId: string };
export type RuneAssistResetRequest = { cwd: string };

export type RuneAssistState = {
  cwd: string;
  inFlight: boolean;
  error: string | null;
  sessionId: string | null;
};

export type RuneAssistStatusPayload = {
  cwd: string;
  paneId: string;
  phase: 'idle' | 'working' | 'error';
  step?: string;
  error?: string;
};

export type RuneAssistResultPayload = {
  cwd: string;
  paneId: string;
  mode: RuneAssistMode;
  /** Ask: the assistant's answer text. */
  answer?: string;
  /** Edit: files rune wrote (best-effort), for reloading other open panes. */
  changedFiles?: string[];
};
```

> Note: `import type` statements are hoisted; placing this one mid-file is legal TypeScript and keeps the Rune-assist additions co-located. If the implementer prefers, move the `import type { RuneAssistMode, RuneAssistSelection }` line up to the import block at the top (lines 1-16) — either is fine.

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: PASS (no errors).

- [ ] **Step 4: Commit**

```bash
git add src/shared/ipc-channels.ts src/shared/ipc-api.ts
git commit -m "feat(rune-assist): IPC channels + payload types

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: `RuneFileChatService` (main process)

**Files:**
- Create: `src/main/rune-assist/rune-file-chat-service.ts`

This is a near-clone of `src/main/kanban/pm-chat-service.ts` (read it first), keyed by `cwd`, with no MCP, plus a `stop(cwd)`. Verified by typecheck (the spawn-driven class has no unit test, matching `PmChatService`); its pure logic is already tested in Task 1.

- [ ] **Step 1: Write the service**

Create `src/main/rune-assist/rune-file-chat-service.ts`:

```ts
import { spawn, type ChildProcess } from 'child_process';
import { mkdirSync, writeFileSync, readFileSync, renameSync } from 'fs';
import { join } from 'path';
import { z } from 'zod';
import { createLogger } from '../logger';
import { CodedError } from '../errors';
import { RUNE_NOT_INSTALLED_MESSAGE } from '../../shared/rune';
import { isAuthFailureText } from '../kanban/spawn-worker';
import { readRuneSession } from '../sessions/rune-source';
import {
  buildAssistArgs,
  buildContextLine,
  composeAssistPrompt,
  parseRuneSessionId,
  lastAssistantText,
  extractChangedFiles
} from '../../shared/rune-assist';
import type { TranscriptMessage } from '../../shared/sessions';
import type {
  RuneAssistSendRequest,
  RuneAssistState,
  RuneAssistStatusPayload,
  RuneAssistResultPayload
} from '../../shared/ipc-api';

const log = createLogger('rune-assist');

/** A turn that runs longer than this is assumed hung and killed. */
const TURN_TIMEOUT_MS = 5 * 60 * 1000;
/** Keep only this much child output in memory (see docs/learnings on stdout OOM). */
const OUTPUT_CAP = 64 * 1024;

const sessionsFileSchema = z.record(z.string(), z.string());

interface CwdChat {
  sessionId: string | null;
  inFlight: boolean;
  error: string | null;
}

export interface RuneFileChatServiceOptions {
  /** Directory for persisted state (app.getPath('userData')). */
  stateDir: string;
  emitStatus: (payload: RuneAssistStatusPayload) => void;
  emitResult: (payload: RuneAssistResultPayload) => void;
}

/**
 * Drives the Rune Quick-Assist overlay: one resumable rune session per workspace `cwd`,
 * advanced one headless turn per request (`rune --prompt`, then `rune --resume <id> --prompt`).
 * One turn in flight per cwd; the originating paneId is echoed back on every event so the
 * renderer routes the pill / answer / reload to the right pane.
 */
export class RuneFileChatService {
  private chats = new Map<string, CwdChat>();
  private opts: RuneFileChatServiceOptions;
  private sessionsLoaded = false;
  private inFlightChildren = new Set<ChildProcess>();
  /** Active child per cwd, so stop(cwd) can SIGTERM the right one. */
  private childByCwd = new Map<string, ChildProcess>();

  constructor(opts: RuneFileChatServiceOptions) {
    this.opts = opts;
  }

  /** Kill any in-flight turns (app shutdown). */
  dispose(): void {
    for (const child of this.inFlightChildren) child.kill('SIGTERM');
    this.inFlightChildren.clear();
    this.childByCwd.clear();
  }

  private sessionsPath(): string {
    return join(this.opts.stateDir, 'rune-assist-sessions.json');
  }

  /** Lazily hydrate persisted cwd→session ids so conversations survive restarts. */
  private chat(cwd: string): CwdChat {
    if (!this.sessionsLoaded) {
      this.sessionsLoaded = true;
      try {
        const raw = sessionsFileSchema.parse(
          JSON.parse(readFileSync(this.sessionsPath(), 'utf-8'))
        );
        for (const [key, sessionId] of Object.entries(raw)) {
          this.chats.set(key, { sessionId, inFlight: false, error: null });
        }
      } catch {
        // first run or unreadable file — start fresh
      }
    }
    let c = this.chats.get(cwd);
    if (!c) {
      c = { sessionId: null, inFlight: false, error: null };
      this.chats.set(cwd, c);
    }
    return c;
  }

  private persistSessions(): void {
    const data: Record<string, string> = {};
    for (const [key, c] of this.chats) {
      if (c.sessionId) data[key] = c.sessionId;
    }
    const path = this.sessionsPath();
    mkdirSync(this.opts.stateDir, { recursive: true });
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, JSON.stringify(data, null, 2));
    renameSync(tmp, path);
  }

  async getState(cwd: string): Promise<RuneAssistState> {
    const c = this.chat(cwd);
    return { cwd, inFlight: c.inFlight, error: c.error, sessionId: c.sessionId };
  }

  /** Forget the conversation (the rune session file is left untouched). */
  reset(cwd: string): void {
    const c = this.chat(cwd);
    if (c.inFlight) throw new CodedError('wait for the current turn to finish first', 'BAD_REQUEST');
    c.sessionId = null;
    c.error = null;
    this.persistSessions();
  }

  /** SIGTERM the in-flight child for this cwd, if any. */
  stop(cwd: string): void {
    this.childByCwd.get(cwd)?.kill('SIGTERM');
  }

  sendMessage(req: RuneAssistSendRequest): void {
    const { cwd, paneId, mode, contextFile, selection } = req;
    const body = req.text.trim();
    if (body === '') throw new CodedError('message is empty', 'BAD_REQUEST');
    const c = this.chat(cwd);
    if (c.inFlight) {
      // Routed to the originating pane so the overlay can show a gentle note.
      this.opts.emitStatus({
        cwd,
        paneId,
        phase: 'error',
        error: 'Rune is still working in this workspace — cancel or wait.'
      });
      return;
    }
    c.inFlight = true;
    c.error = null;
    this.opts.emitStatus({ cwd, paneId, phase: 'working', step: 'starting…' });

    const contextLine = contextFile ? buildContextLine(contextFile, selection) : '';
    const prompt = contextLine ? composeAssistPrompt(mode, contextLine, body) : body;
    const args = buildAssistArgs(prompt, c.sessionId);
    const child = spawn('rune', args, {
      cwd,
      env: { ...process.env },
      stdio: ['ignore', 'pipe', 'pipe']
    });

    this.inFlightChildren.add(child);
    this.childByCwd.set(cwd, child);

    let output = ''; // merged stdout+stderr tail, for error classification
    let sessionId: string | null = c.sessionId;
    const collect = (chunk: Buffer): void => {
      output = (output + chunk.toString('utf-8')).slice(-OUTPUT_CAP);
      if (!sessionId) sessionId = parseRuneSessionId(output);
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);

    let finished = false;
    const finish = (error: string | null): void => {
      if (finished) return;
      finished = true;
      this.inFlightChildren.delete(child);
      this.childByCwd.delete(cwd);
      clearTimeout(timeout);
      c.inFlight = false;
      c.error = error;
      if (sessionId && sessionId !== c.sessionId) {
        c.sessionId = sessionId;
        this.persistSessions();
      }
      if (error) {
        this.opts.emitStatus({ cwd, paneId, phase: 'error', error });
        return;
      }
      void this.readMessages(c.sessionId).then((messages) => {
        const result: RuneAssistResultPayload = { cwd, paneId, mode };
        if (mode === 'ask') {
          result.answer = lastAssistantText(messages);
        } else {
          result.changedFiles = extractChangedFiles(messages);
        }
        this.opts.emitResult(result);
        this.opts.emitStatus({ cwd, paneId, phase: 'idle' });
      });
    };

    const timeout = setTimeout(() => {
      log.warn('rune-assist turn timed out; killing rune', { cwd, pid: child.pid });
      child.kill('SIGTERM');
    }, TURN_TIMEOUT_MS);

    child.on('error', (err: NodeJS.ErrnoException) => {
      log.error('rune-assist failed to spawn', { cwd, error: err.message });
      finish(err.code === 'ENOENT' ? RUNE_NOT_INSTALLED_MESSAGE : err.message);
    });
    child.on('exit', (code, signal) => {
      if (code === 0) return finish(null);
      if (signal) return finish('the run was interrupted; try again');
      if (isAuthFailureText(output)) {
        return finish(
          'rune authentication failed — fix the provider credentials (e.g. `rune login`) and retry'
        );
      }
      const lastLine = output
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean)
        .pop();
      finish(lastLine ? lastLine.slice(0, 300) : `the run failed (exit ${code ?? '?'})`);
    });
  }

  private async readMessages(sessionId: string | null): Promise<TranscriptMessage[]> {
    if (!sessionId) return [];
    const transcript = await readRuneSession(sessionId);
    return transcript?.messages ?? [];
  }
}
```

> Note: confirm `isAuthFailureText` is exported from `src/main/kanban/spawn-worker.ts` (it is — `export function isAuthFailureText(text: string): boolean`). `CodedError` lives in `src/main/errors.ts` (same import the PM service uses).

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/main/rune-assist/rune-file-chat-service.ts
git commit -m "feat(rune-assist): RuneFileChatService (spawn/resume/stop per cwd)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Main process wiring + IPC handlers

**Files:**
- Create: `src/main/rune-assist/rune-assist-ipc.ts`
- Modify: `src/main/index.ts` (service construction near the PM chat construction ~line 1133; `registerRuneAssistIpc` call; `dispose()` on shutdown)

- [ ] **Step 1: Write the IPC registrar**

Create `src/main/rune-assist/rune-assist-ipc.ts`:

```ts
import { ipcMain } from 'electron';
import { IPC_CHANNELS } from '../../shared/ipc-channels';
import type { RuneFileChatService } from './rune-file-chat-service';
import type {
  RuneAssistSendRequest,
  RuneAssistStopRequest,
  RuneAssistResetRequest,
  RuneAssistState
} from '../../shared/ipc-api';

export function registerRuneAssistIpc(service: RuneFileChatService): void {
  ipcMain.handle(IPC_CHANNELS.RUNE_ASSIST_SEND, (_e, req: RuneAssistSendRequest) => {
    service.sendMessage(req);
  });
  ipcMain.handle(IPC_CHANNELS.RUNE_ASSIST_STOP, (_e, req: RuneAssistStopRequest) => {
    service.stop(req.cwd);
  });
  ipcMain.handle(IPC_CHANNELS.RUNE_ASSIST_RESET, (_e, req: RuneAssistResetRequest) => {
    service.reset(req.cwd);
  });
  ipcMain.handle(
    IPC_CHANNELS.RUNE_ASSIST_STATE,
    async (_e, cwd: string): Promise<RuneAssistState> => service.getState(cwd)
  );
}
```

- [ ] **Step 2: Construct the service in `src/main/index.ts`**

First add the imports near the top of `src/main/index.ts` (with the other main-process imports — search for `import { PmChatService }` and add beneath it):

```ts
import { RuneFileChatService } from './rune-assist/rune-file-chat-service';
import { registerRuneAssistIpc } from './rune-assist/rune-assist-ipc';
```

`app` is already imported in `index.ts` (it uses `app.getPath` / `app.whenReady` elsewhere). Find the PM chat construction block (`pmChat = new PmChatService({ ... });` ~line 1133, followed by `registerKanbanIpc(kanbanCommands, pmChat);` ~line 1149). Add a module-scope declaration next to the existing `pmChat` declaration (search for `let pmChat`), mirroring it:

```ts
let runeAssist: RuneFileChatService | null = null;
```

Then immediately after the `registerKanbanIpc(kanbanCommands, pmChat);` line, add:

```ts
runeAssist = new RuneFileChatService({
  stateDir: app.getPath('userData'),
  emitStatus: (payload) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send(IPC_CHANNELS.RUNE_ASSIST_STATUS, payload);
    }
  },
  emitResult: (payload) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send(IPC_CHANNELS.RUNE_ASSIST_RESULT, payload);
    }
  }
});
registerRuneAssistIpc(runeAssist);
```

- [ ] **Step 3: Dispose on shutdown**

Find where `pmChat?.dispose()` is called (search `pmChat?.dispose` or `pmChat.dispose` in the `will-quit` / `before-quit` handler). Add directly after it:

```ts
runeAssist?.dispose();
```

If `pmChat.dispose()` is not called anywhere (grep finds nothing), add a `before-quit` handler near the other app lifecycle handlers:

```ts
app.on('before-quit', () => {
  runeAssist?.dispose();
});
```

- [ ] **Step 4: Typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/main/rune-assist/rune-assist-ipc.ts src/main/index.ts
git commit -m "feat(rune-assist): wire service + IPC handlers into main

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: Preload `runeAssist` namespace

**Files:**
- Modify: `src/preload/index.ts` (add a `runeAssist` object as a peer of `kanban` in `fleetApi`; import the new types)

- [ ] **Step 1: Add the type imports**

In `src/preload/index.ts`, find the import block that brings in `PmChatSendRequest, PmChatState, PmChatStatusPayload, PmChatTranscriptPayload` (around lines 63-66) and add the Rune-assist types to the same `from '../shared/ipc-api'` import:

```ts
  RuneAssistSendRequest,
  RuneAssistStopRequest,
  RuneAssistResetRequest,
  RuneAssistState,
  RuneAssistStatusPayload,
  RuneAssistResultPayload,
```

- [ ] **Step 2: Add the `runeAssist` namespace**

In the `fleetApi` object, add a `runeAssist` object as a peer of the `kanban` object (place it right after the `kanban: { ... }` block's closing `},`). Uses the existing `typedInvoke` / `onChannel` helpers (lines 135-149):

```ts
  runeAssist: {
    send: async (req: RuneAssistSendRequest): Promise<void> =>
      typedInvoke<void>(IPC_CHANNELS.RUNE_ASSIST_SEND, req),
    stop: async (req: RuneAssistStopRequest): Promise<void> =>
      typedInvoke<void>(IPC_CHANNELS.RUNE_ASSIST_STOP, req),
    reset: async (req: RuneAssistResetRequest): Promise<void> =>
      typedInvoke<void>(IPC_CHANNELS.RUNE_ASSIST_RESET, req),
    getState: async (cwd: string): Promise<RuneAssistState> =>
      typedInvoke<RuneAssistState>(IPC_CHANNELS.RUNE_ASSIST_STATE, cwd),
    onStatus: (callback: (payload: RuneAssistStatusPayload) => void): Unsubscribe =>
      onChannel<RuneAssistStatusPayload>(IPC_CHANNELS.RUNE_ASSIST_STATUS, callback),
    onResult: (callback: (payload: RuneAssistResultPayload) => void): Unsubscribe =>
      onChannel<RuneAssistResultPayload>(IPC_CHANNELS.RUNE_ASSIST_RESULT, callback)
  },
```

`FleetApi` is `typeof fleetApi` (exported at the bottom of the file), so `window.fleet.runeAssist` is typed automatically — no `.d.ts` change needed.

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/preload/index.ts
git commit -m "feat(rune-assist): preload window.fleet.runeAssist

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: `editor-context-registry` (+ test)

**Files:**
- Create: `src/renderer/src/lib/editor-context-registry.ts`
- Test: `src/renderer/src/lib/__tests__/editor-context-registry.test.ts`

Mirrors `src/renderer/src/lib/file-save-registry.ts` but stores a richer `EditorHandle` per pane.

- [ ] **Step 1: Write the failing test**

Create `src/renderer/src/lib/__tests__/editor-context-registry.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import {
  registerEditorHandle,
  unregisterEditorHandle,
  getEditorHandle,
  type EditorHandle
} from '../editor-context-registry';

function fakeHandle(): EditorHandle {
  return {
    getSelection: () => ({ fromLine: 1, toLine: 1 }),
    getContent: () => 'x',
    reloadFromDisk: async () => 'x',
    flashLines: () => {},
    writeContent: async () => {}
  };
}

describe('editor-context-registry', () => {
  it('registers and retrieves a handle by pane id', () => {
    const h = fakeHandle();
    registerEditorHandle('pane-1', h);
    expect(getEditorHandle('pane-1')).toBe(h);
  });
  it('returns undefined after unregister', () => {
    registerEditorHandle('pane-2', fakeHandle());
    unregisterEditorHandle('pane-2');
    expect(getEditorHandle('pane-2')).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/renderer/src/lib/__tests__/editor-context-registry.test.ts`
Expected: FAIL — `Cannot find module '../editor-context-registry'`.

- [ ] **Step 3: Write the implementation**

Create `src/renderer/src/lib/editor-context-registry.ts`:

```ts
/**
 * Registry of editor handles for open file panes, so the Rune Quick-Assist overlay can read
 * the current selection and reconcile edits (reload / flash / revert) without per-keystroke
 * store churn. Mirrors file-save-registry.ts.
 */
import type { RuneAssistSelection } from '../../../shared/rune-assist';

export type EditorHandle = {
  /** Current selection as 1-based line numbers (from === to means just the cursor line). */
  getSelection: () => RuneAssistSelection;
  /** Current editor document text. */
  getContent: () => string;
  /** Reload the document from disk; returns the new content (or null on failure). */
  reloadFromDisk: () => Promise<string | null>;
  /** Briefly highlight the given 1-based inclusive line range. */
  flashLines: (range: RuneAssistSelection) => void;
  /** Overwrite the document + persist to disk (used by Revert). */
  writeContent: (content: string) => Promise<void>;
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
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/renderer/src/lib/__tests__/editor-context-registry.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/lib/editor-context-registry.ts src/renderer/src/lib/__tests__/editor-context-registry.test.ts
git commit -m "feat(rune-assist): editor-context registry

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: `FileEditorPane` integration (handle, flash decoration, hotkey)

**Files:**
- Modify: `src/renderer/src/components/FileEditorPane.tsx`

Register an `EditorHandle`, add a `Mod-i` keymap binding that opens the overlay anchored at the cursor, and add a CodeMirror flash decoration for changed lines. The `RuneAssistLayer` mount is added in Task 9.

- [ ] **Step 1: Add imports + flash extension**

At the top of `src/renderer/src/components/FileEditorPane.tsx`, extend the `@codemirror/view` import to include `Decoration`, `ViewPlugin` is not needed — use `StateField` + `StateEffect` (already importing `StateEffect` from `@codemirror/state`). Add:

```ts
import { Decoration, type DecorationSet } from '@codemirror/view';
import { StateField } from '@codemirror/state';
```

Then add these module-level definitions (above the component, below the imports):

```ts
// --- Rune flash: transient line highlight after an Agent edit ---
const flashRangeEffect = StateEffect.define<{ fromLine: number; toLine: number } | null>();

const flashField = StateField.define<DecorationSet>({
  create() {
    return Decoration.none;
  },
  update(deco, tr) {
    let next = deco.map(tr.changes);
    for (const e of tr.effects) {
      if (!e.is(flashRangeEffect)) continue;
      if (e.value === null) {
        next = Decoration.none;
        continue;
      }
      const ranges = [];
      const { fromLine, toLine } = e.value;
      for (let ln = fromLine; ln <= toLine && ln <= tr.state.doc.lines; ln++) {
        const line = tr.state.doc.line(ln);
        ranges.push(Decoration.line({ class: 'rune-flash-line' }).range(line.from));
      }
      next = Decoration.set(ranges, true);
    }
    return next;
  },
  provide: (f) => EditorView.decorations.from(f)
});
```

Add the flash CSS once (in the existing global stylesheet — search for where `.cm-` or app-global styles live, e.g. `src/renderer/src/index.css` or `assets/main.css`; add):

```css
.rune-flash-line {
  background-color: rgba(152, 195, 121, 0.18);
  transition: background-color 1.2s ease-out;
}
```

- [ ] **Step 2: Register the flash field in the editor extensions**

In the `EditorState.create({ extensions: [...] })` array (around line 206), add `flashField,` near the other extensions (e.g. right after `search(),`).

- [ ] **Step 3: Add the `Mod-i` keymap binding**

In the `keymap.of([...])` array (starts line 215), add this entry before `indentWithTab`:

```ts
            {
              key: 'Mod-i',
              run: (view) => {
                const sel = view.state.selection.main;
                const coords = view.coordsAtPos(sel.head);
                const host = containerRef.current?.getBoundingClientRect();
                const anchor =
                  coords && host
                    ? { top: coords.bottom - host.top, left: coords.left - host.left }
                    : { top: 8, left: 8 };
                openRuneOverlayRef.current(anchor);
                return true;
              }
            },
```

- [ ] **Step 4: Register the `EditorHandle` + an overlay-open callback ref**

Add the imports at the top:

```ts
import {
  registerEditorHandle,
  unregisterEditorHandle,
  type EditorHandle
} from '../lib/editor-context-registry';
import { useRuneAssistStore } from '../store/rune-assist-store';
import { changedLineRange } from '../../../shared/rune-assist';
```

> Note: `useRuneAssistStore` is created in Task 8. Implement Task 8 before running this pane's typecheck, or stub the import temporarily. Subagent-driven execution runs tasks in order, so by the time you build, Task 8 exists.

Inside the component, near the other refs (after `const initialContentRef = ...`), add a ref the keymap closure calls:

```ts
  const openRuneOverlayRef = useRef<(anchor: { top: number; left: number }) => void>(() => {});
```

Wire it to the store + the pane's cwd/file. Add after the `setPaneDirty` line:

```ts
  const openOverlay = useRuneAssistStore((s) => s.openOverlay);
  // The workspace cwd that owns this pane (rune runs there). Derived from the workspace store.
  const cwd = useWorkspaceStore((s) => {
    const tab = s.workspace.tabs.find((t) =>
      t.splitRoot ? collectPaneIdsContains(t.splitRoot, paneId) : false
    );
    return tab?.cwd ?? '/';
  });
  openRuneOverlayRef.current = (anchor) => openOverlay(paneId, { cwd, contextFile: filePath, anchor });
```

Add a tiny local helper near the top of the file (below imports) to avoid importing tree internals:

```ts
import type { PaneNode } from '../../../shared/types';
function collectPaneIdsContains(node: PaneNode, paneId: string): boolean {
  if (node.type === 'leaf') return node.id === paneId;
  return collectPaneIdsContains(node.children[0], paneId) || collectPaneIdsContains(node.children[1], paneId);
}
```

Add the handle registration effect (near the existing `registerFileSave` effect, ~line 281):

```ts
  useEffect(() => {
    const handle: EditorHandle = {
      getSelection: () => {
        const view = viewRef.current;
        if (!view) return { fromLine: 1, toLine: 1 };
        const sel = view.state.selection.main;
        return {
          fromLine: view.state.doc.lineAt(sel.from).number,
          toLine: view.state.doc.lineAt(sel.to).number
        };
      },
      getContent: () => viewRef.current?.state.doc.toString() ?? '',
      reloadFromDisk: async () => {
        const res = await window.fleet.file.read(filePath);
        if (!res.success || !res.data) return null;
        const view = viewRef.current;
        if (!view) return null;
        const content = res.data.content;
        view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: content } });
        savedContentRef.current = content;
        return content;
      },
      flashLines: (range) => {
        const view = viewRef.current;
        if (!view) return;
        view.dispatch({ effects: flashRangeEffect.of(range) });
        setTimeout(() => {
          viewRef.current?.dispatch({ effects: flashRangeEffect.of(null) });
        }, 1500);
      },
      writeContent: async (content) => {
        await window.fleet.file.write(filePath, content);
        const view = viewRef.current;
        if (view) {
          view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: content } });
          savedContentRef.current = content;
        }
      }
    };
    registerEditorHandle(paneId, handle);
    return () => unregisterEditorHandle(paneId);
  }, [paneId, filePath]);
```

> Note: `changedLineRange` is imported for use by the store (Task 8/9), not directly here — if lint flags it unused in this file, drop the import from this file and import it in the store instead. Keep imports honest.

- [ ] **Step 5: Typecheck (after Task 8 exists)**

Run: `npm run typecheck`
Expected: PASS. (If you reach this before Task 8, the `useRuneAssistStore` import will error — that's expected; proceed to Task 8 then re-run.)

- [ ] **Step 6: Commit**

```bash
git add src/renderer/src/components/FileEditorPane.tsx src/renderer/src/index.css
git commit -m "feat(rune-assist): editor handle, flash decoration, Mod-i summon

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 8: `rune-assist-store` (+ tests)

**Files:**
- Create: `src/renderer/src/store/rune-assist-store.ts`
- Test: `src/renderer/src/store/__tests__/rune-assist-store.test.ts`

zustand store keyed by pane id. UI state + send/stop/revert + applyStatus/applyResult. The pure reconcile math is `changedLineRange` (already tested); the store's edit reconciliation calls the `EditorHandle`, so tests cover the non-DOM transitions (open/close/draft, applyStatus, applyResult for Ask, the in-flight pre-check).

- [ ] **Step 1: Write the failing test**

Create `src/renderer/src/store/__tests__/rune-assist-store.test.ts`:

```ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useRuneAssistStore } from '../rune-assist-store';

beforeEach(() => {
  useRuneAssistStore.setState({ panes: {} });
  // window.fleet.runeAssist is polyfilled per-test below.
});

describe('rune-assist-store', () => {
  it('opens and closes the overlay for a pane', () => {
    const { openOverlay, closeOverlay } = useRuneAssistStore.getState();
    openOverlay('p1', { cwd: '/repo', contextFile: 'a.ts', anchor: { top: 10, left: 20 } });
    expect(useRuneAssistStore.getState().panes['p1'].open).toBe(true);
    expect(useRuneAssistStore.getState().panes['p1'].cwd).toBe('/repo');
    closeOverlay('p1');
    expect(useRuneAssistStore.getState().panes['p1'].open).toBe(false);
  });

  it('records the draft text', () => {
    const { openOverlay, setDraft } = useRuneAssistStore.getState();
    openOverlay('p1', { cwd: '/repo', contextFile: 'a.ts', anchor: { top: 0, left: 0 } });
    setDraft('p1', 'hello');
    expect(useRuneAssistStore.getState().panes['p1'].draft).toBe('hello');
  });

  it('applyStatus moves the pane through phases and keeps the prompt on error', () => {
    const { openOverlay, setDraft, applyStatus } = useRuneAssistStore.getState();
    openOverlay('p1', { cwd: '/repo', contextFile: 'a.ts', anchor: { top: 0, left: 0 } });
    setDraft('p1', 'do it');
    applyStatus('p1', { phase: 'working', step: 'reading…' });
    expect(useRuneAssistStore.getState().panes['p1'].phase).toBe('working');
    expect(useRuneAssistStore.getState().panes['p1'].step).toBe('reading…');
    applyStatus('p1', { phase: 'error', error: 'boom' });
    const p = useRuneAssistStore.getState().panes['p1'];
    expect(p.phase).toBe('error');
    expect(p.error).toBe('boom');
    expect(p.draft).toBe('do it'); // prompt preserved for Retry
  });

  it('applyResult in ask mode stores the answer and goes idle', () => {
    const { openOverlay, applyResult } = useRuneAssistStore.getState();
    openOverlay('p1', { cwd: '/repo', contextFile: 'a.ts', anchor: { top: 0, left: 0 } });
    applyResult('p1', { cwd: '/repo', paneId: 'p1', mode: 'ask', answer: '42' });
    const p = useRuneAssistStore.getState().panes['p1'];
    expect(p.answer).toBe('42');
    expect(p.phase).toBe('idle');
  });

  it('send is rejected locally when the pane is already working', async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    (globalThis as unknown as { window: { fleet: unknown } }).window = {
      fleet: { runeAssist: { send } }
    };
    const store = useRuneAssistStore.getState();
    store.openOverlay('p1', { cwd: '/repo', contextFile: 'a.ts', anchor: { top: 0, left: 0 } });
    store.applyStatus('p1', { phase: 'working' });
    await store.send('p1', 'finish it');
    expect(send).not.toHaveBeenCalled();
  });
});
```

> Note: the `send` test stubs `window.fleet.runeAssist.send`; the `send` action reads the `EditorHandle` from the registry — when none is registered it falls back to no selection/empty content, which is fine for the "rejected while working" path (it returns before touching the handle). Keep the action's early-return-on-working ordered before any handle access.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/renderer/src/store/__tests__/rune-assist-store.test.ts`
Expected: FAIL — `Cannot find module '../rune-assist-store'`.

- [ ] **Step 3: Write the store**

Create `src/renderer/src/store/rune-assist-store.ts`:

```ts
import { create } from 'zustand';
import { detectIntent, changedLineRange } from '../../../shared/rune-assist';
import { getEditorHandle } from '../lib/editor-context-registry';
import type { RuneAssistResultPayload, RuneAssistStatusPayload } from '../../../shared/ipc-api';

type Phase = 'idle' | 'working' | 'error';

type PaneAssist = {
  open: boolean;
  anchor: { top: number; left: number } | null;
  draft: string;
  phase: Phase;
  step: string | null;
  error: string | null;
  /** Last Ask answer; when set and phase==='idle', the popover is shown. */
  answer: string | null;
  /** Pre-turn content snapshot for one-click Revert (Edit turns only). */
  editSnapshot: string | null;
  /** True after a successful Edit turn lands — drives the "⟳ Reloaded · Revert" affordance. */
  lastEdited: boolean;
  cwd: string;
  contextFile: string;
};

type OpenArgs = { cwd: string; contextFile: string; anchor: { top: number; left: number } };

type StoreState = {
  panes: Record<string, PaneAssist>;
  openOverlay: (paneId: string, args: OpenArgs) => void;
  closeOverlay: (paneId: string) => void;
  setDraft: (paneId: string, draft: string) => void;
  dismissAnswer: (paneId: string) => void;
  send: (paneId: string, text: string) => Promise<void>;
  stop: (paneId: string) => Promise<void>;
  revert: (paneId: string) => Promise<void>;
  applyStatus: (paneId: string, payload: Pick<RuneAssistStatusPayload, 'phase' | 'step' | 'error'>) => void;
  applyResult: (paneId: string, payload: RuneAssistResultPayload) => void;
};

function blank(cwd: string, contextFile: string, anchor: OpenArgs['anchor']): PaneAssist {
  return {
    open: true,
    anchor,
    draft: '',
    phase: 'idle',
    step: null,
    error: null,
    answer: null,
    editSnapshot: null,
    lastEdited: false,
    cwd,
    contextFile
  };
}

function patch(
  state: StoreState,
  paneId: string,
  fn: (p: PaneAssist) => PaneAssist
): { panes: Record<string, PaneAssist> } {
  const existing = state.panes[paneId];
  if (!existing) return { panes: state.panes };
  return { panes: { ...state.panes, [paneId]: fn(existing) } };
}

export const useRuneAssistStore = create<StoreState>((set, get) => ({
  panes: {},

  openOverlay: (paneId, { cwd, contextFile, anchor }) =>
    set((s) => ({
      panes: { ...s.panes, [paneId]: blank(cwd, contextFile, anchor) }
    })),

  closeOverlay: (paneId) => set((s) => patch(s, paneId, (p) => ({ ...p, open: false }))),

  setDraft: (paneId, draft) => set((s) => patch(s, paneId, (p) => ({ ...p, draft }))),

  dismissAnswer: (paneId) => set((s) => patch(s, paneId, (p) => ({ ...p, answer: null }))),

  send: async (paneId, text) => {
    const body = text.trim();
    if (!body) return;
    const p = get().panes[paneId];
    if (!p || p.phase === 'working') return; // one in-flight per pane (main also guards per cwd)

    const mode = detectIntent(body);
    const handle = getEditorHandle(paneId);
    const selection = handle?.getSelection();
    const snapshot = mode === 'edit' ? (handle?.getContent() ?? null) : null;

    set((s) =>
      patch(s, paneId, (cur) => ({
        ...cur,
        draft: body,
        phase: 'working',
        step: 'starting…',
        error: null,
        answer: null,
        lastEdited: false,
        editSnapshot: snapshot
      }))
    );

    try {
      await window.fleet.runeAssist.send({
        cwd: p.cwd,
        paneId,
        text: body,
        mode,
        contextFile: p.contextFile,
        selection
      });
    } catch (err) {
      set((s) =>
        patch(s, paneId, (cur) => ({
          ...cur,
          phase: 'error',
          error: err instanceof Error ? err.message : String(err)
        }))
      );
    }
  },

  stop: async (paneId) => {
    const p = get().panes[paneId];
    if (!p) return;
    await window.fleet.runeAssist.stop({ cwd: p.cwd, paneId });
  },

  revert: async (paneId) => {
    const p = get().panes[paneId];
    if (!p || p.editSnapshot === null) return;
    const handle = getEditorHandle(paneId);
    await handle?.writeContent(p.editSnapshot);
    set((s) => patch(s, paneId, (cur) => ({ ...cur, lastEdited: false, editSnapshot: null })));
  },

  applyStatus: (paneId, payload) =>
    set((s) =>
      patch(s, paneId, (p) => ({
        ...p,
        phase: payload.phase,
        step: payload.step ?? p.step,
        error: payload.phase === 'error' ? (payload.error ?? 'something went wrong') : null
      }))
    ),

  applyResult: (paneId, payload) => {
    // Ask: show the answer popover. Edit: reconcile the editor (reload + flash) and arm Revert.
    if (payload.mode === 'ask') {
      set((s) =>
        patch(s, paneId, (p) => ({ ...p, phase: 'idle', step: null, answer: payload.answer ?? '' }))
      );
      return;
    }
    const p = get().panes[paneId];
    const handle = getEditorHandle(paneId);
    const before = p?.editSnapshot;
    if (handle) {
      void handle.reloadFromDisk().then((after) => {
        if (after !== null && before != null) {
          const range = changedLineRange(before, after);
          if (range) handle.flashLines(range);
        }
        // Reload other open panes rune also changed (best-effort; no revert for those).
        for (const file of payload.changedFiles ?? []) {
          if (file === p?.contextFile) continue;
          // other panes register their own handles keyed by paneId; we don't have a path→pane
          // map here, so leave cross-pane reload to those panes' own focus/refresh. (v1 scope)
          void file;
        }
      });
    }
    set((s) => patch(s, paneId, (cur) => ({ ...cur, phase: 'idle', step: null, lastEdited: true })));
  }
}));
```

> Note: the cross-pane reload loop is intentionally a no-op placeholder in v1 — there is no path→pane index, and the spec scopes Revert/reconcile to the active pane (others are "best-effort"). Keep the `changedFiles` plumbing (it arrives in the payload) but do not build a path→pane map now. If lint flags the empty loop, replace its body with a clarifying comment and drop the `void file;`.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/renderer/src/store/__tests__/rune-assist-store.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/store/rune-assist-store.ts src/renderer/src/store/__tests__/rune-assist-store.test.ts
git commit -m "feat(rune-assist): renderer store (overlay state, send/stop/revert)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 9: Overlay / pill / popover UI + mount in `FileEditorPane`

**Files:**
- Create: `src/renderer/src/components/rune-assist/RuneAssistOverlay.tsx`
- Create: `src/renderer/src/components/rune-assist/RuneWorkingPill.tsx`
- Create: `src/renderer/src/components/rune-assist/RuneAnswerPopover.tsx`
- Create: `src/renderer/src/components/rune-assist/RuneAssistLayer.tsx`
- Modify: `src/renderer/src/components/FileEditorPane.tsx` (mount `RuneAssistLayer`, subscribe to events)

- [ ] **Step 1: Write the input overlay**

Create `src/renderer/src/components/rune-assist/RuneAssistOverlay.tsx`:

```tsx
import { useEffect, useRef } from 'react';

type Props = {
  draft: string;
  onChange: (v: string) => void;
  onSubmit: () => void;
  onClose: () => void;
};

export function RuneAssistOverlay({ draft, onChange, onSubmit, onClose }: Props): React.JSX.Element {
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    ref.current?.focus();
  }, []);
  return (
    <div className="w-80 rounded-lg border border-fleet-border bg-fleet-surface-1 shadow-xl">
      <textarea
        ref={ref}
        rows={1}
        value={draft}
        placeholder="Ask or instruct Rune…"
        className="w-full resize-none bg-transparent px-3 py-2 text-sm text-neutral-100 outline-none placeholder:text-neutral-500"
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            onSubmit();
          } else if (e.key === 'Escape') {
            e.preventDefault();
            onClose();
          }
        }}
      />
      <div className="flex items-center gap-2 border-t border-fleet-border px-3 py-1.5 text-[11px] text-neutral-500">
        <span>⏎ send</span>
        <span>· esc close</span>
        <span className="ml-auto text-neutral-600">imperative → edit · else ask</span>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Write the working pill**

Create `src/renderer/src/components/rune-assist/RuneWorkingPill.tsx`:

```tsx
type Props = {
  step: string | null;
  onStop: () => void;
};

export function RuneWorkingPill({ step, onStop }: Props): React.JSX.Element {
  return (
    <div className="flex items-center gap-2 rounded-full border border-fleet-border bg-fleet-surface-1 px-3 py-1 text-xs text-neutral-200 shadow-lg">
      <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-emerald-400" />
      <span className="text-neutral-300">Rune working…</span>
      {step && <span className="max-w-[12rem] truncate text-neutral-500">{step}</span>}
      <button
        onClick={onStop}
        className="ml-1 text-neutral-500 hover:text-neutral-200"
        aria-label="Stop"
      >
        ✕
      </button>
    </div>
  );
}
```

- [ ] **Step 3: Write the answer popover**

Create `src/renderer/src/components/rune-assist/RuneAnswerPopover.tsx`:

```tsx
import { useEffect, useRef } from 'react';

type Props = {
  answer: string;
  onDismiss: () => void;
};

export function RuneAnswerPopover({ answer, onDismiss }: Props): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onDismiss();
    };
    const onClick = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) onDismiss();
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onClick);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onClick);
    };
  }, [onDismiss]);
  return (
    <div
      ref={ref}
      className="max-h-72 w-96 overflow-auto rounded-lg border border-fleet-border bg-fleet-surface-1 px-3 py-2 text-sm leading-relaxed text-neutral-100 shadow-xl"
    >
      <div className="whitespace-pre-wrap">{answer}</div>
      <div className="mt-2 text-right text-[11px] text-neutral-500">click away · esc to dismiss</div>
    </div>
  );
}
```

> Note: the spec calls for markdown rendering. If the repo already has a markdown renderer component (search `MarkdownPane` / `react-markdown`), use it in place of the `whitespace-pre-wrap` div. Plain text is the acceptable v1 fallback if no lightweight renderer is readily reusable — do not add a new dependency for this.

- [ ] **Step 4: Write the layer host**

Create `src/renderer/src/components/rune-assist/RuneAssistLayer.tsx`:

```tsx
import { useRuneAssistStore } from '../../store/rune-assist-store';
import { RuneAssistOverlay } from './RuneAssistOverlay';
import { RuneWorkingPill } from './RuneWorkingPill';
import { RuneAnswerPopover } from './RuneAnswerPopover';

type Props = { paneId: string };

/** Renders the right transient piece (overlay / pill / popover / revert) for one file pane. */
export function RuneAssistLayer({ paneId }: Props): React.JSX.Element | null {
  const pane = useRuneAssistStore((s) => s.panes[paneId]);
  const { setDraft, send, stop, closeOverlay, dismissAnswer, revert } = useRuneAssistStore();

  if (!pane) return null;

  const anchorStyle: React.CSSProperties = {
    position: 'absolute',
    top: pane.anchor?.top ?? 8,
    left: pane.anchor?.left ?? 8,
    zIndex: 30
  };

  return (
    <div className="pointer-events-none absolute inset-0">
      <div className="pointer-events-auto" style={anchorStyle}>
        {pane.phase === 'working' ? (
          <RuneWorkingPill step={pane.step} onStop={() => void stop(paneId)} />
        ) : pane.answer !== null ? (
          <RuneAnswerPopover answer={pane.answer} onDismiss={() => dismissAnswer(paneId)} />
        ) : pane.open ? (
          <div className="flex flex-col gap-1.5">
            <RuneAssistOverlay
              draft={pane.draft}
              onChange={(v) => setDraft(paneId, v)}
              onSubmit={() => void send(paneId, pane.draft)}
              onClose={() => closeOverlay(paneId)}
            />
            {pane.phase === 'error' && pane.error && (
              <div className="w-80 rounded-md border border-red-900/60 bg-red-950/40 px-3 py-1.5 text-xs text-red-300">
                {pane.error} · edit your prompt and press ⏎ to retry
              </div>
            )}
          </div>
        ) : pane.lastEdited ? (
          <button
            onClick={() => void revert(paneId)}
            className="rounded-full border border-fleet-border bg-fleet-surface-1 px-3 py-1 text-xs text-emerald-300 shadow-lg hover:text-emerald-200"
          >
            ⟳ Reloaded · Revert
          </button>
        ) : null}
      </div>
    </div>
  );
}
```

- [ ] **Step 5: Mount the layer + subscribe to events in `FileEditorPane`**

In `src/renderer/src/components/FileEditorPane.tsx`, add the import:

```ts
import { RuneAssistLayer } from './rune-assist/RuneAssistLayer';
```

Subscribe to status/result events (add an effect near the handle effect from Task 7), routing only this pane's events into the store:

```ts
  const applyStatus = useRuneAssistStore((s) => s.applyStatus);
  const applyResult = useRuneAssistStore((s) => s.applyResult);
  useEffect(() => {
    const offStatus = window.fleet.runeAssist.onStatus((p) => {
      if (p.paneId === paneId) applyStatus(paneId, { phase: p.phase, step: p.step, error: p.error });
    });
    const offResult = window.fleet.runeAssist.onResult((p) => {
      if (p.paneId === paneId) applyResult(paneId, p);
    });
    return () => {
      offStatus();
      offResult();
    };
  }, [paneId, applyStatus, applyResult]);
```

Change the outer return wrapper to be a positioning context and mount the layer. The current outer div is:

```tsx
    <div className="h-full w-full flex flex-col overflow-hidden">
```

Change it to add `relative`, and add `<RuneAssistLayer paneId={paneId} />` as the last child before the closing `</div>`:

```tsx
    <div className="relative h-full w-full flex flex-col overflow-hidden">
      {showPathChrome && <PathChromeHeader filePath={filePath} />}
      <div ref={containerRef} className="flex-1 min-h-0" />
      {/* …existing status bar div… */}
      <RuneAssistLayer paneId={paneId} />
    </div>
```

- [ ] **Step 6: Typecheck + lint**

Run: `npm run typecheck && npm run lint`
Expected: typecheck PASS. Lint: no **new** errors attributable to these files (the repo lint baseline may already be red per project notes — compare against baseline; fix anything your files introduced).

- [ ] **Step 7: Commit**

```bash
git add src/renderer/src/components/rune-assist src/renderer/src/components/FileEditorPane.tsx
git commit -m "feat(rune-assist): overlay/pill/popover UI + mount in file pane

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 10: Full verification + manual smoke

**Files:** none (verification only).

- [ ] **Step 1: Run the full unit suite**

Run: `npx vitest run src/shared/__tests__/rune-assist.test.ts src/renderer/src/lib/__tests__/editor-context-registry.test.ts src/renderer/src/store/__tests__/rune-assist-store.test.ts`
Expected: all PASS.

- [ ] **Step 2: Typecheck + lint + build**

Run: `npm run typecheck`
Expected: PASS.

Run: `npm run lint`
Expected: no new errors from the new/modified files (compare to the pre-existing baseline).

Run: `npm run build`
Expected: build succeeds (runs typecheck + electron-vite build).

- [ ] **Step 3: Manual smoke (requires `rune` on PATH)**

Run: `npm run dev`. Then:
1. `fleet open` a code file (or open one via the UI) so a file pane is showing.
2. Put the cursor in a function, press **⌘I** (Ctrl+I on non-mac). Confirm the overlay appears anchored near the cursor and is focused.
3. Type a **question** ("what does this function do?") and press ⏎. Confirm: the pill shows "Rune working…" with a step; on completion an **answer popover** appears; clicking away / Esc dismisses it; nothing on disk changed.
4. Summon again, type an **imperative** ("add a doc comment to this function") and press ⏎. Confirm: pill → on completion the file **reloads**, the changed lines **flash**, and a **"⟳ Reloaded · Revert"** affordance appears. Click **Revert**; confirm the file returns to its prior content.
5. While a turn is in flight, summon again in the **same** pane and send — confirm the gentle "still working" error note (no second turn).
6. Verify the read-only contract: an Ask turn must not modify the file on disk.

- [ ] **Step 4: Verify changed-file tool-name patterns (open question from the spec)**

During step 4 above, inspect the rune session JSON (`~/.rune/sessions/<id>.json`, or `$RUNE_DIR/sessions`) for the actual write/edit tool-call names. If they don't match `WRITE_TOOL_RE` in `src/shared/rune-assist.ts`, update the regex + the `extractChangedFiles` test fixture in `src/shared/__tests__/rune-assist.test.ts` to match, and re-run Task 1's test. (Active-pane reload does not depend on this; it only affects multi-file awareness, which is best-effort in v1.)

- [ ] **Step 5: Final commit (if Step 4 required changes)**

```bash
git add src/shared/rune-assist.ts src/shared/__tests__/rune-assist.test.ts
git commit -m "fix(rune-assist): match real rune write-tool names

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Notes for the implementer

- **Hotkey collision:** `Mod-i` is registered inside CodeMirror's keymap (scoped to the editor view), so it won't fight terminal bindings. If it shadows a CodeMirror default you rely on, pick another non-colliding chord and update Task 7 + the spec's open question.
- **`as` casts:** none are needed in `src/` here. The store test uses one cast to polyfill `window.fleet` — tests are allowed to cast (project rule bans casts in `src/`, not in tests).
- **No autoscroll:** the answer popover renders in place at the anchor; there is no transcript to scroll, so the NN/g "don't autoscroll" guidance is satisfied by construction.
- **DRY:** all prompt/parse/intent/diff logic is in `src/shared/rune-assist.ts` and imported by both the main service and the renderer store — do not duplicate it.
