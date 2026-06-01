# Design: Kanban Task Artifacts

**Status:** Reviewed; ready for implementation after the fixes in this document
**Branch:** `feat/kanban-artifacts`
**Author:** (pairing session)
**Date:** 2026-05-31

---

## 1. Problem

Kanban tasks run AI agents that produce files — research documents, generated docs,
code, data. Today those files are effectively invisible and sometimes lost:

- **`scratch` tasks** write into `~/.fleet/kanban/workspaces/<taskId>/`. The
  cleanup helper can delete these ephemeral directories, but the current archive path
  does not consistently persist the scratch workspace path or run the cleanup/warning
  lifecycle. This PR will make that lifecycle explicit so scratch outputs are not
  silently lost.
- **`dir` / `worktree` tasks** write into the user's own folder/worktree — the files
  survive, but nothing in the UI points to them.
- The only agent output surfaced in the UI is the one-line `result` string
  (`KanbanDrawer.tsx:274`), plus comments and run summaries.

There is no way to **see** what a task produced, no way to **keep or discard** those
outputs, and no way to **reuse** one as input to a new task or swarm.

This was researched against Baymard (Save features must be low-friction and
discoverable; don't bury discarded items so they look identical to kept ones) and NN/g
(visibility of system status — make produced output explicit, never silently delete;
progressive disclosure within ~2 levels; separate "kept" from the active working set;
plain labels like "Keep"/"Discard"). Comparable tools (Claude Artifacts, ChatGPT
Canvas, Copilot Workspace, Devin, v0) all give produced content a **dedicated,
persistent surface** with **render/download** and an **explicit reuse chain**.

---

## 2. Goals / Non-goals

### Goals
1. Let an agent **register** a file it produced as a durable task **artifact**.
2. **Surface** artifacts: in the task drawer, as a count badge on cards, and in a
   global cross-board Artifacts browser.
3. Let the user **keep / discard** artifacts; discard is soft and recoverable, with a
   retention window that eventually frees disk.
4. Let the user **reuse** an artifact as input to a **new task** or a **new swarm**.
5. **Never silently lose** scratch outputs: persist scratch workspace paths and warn
   when archiving a task whose workspace still holds unregistered files before cleanup.

### Non-goals (this PR)
- Automatic scanning/capture of every file an agent touches (capture is explicit; a
  light archive-time *warning* is the only safety net — see §6).
- Git-backed artifact history / versioning (explicitly dropped — see §11).
- Editing artifacts in place, diff/version timelines beyond per-run grouping.
- Syncing `dir`/`worktree` artifacts back to the user's repo (we snapshot a copy).

---

## 3. Decisions (locked with the user)

| # | Decision | Choice |
|---|---|---|
| D1 | How files become artifacts | **Agent registers** via a new MCP tool `kanban_artifact` |
| D2 | What counts as an artifact | All file types; UI shows **documents first**, others collapsible |
| D3 | Where artifacts are surfaced | Drawer **Outputs** section + card **badge** + **global Artifacts tab** + per-run grouping |
| D4 | Discard semantics | **Soft-hide, recoverable**, with a **retention-period** purge |
| D5 | Storage engine | **Files + DB** (no git) — `~/.fleet/kanban/artifacts/<boardId>/<taskId>/` + `task_artifacts` table |
| D6 | Storage location | Hidden under `~/.fleet` (consistent with existing Fleet data) |
| D7 | Reuse mechanism | **Attach a copy** via an atomic seeded-create command (reusing the attachment copy path); see §8.3 |
| D8 | Scratch safety net | **Warn on archive** if unregistered files remain |
| D9 | Delivery | **One PR**, everything at once |

> D5 changed from an earlier "per-board git repo" idea after three validation passes
> flagged it as a concurrency/bloat/lifecycle liability (see §11).

---

## 4. Data model

New table `task_artifacts` (schema **v6 → v7**; added to `SCHEMA_SQL` with
`CREATE TABLE IF NOT EXISTS`, so no migration ladder block is needed).

> **Why no `if (current < 7)` ladder block is needed (this confused a reviewer).**
> `migrate()` runs `this.db.exec(SCHEMA_SQL)` **unconditionally and first**
> (`kanban-store.ts:62`), *before* the version-gated blocks. So a brand-new
> `CREATE TABLE IF NOT EXISTS task_artifacts` in `SCHEMA_SQL` is created on every
> startup — including when upgrading an existing v6 DB — and `user_version` is then set
> to 7 at the end of `migrate()`. Ladder blocks (`addColumnIfMissing`) exist only to
> backfill **columns on pre-existing tables**, which `CREATE TABLE` in `SCHEMA_SQL`
> cannot do. A wholly new table needs no ladder block; only the `SCHEMA_VERSION` bump.

```sql
CREATE TABLE IF NOT EXISTS task_artifacts (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  run_id INTEGER,                 -- the run that produced it (for per-run grouping)
  board_id TEXT NOT NULL,
  title TEXT,                     -- optional agent-supplied display name
  filename TEXT NOT NULL,
  source_rel_path TEXT NOT NULL,  -- canonical workspace-relative path registered by the agent
  stored_path TEXT NOT NULL,      -- ~/.fleet/kanban/artifacts/<board>/<task>/<id>__<file>
  kind TEXT NOT NULL DEFAULT 'other',     -- document | code | data | other
  content_type TEXT,
  size INTEGER NOT NULL,
  state TEXT NOT NULL DEFAULT 'kept',     -- kept | discarded
  created_at INTEGER NOT NULL,
  discarded_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_artifacts_task  ON task_artifacts(task_id);
CREATE INDEX IF NOT EXISTS idx_artifacts_board ON task_artifacts(board_id);
CREATE INDEX IF NOT EXISTS idx_artifacts_state ON task_artifacts(state);
```

Shared TypeScript types (`src/shared/kanban-types.ts`):

```ts
type ArtifactKind  = 'document' | 'code' | 'data' | 'other';
type ArtifactState = 'kept' | 'discarded';

interface TaskArtifact {
  id; taskId; runId: number | null; boardId;
  title: string | null; filename; sourceRelPath: string; storedPath;
  kind: ArtifactKind; contentType: string | null; size;
  state: ArtifactState; createdAt; discardedAt: number | null;
}

interface ArtifactListItem extends TaskArtifact {  // for the global browser
  taskTitle: string; boardName: string;
}
```

Notes:
- `board_id` stores the immutable board slug, not the display name. Board renames do
  not move artifact files.
- `source_rel_path` is the normalized, workspace-relative path originally registered
  by the agent. It exists specifically so archive-time scratch cleanup can distinguish
  already registered outputs from unregistered leftovers; comparing only `filename` or
  `stored_path` is incorrect for nested files and duplicate basenames.
- `storedPath` is main-process data. Renderer preview/download/reveal actions go
  through explicit IPC; renderer code must not read arbitrary paths directly.

Extended:
- `BoardCard` gains `artifactCount: number` (kept artifacts only).
- `TaskDetail` gains `artifacts: TaskArtifact[]`.

---

## 5. On-disk layout

```
~/.fleet/kanban/
  kanban.db
  attachments/<taskId>/<id>__<file>        (existing — inputs to a task)
  workspaces/<taskId>/                      (existing — scratch cwd; explicit archive cleanup)
  worktrees/<taskId>/                       (existing)
  artifacts/<boardId>/<taskId>/<id>__<file> (NEW — durable task outputs)
```

A copy lives at `stored_path` independent of the task's workspace — a **snapshot** taken
at registration time. Why the copy is necessary per workspace kind:
- **scratch:** the workspace dir is deleted on archive — the copy (made at registration,
  before any cleanup) is the only durable trace.
- **worktree:** the worktree is torn down on archive (`removeWorktree`) — so, as with
  scratch, the copy is **necessary** for durability, not merely a convenience.
- **dir:** the workspace is the user's real folder and survives, but the original file may
  later be edited or deleted by the user; the snapshot preserves what the run produced.

In all three cases the artifact is a point-in-time copy, decoupled from the original.

---

## 6. Capture flow (agent → artifact)

### New MCP tool — `kanban_artifact`
Added to `WORKER_TOOLS` in `kanban-mcp-server.ts`. Because `DECOMPOSE_TOOLS` includes
`WORKER_TOOLS`, the tool is available in **work** and **decompose** runs. It is not added
to `SPECIFY_TOOLS` unless a later use case needs specify-mode artifacts.

```jsonc
{
  "name": "kanban_artifact",
  "description": "Register an output file you produced as a durable task artifact.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "path":  { "type": "string" },                 // relative to the task workspace
      "title": { "type": "string" },                 // optional display name
      "kind":  { "type": "string", "enum": ["document","code","data","other"] }
    },
    "required": ["path"]
  }
}
```

Handler (`handleToolCall`, new `case 'kanban_artifact'`):
1. Resolve the task: `task = store.getTask(scope.taskId)` → gives `boardId` and, after
   the workspace persistence change below, `workspacePath`. `scope.runId` is the
   producing run.
2. If `task.workspacePath` is still null → error (`workspace not ready`). Do not guess a
   path in the MCP handler; workspace resolution belongs to the dispatcher/workspace
   layer.
3. `store.addArtifact({ taskId, runId, boardId, workspaceRoot, relPath: path, title, kind })`.
   `prepareArtifactFile` returns both the copied artifact metadata and the canonical
   `sourceRelPath` to persist in `task_artifacts.source_rel_path`.
4. `appendEvent(taskId, runId, 'artifact_added', { id, filename })` → drives the live
   UI refresh and the card badge.
5. Return the artifact id as text.

### Workspace persistence correction
`main/index.ts` currently persists `workspacePath` only for newly-created worktrees.
This feature changes `prepareWorkspaceFn` to call `setWorkspace` for **scratch** tasks
as well when the path is missing. That makes the MCP handler, archive warning, and
future task detail views use the same persisted workspace path.

### Validation (in `artifact-files.ts:prepareArtifactFile`)
Mandatory, from the security review.

**Threat model note (this is why realpath alone is insufficient).** The adversary here is
the **agent running concurrently in the workspace** — it both supplies `path` *and* controls
the filesystem while the handler runs. So any design that validates a path *string* and then
copies by re-resolving that string has a **TOCTOU** window: between the check and the copy the
agent can swap `report.md` for a symlink to `~/.ssh/id_rsa` or `/etc/shadow`, and the copy
follows it — landing a host secret into durable, previewable, cross-board-shareable storage.
`fs.realpathSync` + `lstat` + later `copyFileSync(path, …)` has exactly this gap; realpath does
**not** "block symlinked targets and traversal" once a concurrent writer exists.

Therefore validation and copy must operate on **one kernel file handle** wherever the
platform exposes enough fd/path information, and must never silently fall back to naive
string-prefix validation:
- **Reject absolute paths** and any path containing a `..` segment (cheap pre-checks).
- **Open non-blocking and no-follow.** Use `fs.openSync(join(workspaceRoot, path),
  fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK)` where the
  constants exist. `O_NOFOLLOW` makes a symlink leaf fail with `ELOOP`; `O_NONBLOCK`
  prevents a FIFO/device from hanging the MCP handler before `fstat`. On platforms where
  `O_NOFOLLOW`/`O_NONBLOCK` are unavailable, use the closest native equivalent and keep the
  `fstat`/bounded-copy checks below.
- **`fstat` the fd** (not `lstat` the string): require a **regular file** (reject dirs,
  fifos, devices, sockets) and read the size from the fd. A preliminary `lstat` is allowed
  only as a cheap early rejection for obvious non-regular files; the fd `fstat` is the
  authoritative check.
- **Confirm containment via the fd's real path when available.** Canonicalize the workspace
  root once with `fs.realpathSync(workspaceRoot)`, then resolve the opened fd's actual path
  and require it to live inside the canonical workspace root.
  - Linux: `fs.realpathSync('/proc/self/fd/' + fd)`.
  - macOS: use `/dev/fd/<fd>` only if verified to return the opened file's canonical path on
    the target Electron/Node runtime. If not, fall back to the best-effort parent strategy
    below and keep the limitation documented.
  - Windows: Node does not expose `GetFinalPathNameByHandle`; either add a small native
    helper for handle → final path or use the best-effort parent strategy below.
  - **Best-effort fallback (accepted v1 limitation outside platforms with fd path
    introspection):** canonicalize the workspace root and the target parent directory before
    opening; require the parent to live inside the root; open with no-follow/non-blocking;
    `fstat` the fd; then canonicalize the parent again and require it to match. This blocks
    ordinary traversal/symlink mistakes but is not a perfect defense against a malicious
    concurrent directory-swap adversary because Node lacks `openat`-style APIs. Do not claim
    the strong TOCTOU guarantee on fallback platforms; a native helper/openat follow-up is in
    §12a.
- **25 MB cap — enforced from the fd's `fstat` size**, before copying. The copy itself is
  also **bounded**: copy at most the `fstat` size, count bytes as they are read, and abort +
  delete the temp file if copied bytes exceed `MAX_BYTES` or if a post-copy `fstat` shows the
  source grew/changed during capture. Do not stream to EOF without a byte limit; otherwise a
  file that grows after the initial `fstat` can bypass the cap.
- **Copy from the fd**, not the path: stream/read the open fd to a temp file with the bounded
  byte accounting above, then rename into place (no partial files, no path re-resolution).
  > The existing `attachments.ts` containment check uses the weaker string-prefix pattern
  > (`resolve(storedPath).startsWith(resolve(taskDir) + sep)`). It is **not currently
  > exploitable** there — the attachment source comes from a user file-picker dialog and the
  > stored name is basename-sanitized, so there is no concurrent adversary supplying the source.
  > We still do not reuse it verbatim; back-porting the handle-based discipline to attachments is
  > a hygiene follow-up (§12a), not an active-vuln fix.
- `kind` defaults from the file extension when the agent omits it (`guessKind`). The
  initial map is explicit and boring:
  - `document`: `.md`, `.markdown`, `.txt`, `.rst`, `.adoc`, `.html`, `.htm`, `.pdf`
  - `code`: common source/config/script extensions such as `.ts`, `.tsx`, `.js`, `.jsx`,
    `.py`, `.go`, `.rs`, `.java`, `.c`, `.cpp`, `.h`, `.json`, `.yaml`, `.yml`, `.toml`,
    `.xml`, `.css`, `.scss`, `.sh`, `.sql`
  - `data`: `.csv`, `.tsv`, `.jsonl`, `.ndjson`, `.parquet`, `.sqlite`, `.db`
  - else `other`

Multiple `kanban_artifact` calls per run are fine — each is one row + one file copy.

> **Accepted risk (honor-system capture) — with a v1 mitigation.** For a `dir` task,
> `workspaceRoot` is the user's real project directory, so an agent *can* register any file
> inside it — not only ones it created this run. This is more than a capture nuisance: a
> registered `.env`/key is **copied out of the project into `~/.fleet`** (surviving the
> original per the snapshot semantics, §5), becomes **previewable and cross-board browsable**
> in the global Artifacts tab (§8.4), and can be **propagated into other tasks/boards** via
> reuse (§7). "Trusted agents" is doing a lot of work for a tool whose purpose is running
> semi-autonomous agents.
>
> **v1 mitigation (cheap, proportionate):** `prepareArtifactFile` rejects registration of a
> default secret deny-list by basename/glob — `.env`, `.env.*`, `*.pem`, `*.key`, `id_rsa`,
> `id_*` (private keys), `.aws/credentials`, `.npmrc`, `.netrc`, `*.p12`, `*.pfx`. The agent
> gets a clear error; the user can still attach such a file deliberately via the existing
> file-picker attachment flow. This does not make capture trustworthy, but it removes the
> most damaging foot-guns. A per-run created-file manifest (only allow files the run actually
> wrote) is the stronger v2 hardening (§12a). The bound stays the same regardless: the
> handle-based check (above) still prevents escaping the workspace entirely.

### Worker prompt nudge
`spawn-worker.ts:buildPrompt` (work and decompose modes) gets one line appended:
> *"If you produce any durable output files (docs, research, data), register each with
> the kanban_artifact tool (path relative to your working directory) so the user can
> find them."*

### Scratch safety net (D8)
**Warn *and preserve*, not warn-then-delete.** An earlier framing emitted the warning
then deleted the scratch dir in the same operation — so the user only ever saw the
warning *after* the files were already gone, which is exactly the silent loss D8 exists to
prevent (flagged by two reviews).

Revised behavior, on archive (`KanbanCommands.setManualStatus → 'archived'`) for a
`scratch` task whose persisted workspace still exists:
1. List top-level non-dotfiles **not** already registered as artifacts. "Already
   registered" is determined by comparing the top-level path against
   `task_artifacts.source_rel_path`, not by comparing basenames or copied
   `stored_path`s. If `source_rel_path` is nested (`reports/out.md`), the top-level
   warning treats the top-level entry (`reports`) as registered only when every
   non-dotfile descendant under that top-level entry is already covered by registered
   source paths; otherwise the top-level entry remains a leftover. The scan uses `lstat`,
   never follows symlinks, and treats symlinked files/directories as unregistered
   leftovers rather than recursing through them. This keeps the v1 UI compact while
   avoiding false suppression of nested unregistered files or traversal outside the
   workspace during the warning scan.
2. **If any remain:** do **not** delete the scratch dir. Instead
   `appendEvent(id, null, 'artifacts_unregistered', { files })` and leave the workspace in
   place. The drawer renders an amber notice — *"N unregistered files remain in this
   task's workspace"* — with **Reveal folder** and **Discard them** actions. The user can
   grab/register them, or explicitly click **Discard them** to delete the dir now.
3. **If none remain** (all registered, or the dir is empty): delete the scratch dir, as
   today.

The warning actions are real backend actions, not renderer filesystem access:
- **Reveal folder** calls `KANBAN_REVEAL_TASK_WORKSPACE` for the archived scratch task's
  persisted workspace path.
- **Discard them** calls `KANBAN_DISCARD_TASK_WORKSPACE_LEFTOVERS`. Because this is a
  **recursive `rmSync`**, the guard must be canonicalization-based, not string-based (same
  discipline as artifact capture — `cleanupWorkspace` in `workspace.ts` does a raw recursive
  delete with no realpath check, so a symlinked workspace component could otherwise delete the
  user's real files). The handler:
  1. Loads the **task row** via `requireTask(taskId)` — never reconstructs the path from the
     renderer's `taskId` arg — and reads its persisted `workspacePath`.
  2. Requires the task to be `scratch` **and** `archived` **and** not running / not currently
     claimed.
  3. `realpathSync` the persisted workspace path **and** the canonical `workspacesRoot`, and
     requires the canonical workspace path to be a direct child of the canonical
     `workspacesRoot`. If realpath throws or containment fails, reject without deleting.
  4. Only then `rmSync(recursive)` and append `artifacts_unregistered_discarded` so the drawer
     can clear the warning.

This is an explicit lifecycle fix — current archive handling removes worktrees but does
not reliably clean scratch workspaces. It keeps "scratch is ephemeral" for the common
case while guaranteeing nothing the agent produced is destroyed without the user getting a
real chance to act. (Trade-off: an archived scratch task with leftovers keeps a small dir
until the user resolves it; acceptable, and surfaced.)

---

## 7. Backend API (store / commands / IPC)

### `KanbanStore` (new methods, mirroring attachments)
- `addArtifact(input): TaskArtifact` — calls `prepareArtifactFile`, inserts row.
- `listArtifacts(taskId): TaskArtifact[]`
- `listAllArtifacts(filter?): ArtifactListItem[]` — joins tasks + boards for the global
  view; filters by board/state.
- `getArtifact(id): TaskArtifact | null`
- `discardArtifact(id)` / `restoreArtifact(id)` — flip `state`, set/clear `discarded_at`.
- `purgeArtifact(id)` — delete row + file (used by retention + hard delete).
- `purgeDiscardedBefore(cutoffMs): Array<{ id: string; taskId: string; runId: number | null; filename: string }>` — retention sweep metadata for per-artifact events.
- `artifactCounts(): Map<taskId, number>` — kept-only, folded into `listBoard()`.
- `createTaskFromArtifact(input): Task` — creates the target task and attaches the kept
  artifact copy inside one command/store operation. This avoids the create-succeeded /
  attach-failed split-brain state from renderer create-then-reuse.
- `createSwarm(input with seedArtifactId?): SwarmCreated` — when seeded, attaches the
  kept artifact copy to the root swarm task only inside the existing swarm creation
  transaction/command path.

### Cleanup integration
- `deleteBoard()` — add `DELETE FROM task_artifacts WHERE board_id=?` to the
  transaction, and `rmSync(join(artifactsRoot, slug))` to the on-disk cleanup loop.
- Archiving a task does **not** delete artifacts (they're the whole point — they
  persist). For scratch tasks, archive may delete the ephemeral workspace after the
  unregistered-output warning check.
- `show()` (TaskDetail) includes `artifacts: listArtifacts(id)`.

### Commands (`KanbanCommands`)
Thin wrappers with `requireTask` + `appendEvent`, matching the attachment methods:
`discardArtifact`, `restoreArtifact`, `removeArtifact` (hard), `getArtifact`,
`listArtifacts`, `listAllArtifacts`, `createTaskFromArtifact`,
`revealTaskWorkspace`, and `discardTaskWorkspaceLeftovers`.

`createTaskFromArtifact` / seeded swarm creation validate that the artifact is `kept`,
copy the artifact's `stored_path` into the target task's attachments through the existing
attachment preparation/copy path, and add a plain reference line to the task body/goal.
Because "atomic" spans SQLite rows and filesystem copies, the command must perform DB work
inside a transaction, track every attachment file copied during the operation, delete those
copied files on any thrown error/rollback, and emit events only after commit. This prevents
both bad split states: a task/swarm created without its promised input, and orphaned copied
attachment files after a rolled-back seeded create.

### Retention sweep
- New top-level setting `KanbanSettings.artifactRetentionDays: number` stored as
  `kanban.artifactRetentionDays` (default **14**), **exposed in the kanban settings UI**
  so the automatic deletion is visible and user-controllable — not a hidden constant. It
  is deliberately not nested under `dispatcher`. `0` disables auto-purge (discarded items
  stay hidden until removed manually).
- **Config plumbing (corrected).** `KanbanDispatcher` does **not** read `settingsStore` —
  it has no reference to it; all config is injected via `DispatcherDeps` and updated through
  `reconfigure()`. `settingsStore.get().kanban.*` is read in `main/index.ts`. So retention
  days must reach the sweep one of two ways: (a) thread `artifactRetentionDays` into
  `DispatcherDeps` (and push updates via `reconfigure()` when settings change), and run the
  sweep inside the dispatcher tick; or (b) keep the sweep out of the dispatcher entirely and
  run it from `index.ts` on the same cadence, where `settingsStore` is already in scope. We
  pick **(a)** for symmetry with how other dispatcher knobs are configured.
- Run inside the existing **dispatcher tick** (`kanban-dispatcher.ts:tick()`): once per tick,
  call `purgeDiscardedBefore(now - days*86400_000)`, reading `days` from the injected config.
  Cheap indexed delete; no new timer.
- `purgeDiscardedBefore` returns purged artifact metadata, not just a count, so the
  dispatcher can emit one `artifact_purged` event per artifact with the correct
  `taskId`, `runId`, `id`, and `filename`. The drawer renders these so the time-based
  deletion is **surfaced, not silent** (NN/g) — together with the persistent
  *"auto-removed after N days"* note on each discarded row and the settings control.

> **Known limitation — no global disk cap.** Only *discarded* artifacts are ever purged;
> *kept* artifacts persist indefinitely (≤25 MB each, unbounded count). A long-running,
> high-throughput board can accumulate significant disk, and total usage is **not**
> tracked in v1. A `kanban.maxArtifactDiskMB` quota with oldest-first eviction is a
> possible fast-follow (§12a) — called out so the omission is conscious.

### New IPC channels (`ipc-channels.ts`) + preload + renderer store
Following the attachment pattern exactly:

| Channel | Args | Purpose |
|---|---|---|
| `KANBAN_DISCARD_ARTIFACT` | `id` | soft-hide |
| `KANBAN_RESTORE_ARTIFACT` | `id` | un-hide |
| `KANBAN_REMOVE_ARTIFACT` | `id` | hard delete (row + file) |
| `KANBAN_SAVE_ARTIFACT_COPY` | `id` | `showSaveDialog` → copy out (like attachments) |
| `KANBAN_REVEAL_ARTIFACT` | `id` | reveal `stored_path` in OS file manager |
| `KANBAN_LIST_ARTIFACTS` | `{ boardSlug?, state?, kind?, query? }` | cross-board browser feed |
| `KANBAN_READ_ARTIFACT_PREVIEW` | `{ id, maxBytes? }` | bounded text/document preview by artifact id |
| `KANBAN_REUSE_ARTIFACT` | `{ id, targetTaskId }` | copy kept artifact → existing target task attachment |
| `KANBAN_CREATE_TASK_FROM_ARTIFACT` | `{ artifactId, input: CreateTaskInput }` | atomically create a new task seeded with the artifact |
| `KANBAN_CREATE_SWARM_FROM_ARTIFACT` | `{ artifactId, input: SwarmInput }` | atomically create a new swarm with the artifact attached to the root task |
| `KANBAN_REVEAL_TASK_WORKSPACE` | `taskId` | reveal preserved scratch workspace leftovers |
| `KANBAN_DISCARD_TASK_WORKSPACE_LEFTOVERS` | `taskId` | explicitly delete preserved scratch workspace leftovers |

Per-task artifacts need **no** new list/fetch channel — they ride along in `TaskDetail`
via the existing `getTask`.

### Safe preview API
Inline preview uses `KANBAN_READ_ARTIFACT_PREVIEW`, never direct renderer file access to
`storedPath`:
- Looks up the artifact by id in the main process.
- Reads only from the stored artifact copy.
- Caps preview at **200 KB** by default and returns `{ text, truncated, contentType,
  size }`. Reads are **bounded at the source** — `createReadStream(storedPath, { end:
  maxBytes - 1 })` (or a single `read(fd, buf, 0, maxBytes)`), never `readFileSync().slice()`
  — so a 25 MB stored artifact is never fully loaded into the main process for a preview.
- Previewable files are allowlisted by content type / extension: markdown/text/html/json
  and other UTF-8-ish document/code/data text files. Before decoding, inspect the bounded
  byte buffer for NUL bytes and obvious binary control-byte density; binary files return
  `{ previewable: false, reason }` rather than mojibake. Unknown extensions are previewed
  only if they pass the UTF-8/text sniff.
- Handles missing files gracefully with a typed error shown in the UI row.

---

## 8. UI

### 8.1 Drawer "Outputs" section (`KanbanDrawer.tsx`)
Inserted **after** the Attachments section (outputs sit with inputs; matches the
existing section styling — `<section>` + `h3` header + `bg-neutral-950` rows).

- Header: `📦 Outputs (N)`.
- **Documents shown first**; non-document kinds collapsed under a "▸ N other files"
  toggle (D2; NN/g progressive disclosure, ≤2 levels).
- Each row: filename + kind icon + size; per-row actions: **preview** (calls
  `KANBAN_READ_ARTIFACT_PREVIEW`; expand markdown via the existing
  ReactMarkdown/remark-gfm/rehype-highlight pipeline for previewable `document` kinds),
  **Download** (save a copy), **Reveal**, **Use as input ▾**, **Discard**.
- **Discarded** group is separate and dimmed, with **Restore** + a
  *"auto-removed after N days"* note (Baymard: don't make discarded look like kept).
- Unregistered-files warning (from §6) renders here as an amber note.

### 8.2 Card badge (`KanbanCard.tsx`)
Add, next to the comment/child badges, when `card.artifactCount > 0`:
```tsx
<span className="inline-flex items-center gap-0.5"><FileText size={10}/> {card.artifactCount}</span>
```

### 8.3 Reuse ("Use as input") 
"Use as input ▾" offers **New task** or **New swarm**:
- Default the target board to the **currently active board**. From the global Artifacts
  tab, show the selected/default board so cross-board reuse is explicit.
- Threads an optional `seedArtifact: { id }` into the create form (`KanbanBoard.tsx`)
  / `SwarmModal.tsx`.
- On **New task**, use `KANBAN_CREATE_TASK_FROM_ARTIFACT` (or an equivalent renderer
  store action wrapping it). The main process validates the artifact is kept, creates the
  task, appends a reference line to the body, and attaches the artifact copy before
  returning the created `Task`. Do **not** implement seeded creation as renderer
  create-then-attach; that can leave a task created without its promised input.
- On **New swarm**, use `KANBAN_CREATE_SWARM_FROM_ARTIFACT` (or an equivalent
  `createSwarm` action/input extension that runs in the same main-process command). The
  artifact copy attaches to the **root swarm task only**. The root task goal gets a
  reference line; workers can be instructed through the swarm plan as needed. Do not
  duplicate the artifact into every worker task in v1.
- `KANBAN_REUSE_ARTIFACT` remains for attaching a kept artifact to an **existing** task.
  The new-task/new-swarm flows use the atomic seeded-create APIs above. All paths copy
  `stored_path` into the target task's attachments via `addAttachment`, so reuse works
  across boards/repos (D7).
- Only **kept** artifacts are reusable.

### 8.4 Global "Artifacts" tab (`ArtifactsView.tsx` — new)
Registered as a pinned Tool sibling to Kanban/Images/Annotate. Wiring (traced against the
existing Kanban-tab wiring; corrected from an earlier over-claim):
- `types.ts`: add `'artifacts'` to both `Tab.type` and `PaneLeaf.paneType`.
- `workspace-store.ts`:
  - `ensureArtifactsTab()` mirroring `ensureKanbanTab` (workspace-store.ts:121), + public
    action, + add `'artifacts'` to `SPECIAL_TAB_TYPES` (workspace-store.ts:292).
  - Add to the ensure-chain in **`loadWorkspace`** and **`switchWorkspace`** (each calls
    `ensureKanbanTab(ensureAnnotateTab(ensureImagesTab(...)))`). **Not**
    `loadBackgroundWorkspaces` — it has *no* `ensure*Tab` chain (workspace-store.ts:951-970,
    only migrates `cwd`/`labelIsCustom`); background workspaces get pinned tabs lazily when
    activated via `switchWorkspace`. (Earlier drafts and §10 wrongly listed a background
    ensure-chain.)
  - The **pinned-exclusion check is duplicated**, not a single shared helper. Add
    `'artifacts'` anywhere special/pinned tabs are excluded from normal-tab behavior,
    including `loadWorkspace` (~:840), `switchWorkspace` (~:906), `App.tsx` (~:707),
    `Sidebar.tsx`'s regular tab list (~:1177), and `use-pane-navigation.ts`'s
    `getNormalTabs()` shortcut filter. Do not rely only on `SPECIAL_TAB_TYPES`; several
    call sites use inline literals.
- `Sidebar.tsx`: `ArtifactsTabCard` + include `'artifacts'` in the Tools header `.some()`
  gate (~:1342) + a new `.filter(t => t.type === 'artifacts').map(...)` render block
  (mirroring the Kanban one ~:1352).
- `App.tsx`: render `<ArtifactsView/>` for `tab.type === 'artifacts'` (render switch ~:834) +
  mini-sidebar icon + empty-workspace init via `ensureArtifactsTab()` (~:354).

View itself: a cross-board table/list fed by `KANBAN_LIST_ARTIFACTS`, **grouped by task
→ run** (the per-run "timeline"), with filters (board, kind, kept/discarded) and a
search box. Per row: preview/download/reveal/reuse/discard. This is the single largest
piece (~new component + ~14 wiring edits).

### 8.5 UX details (states & edge cases)
- **Empty states:** the drawer Outputs section is **omitted entirely** when the task has
  zero artifacts (no empty box). The global tab shows *"No artifacts yet — agents create
  these with the kanban_artifact tool."*
- **Row label:** show `title || filename`, with the other shown on hover/title attribute.
- **Live updates:** `artifact_added` / `artifact_purged` events already flow through the
  existing kanban event → refresh path, so the drawer list and the card badge update in
  real time during a running task (no new wiring).
- **Action density:** to keep the 420px drawer legible, each row shows the high-frequency
  actions inline (**preview**, **discard**) and folds the rest (**download**, **reveal**,
  **use as input**) into a `⋯` menu. This is a deliberate departure from the flatter
  Attachments row, justified by artifacts having more actions.
- **Input vs output asymmetry, made explicit:** Attachments (inputs) hard-delete on
  remove; Artifacts (outputs) soft-discard + retention. A one-line helper under the
  Outputs header states *"Discarded outputs are recoverable until auto-removal."* so the
  differing Remove/Discard semantics don't surprise users.
- **Preview errors:** if `KANBAN_READ_ARTIFACT_PREVIEW` fails (missing file, read error),
  the row shows *"⚠ Preview unavailable"* with the reason on hover; download/reveal still
  offered.
- **Restore:** discarded rows live in the dimmed group with a **Restore** action
  (`restoreArtifact` → row moves back to the kept group). Discarded styling uses opacity
  **and** an icon (not color alone) for colorblind accessibility; all actions have
  `aria-label`s and are keyboard-reachable.
- **Badge semantics:** the card badge counts **kept** artifacts only (so discarding
  declutters the board). Accepted minor consequence: a task whose outputs were all
  discarded shows no badge even though recoverable artifacts still exist for the retention
  window — they remain findable in the drawer's discarded group and the global tab.

---

## 9. Files touched

> **Status:** nothing below is implemented yet — the earlier exploratory edits were
> reverted. All entries are to-be-written. (Verified: `artifact-files.ts` absent;
> `kanban-types.ts` and `schema.ts` contain no artifact types/table; `SCHEMA_VERSION` is
> still 6.)

**New**
- `src/main/kanban/artifact-files.ts` — validation (handle-based, §6), copy, kind guess,
  workspace file listing.
- `src/renderer/src/components/kanban/ArtifactsView.tsx` — global browser.

**Modified — shared**
- `src/shared/kanban-types.ts` — `TaskArtifact`, `ArtifactKind/State`,
  `ArtifactListItem`, `BoardCard.artifactCount`, `TaskDetail.artifacts`.
- `src/shared/ipc-channels.ts` — artifact channels, including bounded preview.
- `src/shared/ipc-api.ts` — request types.
- `src/shared/types.ts` — `'artifacts'` tab/pane type.

**Modified — main**
- `src/main/kanban/schema.ts` — table + version bump (6 → 7).
- `src/main/kanban/kanban-store.ts` — artifact CRUD, counts, deleteBoard cleanup,
  TaskDetail/listBoard wiring, `artifactsRoot`, `source_rel_path`, atomic
  create-task-from-artifact + `createSwarm` `seedArtifactId`.
- `src/main/kanban/kanban-commands.ts` — command wrappers, archive safety net, scratch
  workspace reveal/discard commands.
- `src/main/kanban/kanban-mcp-server.ts` — `kanban_artifact` tool + handler.
- `src/main/kanban/kanban-dispatcher.ts` — retention sweep on tick.
- `src/main/kanban/spawn-worker.ts` — prompt nudge.
- `src/main/kanban/kanban-ipc.ts` — handlers (incl. save-copy/reveal dialogs).
- `src/main/index.ts` — pass `artifactsRoot`, retention days; persist scratch
  `workspacePath` in `prepareWorkspaceFn`.

**Modified — preload / renderer**
- `src/preload/index.ts` — `window.fleet.kanban.*` additions.
- `src/renderer/src/store/kanban-store.ts` — actions for artifact CRUD/preview/reuse and
  atomic `createTaskFromArtifact` / `createSwarmFromArtifact` flows. Existing
  `createTask` may also return the created `Task` since preload/main already do, but the
  seeded artifact flow must not depend on renderer create-then-attach.
- `src/renderer/src/components/kanban/KanbanDrawer.tsx` — Outputs section.
- `src/renderer/src/components/kanban/KanbanCard.tsx` — badge.
- `src/renderer/src/components/kanban/KanbanBoard.tsx` + `SwarmModal.tsx` — reuse seeding.
- `src/renderer/src/components/Sidebar.tsx`, `App.tsx`, `workspace-store.ts`, and
  `src/renderer/src/hooks/use-pane-navigation.ts` — Artifacts tab wiring, including
  active, switched, and empty-workspace initialization paths. Background workspaces migrate
  lazily when activated via `switchWorkspace` because `loadBackgroundWorkspaces` has no
  pinned-tool ensure-chain today.

**Settings**
- Add top-level `KanbanSettings.artifactRetentionDays` / persisted
  `kanban.artifactRetentionDays` (default 14, `0` disables) to the kanban settings schema
  (`shared/types.ts` + `DEFAULT_SETTINGS.kanban` in `shared/constants.ts`) and a control
  in the kanban settings UI (`KanbanSection.tsx`).

**Tests**
- `src/main/__tests__/kanban-store.test.ts` — schema version v7, migration coverage,
  artifact CRUD/count/discard/restore/purge/delete-board cleanup, `source_rel_path`
  persistence, and seeded create-task/swarm attachment behavior.
- `src/main/__tests__/kanban-workspace.test.ts` or command-level tests — scratch
  workspace persistence/archive warning/cleanup behavior, including reveal/discard guards
  and nested leftovers vs registered `source_rel_path` cases.
- Renderer/store tests where practical for preview/reuse actions and atomic
  create-from-artifact flows.

---

## 10. Validation summary (what shaped this)

Three parallel review passes ran before implementation, followed by a repo-evidence
review of this design:

- **Main-process review:** Schema migration approach corrected (table in `SCHEMA_SQL`,
  bump to 7, no ladder block). `deleteBoard` must also delete artifacts. **Concurrency
  on a shared git repo = BLOCKER.** Follow-up repo review corrected the scratch
  assumption: scratch `workspacePath` is not currently persisted and archive cleanup is
  not currently wired for scratch tasks, so this design now includes explicit
  persistence + archive cleanup/warning work.
- **Renderer/IPC review:** drawer/card/IPC/reuse follow the attachment pattern, but
  preview needs a dedicated bounded read IPC. The global tab is the real effort (~14
  wiring edits + new component) and must update every pinned-tool migration/init path.
- **Adversarial review:** path traversal, size/binary bloat, scratch silent-loss,
  retention not freeing git space, board rename/delete/no-git lifecycle, parallel-swarm
  index.lock races, dir/worktree duplication.

The git-related blockers (concurrency, history can't reclaim space, rename/delete/no-git
handling) are **all eliminated** by D5 (files + DB). Remaining mitigations are folded in:
**handle-based** validation/copy with fd containment checks where supported (and an
explicit best-effort fallback limitation elsewhere), 25 MB bounded copies, reject
non-regular files/symlinks, bounded preview IPC, deleteBoard cleanup, scratch workspace
persistence, and **warn-and-preserve** scratch leftovers (no warn-then-delete).

A second review round (three independent passes over this doc) drove the latest changes:
- **BLOCKER fixed in spec:** symlink path traversal — `resolve().startsWith()` is
  insufficient; now `realpathSync` on both workspace root and target (§6).
- **Correctness:** seeded reuse is one atomic server call, not renderer create-then-attach
  (§7, §8.3). `KANBAN_REUSE_ARTIFACT` remains only for existing target tasks.
- **Correctness:** artifacts persist `source_rel_path` so scratch archive warnings can
  distinguish registered files from leftovers without basename guesses (§4, §6).
- **Lifecycle:** scratch warn-and-preserve includes explicit reveal/discard IPC and command
  wiring, with guards, so preserved workspaces do not become dead-ended leaks (§6, §7).
- **Confirmed correct (a reviewer mis-flagged it):** no `if (current < 7)` migration
  ladder block is needed — `SCHEMA_SQL` runs unconditionally first (§4).
- **UX:** retention purges made visible + setting exposed (§7); empty/error/restore/badge
  states specified (§8.5).
- **Wiring:** global Artifacts tab adds `'artifacts'` to both `Tab.type` and
  `PaneLeaf.paneType`, joins the `loadWorkspace`/`switchWorkspace` ensure-chains (not
  `loadBackgroundWorkspaces`, which has none), and updates every pinned/special-tab
  exclusion literal/filter, including workspace selection, mini-sidebar, Sidebar regular
  tabs, and keyboard tab navigation (§8.4).
- **Accepted risks, documented:** honor-system capture for `dir` tasks, mitigated by a v1
  secret deny-list (§6); no global disk cap in v1 (§7).

A third review round (three independent passes over this doc, verified against the repo)
drove the latest changes:
- **BLOCKER fixed in spec:** TOCTOU symlink-swap during capture — realpath-then-copy on a
  *string* is bypassable by the concurrent agent; now a single `O_NOFOLLOW` handle drives
  validate→fstat→size-cap→bounded copy-from-fd on platforms with fd path introspection,
  with the cross-platform fallback limitation documented (§6, §12a).
- **BLOCKER fixed in spec:** the scratch-leftover recursive delete is now canonicalization-
  guarded (realpath containment in `workspacesRoot`, path loaded from the task row) so a
  symlinked workspace component can't delete the user's real files (§6).
- **Correctness:** retention sweep rewired — `KanbanDispatcher` never reads `settingsStore`;
  `artifactRetentionDays` is threaded through `DispatcherDeps`/`reconfigure` (§7).
- **Hardening:** v1 secret deny-list at registration (§6); preview/copy use bounded
  fd/source reads, not full-read-then-slice or unbounded stream-to-EOF (§6, §7).
- **Doc integrity:** removed false `(done)`/`(written)` tags (§9); added the missing
  §12a deferred-follow-ups section; corrected the §8.4 wiring trace.

A fourth repo-evidence review tightened the implementation contract before coding:
- **Capture portability:** fd-path containment is now explicit per platform; Linux has the
  strong `/proc/self/fd` path, while macOS/Windows require verification/native helpers or
  consciously use the documented best-effort fallback (§6, §12a).
- **Capture robustness:** artifact open uses non-blocking/no-follow flags so FIFOs/devices
  cannot hang the MCP handler, and the copy is bounded to the validated `fstat` size so a
  growing file cannot bypass the 25 MB cap (§6).
- **Atomic reuse:** seeded create-task/swarm now specifies filesystem cleanup on DB rollback
  and event emission only after commit (§7).
- **Scratch scanning:** leftover detection uses `lstat`, never follows symlinks, and treats
  symlinks as leftovers (§6).
- **Renderer wiring:** pinned/special tab exclusions now include Sidebar regular tabs and
  keyboard tab navigation, and §9 no longer claims a background-workspace migration path
  that does not exist today (§8.4, §9).

---

## 11. Alternatives considered

- **Per-board git repo** (original instinct, "use worktrees to organise"): one git repo
  per board, one commit per artifact. **Rejected** — concurrent swarm workers race on
  `index.lock`; discarded/purged artifacts can't truly free disk (git blobs persist in
  history, making the retention feature misleading); board rename/delete/no-git each
  need bespoke handling. Files+DB gives the same per-board/per-task organization with
  none of these.
- **Auto-scan workspace** for produced files: rejected as the primary mechanism (noisy
  for code tasks; user chose explicit registration) — kept only as an archive-time
  *warning*, not auto-capture.
- **Reference-in-place for dir/worktree** instead of copying: rejected for v1 —
  copying gives one consistent model and survives the user editing/deleting the
  original; the snapshot semantics are documented.

---

## 12. Resolved review decisions

These were open questions in earlier drafts; now **resolved and treated as locked**
(folded into §3 where they're decisions; restated here with rationale). Nothing below is
simultaneously "open" and "locked."

1. **Reuse target board:** default to the **currently active board**. From the global
   Artifacts tab, make the selected target board visible because the artifact may come
   from another board.
2. **Retention default:** **14 days**, exposed in settings (`0` disables). Discard is
   always soft; immediate hard delete is available only through the explicit remove
   action with confirmation.
3. **`dir`/`worktree` duplication (resolves §3 D7 for all kinds):** always copy; label it
   a **snapshot** (§5). One consistent durable-artifact model across scratch/dir/worktree.
4. **Global tab scope for v1:** build the full D9 surface — drawer, card badge, global
   tab, filters, search, task → run grouping. Visual polish may be modest; do not ship a
   hidden drawer-only feature. (One reviewer recommended deferring the global tab as
   overscope; the user explicitly chose to keep it in this PR — D9.)
5. **Preview size guard:** cap inline preview at **200 KB** through
   `KANBAN_READ_ARTIFACT_PREVIEW` to avoid UI jank and avoid arbitrary renderer file
   reads.

---

## 12a. Deferred follow-ups (explicitly out of scope for v1)

Called out here so each deferral is a conscious decision with a home, not an omission.

1. **Native/openat-style helper for strong cross-platform artifact capture.** Linux can use
   `/proc/self/fd/<fd>` to prove the opened file remains inside the workspace. macOS and
   Windows need verified fd-path support or a native helper (`openat`/`GetFinalPathNameByHandle`)
   to provide the same guarantee against a malicious concurrent directory-swap adversary.
   Until then, non-Linux platforms use the documented best-effort fallback (§6).
2. **Back-port handle-based path safety to attachments.** `attachments.ts` uses the weaker
   `resolve().startsWith()` containment pattern (§6). It is **not currently exploitable**
   (source is a user file-picker, name is basename-sanitized, no concurrent adversary), so
   this is hygiene, not an active-vuln fix — but the artifact code's `O_NOFOLLOW`
   handle-based discipline should eventually replace it for consistency.
3. **Per-run created-file manifest.** The stronger fix for honor-system capture (§6): record
   the files a run actually wrote and only allow `kanban_artifact` to register from that set,
   replacing the v1 secret deny-list with a positive allow-list. Deferred because it needs
   run-scoped filesystem tracking that doesn't exist yet.
4. **Global disk cap (`kanban.maxArtifactDiskMB`).** v1 purges only *discarded* artifacts;
   *kept* artifacts persist unbounded (§7). A quota with oldest-first eviction (and a usage
   indicator in the Artifacts tab) is the fast-follow once real-world disk growth is observed.
