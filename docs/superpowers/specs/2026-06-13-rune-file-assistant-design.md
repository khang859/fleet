# Rune Quick-Assist — Design

**Status:** Approved (design) — pending spec review
**Date:** 2026-06-13

## Summary

A **transient, summoned-at-cursor overlay** that runs **Rune on-demand** against the file you have open with `fleet open` and the surrounding codebase. There is **no docked panel and no visible transcript**. You put your cursor in a file, press a hotkey, a small input appears anchored at the cursor/selection, you type one instruction, and the overlay gets out of the way. It serves two jobs from one input, distinguished automatically by phrasing:

- **Ask (read-only):** "what does this function do", "where is this used", "why" → Rune answers in a one-shot **anchored popover**; nothing touches disk.
- **Edit (writes to disk):** "finish this function", "refactor X", "add a guard" → Rune writes the change; the editor **auto-reloads**, **flashes the changed lines**, and offers a one-click **Revert**.

Rune is a heavyweight agentic binary (seconds-to-minutes per turn), **not** an instant autocomplete model. On submit the overlay collapses to a small inline **"Rune working…" pill** anchored at the invocation line; it is **non-blocking** — you keep editing, or summon Rune on another file. One in-flight turn is allowed **per file pane**, so several files can run at once.

Under the hood there is **one resumable Rune session per workspace** (`--prompt` then `--resume <id>`), so Rune remembers prior edits and questions across invocations even though no conversation is shown. The main-process service is modeled directly on the proven `PmChatService` (`src/main/kanban/pm-chat-service.ts`), minus the kanban MCP.

## Motivation / why not a panel

A docked right-side chat panel against an open file reproduces Cursor / Copilot / Zed almost feature-for-feature, inside an app whose identity is a **terminal multiplexer for running multiple agents in panes** — so it would be a weaker copy of an IDE feature that already exists elsewhere. The overlay is the deliberate alternative: it claims no permanent screen real estate, disappears when you're done, and leans on Fleet primitives (file panes, file-reload, multiple concurrent agents) instead of inventing IDE chrome. Editing works because Rune writes to disk and Fleet's file panes already reload; concurrency ("several Rune turns at once") is the multi-agent pitch for free.

## Goals

- One in-editor surface that both answers questions about and edits the open file, powered by Rune.
- Full codebase context (Rune runs in the workspace root and reads files itself).
- Strictly **ephemeral**: summon → act → vanish. No persistent dock, no transcript to manage.
- **Non-blocking** during Rune's long turns; concurrent turns across panes.
- Reuse existing infrastructure (`PmChatService` pattern, `readRuneSession`, `file-save-registry` pattern) rather than inventing new mechanisms.

## Non-Goals (v1)

- A docked panel or any persistent transcript UI.
- Context chips and `@`-mention picker. Context is **implicit** (active file + selection/cursor line); Rune reads the rest of the codebase itself. (Removed as sidebar baggage.)
- An explicit Ask/Agent mode toggle, model picker, queue-while-running, `/` slash commands, token/context indicator. (All were panel furniture.)
- Multi-turn follow-up inside the Ask popover. The popover is one-shot; re-summon for the next question. (Continuity still exists invisibly via the resumed session.)
- Per-hunk inline accept/reject diff gate. We use **auto-reload + changed-line flash + one-click whole-turn Revert** instead.
- Parallel/background/cloud sessions; an "agents window"; image and voice input.

## Research basis

Grounded in two research passes (2025–2026); the overlay keeps the evidence-based principles and drops the IDE-clone surface they were originally wrapped in:

**Evidence-based UX (NN/g + Baymard):**
- Show live system status on operations past ~1s; for unbounded operations, **list each step** (NN/g, *Response Time Limits*). → the working pill shows a live step + elapsed.
- Make AI context **transparent** (NN/g, *Can Users Control… ML*). → the overlay is anchored at the exact line/selection it will act on, so the scope is visible by position.
- Humane, plain-language errors that preserve the user's input and offer a next step (NN/g, *Error-Message Guidelines*). → on failure the overlay reopens with the typed prompt intact and a Retry.
- AI proposes, human approves for consequential actions; make correction effortless because edit cost is high (NN/g, *AI as a UX Assistant*). → auto-reload + flash + one-click Revert.
- Don't trap the user waiting on a slow operation. → non-blocking pill; keep working elsewhere.

**Modern in-editor assistant patterns (Cursor ⌘K, Copilot, Zed, JetBrains):**
- An at-cursor inline prompt is the established lightweight alternative to a chat dock.
- Whole-turn **Revert / Restore Checkpoint** (Zed) is the accepted safety valve when edits land directly rather than through a per-hunk gate.

## Interaction flow

