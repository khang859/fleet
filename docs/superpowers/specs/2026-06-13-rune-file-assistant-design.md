# Rune File Assistant — Design

**Status:** Approved (design) — pending spec review
**Date:** 2026-06-13

## Summary

A docked right-side panel that runs **Rune on-demand** against the file you have open with `fleet open` and the surrounding codebase. It is **one persistent conversation per workspace** that **retargets** to the active file. It serves two jobs through a single surface:

- **Answer / explain (read-only):** "what does this function do", "where is this used", "why" — Rune answers without changing your code.
- **Edit / complete (agent):** "finish this function", "implement this", "refactor X" — Rune writes the change to disk; the editor auto-reloads and highlights the diff.

The active file path and current selection/line are **auto-attached as a visible, removable context chip**. Additional files/symbols are added with `@` in the composer. The design is modeled directly on the existing, proven `PmChatService` (`src/main/kanban/pm-chat-service.ts`), minus the kanban MCP.

Rune is a heavyweight agentic binary (seconds-to-minutes per turn), **not** an instant autocomplete model. The integration is therefore strictly **on-demand** (you trigger a turn, it works, it returns) — never as-you-type ghost text.

## Goals

- One in-editor surface that both answers questions about and edits the open file, powered by Rune.
- Full codebase context (Rune runs in the workspace root and reads files itself).
- A modern, research-informed chat UX: visible/removable context, collapsible tool steps, streamed output, Stop/Retry, humane errors.
- Reuse existing infrastructure (`PmChatService` pattern, `readRuneSession`, session-transcript rendering, `file-save-registry` pattern) rather than inventing new mechanisms.

## Non-Goals (v1)

- Per-hunk inline accept/reject diff gate. We use **auto-reload + changed-line highlight + one-click whole-turn Revert** instead. (See "Edit reconciliation" for the rationale and the research tension.)
- A dedicated multi-file review surface separate from the transcript.
- Parallel / background / cloud sessions; an "agents window".
- Image and voice input.
- Inline `⌘K`-style at-cursor editing (the alternative surface considered and rejected during brainstorming).

## Research basis

Design decisions are grounded in two research passes (2025–2026), captured here so reviewers can trace the "why":

**Evidence-based UX (NN/g + Baymard):**
- Show live system status on operations past ~1s; for unbounded operations, **list each step** being processed (NN/g, *Response Time Limits*). → streamed tokens + a live tool-step list.
- Collapse tool-calls and diffs by default; scannable headings, multiple expandable (NN/g, *Progressive Disclosure* / *Accordions on Desktop*).
- Make AI context **transparent and editable** — show which files/lines were used (NN/g, *Can Users Control… ML*).
- Don't autoscroll to the bottom of a streaming reply; anchor at the top of the new message (NN/g, *AI Chatbot Guidelines*).
- Humane, plain-language errors that preserve the user's input and offer a next step (NN/g, *Error-Message Guidelines* / *Hostile Patterns*).
- Composer: one clear primary Send, distinct from secondary actions; full keyboard access (Baymard, *Form Design* / *Avoid "Apply" Buttons*).
- AI proposes, human approves for consequential actions; make correction effortless because edit cost is high (NN/g, *AI as a UX Assistant* / *Can Users Control… ML*).

**Modern in-editor assistant patterns (Cursor, Copilot, Zed, JetBrains, Continue, Windsurf):**
- `@`-mention picker for context + every attachment rendered as a removable **chip**; the clear trend is moving auto-included current-file context toward *explicit, visible* attachment.
- Transcript = vertical stack of typed blocks: streamed markdown + collapsible tool cards (icon + verb + args/result) + collapsible reasoning + edit summary.
- Edit-landing gold standard is an inline per-hunk Keep/Undo gate; both Cursor and Windsurf drew user backlash when they auto-applied to disk *without* a review gate. Whole-turn **Revert / Restore Checkpoint** (Zed) is the accepted lighter-weight safety valve.
- In-composer **Ask/Agent mode toggle**, model picker, persistent **Stop**, **queue-while-running**, `/` slash commands.
- Right-side dock is the universal default.

## Architecture

### Main process — `RuneFileChatService`

New file `src/main/rune-assist/rune-file-chat-service.ts`, a near-clone of `PmChatService`:

- **Spawn:** `rune --prompt <body>` with `cwd` = the **workspace root** (so Rune has full codebase context). On subsequent turns append `--resume <sessionId>`. Append `--model <m>` when a model is selected.
- **Mode:**
  - **Ask** (read-only): Rune must not edit/write. Implement by running Rune with a read-only constraint — preferred: a profile/flag that disables edit/write/bash tools; fallback: a prompt wrapper instructing answer-only. (Exact mechanism verified against the installed `rune` CLI during implementation.)
  - **Agent**: full tools (default Rune behavior).
- **Session:** parse `session-id:` from stdout (same regex as PM chat); persist `workspace → sessionId` to a JSON file under Fleet's app data so conversations survive restarts. `reset()` forgets the session id (leaves Rune's session file untouched).
- **Transcript:** read back via `readRuneSession(sessionId)` → `TranscriptMessage[]`.
- **Reuse wholesale from the PM pattern:** single in-flight guard, `OUTPUT_CAP` stdout/stderr tail, turn timeout, `isAuthFailureText` classification, `ENOENT → RUNE_NOT_INSTALLED_MESSAGE`, `dispose()` to SIGTERM in-flight children on shutdown, atomic temp-file writes for persisted state.
- **No kanban MCP.** The file assistant needs only Rune's normal tools + codebase access. (If a future need arises, an MCP can be added the same way PM chat does.)

