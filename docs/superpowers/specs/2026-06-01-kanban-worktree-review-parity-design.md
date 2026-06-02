# Kanban Worktree Review & Integration — Parity Path Design

**Status:** Implemented (all 3 phases) · **Date:** 2026-06-01

Closes the gap between "an agent did work in a worktree" and "that work is
preserved, reviewable, and integrated." Brings Fleet to parity with the Hermes
`review-required` convention and the vibe-kanban review/merge UX, while solving
the "how do child tasks build on the same feature?" problem.

---

## Problem

Today, when an orchestrator decomposes a Triage task into children:

- **Each task gets its own isolated worktree + branch** `kanban/<taskId>`, branched
  from the repo's current HEAD — *not* from the parent's branch. Verified in
  `workspace.ts:70-75` (`git worktree add <dir> -b kanban/<id>`, no start-point)
  and `kanban-mcp-server.ts:471-476` (children inherit only `repoPath`). So
  children **cannot see each other's work**, and a dependent child branches from
  stale base, not from its prerequisite's output.
- **No work is preserved automatically.** `kanban_complete`
  (`kanban-mcp-server.ts:349-361`) just sets `done` — there is **no commit, no
  diff, no PR, no merge** anywhere (`workspace.ts` only does `worktree add` /
  `worktree remove` / `branch -D`).
- **Archive destroys unmerged work.** The archive path
  (`kanban-commands.ts:255-273`) force-deletes the branch (`git branch -D`) even
  when it is unmerged — silent data loss.

## The core insight

Make a worktree task's terminal state **"merged into its base branch = done"**
instead of "`kanban_complete` = done." This single change solves both halves of
the problem:

1. **Preservation** — work is committed on `kanban/<id>`, reviewable in-app, and
   merged on explicit human approval.
2. **Build-on-each-other** — a dependent child gates on `parent = done`, and
   `done` now means *merged into base*. Because children branch from base HEAD,
   the child's worktree automatically contains the parent's merged work. **No
   stacked branches, no shared mutable worktree** — the human-merge gate
   sequences it correctly.

This is strictly less machinery than a shared/stacked feature branch, and it
matches what Hermes (`review-required` block + diff/PR-url comment, human
review) and vibe-kanban (To Do → In Progress → **Review** → Done, inline diff,
PR creation) already do. The broader 2026 ecosystem consensus is the same:
decompose into non-overlapping slices, isolate per worktree, integrate via
PR-per-task or orchestrated sequential merge with explicit human/CI gates —
nobody auto-builds stacked feature branches because the merge complexity is
exactly what bites.

## What exists today (verified anchors)

- `TaskStatus` (`kanban-types.ts:1-9`): `triage|scheduled|todo|ready|running|blocked|done|archived` — **no review state**.
- A partial `review-required` notion already exists, but only for *failure*:
  exit-3 (model went quiet) → `blocked` with `result = "review-required: …"`,
  run outcome `incomplete` (`kanban-dispatcher.ts:84-92`). Successful completion
  has none of this.
- `GitService.getFullStatus(cwd)` (`git-service.ts:18`) already returns
  `{ isRepo, branch, files, diff }` — the diff-review primitive; already used by
  `GitChangesModal.tsx`.
- A scratch "leftovers" safety net already exists (`kanban-commands.ts:276-283`)
  — the pattern to mirror for unmerged branches.
- Dependency gating: promotion to `ready` requires all parents
  `status IN ('done','archived')` (`kanban-store.ts` `promotableTodoTasks`).

---

## Design — three independently shippable phases

### Phase 1 — Stop losing work *(safety only, no UX change)*

1. **Auto-commit on run finish.** New best-effort `finalizeWorktree(task)` in
   `workspace.ts`: `git -C <worktree> add -A && git commit -m "kanban/<id>: <title>"`
   when there are changes. Called from the `kanban_complete` handler
   (`kanban-mcp-server.ts:349`) **and** the review-required/exit-3 path
   (`kanban-dispatcher.ts:84`) so both a clean finish and a quiet exit leave a
   committed branch. Never throws.
2. **Branch retention on archive.** In `removeWorktree()` (`workspace.ts:108`),
   only `git branch -D` when the branch is merged into base
   (`git branch --merged <base>`); if unmerged, keep the branch (remove only the
   worktree dir to free disk) and emit an `unmerged_branch_kept` event —
   mirroring the scratch-leftovers net.

