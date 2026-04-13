# Telescope Browse Mode: Gitignore-Aware File Dimming

## Summary

Add visual differentiation to the telescope Browse mode so that gitignored files and folders appear dimmed (muted text color) compared to tracked/untracked project files. This helps users quickly distinguish "project files I work on" from "build artifacts / dependencies / generated stuff."

## Scope

- **Browse mode only.** Files mode already filters out gitignored files via `git ls-files`. Grep and Panes modes are unaffected.
- **Gitignored vs. not-ignored only.** No other git status indicators (modified, staged, untracked). The telescope is a quick navigation tool, not a file manager.
- **Git repos only.** Non-git directories render everything normally with no dimming.

## UX Research

Based on Baymard Institute and Nielsen Norman Group research:

- **Dim rather than hide.** Hiding items breaks spatial awareness and prevents users from knowing what exists (Baymard, NNG). Browse mode should continue showing everything.
- **Muted text color over opacity.** NNG flags opacity as problematic — it can signal "disabled/non-interactive" when the item is still selectable. A hand-picked muted color avoids this and is more accessible.
- **Keep it simple.** NNG warns that over-differentiating list items "can backfire and make it difficult to scan." A single binary color split (normal vs. muted) is the lightest effective treatment.
- **Established pattern.** VS Code, JetBrains, and most editors use muted text for gitignored files. Users already recognize this visual language.

## Visual Treatment

| State | Text Color | Notes |
|-------|-----------|-------|
| Normal file/folder (unselected) | `text-neutral-300` | Current behavior, unchanged |
| Gitignored file/folder (unselected) | `text-neutral-600` | Muted but still readable |
| Any file/folder (selected) | `text-white` on `bg-neutral-700` | Selection always wins, no dimming |

The icon color follows the text color — no separate icon treatment needed.

## Technical Design

### New IPC Handler: `FILE_CHECK_IGNORED`

- **Input:** directory path (string)
- **Process:** 
  1. Read directory entries via `readdir()`
  2. Run `git check-ignore <entries...>` in one batch call from the directory
  3. Parse output to get the set of ignored entry names
- **Output:** `string[]` of ignored file/folder names
- **Error handling:** If `git check-ignore` fails (not a git repo, git not installed, any error), return an empty array — no dimming, no errors

### Browse Mode Changes

1. After `readdir()` loads entries for a directory, call `FILE_CHECK_IGNORED` with the directory path
2. Attach an `isIgnored: boolean` flag to each `TelescopeItem` via the `data` property
3. Cache ignore results per directory path (same pattern as files mode's module-level cache) so navigating back is instant

### TelescopeModal Changes

1. When rendering each result item, check `item.data?.isIgnored`
2. Apply `text-neutral-600` class instead of `text-neutral-300` for ignored items (unselected state only)
3. Selected state unchanged — `text-white` always wins

### Edge Cases

- **Not a git repo:** `git check-ignore` fails, returns empty array, no dimming applied. Behaves exactly as today.
- **`.git/` directory:** Gets dimmed (it's in `.gitignore` implicitly or recognized as special). If `git check-ignore` doesn't flag it, we can hardcode `.git` as always-dimmed.
- **Gitignored folder drilled into:** When user navigates into an ignored folder (e.g., `node_modules/`), the contents are checked independently via a fresh `git check-ignore` call for that subdirectory. Items inside may or may not be individually ignored.
- **Symlinks:** Handled normally — `git check-ignore` resolves them.
- **Large directories:** `git check-ignore` is fast even for large directories since it's a single batch call. No performance concern.
- **Cache invalidation:** Cache is per-telescope-session (module-level). Cleared when telescope closes. No need for filesystem watchers — the telescope is a transient UI.

## Files Changed

| File | Change |
|------|--------|
| `src/shared/ipc-api.ts` | Add `FILE_CHECK_IGNORED` channel definition |
| `src/main/ipc-handlers.ts` | Add handler that runs `git check-ignore` |
| `src/preload/index.ts` | Expose `file.checkIgnored()` to renderer |
| `src/renderer/src/components/Telescope/modes/browse-mode.ts` | Call `checkIgnored`, attach `isIgnored` flag to items |
| `src/renderer/src/components/Telescope/TelescopeModal.tsx` | Apply muted color class for ignored items |