### Renderer — `RuneAssistPanel`

New component under `src/renderer/src/components/rune-assist/`, docked on the right of the editor area.

- **Header:** `Rune` label · context/token indicator (how full the window is, expandable breakdown) · new-thread (reset) button.
- **Transcript:** reuse existing session-transcript rendering for user/assistant messages. Render Rune's tool calls as **collapsible cards** ("Read auth.ts", "Edited auth.ts +2 −1"), collapsed by default. Render reasoning, if present in the session JSON, as a **collapsible "Thought process" block** collapsed by default (degrades to nothing if Rune emits no reasoning). Stream assistant tokens; **do not autoscroll** — anchor at the top of each new message.
- **Composer:**
  - Context chips: the active file + selection/line auto-attached, each removable; `@` opens a picker to add more files/symbols (each becomes a chip).
  - **Ask / Agent mode toggle** (in-composer; remembers last choice).
  - Model picker.
  - **Send** as the clear primary action; **Stop** while a turn runs; **Retry** on failure with the failed prompt preserved and editable.
  - **`/` slash commands** (e.g. `/explain`, `/fix`, `/tests`) that expand into structured prompts.
  - **Queue-while-running:** typing + Enter during an in-flight turn queues the message to run next.
  - Full keyboard access.

### Editor integration

- **Active file:** read from `workspace-store` (the currently-focused pane's file path).
- **Selection/cursor:** `FileEditorPane` registers a getter in a new **editor-context registry** (mirrors the existing `file-save-registry` in `src/renderer/src/lib/file-save-registry.ts`). The panel calls it **only at send-time** to read the current selection range / cursor line — no per-keystroke store churn.
- **Context line:** each message prepends a machine-readable context line, e.g. `[context: file src/auth.ts, lines 11–14 selected]`, then the user's text. Rune reads the file contents itself.

### Edit reconciliation (auto-reload + highlight + Revert)

1. **Before** an Agent-mode turn, flush any unsaved edits in open panes to disk (so the post-turn reload can't clobber in-progress typing).
2. Run the turn.
3. **After** the turn, determine which files Rune changed (from the tool-call records in the session JSON; fall back to disk mtime comparison for open files). For each open pane on a changed file: reload the CodeMirror document from disk and apply a **transient changed-line highlight**.
4. Attach a one-click **Revert** to the turn that restores the changed file(s) to their pre-turn snapshot. This is the human-approval safety valve in lieu of a per-hunk gate.

**Rationale / tension:** the research shows users value an inline accept/reject gate, and Rune writes directly to disk (which makes per-hunk gating hard without intercepting Rune's tools). Auto-reload + highlight + whole-turn Revert is the pragmatic middle that fits Rune's execution model while keeping an effortless undo. This is a conscious v1 trade-off; a per-hunk gate can be revisited later.

## IPC surface

Mirror the PM chat channels (Zod-validated payloads in `src/shared/ipc-api.ts` — no unsafe casts, per project rule):

- `runeAssist.getState(workspace) → { inFlight, error, messages, mode, sessionId }`
- `runeAssist.sendMessage(workspace, { text, mode, model, contextFile, selection })`
- `runeAssist.reset(workspace)`
- `runeAssist.stop(workspace)`
- `runeAssist.setMode(workspace, mode)`
- Emitted events: `runeAssist.status` (`idle | thinking | error`) and `runeAssist.transcript` (`TranscriptMessage[]`).

## Edge cases

- **Rune not installed:** reuse `RUNE_NOT_INSTALLED_MESSAGE`; surface humanely with a link to Settings → Rune.
- **One in-flight turn at a time:** additional sends are queued (see queue-while-running) rather than rejected.
- **Switching files mid-conversation:** the thread persists; the context chip retargets to the new active file. Switching does not reset the conversation.
- **Auth failure:** classified via `isAuthFailureText`; message tells the user to fix provider credentials (e.g. `rune login`) and Retry.
- **Non-code panes** (image / PDF / markdown active): the panel still works as plain chat; the file chip reflects the active file or shows none.
- **Turn timeout / interrupt:** SIGTERM the child; preserve completed transcript; offer Retry.

## Testing

- **Main:** unit-test `RuneFileChatService` like `kanban-spawn-worker.test.ts` / the PM tests — arg building (`--prompt` / `--resume` / `--model` / mode→constraint), `session-id:` parse, error classification (`ENOENT`, auth failure, non-zero exit), persisted session round-trip.
- **Renderer:** context-chip assembly from active file + selection; queue/stop state machine; "do not autoscroll" behavior.
- **Verification:** `npm run typecheck` and `npm run lint` clean.

## Out-of-scope notes carried from research (future)

Per-hunk inline accept/reject; dedicated multi-file Changes panel; parallel/background/cloud agents; image & voice input; `⌘K` at-cursor inline edit. All are documented modern patterns deferred past v1.

## Open implementation questions (resolve during build, not blocking design)

- Exact Rune CLI mechanism for read-only **Ask** mode (profile/flag vs. prompt constraint).
- Whether Rune's session JSON includes reasoning blocks (drives whether the collapsible reasoning block renders anything).
- Whether changed-file detection is reliable from tool-call records alone or needs the disk-mtime fallback.
