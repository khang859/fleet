# Shell Environment Viewer - Design Spec

**Date:** 2026-07-03
**Status:** Approved for planning

## Summary

A read-only modal that shows the environment variables Fleet injected into the focused terminal at spawn time, grouped by where each variable came from.
It is opened exclusively from the ⌘K command palette ("Shell Environment") - it has no pane-toolbar button.
It is a diagnostic inspector, distinct from the two existing env features:

- **Env Editor** - edits `.env` *files* on disk under a pane's cwd.
- **Env Sync** - manages encrypted vars injected into new PTYs at spawn.
- **Shell Environment (this tool)** - *views* the resolved env a given terminal actually started with.

## Motivation

Developers running multiple shells and AI agents frequently need to answer "what did Fleet actually inject into *this* terminal, and where did each value come from?"
A plain `env | grep` answers the first half but not the provenance, and it clutters the terminal.
The provenance grouping (login shell vs Env Sync vs Fleet built-ins) is the reason this tool earns a place next to `env`.

## Hard Constraint: Spawn-Time Snapshot Only

Reading the *live* environment of a running shell from outside the process is not viable cross-platform, and is impossible on macOS (the primary platform):

- **macOS**: Since macOS 11 with SIP enabled, a process cannot read another process's environment at all. `KERN_PROCARGS2` only ever exposed the exec-time snapshot.
- **Linux**: `/proc/<pid>/environ` is readable but is also exec-time only - it never reflects `export`s typed after the shell started.
- **Windows**: requires system APIs, same exec-time limitation.

VS Code, the reference implementation, never reads live env either - it manages an injection collection applied at terminal creation.

