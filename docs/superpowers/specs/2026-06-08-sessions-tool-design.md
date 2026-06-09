# Sessions Tool — Design

**Date:** 2026-06-08
**Status:** Approved for planning
**Companion issues:** [khang859/rune#17](https://github.com/khang859/rune/issues/17) (`rune --resume <id>` flag), [khang859/fleet#222](https://github.com/khang859/fleet/issues/222) (branch/DAG tree — deferred fast-follow)

## Summary

A new pinned **Sessions** tool in the Tools section: a global, project-grouped library of past agent conversations — **Rune** (`~/.rune/sessions/*.json`) and **Claude Code** (`~/.claude/projects/*/*.jsonl`). Click a session to read its **full rendered transcript** in-app; hit **Resume** to continue it in a new terminal tab `cd`'d to its original working directory.

Rune is the priority harness; Claude Code is included because Fleet already parses its transcripts (`conversation-reader.ts`), so it's nearly free.

## Goals

- Browse every past Rune and Claude Code session in one place, grouped by project, searchable.
- Filter by agent (All / Rune / Claude Code) and set a **preferred agent** that defaults the view.
- Read a session's full transcript without resuming it.
- Resume a session into a new terminal tab in its original `cwd`.
- Stay fresh as sessions change on disk (live refresh).

## Non-goals (v1)

Branch/DAG tree visualization ([fleet#222](https://github.com/khang859/fleet/issues/222)) · rename/delete sessions from Fleet · subagent drill-down · token-usage analytics · export/share · "resume in current pane."

## Architecture

A new **`src/main/sessions/`** module in the main process with a per-agent adapter interface. Everything normalizes to one shape so the renderer never branches on agent type.

```
interface SessionSource {
  agent: 'rune' | 'claude'
  list(): Promise<SessionSummary[]>          // cheap: directory scan + per-file metadata
  read(id: string): Promise<SessionTranscript>  // full parse of one session
  watchPaths(): string[]                      // dirs to fs.watch for liveness
}
```

### Normalized model (`src/main/sessions/types.ts`, mirrored in `src/shared/types.ts`)

```ts
type SessionAgent = 'rune' | 'claude'

interface SessionSummary {
  agent: SessionAgent
  id: string
  title: string          // Rune: name, else preview; Claude: derived summary/first msg
  project: string        // display name for the cwd group (basename or git root name)
  cwd: string            // absolute; used for grouping + resume
  model?: string
  provider?: string      // Rune only
  updatedAt: number      // epoch ms (file mtime)
  messageCount: number
  preview: string        // first user message on the active path, truncated
}

interface SessionTranscript {
  summary: SessionSummary
  messages: TranscriptMessage[]   // root -> active path, flattened (v1)
  // NOTE: the underlying graph is intentionally NOT discarded at read time;
  // see "Forward-compat" — the shape must be able to carry the full node
  // graph later (fleet#222) without a breaking change.
}

interface TranscriptMessage {
  role: 'user' | 'assistant' | 'tool'
  blocks: TranscriptBlock[]
  createdAt?: number
}

type TranscriptBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; name: string; args: unknown; id?: string }
  | { type: 'tool_result'; toolCallId?: string; output: string; isError?: boolean }
  | { type: 'image'; mimeType: string; data: string }
```

All disk-read JSON is validated with **zod** at the boundary (no `as` casts) — both formats are external/untrusted and may be malformed; malformed files are skipped gracefully in `list()` and surface a clear error in `read()`.

### Adapters

**`rune-source.ts`**
- `list()`: scan `$RUNE_DIR/sessions/*.json` (default `~/.rune/sessions`). For each, read the file and pull `id`, `name`, `model`, `provider`, `cwd`, message count (nodes with `has_message`), and a preview by walking `active_id → root` to the first `role: "user"` node. `updatedAt` = file mtime.
- `read(id)`: load the session, reconstruct parent/child pointers, walk `root_id → active_id`, normalize each node's polymorphic content blocks (`text` / `tool_use` / `tool_result` / `image` / `document`) into `TranscriptBlock[]`. (Full node graph retained internally — see forward-compat.)
- Schema reference: `../rune/internal/session/persist.go`, `../rune/internal/ai/types.go`.

**`claude-source.ts`**
- Built on the existing `src/main/copilot/conversation-reader.ts` (already parses `~/.claude/projects/*/<sessionId>.jsonl`). Extend it to also enumerate sessions (`list()`) and produce a `SessionSummary` per `.jsonl` (id = filename stem, cwd from the project dir mapping, title/preview from first user message, `updatedAt` from mtime). Claude transcripts are linear.

**`index.ts` (aggregator)**
- Runs both sources, merges, sorts by `updatedAt` desc, and groups by `project`/`cwd`. Applies the agent filter (see Settings). Exposes `listSessions(filter)`, `readSession(agent, id)`, and `resumeSession(agent, id, cwd)`.

## Data flow

```
~/.rune/sessions/*.json ─┐
                         ├─► main: SessionSource adapters ─► IPC ─► renderer SessionsTab
~/.claude/.../*.jsonl ───┘         │
                                   └─ fs.watch (recursive, debounced 500ms)
                                       └─► "sessions:changed" event ─► renderer refetches list
```

### IPC surface (mirrors `copilot` / `kanban` bridges)

- `sessions:list` → `SessionSummary[]` (respects current filter/preferred-agent).
- `sessions:read` `(agent, id)` → `SessionTranscript`.
- `sessions:resume` `(agent, id, cwd)` → creates a new terminal tab (reusing Fleet's existing tab-creation flow) in `cwd`, auto-running the resume command.
- `sessions:changed` (pushed) → renderer invalidates and refetches the list; if the open transcript's file changed, it refetches too.

Liveness uses `fs.watch` on each source's `watchPaths()` with a 500ms debounce; falls back to a manual refresh button if a watcher errors.

## Resume

`sessions:resume` opens a **new terminal tab** `cd`'d to the session's `cwd` and runs:

- Rune: `rune --resume <id>` — the flag is being added in parallel under [rune#17](https://github.com/khang859/rune/issues/17), so v1 assumes it exists; no fallback path.
- Claude Code: `claude --resume <id>`.

Each resumed session gets its own tab (no clobbering of the focused pane in v1).

## UI

### Sidebar

New `'sessions'` value in the `Tab` `type` union (`src/shared/types.ts`) and a `SessionsTabCard` in the **Tools** section of `Sidebar.tsx`, alongside Kanban / Images / Annotate — pinned, non-closable, matching the existing tool-card styling and active-glow treatment.

### Sessions tab — two panes

```
┌───────────────────────────────┬─────────────────────────────────────┐
│ 🔍 search…        [All ▾]      │  Fix auth bug          [Resume ▸]   │
│                               │  rune · groq · 14 msgs · 2h ago     │
│ ▼ myapp                        │  ─────────────────────────────────  │
│   • Fix auth bug    rune  2h   │  you ▸ fix the login issue…         │
│   • Refactor api    cc    1d   │  rune ▸ I found it in auth.go…      │
│ ▼ fleet                        │        ⚙ read auth.go               │
│   • Sessions tool   rune  5m   │  you ▸ …                            │
└───────────────────────────────┴─────────────────────────────────────┘
```

- **Left — list:** search box + an **agent filter** dropdown (`All` / `Rune` / `Claude Code`). Sessions grouped by project (collapsible), newest-first within each group. Rows show title/preview, agent + model badges, relative time, message count.
- **Right — transcript:** the **full rendered transcript** of the selected session (read-only), reusing the copilot chat's markdown + tool-call rendering. Header shows title + metadata and a primary **Resume ▸** button.

### Agent filter + preferred agent (new requirement)

- The list has an **agent filter** with three options: **All**, **Rune**, **Claude Code**. It controls which sessions are shown.
- The selection is **persisted**: it's backed by `sessions.preferredAgent` (`'all' | 'rune' | 'claude'`, default `'rune'`) in the existing settings store (`settings-store.ts`). The tab opens to the saved value, and switching the dropdown **writes back to the setting immediately** — so the choice sticks across tab reopens and app restarts.
- Default is **`'rune'`** (Rune is the priority harness): out of the box the library shows only Rune sessions until the user switches to `All` or `Claude Code`.

## Forward-compat (for fleet#222)

The branch/DAG tree is deferred, but the v1 read path must not foreclose it:

- `rune-source.read()` retains the full node graph internally; `SessionTranscript` is shaped so the graph (ids, parent/children, per-node usage, `compacted_count`, subagents) can be attached later without a breaking change to the renderer contract.
- v1 renders only the flattened `root → active` path.

## Testing / verification

- **Adapter unit tests** (vitest): zod parsing of representative Rune `.json` (incl. branching, compaction, tool blocks) and Claude `.jsonl` fixtures → expected `SessionSummary` / `SessionTranscript`; malformed-file handling (skipped in `list`, errors in `read`).
- **Aggregator tests:** merge + sort + group-by-project; agent filter; `preferredAgent` persistence (switching writes back, reopen restores, default is `'rune'`).
- **Manual:** real `~/.rune/sessions` and `~/.claude/projects` render correctly; live refresh fires on a new turn; Resume opens a new tab in the right cwd and runs the right command (Rune behind rune#17).
- `npm run typecheck` and `npm run lint` clean.

## Build sequence

1. Normalized types + zod schemas (`src/main/sessions/types.ts`, shared types). → verify: typecheck.
2. `rune-source.ts` + tests. → verify: vitest fixtures pass.
3. `claude-source.ts` on top of `conversation-reader.ts` + tests. → verify: vitest.
4. Aggregator + IPC handlers + `fs.watch` liveness. → verify: manual IPC smoke.
5. `'sessions'` tab type + `SessionsTabCard` in Sidebar. → verify: tab opens, pinned.
6. SessionsTab two-pane UI: list (search + group), transcript (reuse copilot rendering), Resume button. → verify: real data renders, resume opens tab.
7. Agent filter dropdown + `sessions.preferredAgent` setting (default `'rune'`, persists on change) + settings-page control. → verify: filter works, switching persists across reopen/restart.
8. Final typecheck + lint pass.
