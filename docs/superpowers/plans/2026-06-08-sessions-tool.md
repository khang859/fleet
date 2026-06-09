# Sessions Tool Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a pinned **Sessions** tool to Fleet that browses past Rune + Claude Code agent conversations (global, grouped by project), renders a session's full transcript, and resumes one into a new terminal tab.

**Architecture:** A main-process `src/main/sessions/` module with one normalize-and-read *source* per agent (pure functions + thin fs wrappers), aggregated and exposed over IPC, plus an `fs.watch`-based change event. The renderer adds a `'sessions'` tool tab (two panes: searchable project-grouped list + transcript view) backed by a zustand store. Resume is a renderer action that opens a new terminal tab whose pane carries a one-shot startup command. Spec: `docs/superpowers/specs/2026-06-08-sessions-tool-design.md`.

**Tech Stack:** Electron (main/preload/renderer), TypeScript, React, zustand, zod (disk-boundary validation), vitest. Reuses existing patterns: `settings-store` deep-merge, `IPC_CHANNELS` + `typedInvoke`/`onChannel`, `useTerminal({ cmd })`, sidebar tool-card cards.

**Note on spec deviations (intentional):**
- **Resume is a renderer action, not an IPC handler.** Tab/workspace state lives in the renderer; the Resume button calls a `workspace-store` action that builds the command (`rune --resume <id>` / `claude --resume <id>`) and opens a tab. No `sessions:resume` IPC channel.
- **Transcript view is a dedicated renderer component, not the copilot's `ChatMessageItem`.** The copilot is a separate Vite bundle (`src/renderer/copilot/`) and cannot be imported by the main renderer. We reuse the *approach* (block-switch rendering) against our normalized block union.
- **Image blocks render as a placeholder** (`[image]`) in v1 — we don't ship base64 to the renderer.

---

## File Structure

**Create:**
- `src/shared/sessions.ts` — normalized cross-agent types (shared by main + renderer).
- `src/main/sessions/rune-source.ts` — Rune zod schema + pure normalizers + fs scan/read.
- `src/main/sessions/claude-source.ts` — Claude scan/read (reuses `ConversationReader`) + pure mapper.
- `src/main/sessions/aggregate.ts` — pure filter/sort/group helpers.
- `src/main/sessions/service.ts` — `SessionsService`: list/read + `fs.watch` change notifier.
- `src/main/sessions/ipc-handlers.ts` — `registerSessionsIpcHandlers`.
- `src/main/sessions/__tests__/rune-source.test.ts`
- `src/main/sessions/__tests__/claude-source.test.ts`
- `src/main/sessions/__tests__/aggregate.test.ts`
- `src/renderer/src/store/sessions-store.ts` — zustand store (list, selected, transcript, filter).
- `src/renderer/src/components/sessions/SessionsTab.tsx` — two-pane container.
- `src/renderer/src/components/sessions/SessionList.tsx` — search + filter + grouped list.
- `src/renderer/src/components/sessions/TranscriptView.tsx` — transcript renderer + Resume button.
- `src/renderer/src/components/sessions/SessionsTabCard.tsx` — sidebar tool card.

**Modify:**
- `src/shared/types.ts` — add `'sessions'` to `Tab.type`; add `cmd?` to `PaneLeaf`; add `sessions` to `FleetSettings`.
- `src/shared/constants.ts` — add `sessions` to `DEFAULT_SETTINGS`.
- `src/main/settings-store.ts` — deep-merge the new `sessions` key.
- `src/shared/ipc-channels.ts` — add `SESSIONS_LIST`, `SESSIONS_READ`, `SESSIONS_CHANGED`.
- `src/preload/index.ts` — expose `fleet.sessions`.
- `src/main/index.ts` — construct `SessionsService`, register IPC handlers, wire change event to the window.
- `src/renderer/src/store/workspace-store.ts` — `ensureSessionsTab` + `openResumeTab` actions + `ensureSessionsTab` helper.
- `src/renderer/src/components/PaneGrid.tsx` — pass `cmd={leaf.node.cmd}` to `TerminalPane`.
- `src/renderer/src/components/TerminalPane.tsx` — accept `cmd` prop, forward to `useTerminal`.
- `src/renderer/src/App.tsx` — render `<SessionsTab />` for `tab.type === 'sessions'`.
- `src/renderer/src/components/Sidebar.tsx` — render `SessionsTabCard` in the TOOLS section.
- `src/renderer/src/lib/commands.ts` — add `open-sessions` command.
- `src/renderer/src/components/settings/RuneSection.tsx` — add the "Preferred agent" dropdown.

---

## Task 1: Normalized session types

**Files:**
- Create: `src/shared/sessions.ts`

- [ ] **Step 1: Write the shared types**

```ts
// src/shared/sessions.ts
// Normalized, agent-agnostic session model shared by main + renderer.

export type SessionAgent = 'rune' | 'claude';

/** Persisted in settings as sessions.preferredAgent; also the list filter value. */
export type SessionAgentFilter = 'all' | 'rune' | 'claude';

export type TranscriptBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; name: string; argsPreview: string; id?: string }
  | { type: 'tool_result'; toolCallId?: string; output: string; isError?: boolean }
  | { type: 'image' };

export type TranscriptMessage = {
  role: 'user' | 'assistant' | 'tool';
  blocks: TranscriptBlock[];
  createdAt?: number;
};

export type SessionSummary = {
  agent: SessionAgent;
  id: string;
  title: string;
  project: string; // display name for the cwd group
  cwd: string;
  model?: string;
  provider?: string; // Rune only
  updatedAt: number; // epoch ms
  messageCount: number;
  preview: string;
};

export type SessionTranscript = {
  summary: SessionSummary;
  messages: TranscriptMessage[];
};

export type SessionGroup = {
  project: string;
  cwd: string;
  sessions: SessionSummary[];
};
```

- [ ] **Step 2: Verify it typechecks**

Run: `npm run typecheck`
Expected: PASS (no references yet, just new types).

- [ ] **Step 3: Commit**

```bash
git add src/shared/sessions.ts
git commit -m "feat(sessions): add normalized cross-agent session types"
```

---

## Task 2: Type & settings wiring (Tab union, PaneLeaf.cmd, settings, IPC channels)

**Files:**
- Modify: `src/shared/types.ts` (Tab.type union; PaneLeaf; FleetSettings)
- Modify: `src/shared/constants.ts` (DEFAULT_SETTINGS)
- Modify: `src/main/settings-store.ts` (deep-merge)
- Modify: `src/shared/ipc-channels.ts` (channels)

- [ ] **Step 1: Add `'sessions'` to the Tab type union**

In `src/shared/types.ts`, the `Tab.type` field currently reads:

```ts
  type?: 'terminal' | 'file' | 'image' | 'images' | 'settings' | 'annotate' | 'pi' | 'markdown' | 'kanban' | 'artifacts' | 'pdf';
```

Change it to add `'sessions'`:

```ts
  type?: 'terminal' | 'file' | 'image' | 'images' | 'settings' | 'annotate' | 'pi' | 'markdown' | 'kanban' | 'artifacts' | 'pdf' | 'sessions';
```

- [ ] **Step 2: Add `cmd` to `PaneLeaf`**

In `src/shared/types.ts`, in the `PaneLeaf` type, add after `serializedContent?: string;`:

```ts
  /** One-shot startup command for this pane (e.g. resuming a session). Runs on first PTY create. */
  cmd?: string;
```