Therefore this tool shows **the environment Fleet resolved and passed to the terminal at spawn time**: `process.env` (enriched from the user's login shell at startup) merged with the extras Fleet injects (Env Sync vars, `CLAUDE_CONFIG_DIR`, `FLEET_SESSION`).

**Accepted limitation:** the snapshot will not reflect variables the user manually `export`ed *after* the shell started. This is communicated with a single muted footer line, not a banner.

## Non-Goals

- No editing, creating, renaming, or deleting variables.
- No export-to-file.
- No diff-between-panes.
- No live refresh / re-read of the running shell.
- No "apply to next spawn" mutation layer (that is Env Sync's job).
- No pane-toolbar button (⌘K only).

## Architecture

### Data capture (main process)

The resolved env is captured **once, at spawn time**, and stashed on the pane's PTY entry.
It is never recomputed on demand - a later recompute would reflect what the env *would be now* (`process.env` mutates, Env Sync vars can change, secrets re-decrypt), which would misrepresent what the shell actually received.

**Source tagging.** Each key is tagged with its provenance as the env is merged:

- `login-shell` - inherited from `process.env`.
- `env-sync` - from `envSyncManager.getEnvForCwd(cwd)`.
- `fleet-builtin` - `CLAUDE_CONFIG_DIR` (set in the `PTY_CREATE` handler) and `FLEET_SESSION` (added in `pty-manager`).

**Where tagging happens.** `src/main/ipc-handlers.ts` `PTY_CREATE` already assembles `extraEnv` from known sources; it builds a `sources: Record<string, EnvSource>` map alongside the env it passes down (keys it explicitly adds are tagged `env-sync` / `fleet-builtin`).
`src/main/pty-manager.ts` `create()` performs the final merge, tags its own `FLEET_SESSION` as `fleet-builtin`, tags any remaining key present in `process.env` as `login-shell`, and stores the snapshot on the `PtyEntry`:

```ts
snapshot: {
  spawnedAt: number,          // epoch ms at spawn
  shellName: string,          // e.g. "zsh (login)"
  cwd: string,
  vars: Array<{ key: string; value: string; source: 'login-shell' | 'env-sync' | 'fleet-builtin' }>
}
```

**Edge cases:**

- The idempotent early-return path in `create()` (HMR re-create) must not drop an existing snapshot.
- Any pane restart/reload path must **overwrite** the snapshot rather than keep a stale one.

### IPC

One new channel, minimal surface - single pane only, no "list all panes" endpoint:

- Channel: `shell-env:get`
- Request: `paneId: string`
- Response: `ShellEnvSnapshot | null` (null when the focused pane has no PTY - e.g. a non-terminal pane)
- Preload: `window.fleet.shellEnv.get(paneId)`

Because the response carries decrypted Env-Sync secret values, the channel is deliberately scoped to a single `paneId` and there is no bulk endpoint.
(The renderer already receives terminal output, so this does not widen the trust boundary.)

### Command palette entry

Register a "Shell Environment" command in the cmdk palette (`src/renderer/src/lib/commands.ts` + `CommandPalette.tsx`).
Invoking it dispatches a toggle for the modal, targeting the pane focused **at invocation time**.
If the focused pane is not a terminal, the command still runs and the modal shows a graceful "no shell here" empty state (rather than the command being hidden).

### Renderer modal

New component under `src/renderer/src/components/shell-env/`.
Wired into `App.tsx` following the existing modal-tool pattern (state + DOM-custom-event toggle listener + render), matching Notes/Env Editor.
On open it calls `window.fleet.shellEnv.get(activePaneId)`.

## UI Specification

Grounded in existing conventions: neutral-* palette, `bg-black/60` backdrop, `border-neutral-800` chrome, `font-mono text-xs` content, `dialogFadeAnim` + `overlayTiming`/`usePresence` from `src/renderer/src/lib/motion.ts`, Eye/EyeOff reveal from `EnvEditorModal`.

### Shape & density

- Modal `w-[640px] max-w-[92vw] max-h-[72vh]`, centered, `rounded-xl border border-neutral-800 bg-neutral-900 shadow-2xl`. Inspector-sized, not workspace-sized.
- Backdrop `bg-black/60`, `dialogFadeAnim`. Rows never animate in.
- Fixed vertical structure: **header** (`px-5 py-3`, `border-b border-neutral-800`) / **search** (`px-5 py-2.5`, no bottom border) / **scroll region** (`flex-1 min-h-0 overflow-y-auto overscroll-contain`) / **footer** (`border-t border-neutral-800`, `px-5 py-2`).

### Rows

- Single-line grid `grid grid-cols-[minmax(140px,max-content)_1fr_auto]`, `h-8`, `px-5`, `items-center`. No per-row borders, no zebra.
- **Key** (col 1): `font-mono text-xs text-neutral-200 font-medium`, `pr-4`, no truncation. Brightest text in the row.
- **Value** (col 2): `font-mono text-xs text-neutral-400`, always `truncate` (one line), `title={value}` for full text. Never wrap. Long values (e.g. `PATH`) truncate; full text lands on copy.
- **Actions** (col 3): reveal + copy cluster, fixed width, `opacity-0 group-hover:opacity-100 focus-within:opacity-100` so it never shifts the value column.
- No literal `=` glyph - column gap + color contrast read as assignment.
- Row hover / keyboard selection: inset pill `hover:bg-neutral-800/50 rounded-md` with `text-neutral-100` on the key when selected.

### Provenance grouping

- **Section headers only** - no per-row badges, no colored left borders, no per-row tinting.
- Sticky headers: `sticky top-0 z-10 bg-neutral-900/95 backdrop-blur-sm`, `px-5 pt-4 pb-1.5`, `text-[11px] font-medium uppercase tracking-wider text-neutral-500`, showing `Label · count`.
- Single 8px `rounded-full` accent dot before each section label is the entire color system: neutral for Login shell, Fleet accent (teal) for Fleet built-ins, blue for Env Sync (match Env Sync's existing badge color if present).
- Section order: **Fleet built-ins, Env Sync, Login shell** - Fleet's own injections first, the large login-shell dump last.

### Typography

- Everything in the scroll region is mono; header, footer, search, and section labels are sans. This sans-chrome/mono-content contrast is the primary "professional" signal.
- One value color only - no value syntax coloring.

### Masking

- Masked value renders as literal `••••••••` (exactly 8 bullets, `text-neutral-500`, mono) regardless of true length - fixed width, no length leak, never blur.
- Masked by default when: the key matches `/TOKEN|SECRET|KEY|PASSWORD|PASSWD|CREDENTIAL|AUTH/i`, **or** the var's source is `env-sync` (encrypted for a reason), regardless of key name.
- Reveal: the masked span itself is a button (`hover:text-neutral-300`, `title="Click to reveal"`), plus an Eye icon (13px) in the action cluster. Reveal is per-row, resets on modal close, no animation on swap.
- A header-right **"Reveal all"** Eye/EyeOff toggle mirrors `EnvEditorModal`.
- No layout shift on reveal: the value cell is `flex-1 truncate` in both states.
- **Copy** (Copy icon, 13px) always copies the **true** value even while masked - the core workflow is copying a token without shoulder-surfing it. One copy action per row (value only); no copy-key or copy-`KEY=value`.
- Icon buttons: `h-6 w-6 rounded-md hover:bg-neutral-800 text-neutral-500 hover:text-neutral-300`.

### Search

- Fixed strip under the header (never inside scroll region). Input `h-8 rounded-md bg-neutral-950 border border-neutral-800 pl-8 pr-3 font-mono text-xs`, Search icon 14px absolute-left, sans placeholder "Filter variables…". **Autofocus on open.** Focus ring `focus-visible:border-neutral-600` (no blue halo).
- Live, case-insensitive substring match on key **or** value. Matches against true values even when masked, but does **not** auto-reveal matched secrets. No debounce (in-memory list).
- Section headers are kept while filtering; empty sections are hidden; counts update to `3 of 42`.
- Matched substring in keys is brightened (`text-neutral-50`), not background-highlighted. No highlight inside masked values.
- Empty state: centered `SearchX` icon 24px `text-neutral-600` + "No variables match '<query>'" `text-sm text-neutral-400`. No CTA.

### Keyboard

The keyboard-first flow is the spine of the feature: `⌘K → "shell env" → type FOO → ↑/↓ select → Enter copies value`, no mouse.

- Search input retains DOM focus (cmdk-style); `↑/↓` move a selection highlight through visible rows.
- `Enter` (or `⌘C`) copies the selected row's value.
- `Space` toggles reveal on the selected row.
- `Esc` closes (via existing Overlay).

### Header

- Two lines max. Line 1: Terminal icon 16px `text-neutral-400` + shell name `text-sm font-semibold text-neutral-100` (e.g. "zsh (login)") + cwd chip (`bg-neutral-800 rounded-md px-2.5 py-1 text-xs truncate max-w-[260px]`, matching Notes' project chip).
- Right side: Reveal-all toggle, then close X.
- Spawn time is **not** in the header - it lives in the footer where the sentence gives it meaning.

### Footer

- One muted line, `text-[11px] text-neutral-500`, `·` separators: "Snapshot at shell launch (12:34 PM) · variables exported after launch aren't shown."
- Optionally right-aligned total count "97 variables".

### Copy feedback

- Copy icon swaps to `Check` in `text-emerald-400` for 1200ms, then reverts. No toast.

### Empty / no-shell state

- When the snapshot is null (focused pane has no PTY), the modal shows a centered muted "No shell in this pane" message instead of sections.

## Motion

Exactly `dialogFadeAnim` + `overlayTiming` from `src/renderer/src/lib/motion.ts` with `usePresence` for exit. Nothing bespoke. Rows do not animate.

## What to Avoid

- Per-row provenance badges (repeated pills = visual gravel; headers carry it).
- Cards/panels per section (reads as a dated dashboard).
- Zebra striping.
- Value syntax coloring.
- Blur masks, animated reveals, skeleton loaders (data is local and instant).
- Copy-key / copy-`KEY=value` buttons (one value copy per row).
- Editable-looking affordances (read-only should look inert; visual distance from Env Editor prevents "why can't I type here" confusion).
- Tabs instead of sections (hides data, kills cross-source search).

## Implementation Anchors

- Modal chrome pattern: `src/renderer/src/components/notes/NotesModal.tsx` (approx. lines 215-262).
- Reveal pattern (`revealAll` / `revealed` Set, Eye/EyeOff): `src/renderer/src/components/env-editor/EnvEditorModal.tsx` (approx. lines 51-52, 400-414).
- Motion tokens: `src/renderer/src/lib/motion.ts` (`dialogFadeAnim`, `overlayExitMs`, `usePresence`).
- Spawn env merge point: `src/main/pty-manager.ts` `create()` (approx. lines 106-112) and `src/main/ipc-handlers.ts` `PTY_CREATE` handler (approx. lines 251-333).
- IPC registration: `src/shared/ipc-channels.ts`, `src/main/ipc-handlers.ts`, `src/preload/index.ts`.
- Command palette: `src/renderer/src/lib/commands.ts`, `src/renderer/src/components/CommandPalette.tsx`.
- App wiring: `src/renderer/src/App.tsx` (modal state + DOM-custom-event toggle, following Env Editor / Notes).

## Success Criteria

1. ⌘K → "Shell Environment" opens the modal for the focused terminal.
2. Variables are shown grouped under Fleet built-ins / Env Sync / Login shell with correct provenance tags.
3. Secret-heuristic keys and all Env-Sync vars are masked by default; per-row and reveal-all reveal work; copy always copies the true value.
4. Search live-filters across keys and values, preserving section headers and counts.
5. Keyboard-only flow works end to end: open, filter, ↑/↓ select, Enter copies value, Esc closes.
6. Footer shows the spawn timestamp and the manual-export caveat.
7. Focusing a non-terminal pane and invoking the command shows the no-shell empty state.
8. Snapshot reflects spawn-time values and does not change if `process.env` / Env Sync change afterward.
9. `npm run typecheck` and `npm run lint` pass.