**Verify:** uncommitted agent edits → branch ends with a commit; archiving an
unmerged task keeps the branch + logs a warning event.

### Phase 2 — Review column + in-app diff

3. **`'review'` status + column.** Add `'review'` to `TaskStatus`
   (`kanban-types.ts:1`) and `COLUMNS` (`kanban-utils.ts`) between Running and
   Done. No DB migration (status is TEXT). `kanban_complete` routes **worktree**
   tasks → `review`; scratch/dir research tasks still → `done` (nothing to
   merge). Gating stays `status IN ('done','archived')`, so `review` correctly
   blocks dependent children until accepted.
4. **Review metadata comment.** After the Phase-1 commit, `kanban_complete`
   posts `review-required: N files (+x/−y) on kanban/<id>` (from
   `getFullStatus`) and stores it in run metadata — Hermes' "structured metadata
   in a comment first."
5. **Diff in the drawer.** New IPC `kanban:gitStatus(taskId)` →
   `GitService.getFullStatus(task.workspacePath)` → render changed files + diff
   (reuse `GitChangesModal.tsx`).

**Verify:** completing a worktree task lands it in **Review**; drawer shows the
diff.

### Phase 3 — Three review actions

**Prereq:** track `base_branch` (repo HEAD captured at worktree creation) — one
additive column (`schema.ts` migration). Sets the merge target and the
child-branch base.

On a Review task the drawer shows three buttons:

| Button | Action | Result |
|---|---|---|
| **Make Pull Request** | `git push -u origin kanban/<id>` then `gh pr create --base <base> --head kanban/<id>`. Capture PR URL → comment + run metadata. Graceful error if no remote / `gh` missing. | Task → `done`; PR link in drawer. |
| **Merge to `<base>`** | Merge `kanban/<id>` into `base_branch` locally, done conservatively so it never disturbs the user's current checkout (e.g. merge via a scratch worktree on base). On conflict: abort, stay in `review`, comment the conflict (user resolves manually or **Unblock** to re-spawn with the thread). | Clean → `done` + "merged" comment. |
| **Do Nothing** | No git op. Marks task accepted (`done`) but preserves branch + worktree; drawer surfaces `kanban/<id>` + worktree path for manual checkout. | Task → `done`; branch untouched. |

6. **Children branch from `base_branch` HEAD.** Small change to the inherit
   logic (`kanban-mcp-server.ts:471`) + `prepareWorkspace`. This is what makes a
   dependent child **inherit merged-parent work** without stacked branches.

**Verify:** **Merge** → base contains the commit; a gated child's worktree then
contains the parent's merged files. **PR** → branch pushed, PR URL shown.
**Do Nothing** → branch present, task `done`, nothing merged.

---

## Consequence worth flagging

The "children build on each other" guarantee only holds when the parent's work
actually reaches `base_branch` HEAD **locally** before the child is claimed:

- **Merge to `<base>`** → immediate; works.
- **Make Pull Request** → only after the PR is merged on GitHub *and* the local
  base is updated.
- **Do Nothing** → never enters base, so a dependent child branches from clean
  base and won't see it (expected — "Do Nothing" = "I'll handle this branch
  myself").

---

## Out of scope (the autonomy path, later)

Auto-merge on green CI, agents auto-fixing CI / auto-addressing review comments,
true stacked branches. Parity = **commit + review + human-decided integration**.

## Files in play

`kanban-types.ts`, `kanban-utils.ts`, `workspace.ts`, `kanban-mcp-server.ts`,
`kanban-dispatcher.ts`, `kanban-commands.ts`, `schema.ts` (base_branch
migration), `index.ts` + preload (git IPC), `KanbanDrawer.tsx`; reuse
`GitChangesModal.tsx` + `git-service.ts`.

## Decisions locked

- Dedicated **Review** column (not overloading `blocked`).
- Three review actions: **Make Pull Request**, **Merge to `<base>`**, **Do Nothing**.
- Phasing: 1 (safety) → 2 (review + diff) → 3 (actions + base-branch); each
  independently shippable.

## See also

- `docs/kanban-hermes-parity-backlog.md` — remaining Hermes capabilities.
- `docs/superpowers/specs/2026-05-30-kanban-board-design.md:286-293` — Hermes
  worktree & `review-required` convention.
- `docs/learnings/2026-06-01-kanban-headless-worker-persistence.md` — exit-3 /
  `review-required` classification this design builds on.
</content>
</invoke>