- [ ] **Step 3: Add `sessions` to `FleetSettings`**

In `src/shared/types.ts`, in `FleetSettings`, add after the `annotate` block (before `kanban`):

```ts
  sessions: {
    /** Default + persisted agent filter for the Sessions tool. */
    preferredAgent: SessionAgentFilter;
  };
```

Add the import at the top of `src/shared/types.ts` (next to other imports):

```ts
import type { SessionAgentFilter } from './sessions';
```

- [ ] **Step 4: Add the default**

In `src/shared/constants.ts`, in the `DEFAULT_SETTINGS` object, add after the `annotate: { retentionDays: 3 },` block:

```ts
  sessions: {
    preferredAgent: 'rune'
  },
```

- [ ] **Step 5: Deep-merge the new key in the main store**

In `src/main/settings-store.ts`, inside `get()`'s returned object, add after the `annotate` line:

```ts
      sessions: { ...DEFAULT_SETTINGS.sessions, ...(saved.sessions ?? {}) },
```

- [ ] **Step 6: Add IPC channels**

In `src/shared/ipc-channels.ts`, add to the `IPC_CHANNELS` object (near the other feature channels):

```ts
  SESSIONS_LIST: 'sessions:list',
  SESSIONS_READ: 'sessions:read',
  SESSIONS_CHANGED: 'sessions:changed',
```

- [ ] **Step 7: Verify typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/shared/types.ts src/shared/constants.ts src/main/settings-store.ts src/shared/ipc-channels.ts
git commit -m "feat(sessions): wire tab type, pane cmd, settings, and IPC channels"
```

---

## Task 3: Rune source — schema + normalizers (TDD)

**Files:**
- Create: `src/main/sessions/rune-source.ts`
- Test: `src/main/sessions/__tests__/rune-source.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// src/main/sessions/__tests__/rune-source.test.ts
import { describe, it, expect } from 'vitest';
import { summarizeRune, readRuneTranscript } from '../rune-source';

const RAW = {
  id: 'a1b2c3d4e5f6g7h8',
  name: 'Fix auth bug',
  created: '2026-04-30T09:08:07Z',
  provider: 'groq',
  model: 'mixtral-8x7b-32768',
  cwd: '/Users/khang/projects/myapp',
  root_id: 'root',
  active_id: 'n2',
  nodes: [
    { id: 'root', parent_id: '', children: ['n1'], has_message: false, created: '2026-04-30T09:08:07Z' },
    {
      id: 'n1',
      parent_id: 'root',
      children: ['n2'],
      has_message: true,
      message: { role: 'user', content: [{ type: 'text', text: 'fix the login issue in auth.go' }] },
      created: '2026-04-30T09:08:08Z'
    },
    {
      id: 'n2',
      parent_id: 'n1',
      children: [],
      has_message: true,
      message: {
        role: 'assistant',
        content: [
          { type: 'text', text: 'I found it in auth.go' },
          { type: 'tool_use', id: 't1', name: 'read', args: '{"path":"auth.go"}' }
        ]
      },
      created: '2026-04-30T09:08:12Z'
    }
  ],
  subagents: [],
  files_read: ['/Users/khang/projects/myapp/auth.go']
};

describe('summarizeRune', () => {
  it('builds a summary from the active path', () => {
    const s = summarizeRune(RAW, 1700000000000);
    expect(s).not.toBeNull();
    expect(s!.agent).toBe('rune');
    expect(s!.id).toBe('a1b2c3d4e5f6g7h8');
    expect(s!.title).toBe('Fix auth bug');
    expect(s!.model).toBe('mixtral-8x7b-32768');
    expect(s!.provider).toBe('groq');
    expect(s!.cwd).toBe('/Users/khang/projects/myapp');
    expect(s!.project).toBe('myapp');
    expect(s!.messageCount).toBe(2);
    expect(s!.preview).toBe('fix the login issue in auth.go');
    expect(s!.updatedAt).toBe(1700000000000);
  });

  it('falls back to preview when name is missing', () => {
    const s = summarizeRune({ ...RAW, name: undefined }, 1);
    expect(s!.title).toBe('fix the login issue in auth.go');
  });

  it('returns null for malformed input', () => {
    expect(summarizeRune({ nope: true }, 1)).toBeNull();
  });
});

