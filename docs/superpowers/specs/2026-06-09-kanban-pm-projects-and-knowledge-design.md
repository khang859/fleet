# Kanban PM: Board Projects & Knowledge Design

**Date:** 2026-06-09
**Status:** Approved design, pre-implementation

## Problem

The PM chat agent (`pm-chat-service.ts`) runs headless rune in an empty scratch
dir (`~/.fleet/kanban/pm/<boardId>/`) with board-scoped kanban MCP tools. It has
no idea which project folders the board's work lives in, cannot read code, and
has nowhere to keep PRDs or accumulated knowledge. Tickets it creates carry no
`repoPath`, so dispatched work doesn't land in the right repo.

Two interlocking gaps:

1. **Code context** — the PM doesn't know which folders/repos the board covers.
2. **Knowledge context** — PRDs, specs, decisions, and learnings accumulate as a
   project evolves, and Fleet has nowhere to put them.

## Decision summary

- Boards stay **multi-project** (not folder-scoped). Research note: planning
  tools that repo-scoped boards (GitHub classic Projects) abandoned it;
  Vibe Kanban's redesigned workspaces headline multi-repo support. Repo-scoped
  boards also can't represent cross-repo features, and Fleet features inherit
  `repoPath` to member tasks within one board.
- Each board has a **default project** so the common single-repo case has zero
  routing friction (behaves like a folder-scoped board).
- The PM reads code with **rune's native file tools** via absolute paths
  injected into its prompt (approach A). Fallback if rune sandboxes reads to
  cwd: scoped `kanban_read_file`/`kanban_grep` MCP tools (approach B) — registry,
  routing, and UI are unchanged either way.
- Board knowledge lives as **files in the PM's cwd** (`docs/` + `MEMORY.md`),
  not in SQLite and not in project repos. The PM maintains them with native
  file tools.
- Per-ticket flowback reuses the **existing task-artifact system**: the PM gains
  read access to ticket artifacts instead of a new comment-based mechanism.

## Phase 1: Project registry

### Data model

New `projects` table in `kanban.db` (`schema.ts`):

| column        | type    | notes                                       |
| ------------- | ------- | ------------------------------------------- |
| `id`          | TEXT PK | short uuid                                  |
| `board_id`    | TEXT    | FK → boards(slug), cascade delete           |
| `name`        | TEXT    | short label, e.g. `fleet`                   |
| `path`        | TEXT    | absolute folder path                        |
| `description` | TEXT    | nullable one-liner                          |
| `is_default`  | INTEGER | exactly one per board (when any rows exist) |
| timestamps    |         | `created_at`, `updated_at`                  |

Unique `(board_id, name)` and `(board_id, path)`.

- First project added to a board becomes default automatically.
- Removing the default promotes the oldest remaining project (or none).
- `KanbanStore`: `listProjects(boardId)`, `addProject`, `removeProject`,
  `setDefaultProject`.
- `KanbanCommands` wraps with validation: path exists and is a directory,
  non-empty name, no duplicates. Existence is checked only at add time — no
  background re-checks; a later-moved folder surfaces as failed PM reads.
- `Project` interface in `src/shared/kanban-types.ts`.

### PM prompt injection

`PM_AGENTS_MD` becomes a generator function. Each turn (`sendMessage` already
rewrites `AGENTS.md`), append:

```
## Projects on this board
- fleet → /Users/…/fleet — Electron terminal multiplexer (default)
- fleet-site → /Users/…/fleet-site — landing page

Read code in these folders with your file tools (absolute paths) to ground
tickets in reality. Read-only: never edit or create files in project folders.
When creating tickets, pass the relevant project name; assume the default
project unless the ticket clearly belongs elsewhere.
```

### MCP tools (board-scoped, added to PM_TOOLS)

- `kanban_project_list` — name, path, description, default flag.
- `kanban_project_add(name, path, description?)` — same validation as UI.
- `kanban_project_remove(name)`.

### Ticket routing

- `kanban_create` / `kanban_feature_create` gain optional `project` (registered
  name) → resolves to the project's path, stored in the existing `repoPath`
  field (a path snapshot — no FK, so removing a project never touches existing
  tickets).
- Param omitted → default project's path. Unknown name → error listing valid
  names (PM self-corrects). Zero projects on the board → today's behavior.

### UI