1. **Summon.** Cursor in a file pane → hotkey (proposed `⌘I`; verify against existing terminal/editor bindings during implementation, fall back to a non-colliding chord). A single-line-growing input appears anchored at the cursor (or at the selection's start line if a range is selected).
2. **Type one instruction** and press Enter. Esc closes the overlay without sending.
3. **Intent auto-detection.** The text is classified Ask vs Edit (see below). The mode is sent with the request; the renderer shows the user which way it was read once the result lands (e.g. popover for Ask, reload+flash for Edit).
4. **Working.** The overlay collapses to an inline **pill** at the invocation line: `◆ Rune working… {elapsed}s` + the latest step (e.g. "reading auth.ts…") + a cancel **✕**. Non-blocking. Summoning Rune again in the *same* pane while a turn is in flight is rejected with a gentle inline note; summoning in a *different* pane starts a parallel turn.
5. **Result.**
   - **Ask** → an **anchored popover** at the line renders the answer (markdown). Dismiss on click-away or Esc. Nothing persists.
   - **Edit** → the pane reloads from disk, changed lines **flash**, and the pill is replaced by a small **`⟳ Reloaded · Revert`** affordance tied to that turn.
6. **Failure / cancel.** SIGTERM the child; the overlay reopens at the line with the typed prompt preserved and a **Retry**; a humane one-line error explains why.

## Intent auto-detection

- The classification is performed by **Rune itself**, instructed via a prompt preamble: edit/write to disk **only** when the request is an imperative change to the code ("finish", "implement", "refactor", "add", "rename", "fix"); otherwise answer read-only and make no file changes.
- The renderer also does a lightweight local heuristic (leading imperative verb / presence of a selection) purely to choose the *initial* result affordance and to decide whether to arm the pre-turn snapshot; the authoritative behavior is Rune's.
- **Safety net:** because edits land on disk, even a misclassified "edit when I only asked" is recoverable via the changed-line flash + one-click Revert. This is the conscious mitigation for auto-detection risk (the user accepted auto-detect with this trade-off explicit).

## Architecture

### Main process — `RuneFileChatService`

New file `src/main/rune-assist/rune-file-chat-service.ts`, a near-clone of `PmChatService`:

- **Keying:** one logical session **per workspace root (`cwd`)**. A turn is additionally tagged with the originating **pane id** so the renderer can route the working pill / result and enforce one-in-flight **per pane**. (The service still serializes to one Rune child per workspace session; cross-*workspace* concurrency is naturally separate. Cross-*pane within the same workspace* concurrency is a renderer-level queue concern — see Edge cases.)
- **Spawn:** `rune --prompt <body>` with `cwd` = the workspace root. On subsequent turns append `--resume <sessionId>`. Append `--model <m>` only if a model is ever configured (none in v1).
- **Mode:** carried on the request (`ask` | `edit`). Both run the same `rune` invocation; the difference is the **prompt preamble** (Ask prepends the read-only instruction). No separate CLI flag is assumed; if the installed `rune` later exposes a read-only profile/flag it can harden Ask mode (tracked as an open question).
- **Session:** parse `session-id:` from stdout (same regex as PM chat); persist `cwd → sessionId` to a JSON file under Fleet's app data (`app.getPath('userData')`, atomic temp-file write) so conversations survive restarts. `reset(cwd)` forgets the session id (leaves Rune's own session file untouched).
- **Changed-file detection:** after a turn, report which files Rune wrote, derived from the session JSON tool-call records (`readRuneSession`), with a disk-mtime fallback for open files. Used by the renderer to decide which panes to reload and what to snapshot/Revert.
- **Reuse wholesale from PM:** single in-flight guard (per workspace session), `OUTPUT_CAP` stdout/stderr tail, turn timeout, `isAuthFailureText` classification, `ENOENT → RUNE_NOT_INSTALLED_MESSAGE`, `dispose()` to SIGTERM in-flight children on shutdown, atomic persisted-state writes. Adds a `stop(cwd)` that SIGTERMs the in-flight child.
- **No kanban MCP.**

### Renderer — overlay, pill, popover (no panel)

New components under `src/renderer/src/components/rune-assist/`:

- **`RuneAssistOverlay`** — the summoned input. Anchored at the cursor/selection within a file pane. Single text field; Enter sends, Esc closes. On send it transitions to the **pill** state in place.
- **Working pill** — compact inline indicator at the invocation line: animated icon, elapsed seconds, latest step text, cancel ✕. Driven by the `status` event stream.
- **`RuneAnswerPopover`** — one-shot, read-only, markdown answer anchored at the line; dismiss on click-away/Esc. No follow-up input.
- **Edit affordance** — replaces the pill after a successful Edit turn: `⟳ Reloaded · Revert`, tied to that turn's snapshot.