describe('readRuneTranscript', () => {
  it('flattens the root->active path into messages', () => {
    const t = readRuneTranscript(RAW, 1)!;
    expect(t.messages.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(t.messages[0].blocks).toEqual([{ type: 'text', text: 'fix the login issue in auth.go' }]);
    expect(t.messages[1].blocks).toEqual([
      { type: 'text', text: 'I found it in auth.go' },
      { type: 'tool_use', id: 't1', name: 'read', argsPreview: '{"path":"auth.go"}' }
    ]);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/main/sessions/__tests__/rune-source.test.ts`
Expected: FAIL — cannot find module `../rune-source`.

- [ ] **Step 3: Implement `rune-source.ts` (schema + normalizers; fs wrappers added in Task 6)**

```ts
// src/main/sessions/rune-source.ts
import { z } from 'zod';
import { basename } from 'node:path';
import type { SessionSummary, SessionTranscript, TranscriptBlock, TranscriptMessage } from '../../shared/sessions';

const contentBlockSchema = z
  .object({
    type: z.string(),
    text: z.string().optional(),
    id: z.string().optional(),
    name: z.string().optional(),
    args: z.unknown().optional(),
    tool_call_id: z.string().optional(),
    output: z.string().optional(),
    is_error: z.boolean().optional()
  })
  .passthrough();

const nodeSchema = z
  .object({
    id: z.string(),
    parent_id: z.string().optional().default(''),
    children: z.array(z.string()).optional().default([]),
    has_message: z.boolean().optional().default(false),
    message: z
      .object({ role: z.string(), content: z.array(contentBlockSchema).optional().default([]) })
      .optional(),
    created: z.string().optional()
  })
  .passthrough();

export const runeSessionSchema = z
  .object({
    id: z.string(),
    name: z.string().optional(),
    created: z.string().optional(),
    provider: z.string().optional(),
    model: z.string().optional(),
    cwd: z.string().optional().default(''),
    root_id: z.string().optional().default(''),
    active_id: z.string().optional().default(''),
    nodes: z.array(nodeSchema).optional().default([])
  })
  .passthrough();

export type RuneSession = z.infer<typeof runeSessionSchema>;

/** Walk root -> active_id and return nodes that carry a message, in chronological order. */
function activePath(session: RuneSession): RuneSession['nodes'] {
  const byId = new Map(session.nodes.map((n) => [n.id, n]));
  const chain: RuneSession['nodes'] = [];
  let current = byId.get(session.active_id);
  const guard = new Set<string>();
  while (current && !guard.has(current.id)) {
    guard.add(current.id);
    if (current.has_message && current.message) chain.push(current);
    current = current.parent_id ? byId.get(current.parent_id) : undefined;
  }
  return chain.reverse();
}

function firstUserText(path: RuneSession['nodes']): string {
  for (const node of path) {
    if (node.message?.role === 'user') {
      const text = node.message.content.find((b) => b.type === 'text')?.text;
      if (text) return text.trim();
    }
  }
  return '';
}

function toRole(role: string): TranscriptMessage['role'] {
  if (role === 'user') return 'user';
  if (role === 'assistant') return 'assistant';
  return 'tool';
}

function toBlocks(content: z.infer<typeof contentBlockSchema>[]): TranscriptBlock[] {
  return content.map((b): TranscriptBlock => {
    switch (b.type) {
      case 'text':
        return { type: 'text', text: b.text ?? '' };
      case 'tool_use':
        return {
          type: 'tool_use',
          name: b.name ?? 'tool',
          argsPreview: typeof b.args === 'string' ? b.args : JSON.stringify(b.args ?? {}),
          id: b.id
        };
      case 'tool_result':
        return { type: 'tool_result', toolCallId: b.tool_call_id, output: b.output ?? '', isError: b.is_error };
      default:
        return { type: 'image' };
    }
  });
}

export function summarizeRune(raw: unknown, updatedAt: number): SessionSummary | null {
  const parsed = runeSessionSchema.safeParse(raw);
  if (!parsed.success) return null;
  const session = parsed.data;
  const path = activePath(session);
  const preview = firstUserText(path);
  return {
    agent: 'rune',
    id: session.id,
    title: session.name?.trim() || preview || '(untitled)',
    project: session.cwd ? basename(session.cwd) : '(no project)',
    cwd: session.cwd,
    model: session.model,
    provider: session.provider,
    updatedAt,
    messageCount: path.length,
    preview: preview.slice(0, 140)
  };
}

export function readRuneTranscript(raw: unknown, updatedAt: number): SessionTranscript | null {
  const summary = summarizeRune(raw, updatedAt);
  if (!summary) return null;
  const session = runeSessionSchema.parse(raw);
  const messages = activePath(session).map((node): TranscriptMessage => ({
    role: toRole(node.message!.role),
    blocks: toBlocks(node.message!.content)
  }));
  return { summary, messages };
}
```

- [ ] **Step 4: Run tests to verify pass**

Run: `npx vitest run src/main/sessions/__tests__/rune-source.test.ts`
Expected: PASS (all cases).

- [ ] **Step 5: Commit**

```bash
git add src/main/sessions/rune-source.ts src/main/sessions/__tests__/rune-source.test.ts
git commit -m "feat(sessions): rune session schema and normalizers"
```

---

## Task 4: Claude source — message mapper (TDD)

**Files:**
- Create: `src/main/sessions/claude-source.ts`
- Test: `src/main/sessions/__tests__/claude-source.test.ts`

Claude Code transcripts are parsed by the existing `ConversationReader` (`src/main/copilot/conversation-reader.ts`) into `CopilotChatMessage[]`. This task implements the pure mapper from those to our normalized `TranscriptMessage[]`. The fs scan that drives it is added in Task 6.

- [ ] **Step 1: Write the failing test**

```ts
// src/main/sessions/__tests__/claude-source.test.ts
import { describe, it, expect } from 'vitest';
import { claudeMessagesToTranscriptMessages, claudePreview } from '../claude-source';
import type { CopilotChatMessage } from '../../../shared/types';

const MESSAGES: CopilotChatMessage[] = [
  { id: 'm1', role: 'user', timestamp: '2026-05-01T10:00:00Z', blocks: [{ type: 'text', text: 'refactor the api' }] },
  {
    id: 'm2',
    role: 'assistant',
    timestamp: '2026-05-01T10:00:05Z',
    blocks: [
      { type: 'thinking', text: 'considering...' },
      { type: 'text', text: 'done' },
      { type: 'tool_use', id: 't1', name: 'Edit', inputPreview: 'api.ts', input: { path: 'api.ts' } }
    ]
  }
];

describe('claudeMessagesToTranscriptMessages', () => {
  it('maps copilot blocks into normalized blocks', () => {
    const msgs = claudeMessagesToTranscriptMessages(MESSAGES);
    expect(msgs[0]).toEqual({ role: 'user', blocks: [{ type: 'text', text: 'refactor the api' }] });
    expect(msgs[1].role).toBe('assistant');
    expect(msgs[1].blocks).toEqual([
      { type: 'text', text: 'considering...' },
      { type: 'text', text: 'done' },
      { type: 'tool_use', name: 'Edit', argsPreview: 'api.ts', id: 't1' }
    ]);
  });
});

describe('claudePreview', () => {
  it('returns the first user text', () => {
    expect(claudePreview(MESSAGES)).toBe('refactor the api');
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/main/sessions/__tests__/claude-source.test.ts`
Expected: FAIL — cannot find module `../claude-source`.

- [ ] **Step 3: Implement the mapper in `claude-source.ts`**

```ts
// src/main/sessions/claude-source.ts
import type { CopilotChatMessage } from '../../shared/types';
import type { TranscriptBlock, TranscriptMessage } from '../../shared/sessions';

export function claudeMessagesToTranscriptMessages(messages: CopilotChatMessage[]): TranscriptMessage[] {
  return messages.map((m): TranscriptMessage => {
    const blocks: TranscriptBlock[] = [];
    for (const b of m.blocks) {
      if (b.type === 'text' || b.type === 'thinking') {
        blocks.push({ type: 'text', text: b.text });
      } else if (b.type === 'tool_use') {
        blocks.push({ type: 'tool_use', name: b.name, argsPreview: b.inputPreview, id: b.id });
      }
      // 'interrupted' blocks are dropped from the transcript view.
    }
    return { role: m.role, blocks };
  });
}

export function claudePreview(messages: CopilotChatMessage[]): string {
  for (const m of messages) {
    if (m.role === 'user') {
      const text = m.blocks.find((b) => b.type === 'text');
      if (text && text.type === 'text') return text.text.trim();
    }
  }
  return '';
}
```

- [ ] **Step 4: Run tests to verify pass**

Run: `npx vitest run src/main/sessions/__tests__/claude-source.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/main/sessions/claude-source.ts src/main/sessions/__tests__/claude-source.test.ts
git commit -m "feat(sessions): claude transcript message mapper"
```

---

## Task 5: Aggregator — filter / sort / group (TDD)

**Files:**
- Create: `src/main/sessions/aggregate.ts`
- Test: `src/main/sessions/__tests__/aggregate.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// src/main/sessions/__tests__/aggregate.test.ts
import { describe, it, expect } from 'vitest';
import { applyAgentFilter, groupByProject } from '../aggregate';
import type { SessionSummary } from '../../../shared/sessions';

const make = (over: Partial<SessionSummary>): SessionSummary => ({
  agent: 'rune', id: 'x', title: 't', project: 'p', cwd: '/p', updatedAt: 0, messageCount: 1, preview: '', ...over
});

const SESSIONS = [
  make({ id: 'r1', agent: 'rune', project: 'myapp', cwd: '/myapp', updatedAt: 100 }),
  make({ id: 'c1', agent: 'claude', project: 'myapp', cwd: '/myapp', updatedAt: 300 }),
  make({ id: 'r2', agent: 'rune', project: 'fleet', cwd: '/fleet', updatedAt: 200 })
];

describe('applyAgentFilter', () => {
  it('all returns everything', () => {
    expect(applyAgentFilter(SESSIONS, 'all')).toHaveLength(3);
  });
  it('filters by agent', () => {
    expect(applyAgentFilter(SESSIONS, 'rune').map((s) => s.id)).toEqual(['r1', 'r2']);
    expect(applyAgentFilter(SESSIONS, 'claude').map((s) => s.id)).toEqual(['c1']);
  });
});

describe('groupByProject', () => {
  it('groups by cwd, newest session first within group, groups ordered by newest', () => {
    const groups = groupByProject(SESSIONS);
    // myapp group's newest is c1 (300) > fleet's r2 (200), so myapp comes first
    expect(groups.map((g) => g.project)).toEqual(['myapp', 'fleet']);
    expect(groups[0].sessions.map((s) => s.id)).toEqual(['c1', 'r1']);
    expect(groups[1].sessions.map((s) => s.id)).toEqual(['r2']);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/main/sessions/__tests__/aggregate.test.ts`
Expected: FAIL — cannot find module `../aggregate`.

- [ ] **Step 3: Implement `aggregate.ts`**

```ts
// src/main/sessions/aggregate.ts
import type { SessionAgentFilter, SessionGroup, SessionSummary } from '../../shared/sessions';

export function applyAgentFilter(sessions: SessionSummary[], filter: SessionAgentFilter): SessionSummary[] {
  if (filter === 'all') return sessions;
  return sessions.filter((s) => s.agent === filter);
}

export function groupByProject(sessions: SessionSummary[]): SessionGroup[] {
  const groups = new Map<string, SessionGroup>();
  for (const s of sessions) {
    const existing = groups.get(s.cwd);
    if (existing) existing.sessions.push(s);
    else groups.set(s.cwd, { project: s.project, cwd: s.cwd, sessions: [s] });
  }
  const result = [...groups.values()];
  for (const g of result) g.sessions.sort((a, b) => b.updatedAt - a.updatedAt);
  result.sort((a, b) => b.sessions[0].updatedAt - a.sessions[0].updatedAt);
  return result;
}
```

- [ ] **Step 4: Run tests to verify pass**

Run: `npx vitest run src/main/sessions/__tests__/aggregate.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/main/sessions/aggregate.ts src/main/sessions/__tests__/aggregate.test.ts
git commit -m "feat(sessions): aggregate filter and group-by-project helpers"
```

---

## Task 6: SessionsService — fs scan, read, and watch

**Files:**
- Create: `src/main/sessions/service.ts`
- Modify: `src/main/sessions/rune-source.ts` (add fs scan/read wrappers)
- Modify: `src/main/sessions/claude-source.ts` (add fs scan/read wrappers)

No unit test (fs/timer-bound); verified via the IPC smoke in Task 8.

- [ ] **Step 1: Add Rune fs wrappers to `rune-source.ts`**

Append to `src/main/sessions/rune-source.ts`:

```ts
import { readFile, readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { SessionSummary, SessionTranscript } from '../../shared/sessions';

export function runeSessionsDir(): string {
  const base = process.env.RUNE_DIR && process.env.RUNE_DIR.length > 0 ? process.env.RUNE_DIR : join(homedir(), '.rune');
  return join(base, 'sessions');
}

export async function listRuneSessions(): Promise<SessionSummary[]> {
  const dir = runeSessionsDir();
  let files: string[];
  try {
    files = (await readdir(dir)).filter((f) => f.endsWith('.json'));
  } catch {
    return []; // dir may not exist
  }
  const out: SessionSummary[] = [];
  for (const file of files) {
    try {
      const full = join(dir, file);
      const [raw, st] = await Promise.all([readFile(full, 'utf8'), stat(full)]);
      const summary = summarizeRune(JSON.parse(raw), st.mtimeMs);
      if (summary) out.push(summary);
    } catch {
      // skip malformed file
    }
  }
  return out;
}

export async function readRuneSession(id: string): Promise<SessionTranscript | null> {
  const full = join(runeSessionsDir(), `${id}.json`);
  const [raw, st] = await Promise.all([readFile(full, 'utf8'), stat(full)]);
  return readRuneTranscript(JSON.parse(raw), st.mtimeMs);
}
```

- [ ] **Step 2: Add Claude fs wrappers to `claude-source.ts`**

Append to `src/main/sessions/claude-source.ts`:

```ts
import { readFile, readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { ConversationReader } from '../copilot/conversation-reader';
import type { SessionSummary, SessionTranscript } from '../../shared/sessions';

const reader = new ConversationReader();

export function claudeProjectsDir(): string {
  return join(homedir(), '.claude', 'projects');
}

/** Read the cwd recorded in the first JSON line of a transcript file. */
async function readCwdFromJsonl(filePath: string): Promise<string> {
  const content = await readFile(filePath, 'utf8');
  const firstLine = content.split('\n').find((l) => l.trim().length > 0);
  if (!firstLine) return '';
  try {
    const obj = JSON.parse(firstLine) as { cwd?: string };
    return typeof obj.cwd === 'string' ? obj.cwd : '';
  } catch {
    return '';
  }
}

export async function listClaudeSessions(): Promise<SessionSummary[]> {
  const root = claudeProjectsDir();
  let projectDirs: string[];
  try {
    projectDirs = await readdir(root);
  } catch {
    return [];
  }
  const out: SessionSummary[] = [];
  for (const projectDir of projectDirs) {
    const dirPath = join(root, projectDir);
    let files: string[];
    try {
      files = (await readdir(dirPath)).filter((f) => f.endsWith('.jsonl'));
    } catch {
      continue;
    }
    for (const file of files) {
      try {
        const full = join(dirPath, file);
        const id = basename(file, '.jsonl');
        const [cwd, st] = await Promise.all([readCwdFromJsonl(full), stat(full)]);
        if (!cwd) continue;
        const messages = reader.getMessages(id, cwd);
        if (messages.length === 0) continue;
        const preview = claudePreview(messages);
        out.push({
          agent: 'claude',
          id,
          title: preview || '(untitled)',
          project: basename(cwd),
          cwd,
          updatedAt: st.mtimeMs,
          messageCount: messages.length,
          preview: preview.slice(0, 140)
        });
      } catch {
        // skip malformed file
      }
    }
  }
  return out;
}

export async function readClaudeSession(id: string, cwd: string): Promise<SessionTranscript | null> {
  const messages = reader.getMessages(id, cwd);
  if (messages.length === 0) return null;
  const full = join(claudeProjectsDir(), cwdToDir(cwd), `${id}.jsonl`);
  let updatedAt = 0;
  try {
    updatedAt = (await stat(full)).mtimeMs;
  } catch {
    // best-effort mtime
  }
  const preview = claudePreview(messages);
  return {
    summary: {
      agent: 'claude',
      id,
      title: preview || '(untitled)',
      project: basename(cwd),
      cwd,
      updatedAt,
      messageCount: messages.length,
      preview: preview.slice(0, 140)
    },
    messages: claudeMessagesToTranscriptMessages(messages)
  };
}

/** Mirror conversation-reader's cwd->dir sanitization (replace path separators with dashes). */
function cwdToDir(cwd: string): string {
  return cwd.replace(/[/\\:]/g, '-');
}
```

> **Verify the `cwdToDir` rule** against `cwdToProjectDir` in `src/main/copilot/conversation-reader.ts` and match it exactly. If that helper is exported, import and use it instead of redefining.

- [ ] **Step 3: Implement `SessionsService`**

```ts
// src/main/sessions/service.ts
import { watch, type FSWatcher } from 'node:fs';
import type { SessionAgent, SessionSummary, SessionTranscript } from '../../shared/sessions';
import { listRuneSessions, readRuneSession, runeSessionsDir } from './rune-source';
import { claudeProjectsDir, listClaudeSessions, readClaudeSession } from './claude-source';

export class SessionsService {
  private watchers: FSWatcher[] = [];
  private debounce: ReturnType<typeof setTimeout> | null = null;

  async list(): Promise<SessionSummary[]> {
    const [rune, claude] = await Promise.all([listRuneSessions(), listClaudeSessions()]);
    return [...rune, ...claude].sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async read(agent: SessionAgent, id: string, cwd: string): Promise<SessionTranscript | null> {
    return agent === 'rune' ? readRuneSession(id) : readClaudeSession(id, cwd);
  }

  /** Start watching both source dirs; calls onChange (debounced) when anything changes. */
  startWatching(onChange: () => void): void {
    for (const dir of [runeSessionsDir(), claudeProjectsDir()]) {
      try {
        const w = watch(dir, { recursive: true }, () => {
          if (this.debounce) clearTimeout(this.debounce);
          this.debounce = setTimeout(onChange, 500);
        });
        this.watchers.push(w);
      } catch {
        // dir may not exist yet; skip
      }
    }
  }

  dispose(): void {
    if (this.debounce) clearTimeout(this.debounce);
    for (const w of this.watchers) w.close();
    this.watchers = [];
  }
}
```

- [ ] **Step 4: Verify typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/main/sessions/service.ts src/main/sessions/rune-source.ts src/main/sessions/claude-source.ts
git commit -m "feat(sessions): fs scan/read wrappers and watch service"
```

---

## Task 7: IPC handlers + main wiring

**Files:**
- Create: `src/main/sessions/ipc-handlers.ts`
- Modify: `src/main/index.ts`

- [ ] **Step 1: Implement the IPC handlers**

```ts
// src/main/sessions/ipc-handlers.ts
import { ipcMain } from 'electron';
import { IPC_CHANNELS } from '../../shared/ipc-channels';
import type { SessionAgent } from '../../shared/sessions';
import type { SessionsService } from './service';

export function registerSessionsIpcHandlers(service: SessionsService): void {
  ipcMain.handle(IPC_CHANNELS.SESSIONS_LIST, () => service.list());
  ipcMain.handle(
    IPC_CHANNELS.SESSIONS_READ,
    (_event, args: { agent: SessionAgent; id: string; cwd: string }) =>
      service.read(args.agent, args.id, args.cwd)
  );
}
```

- [ ] **Step 2: Wire it into `src/main/index.ts`**

Near the other service constructions / `registerIpcHandlers` calls, add construction and registration. Mirror how images sends `IMAGES_CHANGED` (see `src/main/index.ts` around line 130, `windowRef.webContents.send(...)`):

```ts
import { SessionsService } from './sessions/service';
import { registerSessionsIpcHandlers } from './sessions/ipc-handlers';

// ...after the BrowserWindow (windowRef) is created and IPC handlers are registered:
const sessionsService = new SessionsService();
registerSessionsIpcHandlers(sessionsService);
sessionsService.startWatching(() => {
  if (!windowRef.isDestroyed()) windowRef.webContents.send(IPC_CHANNELS.SESSIONS_CHANGED);
});
```

> Use the same `windowRef` variable the images `IMAGES_CHANGED` send uses, and add `sessionsService.dispose()` next to other teardown (e.g. in the window `closed`/`before-quit` handler) if one exists.

- [ ] **Step 3: Verify typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/main/sessions/ipc-handlers.ts src/main/index.ts
git commit -m "feat(sessions): register IPC handlers and change notifier"
```

---

## Task 8: Preload bridge

**Files:**
- Modify: `src/preload/index.ts`

- [ ] **Step 1: Add the `sessions` namespace to `fleetApi`**

In `src/preload/index.ts`, add to the `fleetApi` object (next to `images` / `kanban`), using the existing `typedInvoke` / `onChannel` helpers:

```ts
  sessions: {
    list: async (): Promise<SessionSummary[]> => typedInvoke(IPC_CHANNELS.SESSIONS_LIST),
    read: async (args: { agent: SessionAgent; id: string; cwd: string }): Promise<SessionTranscript | null> =>
      typedInvoke(IPC_CHANNELS.SESSIONS_READ, args),
    onChanged: (callback: () => void): Unsubscribe => onChannel(IPC_CHANNELS.SESSIONS_CHANGED, callback)
  },
```

Add the imports at the top of `src/preload/index.ts`:

```ts
import type { SessionAgent, SessionSummary, SessionTranscript } from '../shared/sessions';
```

- [ ] **Step 2: Verify typecheck (confirms `FleetApi` picks up the new namespace)**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 3: Smoke-test the IPC end-to-end**

Run: `npm run dev`, open DevTools console in the Fleet window, run:

```js
await window.fleet.sessions.list()
```

Expected: an array (possibly empty if you have no `~/.rune/sessions` or `~/.claude/projects`). If you have Rune/Claude history, entries appear with `agent`, `title`, `cwd`, `updatedAt`.

- [ ] **Step 4: Commit**

```bash
git add src/preload/index.ts
git commit -m "feat(sessions): expose sessions bridge to renderer"
```

---

## Task 9: Renderer sessions store

**Files:**
- Create: `src/renderer/src/store/sessions-store.ts`

- [ ] **Step 1: Implement the store**

```ts
// src/renderer/src/store/sessions-store.ts
import { create } from 'zustand';
import type { SessionAgent, SessionSummary, SessionTranscript } from '../../../shared/sessions';

type SelectedKey = { agent: SessionAgent; id: string; cwd: string };

type SessionsStoreState = {
  sessions: SessionSummary[];
  isLoaded: boolean;
  selected: SelectedKey | null;
  transcript: SessionTranscript | null;
  isLoadingTranscript: boolean;
  load: () => Promise<void>;
  select: (s: SessionSummary) => Promise<void>;
};

export const useSessionsStore = create<SessionsStoreState>((set, get) => ({
  sessions: [],
  isLoaded: false,
  selected: null,
  transcript: null,
  isLoadingTranscript: false,

  load: async () => {
    const sessions = await window.fleet.sessions.list();
    set({ sessions, isLoaded: true });
    // If a session is open and still present, refresh its transcript.
    const sel = get().selected;
    if (sel && sessions.some((s) => s.agent === sel.agent && s.id === sel.id)) {
      const transcript = await window.fleet.sessions.read(sel);
      set({ transcript });
    }
  },

  select: async (s) => {
    const selected = { agent: s.agent, id: s.id, cwd: s.cwd };
    set({ selected, isLoadingTranscript: true, transcript: null });
    const transcript = await window.fleet.sessions.read(selected);
    // Ignore if the user selected something else meanwhile.
    if (get().selected?.id === s.id) set({ transcript, isLoadingTranscript: false });
  }
}));
```

- [ ] **Step 2: Verify typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/renderer/src/store/sessions-store.ts
git commit -m "feat(sessions): renderer sessions store"
```

---

## Task 10: Resume plumbing (PaneLeaf.cmd → terminal + workspace action)

**Files:**
- Modify: `src/renderer/src/components/PaneGrid.tsx`
- Modify: `src/renderer/src/components/TerminalPane.tsx`
- Modify: `src/renderer/src/store/workspace-store.ts`

- [ ] **Step 1: Forward `cmd` from the leaf in `PaneGrid.tsx`**

In `src/renderer/src/components/PaneGrid.tsx`, in the `<TerminalPane ... />` JSX (the block that passes `serializedContent={...}` and `shellProfileId={leaf.node.shellProfileId}`), add:

```tsx
                cmd={leaf.node.cmd}
```

- [ ] **Step 2: Accept and forward `cmd` in `TerminalPane.tsx`**

In `src/renderer/src/components/TerminalPane.tsx`:

In the `TerminalPaneProps` type (starts at line 14), add:

```ts
  cmd?: string;
```

In the destructured props (the block ending `shellProfileId`), add `cmd,`. Then in the `useTerminal(containerRef, { ... })` call, add:

```ts
    cmd,
    exitOnComplete: false,
```

- [ ] **Step 3: Add the `openResumeTab` action in `workspace-store.ts`**

First add the signature to the store's state type (next to `addTab: (label: string | undefined, cwd: string) => string;`):

```ts
  openResumeTab: (cwd: string, cmd: string, label: string) => void;
```

Then implement it (next to the `addTab` implementation around line 327), mirroring `addTab` but attaching `cmd` to the leaf:

```ts
  openResumeTab: (cwd, cmd, label) => {
    const { id: profileId, pathContext } = resolveDefaultProfile();
    const leaf: PaneLeaf = {
      type: 'leaf',
      id: generateId(),
      cwd,
      cmd,
      shellProfileId: profileId,
      pathContext
    };
    const tab: Tab = {
      id: generateId(),
      label,
      labelIsCustom: true,
      cwd,
      splitRoot: leaf,
      shellProfileId: profileId,
      pathContext
    };
    set((state) => ({
      workspace: { ...state.workspace, tabs: [...state.workspace.tabs, tab] },
      activeTabId: tab.id,
      activePaneId: leaf.id,
      isDirty: true
    }));
  },
```

> Ensure `PaneLeaf` and `Tab` are already imported in `workspace-store.ts` (they are, used by `addTab`).

- [ ] **Step 4: Verify typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/components/PaneGrid.tsx src/renderer/src/components/TerminalPane.tsx src/renderer/src/store/workspace-store.ts
git commit -m "feat(sessions): pane startup command and openResumeTab action"
```

---

## Task 11: Transcript view component

**Files:**
- Create: `src/renderer/src/components/sessions/TranscriptView.tsx`

- [ ] **Step 1: Implement the transcript renderer + Resume button**

```tsx
// src/renderer/src/components/sessions/TranscriptView.tsx
import React from 'react';
import type { SessionSummary, TranscriptBlock, TranscriptMessage } from '../../../../shared/sessions';
import { useSessionsStore } from '../../store/sessions-store';
import { useWorkspaceStore } from '../../store/workspace-store';

function resumeCommand(s: SessionSummary): string {
  return s.agent === 'rune' ? `rune --resume ${s.id}` : `claude --resume ${s.id}`;
}

function Block({ block }: { block: TranscriptBlock }): React.JSX.Element {
  switch (block.type) {
    case 'text':
      return <div className="whitespace-pre-wrap text-sm text-fleet-text">{block.text}</div>;
    case 'tool_use':
      return (
        <div className="text-xs text-fleet-text-subtle font-mono">
          ⚙ {block.name} <span className="opacity-60">{block.argsPreview}</span>
        </div>
      );
    case 'tool_result':
      return (
        <div className={`text-xs font-mono ${block.isError ? 'text-red-400' : 'text-fleet-text-subtle'}`}>
          ↳ {block.output.slice(0, 2000)}
        </div>
      );
    case 'image':
      return <div className="text-xs text-fleet-text-subtle italic">[image]</div>;
  }
}

function Message({ message }: { message: TranscriptMessage }): React.JSX.Element {
  const isUser = message.role === 'user';
  return (
    <div className={`flex flex-col gap-1 ${isUser ? 'items-end' : 'items-start'}`}>
      <span className="text-[10px] uppercase tracking-wider text-fleet-text-subtle">{message.role}</span>
      <div
        className={`max-w-[85%] rounded-md px-3 py-2 ${
          isUser ? 'bg-blue-600/20' : 'bg-fleet-surface-2/60'
        } flex flex-col gap-1`}
      >
        {message.blocks.map((b, i) => (
          <Block key={i} block={b} />
        ))}
      </div>
    </div>
  );
}

export function TranscriptView(): React.JSX.Element {
  const { selected, transcript, isLoadingTranscript } = useSessionsStore();
  const openResumeTab = useWorkspaceStore((s) => s.openResumeTab);

  if (!selected) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-fleet-text-subtle">
        Select a session to view its transcript.
      </div>
    );
  }
  if (isLoadingTranscript || !transcript) {
    return <div className="flex h-full items-center justify-center text-sm text-fleet-text-subtle">Loading…</div>;
  }

  const s = transcript.summary;
  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b border-fleet-border px-4 py-3">
        <div className="min-w-0">
          <div className="truncate text-sm font-semibold text-fleet-text">{s.title}</div>
          <div className="text-xs text-fleet-text-subtle">
            {s.agent} {s.provider ? `· ${s.provider}` : ''} {s.model ? `· ${s.model}` : ''} · {s.messageCount} msgs
          </div>
        </div>
        <button
          onClick={() => openResumeTab(s.cwd, resumeCommand(s), s.title)}
          className="flex-shrink-0 rounded bg-blue-600/80 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-600"
        >
          Resume ▸
        </button>
      </div>
      <div className="flex-1 overflow-y-auto px-4 py-3 flex flex-col gap-3">
        {transcript.messages.map((m, i) => (
          <Message key={i} message={m} />
        ))}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Verify typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/renderer/src/components/sessions/TranscriptView.tsx
git commit -m "feat(sessions): transcript view with resume button"
```

---

## Task 12: Session list component (search + filter + groups)

**Files:**
- Create: `src/renderer/src/components/sessions/SessionList.tsx`

This component owns the agent filter and **persists** changes to `sessions.preferredAgent` via the settings store (default `'rune'`).

- [ ] **Step 1: Implement the list**

```tsx
// src/renderer/src/components/sessions/SessionList.tsx
import React, { useEffect, useMemo, useState } from 'react';
import type { SessionAgentFilter, SessionGroup, SessionSummary } from '../../../../shared/sessions';
import { useSessionsStore } from '../../store/sessions-store';
import { useSettingsStore } from '../../store/settings-store';

function groupByProject(sessions: SessionSummary[]): SessionGroup[] {
  const groups = new Map<string, SessionGroup>();
  for (const s of sessions) {
    const g = groups.get(s.cwd);
    if (g) g.sessions.push(s);
    else groups.set(s.cwd, { project: s.project, cwd: s.cwd, sessions: [s] });
  }
  const result = [...groups.values()];
  for (const g of result) g.sessions.sort((a, b) => b.updatedAt - a.updatedAt);
  result.sort((a, b) => b.sessions[0].updatedAt - a.sessions[0].updatedAt);
  return result;
}

function relativeTime(ms: number): string {
  const diff = Date.now() - ms;
  const min = Math.floor(diff / 60000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min}m`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h`;
  return `${Math.floor(hr / 24)}d`;
}

export function SessionList(): React.JSX.Element {
  const { sessions, selected, select } = useSessionsStore();
  const { settings, updateSettings } = useSettingsStore();
  const filter: SessionAgentFilter = settings?.sessions.preferredAgent ?? 'rune';
  const [query, setQuery] = useState('');

  const setFilter = (next: SessionAgentFilter): void => {
    void updateSettings({ sessions: { preferredAgent: next } });
  };

  const groups = useMemo(() => {
    const q = query.trim().toLowerCase();
    const filtered = sessions
      .filter((s) => filter === 'all' || s.agent === filter)
      .filter((s) => !q || s.title.toLowerCase().includes(q) || s.preview.toLowerCase().includes(q) || s.project.toLowerCase().includes(q));
    return groupByProject(filtered);
  }, [sessions, filter, query]);

  return (
    <div className="flex h-full flex-col border-r border-fleet-border">
      <div className="flex items-center gap-2 border-b border-fleet-border px-3 py-2">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search sessions…"
          className="flex-1 rounded bg-fleet-surface px-2 py-1 text-sm text-fleet-text border border-fleet-border-strong"
        />
        <select
          value={filter}
          onChange={(e) => setFilter(e.target.value as SessionAgentFilter)}
          className="rounded bg-fleet-surface px-2 py-1 text-sm text-fleet-text border border-fleet-border-strong"
        >
          <option value="all">All</option>
          <option value="rune">Rune</option>
          <option value="claude">Claude Code</option>
        </select>
      </div>
      <div className="flex-1 overflow-y-auto">
        {groups.length === 0 ? (
          <div className="px-3 py-6 text-center text-sm text-fleet-text-subtle">No sessions.</div>
        ) : (
          groups.map((g) => (
            <div key={g.cwd}>
              <div className="px-3 py-1 text-[10px] font-semibold uppercase tracking-wider text-fleet-text-subtle bg-fleet-surface/40 truncate">
                {g.project}
              </div>
              {g.sessions.map((s) => {
                const isSel = selected?.agent === s.agent && selected?.id === s.id;
                return (
                  <div
                    key={`${s.agent}-${s.id}`}
                    onClick={() => void select(s)}
                    className={`cursor-pointer px-3 py-2 border-b border-fleet-border/40 ${isSel ? 'bg-blue-600/15' : 'hover:bg-fleet-surface-2/50'}`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="truncate text-sm text-fleet-text">{s.title}</span>
                      <span className="flex-shrink-0 text-[10px] text-fleet-text-subtle">{relativeTime(s.updatedAt)}</span>
                    </div>
                    <div className="flex items-center gap-2 text-[10px] text-fleet-text-subtle">
                      <span className="rounded bg-fleet-surface-2 px-1">{s.agent}</span>
                      {s.model && <span className="truncate">{s.model}</span>}
                      <span>· {s.messageCount} msgs</span>
                    </div>
                  </div>
                );
              })}
            </div>
          ))
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Verify typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/renderer/src/components/sessions/SessionList.tsx
git commit -m "feat(sessions): grouped session list with search and persisted agent filter"
```

---

## Task 13: SessionsTab container + content render wiring

**Files:**
- Create: `src/renderer/src/components/sessions/SessionsTab.tsx`
- Modify: `src/renderer/src/App.tsx`

- [ ] **Step 1: Implement the two-pane container**

```tsx
// src/renderer/src/components/sessions/SessionsTab.tsx
import React, { useEffect } from 'react';
import { SessionList } from './SessionList';
import { TranscriptView } from './TranscriptView';
import { useSessionsStore } from '../../store/sessions-store';
import { useSettingsStore } from '../../store/settings-store';

export function SessionsTab(): React.JSX.Element {
  const load = useSessionsStore((s) => s.load);
  const settingsLoaded = useSettingsStore((s) => s.isLoaded);
  const loadSettings = useSettingsStore((s) => s.loadSettings);

  useEffect(() => {
    if (!settingsLoaded) void loadSettings();
  }, [settingsLoaded, loadSettings]);

  useEffect(() => {
    void load();
    const cleanup = window.fleet.sessions.onChanged(() => void load());
    return cleanup;
  }, [load]);

  return (
    <div className="grid h-full" style={{ gridTemplateColumns: '320px 1fr' }}>
      <SessionList />
      <TranscriptView />
    </div>
  );
}
```

- [ ] **Step 2: Render it for `tab.type === 'sessions'` in `App.tsx`**

In `src/renderer/src/App.tsx`, in the per-type content switch (around line 868, the `tab.type === 'images' ? ... : tab.type === 'kanban' ? <KanbanBoard /> :` chain), add a branch before the final `: (` `<PaneGrid .../>`:

```tsx
                    ) : tab.type === 'sessions' ? (
                      <SessionsTab />
```

Add the import at the top of `App.tsx` (with the other tab component imports):

```ts
import { SessionsTab } from './components/sessions/SessionsTab';
```

- [ ] **Step 3: Verify typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/renderer/src/components/sessions/SessionsTab.tsx src/renderer/src/App.tsx
git commit -m "feat(sessions): two-pane sessions tab and content wiring"
```

---

## Task 14: Sidebar tool card + open trigger

**Files:**
- Create: `src/renderer/src/components/sessions/SessionsTabCard.tsx`
- Modify: `src/renderer/src/components/Sidebar.tsx`
- Modify: `src/renderer/src/store/workspace-store.ts` (`ensureSessionsTab`)
- Modify: `src/renderer/src/lib/commands.ts` (`open-sessions`)

- [ ] **Step 1: Implement the sidebar card**

```tsx
// src/renderer/src/components/sessions/SessionsTabCard.tsx
import React, { useEffect } from 'react';
import { History } from 'lucide-react';
import { useSessionsStore } from '../../store/sessions-store';

export function SessionsTabCard({
  isActive,
  onClick
}: {
  isActive: boolean;
  onClick: () => void;
}): React.JSX.Element {
  const { sessions, isLoaded, load } = useSessionsStore();

  useEffect(() => {
    if (!isLoaded) void load();
  }, [isLoaded, load]);

  useEffect(() => {
    const cleanup = window.fleet.sessions.onChanged(() => void load());
    return cleanup;
  }, [load]);

  return (
    <div
      onClick={onClick}
      className="cursor-pointer rounded-md overflow-hidden relative transition-all"
      style={{
        background: isActive ? '#0d0a1a' : 'rgba(13,10,26,0.4)',
        border: isActive ? '1px solid rgba(96,165,250,0.35)' : '1px solid rgba(255,255,255,0.05)'
      }}
    >
      <div className="relative z-20 flex items-center gap-2.5 px-2.5 py-2">
        <div className="flex-shrink-0 w-8 h-8 rounded-sm overflow-hidden bg-fleet-surface-2/50 flex items-center justify-center">
          <History size={16} className={isActive ? 'text-blue-400' : 'text-blue-400/50'} />
        </div>
        <div className="flex-1 min-w-0">
          <div style={{ fontSize: '9px' }}>Sessions</div>
          <span className="text-[9px]">{sessions.length > 0 ? `${sessions.length} saved` : 'none yet'}</span>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Add `ensureSessionsTab` to `workspace-store.ts`**

Add the helper near `ensureImagesTab` (the standalone `function ensureImagesTab(workspace)` around line 86):

```ts
function ensureSessionsTab(workspace: Workspace): Workspace {
  if (workspace.tabs.some((t) => t.type === 'sessions')) return workspace;
  const cwd = workspace.tabs[0]?.cwd ?? '/';
  const sessionsTab: Tab = {
    id: generateId(),
    label: 'Sessions',
    labelIsCustom: true,
    cwd,
    type: 'sessions',
    splitRoot: createLeaf(cwd)
  };
  return { ...workspace, tabs: [sessionsTab, ...workspace.tabs] };
}
```

Add the action to the store state type (next to `ensureImagesTab: () => void;`):

```ts
  ensureSessionsTab: () => void;
```

Add the action implementation (next to the `ensureImagesTab:` action around line 870):

```ts
  ensureSessionsTab: () => {
    set((state) => {
      const updated = ensureSessionsTab(state.workspace);
      if (updated === state.workspace) return state;
      return { workspace: updated, isDirty: true };
    });
  },
```

- [ ] **Step 3: Render the card in the Sidebar TOOLS section**

In `src/renderer/src/components/Sidebar.tsx`:

Update the TOOLS-section guard (around line 1367) to include `'sessions'`:

```ts
      {workspace.tabs.some(
        (t) => t.type === 'images' || t.type === 'annotate' || t.type === 'kanban' || t.type === 'sessions'
      ) && (
```

Add the card block inside the TOOLS section (after the annotate `.filter(...).map(...)` block, before the closing `</div>` at line 1406):

```tsx
          {/* Sessions tab (pinned, not closeable) */}
          {workspace.tabs
            .filter((tab) => tab.type === 'sessions')
            .map((tab) => (
              <SessionsTabCard
                key={tab.id}
                isActive={tab.id === activeTabId}
                onClick={() => setActiveTab(tab.id)}
              />
            ))}
```

Add the import at the top of `Sidebar.tsx`:

```ts
import { SessionsTabCard } from './sessions/SessionsTabCard';
```

- [ ] **Step 4: Add the command-palette entry**

In `src/renderer/src/lib/commands.ts`, add after the `open-kanban` command object (around line 173):

```ts
    {
      id: 'open-sessions',
      label: 'Open Sessions',
      category: 'Tabs',
      execute: () => {
        const ws = useWorkspaceStore.getState();
        ws.ensureSessionsTab();
        const sessions = useWorkspaceStore.getState().workspace.tabs.find((t) => t.type === 'sessions');
        if (sessions) ws.setActiveTab(sessions.id);
      }
    }
```

> Add a comma after the `open-kanban` object's closing brace if needed so the array stays valid.

- [ ] **Step 5: Verify typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 6: Manual verify**

Run: `npm run dev`. Open the command palette, run **Open Sessions**. The Sessions tab appears pinned in the TOOLS section and opens the two-pane view. Selecting a session renders its transcript; **Resume ▸** opens a new terminal tab in the session's cwd running the resume command.

- [ ] **Step 7: Commit**

```bash
git add src/renderer/src/components/sessions/SessionsTabCard.tsx src/renderer/src/components/Sidebar.tsx src/renderer/src/store/workspace-store.ts src/renderer/src/lib/commands.ts
git commit -m "feat(sessions): sidebar tool card and open-sessions command"
```

---

## Task 15: Preferred-agent setting in the Rune settings section

**Files:**
- Modify: `src/renderer/src/components/settings/RuneSection.tsx`

The list dropdown already persists `sessions.preferredAgent`; this adds a discoverable control in Settings using the same value.

- [ ] **Step 1: Add the dropdown to `RuneSection`**

In `src/renderer/src/components/settings/RuneSection.tsx`, inside the rendered section (using the existing `SettingRow` + `useSettingsStore` pattern from `GeneralSection`), add:

```tsx
<SettingRow label="Sessions: preferred agent">
  <select
    value={settings.sessions.preferredAgent}
    onChange={(e) =>
      updateSettings({ sessions: { preferredAgent: e.target.value as SessionAgentFilter } })
    }
    className="bg-fleet-surface text-fleet-text text-sm rounded px-2 py-1 border border-fleet-border-strong"
  >
    <option value="rune">Rune</option>
    <option value="claude">Claude Code</option>
    <option value="all">All</option>
  </select>
</SettingRow>
```

Ensure these are imported/available in `RuneSection.tsx`:
- `useSettingsStore` (and destructure `const { settings, updateSettings } = useSettingsStore();`)
- `SettingRow` from `./SettingRow`
- `import type { SessionAgentFilter } from '../../../../shared/sessions';`

Guard for `settings` being `null` the same way the file/other sections already do (e.g. `if (!settings) return null;`).

- [ ] **Step 2: Verify typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 3: Manual verify**

Run: `npm run dev`, open Settings → Rune. Change "preferred agent" to Claude Code; reopen the Sessions tab — the list filter reflects the change. Switching the in-list dropdown back to Rune and reopening Settings shows Rune selected (shared persisted value).

- [ ] **Step 4: Commit**

```bash
git add src/renderer/src/components/settings/RuneSection.tsx
git commit -m "feat(sessions): preferred-agent setting in Rune settings section"
```

---

## Task 16: Full verification pass

**Files:** none (verification only)

- [ ] **Step 1: Typecheck**

Run: `npm run typecheck`
Expected: PASS (both `typecheck:node` and `typecheck:web`).

- [ ] **Step 2: Lint**

Run: `npm run lint`
Expected: No new errors introduced by these files. (Repo lint may be pre-existing-red; confirm none of the new `src/main/sessions/**`, `src/renderer/src/components/sessions/**`, or modified files add errors.)

- [ ] **Step 3: Run the new unit tests**

Run: `npx vitest run src/main/sessions`
Expected: PASS (rune-source, claude-source, aggregate).

- [ ] **Step 4: Build**

Run: `npm run build`
Expected: PASS.

- [ ] **Step 5: End-to-end manual check**

Run: `npm run dev`. Verify:
- Open Sessions (command palette) → Rune sessions listed, grouped by project, newest first.
- Filter dropdown → All shows Claude sessions too; choice persists after closing/reopening the tab.
- Click a session → full transcript renders.
- Resume ▸ → new tab in the session's cwd runs `rune --resume <id>` (requires [rune#17](https://github.com/khang859/rune/issues/17)) / `claude --resume <id>`.
- Start a new turn in a live Rune/Claude session → the list refreshes within ~1s (fs.watch).

- [ ] **Step 6: Final commit (if any verification fixups were needed)**

```bash
git add -A
git commit -m "chore(sessions): verification fixups"
```

---

## Self-Review Notes

**Spec coverage:**
- Library / browse / global+grouped-by-project → Tasks 5, 12.
- Rune + Claude sources → Tasks 3, 4, 6.
- Full rendered transcript → Tasks 4, 11.
- Resume into new tab in cwd → Tasks 10, 11.
- Agent filter + preferred agent (default `'rune'`, persists on change) → Tasks 2, 12, 15.
- Live freshness (fs.watch) → Tasks 6, 7, 13.
- Pinned tool tab in TOOLS section → Tasks 13, 14.
- zod at disk boundary → Task 3 (Rune); Claude reuses the validated `ConversationReader`.
- Forward-compat for DAG tree (fleet#222) → normalized `SessionTranscript` carries messages only in v1; the Rune source retains the node graph internally and the shape is additive, so the tree can attach later without breaking the renderer contract.

**Deferred (not in this plan):** DAG tree viz, rename/delete, subagent drill-down, usage analytics, export, resume-in-current-pane.

**Type consistency:** `SessionSummary`, `SessionTranscript`, `TranscriptMessage`, `TranscriptBlock`, `SessionAgent`, `SessionAgentFilter` defined once in `src/shared/sessions.ts` and used unchanged across main, preload, and renderer. `openResumeTab(cwd, cmd, label)` signature matches between the store type, implementation, and `TranscriptView` call site. `window.fleet.sessions.{list,read,onChanged}` matches between preload and both store/components.