"Projects" dialog opened from the Kanban toolbar (next to the PM button):

- Rows: name, path, description, default badge; actions: set default, remove.
- Add via existing `showFolderPicker`; name pre-filled from folder basename,
  editable; optional description.
- Adding a project also updates `fleet:recent-folders`.

## Phase 2: Board knowledge

### Layout

The PM's cwd becomes the board knowledge home:

```
~/.fleet/kanban/pm/<boardId>/
  AGENTS.md      generated persona (as today)
  MEMORY.md      decisions & learnings, PM-curated
  docs/          PRDs / specs, PM-authored markdown
```

The persona's "never edit files" rule is rescoped: project folders are
read-only; `docs/` and `MEMORY.md` are the PM's to create and maintain (native
file tools, relative paths — works regardless of any rune sandboxing).

### MEMORY.md

- Injected verbatim into the generated `AGENTS.md` every turn (when present).
- Persona instructions: keep it curated and under ~200 lines — decisions made
  and why, constraints discovered, things that failed. Not a log. Knowledge
  worth keeping must graduate here (or into `docs/`) because chat resets drop
  the session.

### Living docs (PRDs / specs)

- PM authors markdown in `docs/` with its file tools; links docs to work via a
  new `docs` field rather than path-parsing ticket bodies.
- `kanban_create` / `kanban_update` gain optional `docs?: string[]` — filenames
  relative to the board's `docs/` dir, validated to exist. Stored as a JSON
  column on tasks.
- At dispatch, the worker prompt inlines the contents of each referenced doc
  (size-capped; oversized docs are truncated with a note). Inlining avoids any
  dependency on workers reading outside their workspace.
- Persona: write a PRD in `docs/` when shaping a multi-ticket effort; reference
  it from each member ticket via `docs` (the field lives on tasks, not
  features); keep it updated as decisions land.

### Artifact flowback (reuses existing system)

Task artifacts (immutable snapshots under `~/.fleet/kanban/artifacts/`) already
capture worker outputs; the gap is PM visibility:

- PM's `kanban_show` output includes the task's kept artifacts (id, title,
  filename, kind, size).
- New PM tool `kanban_artifact_read(artifactId)` — returns text content from
  `storedPath` (board-scoped, text types only, size-capped).
- Persona: when reviewing finished work, read relevant artifacts and distill
  durable knowledge into `MEMORY.md` or the relevant doc in `docs/`.

Living docs are intentionally **not** artifacts: artifacts are immutable
task-scoped outputs (evidence of work); docs are mutable board-scoped inputs.
Extending the artifact schema to cover both would require nullable `taskId` and
mutability, undermining what makes artifacts trustworthy.

## Pre-flight check (implementation task #1)

Verify headless rune launched from the PM scratch dir can read absolute paths
outside its cwd (project folders). Workers suggest file tools are enabled by
default in headless mode, but out-of-cwd reads are unverified. If sandboxed,
swap approach A's "native tools + injected paths" for scoped MCP read tools
(`kanban_read_file`, `kanban_grep` restricted to registered project roots);
everything else in this design is unaffected.

## Out of scope / deferred

- Project suggestions inside task/feature creation modals' folder field.
- A "Board docs" tab in the Artifacts browser (UI for viewing/editing PRDs);
  for now docs are plain files on disk.
- Cached per-project briefs (approach C) — revisit if PM turns feel slow.
- Background existence checks / health badges for registered project paths.
- Devs' own repo-resident docs need no feature: the PM reads them through the
  project registry like any other code.

## Testing & verification

- Vitest: store CRUD + default-promotion logic; command validation (bad path,
  duplicates); MCP tool handlers; `repoPath` resolution (explicit / default /
  unknown / zero-project); `docs` validation and worker-prompt inlining;
  `kanban_artifact_read` scoping (wrong board, non-text, oversized).
- Manual: PM turn that reads real code in a registered project and files a
  correctly-routed ticket; PM writes a PRD and links it; worker receives doc
  content; PM reads a finished task's artifact and updates `MEMORY.md`.

## Implementation order

1. Pre-flight rune absolute-path check (decides A vs B for code reads).
2. Phase 1: registry (schema → store → commands → MCP tools → prompt injection
   → routing → UI).
3. Phase 2: knowledge (persona rescope → MEMORY.md injection → `docs` field +
   worker inlining → PM artifact tools).
