# Learnings: Pane-scoped modals reload on background cwd changes (2026-07-03)

Context: building the Project Notes pane tool (`NotesModal`), a modal keyed on the focused pane's project. Two subtle data-loss bugs surfaced in review; both stem from how pane-scoped modals receive live state.

## A cwd-driven load effect clobbers unsaved edits

**Problem:** Pane-tool modals receive `cwd={focusedPaneCwd}` from `App.tsx`, sourced from `useCwdStore`, which updates via `window.fleet.pty.onCwd` (OSC 7) **whenever the pane's shell reports a new directory — independent of focus or user interaction.** In Fleet, agents `cd` around inside panes constantly.

A load effect with `cwd` in its dependency array therefore re-runs on every `cd`. If it unconditionally re-reads from disk and overwrites the editor buffer, a `cd` (even one that stays inside the same repo) silently discards the user's unsaved typing.

**Fix:** Resolve the scope (e.g. `git.repoRoot(cwd)`), then bail before touching the buffer when the scope hasn't changed:

```ts
if (cancelled || scope === scopeRef.current) return;
// scope genuinely changed → flush unsaved edits to the old note, then load the new one
if (scopeRef.current && textRef.current !== originalTextRef.current) {
  await save(false);
}
```

A `cd` within the same project resolves to the same repo root, so the guard makes it a no-op. Only a move to a different project reloads — and it flushes first.

## In-flight async writes must re-check scope after `await`

**Problem:** A pane-tool modal is never unmounted on close (`if (!isOpen) return null` sits *after* the hooks), so its refs persist, and `activePaneId` can change via global keyboard shortcuts while the modal is open. A debounced autosave that captures the scope, `await`s the IPC write, then mutates shared refs/state in its continuation will write those mutations against **whatever note is showing now**, not the one it saved — desyncing `dirty` and poisoning the next note's mtime conflict guard.

**Fix:** Capture the scope before the `await` and abandon the post-await mutations if it changed:

```ts
const scope = scopeRef.current;
const res = await window.fleet.notes.write(scope, ...);
if (scopeRef.current !== scope) return; // a different note is open now
```

**Takeaway:** Any modal keyed on `focusedPaneCwd` inherits both hazards. Treat `cwd` as a live, high-frequency signal (not a stable open-time value), and treat these long-lived-modal effects/callbacks like they can straddle a note/pane switch. `EnvEditorModal` avoids the first hazard only because it re-lists files rather than holding an editable buffer keyed on cwd.