These are mounted **inside the file pane** (in/near `FileEditorPane` / `PaneGrid`'s file-pane render site), positioned relative to the editor, so each pane can host its own overlay/pill/popover independently — which is what enables per-pane concurrency.

A small zustand store (`rune-assist-store`) tracks, **keyed by pane id**: overlay open/closed + anchor, the in-flight turn (status, elapsed, latest step), the last result (answer text or edit summary + snapshot for Revert), and the preserved prompt on failure. There is **no transcript array** — at most one result per pane is retained, and it's transient.

### Editor integration

- **Active file & cwd:** read from `workspace-store` (focused pane's `filePath`; workspace/tab `cwd` for the Rune working directory).
- **Selection / cursor:** `FileEditorPane` registers a getter in a new **editor-context registry** (mirrors `src/renderer/src/lib/file-save-registry.ts`). The overlay reads selection range / cursor line **only at send-time** — no per-keystroke store churn. The same registry exposes `reloadFromDisk()` and a `flashLines(range)` decoration used after Edit turns.
- **Context line:** each request prepends a machine-readable context line, e.g. `[context: file src/auth.ts, lines 11–14 selected]` (or `line 12` if no selection), then the user's text. Rune reads the file contents itself.

### Edit reconciliation (snapshot → reload → flash → Revert)

1. **Before** an Edit-intent turn, flush unsaved edits in the target pane to disk and **snapshot** the current on-disk content of the active file (and any other open file the turn is likely to touch — minimally the active file; others reconciled reactively from the changed-file report).
2. Run the turn.
3. **After** the turn, for each open pane whose file Rune changed: `reloadFromDisk()` then `flashLines()` on the changed range (changed range derived by diffing snapshot vs. new content; fall back to flashing the whole file if no clean range).
4. Attach a one-click **Revert** to the turn that restores the snapshot(s). This is the human-approval safety valve in lieu of a per-hunk gate. Revert writes the snapshot back to disk and reloads the pane.

## IPC surface

Mirror the PM chat channels (Zod-validated payloads in `src/shared/ipc-api.ts` — no unsafe casts, per project rule). Channels under `rune-assist:*`:

- `runeAssist.send({ cwd, paneId, text, mode, contextFile?, selection? }) → void` — `mode` is `'ask' | 'edit'`; `selection` is `{ fromLine, toLine }`.
- `runeAssist.stop({ cwd, paneId }) → void`
- `runeAssist.reset({ cwd }) → void`
- `runeAssist.getState({ cwd }) → { inFlight, error, sessionId }`
- Emitted events:
  - `runeAssist.status` → `{ cwd, paneId, phase: 'idle' | 'working' | 'error', step?, error? }`
  - `runeAssist.result` → `{ cwd, paneId, mode, answer?, changedFiles? }` (answer for Ask; changedFiles for Edit)

No `setMode` channel (mode rides on each send). No transcript channel (no transcript). The renderer reconciles edits from `result.changedFiles` + the editor-context registry.

## Edge cases

- **Rune not installed:** reuse `RUNE_NOT_INSTALLED_MESSAGE`; surface humanely in the overlay with a pointer to Settings → Rune.
- **Second summon in a pane with a turn in flight:** rejected with a gentle inline note ("Rune is still working on this file — cancel or wait"). No renderer queue in v1; concurrency is *across* panes, not stacked within one.
- **Summon in another pane:** starts a parallel turn (separate working pill). Allowed.
- **Switching focus mid-turn:** the pill stays anchored in its pane; the result lands there regardless of where focus moved.
- **Auth failure:** classified via `isAuthFailureText`; overlay reopens with prompt preserved, error tells the user to fix provider credentials (e.g. `rune login`) and Retry.
- **Non-code panes** (image/PDF): no summon hotkey (or a no-op); the feature targets text file panes.
- **Turn timeout / cancel:** SIGTERM the child; overlay reopens with the prompt preserved; offer Retry.
- **Edit turn changes a file that is not open in any pane:** reported in `changedFiles`; we surface a brief note ("also edited 2 files") with Revert covering snapshots we hold (active file at minimum). Best-effort in v1.

## Testing

- **Main:** unit-test `RuneFileChatService` like `kanban-spawn-worker.test.ts` / the PM tests — arg building (`--prompt` / `--resume`, mode→preamble), `session-id:` parse, error classification (`ENOENT`, auth failure, non-zero exit), persisted session round-trip, changed-file extraction from a sample session JSON.
- **Renderer:** intent heuristic (imperative verb / selection → initial affordance); context-line assembly from active file + selection; per-pane in-flight guard (second summon rejected, other pane allowed); snapshot→Revert restores prior content.
- **Verification:** `npm run typecheck` and `npm run lint` clean; `npm run build`.

## Open implementation questions (resolve during build, not blocking design)

- Exact summon hotkey that doesn't collide with terminal/editor bindings (proposed `⌘I`).
- Exact Rune CLI mechanism for read-only **Ask** mode (prompt preamble in v1; profile/flag if available later).
- Reliability of changed-file detection from session tool-call records vs. needing the disk-mtime fallback.
- Whether to snapshot more than the active file proactively, or rely entirely on the post-turn `changedFiles` report for Revert coverage.
