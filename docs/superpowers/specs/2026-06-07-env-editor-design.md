# Env Editor — Design Spec

**Date:** 2026-06-07
**Status:** Approved (brainstorming complete; ready for implementation plan)

## Summary

A standalone UI for editing `.env` files inside a folder, shipped alongside the
existing Env Sync toolbar feature. It opens from its own toolbar button into a
master–detail modal: a left navigator listing all `.env*` files (grouped by
folder, handling arbitrary nesting) and a right-hand **hybrid editor** that
defaults to a structured KEY=VALUE form with a one-click toggle to raw text.

It is intentionally separate from `EnvSyncModal` (which handles S3 push/pull) to
avoid bloating that already-large component. They share styling conventions and
file-parsing patterns but no runtime state.

## Goals

- Edit existing `.env` files with guardrails (validation, secret masking) plus a
  raw escape hatch that preserves comments, blank lines, and key ordering.
- Handle nested `.env` files at any depth across a project.
- Full file management: create, rename, delete (soft-delete + undo).
- Polished, NN/g-grounded micro-interactions and click feedback.
- Real icons (lucide-react), no emoji.

## Non-Goals

- No S3 / remote sync (that is Env Sync's job; the two features are independent).
- No `.env` schema/secret-store integrations (Doppler, Vault, etc.).
- No syntax-aware autocomplete for values.
- Renderer unit tests beyond pure logic (repo renderer is largely untested).

## Decisions (from brainstorming)

| Decision | Choice |
|---|---|
| Entry point | Separate toolbar button + standalone modal |
| Editing model | Hybrid: structured form default + raw-text toggle |
| Scan root | Focused pane's cwd, with a folder picker to change it |
| File navigator | Flat list grouped by folder, with instant filter |
| Save model | Explicit: Cmd+S **and** a Save button that activates when dirty |
| Secret masking | Mask all values by default; per-row reveal + global "Reveal all" |
| Templates (`.env.example`/`.sample`/`.template`) | Shown, editable, visually dimmed |
| File ops | Full create / rename / delete |
| Delete | Soft-delete + Undo toast (no blocking confirm dialog) |
| Icons | lucide-react only, no emoji |

## Architecture

Mirrors the existing env-sync layout. New code lives in its own folders.

### Renderer — `src/renderer/src/components/env-editor/`

- **`EnvEditorModal.tsx`** — modal shell, owns all state (file list, selected
  file, parsed model, dirty flag, reveal-all flag, busy flags). Plain React
  `useState` (matches `EnvSyncModal`). Handles Cmd+S, Escape, unsaved-changes
  guard, click-away.
- **`FileNavigator.tsx`** — grouped file list + filter box + "New .env file" and
  folder-picker controls. Emits selection and file-op intents.
- **`EnvForm.tsx`** — structured rows view; renders `EnvRow` per variable plus
  "Add variable".
- **`EnvRow.tsx`** — one variable: key field, value field, mask/reveal eye,
  delete-row, inline validation (duplicate key, empty key).
- **`EnvRawEditor.tsx`** — raw-text `<textarea>` with simple monospace styling
  (no heavy editor dep); reflects/produces the same file text.
- **Dialogs:** `NewFileDialog.tsx`, `RenameDialog.tsx` (or inline rename),
  delete handled via undo toast (no dialog).

### Main — `src/main/env-editor/`

- **`env-editor-fs.ts`** — filesystem operations: `listEnvFiles(root)`,
  `readFile(absPath)`, `writeFile(absPath, text)` (atomic: write temp + rename),
  `createFile`, `renameFile`, `softDelete`/`restore`. Reuses `parseEnv` patterns
  from `src/main/env-sync/env-file.ts`.
- **`env-parse.ts`** — round-trip parser: text → `EnvLine[]` (variable | comment
  | blank) and back, so form edits never lose comments/order. (May reuse/extend
  `env-sync/env-file.ts#parseEnv` rather than duplicate; implementation plan to
  decide reuse vs. new module.)

### Shared — `src/shared/env-editor-types.ts`

All request/response payloads defined as zod schemas and inferred types (per the
project's "no unsafe assertions" rule — runtime-validate at the IPC boundary).

### Wiring

- `PaneToolbar.tsx`: add `onEnvEditor?: () => void` prop + a `FilePenLine`
  button with `ToolbarTooltip` label "Edit .env", placed next to Env Sync.
- `TerminalPane.tsx` / `PiTab.tsx`: pass
  `onEnvEditor={() => document.dispatchEvent(new CustomEvent('fleet:toggle-env-editor'))}`.
- `App.tsx`: `envEditorOpen` state, toggle listener for
  `fleet:toggle-env-editor`, render `<EnvEditorModal isOpen onClose cwd={focusedPaneCwd} />`.

## Data Model

```ts
// One physical line in an .env file, preserved for round-trip fidelity.
type EnvLine =
  | { kind: 'var'; key: string; value: string; raw: string }
  | { kind: 'comment'; raw: string }
  | { kind: 'blank' };

type ParsedEnvFile = {
  lines: EnvLine[];        // full ordered line list (source of truth)
  text: string;            // exact original text (for raw mode + dirty diff)
};

type EnvFileEntry = {
  absPath: string;
  relPath: string;         // posix, relative to scan root
  group: string;           // folder path for grouping ('·root' for top level)
  name: string;            // e.g. '.env.local'
  isTemplate: boolean;     // .example / .sample / .template / .dist / .defaults
  varCount: number;
  readable: boolean;       // false → shown disabled with reason
};
```

Form mode mutates a working copy of `lines`; serialization rebuilds text from
`lines`, patching only changed `var` lines and leaving `comment`/`blank` intact.
Toggling Form↔Raw re-parses/re-serializes so the two views never diverge.

### Masking policy

**All values are masked until revealed** — there is no per-key "is this a
secret?" heuristic (the chosen policy masks everything, so none is needed).
Reveal is per-row (`Eye`/`EyeOff`) or global ("Reveal all"). Masking is a
display-only, per-session state and is never written to disk.

## IPC Surface

New channels (added to `src/shared/ipc-channels.ts`, handlers in
`src/main/ipc-handlers.ts`, preload binding `window.fleet.envEditor.*`):

| Channel | Args | Returns |
|---|---|---|
| `env-editor:list` | `root: string` | `EnvFileEntry[]` (grouped/sorted) |
| `env-editor:read` | `absPath: string` | `{ text: string; mtimeMs: number }` |
| `env-editor:write` | `absPath, text, expectedMtimeMs?` | `{ ok; mtimeMs }` or `{ externalChange: true }` |
| `env-editor:create` | `dir, name` | `EnvFileEntry` (collision → error) |
| `env-editor:rename` | `absPath, newName` | `EnvFileEntry` (collision → error) |
| `env-editor:delete` | `absPath` | `{ trashPath }` (soft-delete) |
| `env-editor:restore` | `trashPath, absPath` | `{ ok }` (undo) |

All inputs/outputs validated with zod. Writes are atomic (temp file + rename).
`expectedMtimeMs` enables external-change detection on save.

### Scanner rules (`env-editor:list`)

- Recursively scan from `root` (cwd or picked folder), max depth ~4 (matches
  env-sync), excluding `node_modules`, `.git`, `dist`, `build`, `.next`,
  `.turbo`, `out`, `coverage`.
- Match files whose basename starts with `.env`. **Include** templates
  (`.example`/`.sample`/`.template`/`.dist`/`.defaults`) flagged `isTemplate`
  (unlike env-sync's scanner, which excludes them).
- Group by parent folder; top-level files in a `·root` group; sort groups by
  path, files alphabetically within a group.

## Key Behaviors

### Save
- Edits stay in memory until **Cmd+S** or clicking **Save**. Save button is
  disabled/quiet until `dirty`, then becomes prominent (blue, glow).
- On save: optimistic UI (mark saved immediately), call `env-editor:write`. On
  success show passive **"Saved" toast**. On failure: revert dirty=true and show
  an **inline** error banner in the editor (never a toast for errors).
- If `write` reports `externalChange` (mtime mismatch): inline warning "This file
  changed on disk" with **Reload** (discard local) / **Overwrite** actions.
- Switching files or closing the modal while dirty → confirm dialog
  ("Discard unsaved changes to `<file>`?" with named, separated destructive button).

### Secrets
- All values masked by default. `Eye`/`EyeOff` per row; "Reveal all" in header
  toggles globally. State is per-session, display-only.

### File operations
- **Create:** `NewFileDialog` — choose target folder (from scanned folders) +
  filename (validated: must start with `.env`, no collision). New file opens
  selected and empty.
- **Rename:** inline edit of the filename in the navigator; collision-checked.
- **Delete:** soft-delete (move to an app temp trash dir) + **Undo toast**
  ("Deleted `<file>`. Undo"). Undo calls `env-editor:restore`. Trash purged when
  the modal closes.

### Navigator filter
- Instant filter-as-you-type over file name + relPath. Calm reflow (no flashy
  per-keystroke animation). Zero matches → inline empty state with "Clear filter".

### Empty / first-run state
- No `.env` files under root → centered empty state: explanation of what `.env`
  files are + prominent **"Create .env file"** button (single primary action).

## Edge Cases

- Nested `.env` files at any depth → grouped by folder.
- Duplicate keys → live inline "duplicate key" warning; parse is last-wins.
- Values containing `=`, quotes, `export ` prefix, `#` inside quoted values,
  and quoted multi-token values → preserved via the original `raw` line.
- Empty values (`KEY=`) → valid, shown as empty input.
- Comments and blank lines → preserved (round-trip via `EnvLine`).
- `.env` with no suffix vs `.env.local`/`.env.production` → all matched.
- Symlinks → resolve and edit the target.
- File changed on disk while open → detected on save via mtime → inline
  warning + Reload/Overwrite.
- Very large file → fall back to raw mode only (skip structured parse above a
  size threshold) to keep the form responsive.
- Unreadable / permission-denied file → listed but disabled, with reason shown.
- Filter yields no results → empty state, not a blank pane.

## Micro-interactions & Animation (NN/g-grounded)

Exact values to implement (sources: NN/g "Executing UX Animations: Duration and
Motion Characteristics", "Response Time Limits", "Visibility of System Status",
"Button States", "Stop Password Masking", "Indicators, Validations, and
Notifications", "Confirmation Dialogs", "User Control and Freedom").

- **Press feedback:** every button uses `active:scale-[0.97]`, transition < 100ms
  (reuse env-sync `primaryBtn`/`neutralBtn`). Click feedback must land inside the
  0.1s "instantaneous" window.
- **Modal:** enter ~300ms, exit ~200ms, **ease-out** (enter slightly longer than
  exit per NN/g asymmetry guidance).
- **Selected file:** three cues, not color alone — background fill + left-edge
  accent bar + bold text.
- **Dirty state shown redundantly:** amber dot on the file in the navigator +
  "● unsaved" near the filename + Save button activating.
- **Row edit mode:** focused row gets a blue ring; commit on blur or Enter, Esc
  cancels (modes must be visible and escapable).
- **Validation:** field errors on blur; the duplicate-key warning is live
  (validation that prevents a real mistake may fire while typing).
- **Loading:** `Loader2` spinner only for waits > 1s; sub-second ops show no
  spinner (optimistic). Inline spinner on in-flight Save/file-op buttons.
- **Feedback channels:** passive success → toast ("Saved", "Deleted … Undo");
  field problems → inline; blocking/critical → modal. Never errors in a toast.
- **Accessibility:** all motion gated behind `prefers-reduced-motion`; reduced
  motion → instant state changes, no scale/slide.
- **Icons:** lucide-react only (`FilePenLine`, `Eye`/`EyeOff`, `Save`, `Plus`,
  `Trash2`, `Pencil`, `Folder`, `ChevronDown`, `Search`, `Table`/`Code`,
  `AlertTriangle`, `Loader2`). No emoji.

## Testing

Main-process unit tests (follow `src/main/__tests__/env-sync-*.test.ts`):

- **Parser round-trip:** text → `EnvLine[]` → text is byte-stable; editing one
  value preserves all comments, blank lines, ordering, and quoting.
- **Scanner:** correct grouping, template detection, depth limit, exclude dirs.
- **Atomic write:** temp+rename; external-change (mtime) detection.
- **Edge cases:** duplicate keys, `=` in values, quoted values, empty values,
  `export ` prefix.

Shared: zod schema tests for IPC payloads.

Renderer: keep parsing/serialization in pure functions so they're unit-testable
without rendering; no component tests (consistent with repo conventions).

## Files Touched (summary)

**New:**
- `src/renderer/src/components/env-editor/` (EnvEditorModal, FileNavigator,
  EnvForm, EnvRow, EnvRawEditor, NewFileDialog, RenameDialog)
- `src/main/env-editor/env-editor-fs.ts`, `env-parse.ts`
- `src/shared/env-editor-types.ts`
- `src/main/__tests__/env-editor-*.test.ts`, `src/shared/__tests__/env-editor-types.test.ts`

**Modified:**
- `src/shared/ipc-channels.ts` (new channel constants)
- `src/main/ipc-handlers.ts` (register handlers)
- `src/preload/index.ts` (`window.fleet.envEditor.*` binding + types)
- `src/renderer/src/components/PaneToolbar.tsx` (toolbar button)
- `src/renderer/src/components/TerminalPane.tsx`, `PiTab.tsx` (event dispatch)
- `src/renderer/src/App.tsx` (modal state + render)

## Verification

`npm run typecheck`, `npm run lint`, `npm run build`, and the new unit tests must
pass before completion.
