# Rune as Flagship Agent — Rebrand & Default Switch

**Status:** Approved (design)
**Date:** 2026-05-26
**Owner:** @khang859

## Goal

Make [Rune](https://github.com/khang859/rune) the flagship AI coding agent surfaced by Fleet. Pi remains installed and fully functional, but loses its lead position in marketing, Dashboard, CLI, and Settings.

## Background

Fleet currently treats Pi as the flagship agent. Pi has a dedicated tab type (`PiTab`), plan modal (`PiPlanModal`), an extensive Settings panel under `settings/pi/`, a TypeScript extension surface (`resources/pi-extensions/`), and a top-level `fleet pi` CLI command.

PR #207 added a beachhead for Rune: when Rune starts inside a Fleet pane it emits `RUNE_READY_MARKER`, and Fleet pastes `~/.fleet/skills/fleet.md` into the session so Rune knows how to call Fleet's terminal commands. Rune is a Go binary with a self-contained TUI; it owns its own provider/model/skills configuration under `~/.rune/`.

We want Rune to feel like the recommended choice — without ripping Pi out.

## Scope

Four user-facing surfaces flip:

1. **README** — recommend Rune by name.
2. **Dashboard** — primary "Start Rune" CTA.
3. **CLI** — new `fleet rune` subcommand.
4. **Settings** — new Rune section above a relabeled "Pi (legacy)" section.

No Pi code is removed or refactored.

## Non-goals

- Removing or refactoring `pi-agent-manager.ts`, `pi-config-manager.ts`, `pi-env-injection-manager.ts`, `pi-auth-inspector.ts`, `PiTab.tsx`, `PiPlanModal.tsx`, `settings/pi/*`, `resources/pi-extensions/*`, or `resources/pi-skills/*`.
- Building a Rune-specific tab type / `RuneTab` component. Rune runs inside a normal terminal pane.
- Building a Rune plan modal. Rune's TUI owns plan mode.
- Building a providers/models/presets UI for Rune. Rune persists its own config under `~/.rune/` and exposes `/providers`, `/model`, `/settings` inside the TUI.
- Mascot or visualizer changes.

## Design

### 1. README

Under the existing tagline ("A lightweight, cross-platform terminal multiplexer for developers running multiple AI coding agents simultaneously."), add a "Recommended agent: Rune" callout near the top of the Features section. It links to https://github.com/khang859/rune and shows the install one-liner:

```bash
curl -fsSL https://raw.githubusercontent.com/khang859/rune/main/install.sh | sh
```

The README does not currently name Pi, so no Pi mentions need to be edited.

### 2. Dashboard

In `src/renderer/src/components/Dashboard.tsx`, add a "Start Rune" button directly below "New Terminal," using the same hover-cyan styling. No keyboard shortcut hint in the first cut.

The handler calls a new prop `onStartRune()`, wired in `App.tsx` to dispatch the same store action that the `fleet rune` CLI dispatches (see below).

### 3. CLI

In `src/main/fleet-cli.ts`, add a `fleet rune` subcommand symmetric to the existing `fleet pi` block.

Behavior:

- `fleet rune` — opens a new terminal tab in the current working directory; the initial command is `rune`.
- Trailing args pass through: `fleet rune --prompt "fix tests"` → `rune --prompt "fix tests"` in the new tab.
- No `plan_open` analog. Rune handles plan mode internally.

Wire-up:

- Add top-level help row: `| rune | Open Rune coding agent tabs. |`. The existing `pi` row stays.
- Add a `rune` help block analogous to the `pi` help block.
- The command sends a new socket-API message `rune.open` with `{ cwd, args }`.

### 4. Settings

#### Nav order (`SettingsNav.tsx`)

```
General
Notifications
Socket API
Visualizer
Copilot (darwinOnly)
Rune            ← new, leads agent-related entries
Pi (legacy)     ← relabeled from "Pi Agent"
Annotate
Updates
```

`SettingsSection` union gains `'rune'`. `ALL_SECTIONS` order updated. The Pi entry's `label` flips from `"Pi Agent"` to `"Pi (legacy)"`; its `id` stays `'pi'`, so no other code needs to change.

#### New `RuneSection.tsx`

Location: `src/renderer/src/components/settings/rune/RuneSection.tsx`.

Sections, top to bottom:

1. **Header strip** — title "Rune", one-line description, GitHub link.
2. **Install row** — on mount, call the new `window.fleet.rune.getVersion()` IPC, which spawns `rune --version` in the main process and parses stdout. If installed, show the version string. If not (binary missing on `PATH` or non-zero exit), show:
   - "Rune is not installed."
   - The install one-liner in a `<code>` block with a "Copy" button.
   - No auto-install.
3. **Skills row** — button "Open `~/.rune/skills`" that opens the folder in the OS file browser. Implementation: if an `openPath`-style IPC already exists on `window.fleet` (e.g. used for recent folders in the Dashboard), reuse it; otherwise add a small `rune.openSkillsDir` handler that calls Electron's `shell.openPath('~/.rune/skills')` and creates the directory if it doesn't exist.
4. **Configuration note** — short paragraph: "Configure providers, models, and other settings inside Rune itself via `/providers`, `/model`, and `/settings`. Rune persists configuration under `~/.rune/`."

No reads of `~/.rune/` config from Fleet's side. No new shared types. No new main-process service beyond a `rune.version` IPC.

### IPC additions

In `src/shared/ipc-api.ts`:

- `pi.open` already exists; add a symmetric `rune.open` payload `{ cwd: string; args: string[] }`.
- New `rune.getVersion(): Promise<{ installed: true; version: string } | { installed: false }>`.

Main-process registration mirrors the existing Pi patterns.

### Workspace store

Add `addRuneTab(cwd: string, args: string[]): string` to `workspace-store.ts`. Implementation creates a normal terminal tab (`type: 'terminal'`) whose initial pane command is `rune` plus the args. Returns the new tab id.

Reuse the existing `RUNE_READY_MARKER` skill-injection plumbing in `use-terminal.ts` — no changes there.

### App.tsx

Add a listener parallel to the existing `window.fleet.pi.onOpen` listener:

```ts
const cleanup = window.fleet.rune.onOpen((payload) => {
  useWorkspaceStore.getState().addRuneTab(payload.cwd, payload.args);
});
```

Dashboard's `onStartRune` prop calls `addRuneTab(cwd, [])` directly.

## Files added / changed

**Added:**

- `src/renderer/src/components/settings/rune/RuneSection.tsx`

**Modified:**

- `README.md` — Rune callout.
- `src/renderer/src/components/Dashboard.tsx` — "Start Rune" CTA.
- `src/renderer/src/components/settings/SettingsNav.tsx` — add `'rune'` to union, reorder, relabel Pi.
- `src/renderer/src/components/settings/SettingsTab.tsx` — route `'rune'` to `<RuneSection />`.
- `src/renderer/src/App.tsx` — Dashboard prop, `rune.onOpen` listener.
- `src/renderer/src/store/workspace-store.ts` — `addRuneTab` action.
- `src/main/fleet-cli.ts` — `rune` group, help text.
- `src/main/index.ts` (or wherever socket-API commands are registered) — `rune.open`, `rune.getVersion` handlers.
- `src/preload/index.ts` — expose `window.fleet.rune.{onOpen, getVersion}`.
- `src/shared/ipc-api.ts` — new IPC payload types.

## Testing

- Unit test for `fleet rune` CLI argument parsing in `fleet-cli.test.ts`.
- Unit test for `addRuneTab` store action.
- Manual: launch Fleet, click Dashboard "Start Rune," confirm a terminal tab opens and Rune launches with the Fleet skill injected.
- Manual: from any terminal pane, run `fleet rune --prompt "hello"` and confirm a new tab opens running that command.
- Manual: Settings → Rune renders correctly with and without Rune installed; "Copy" copies the install command; "Open `~/.rune/skills`" opens the folder.
- Verify Settings nav shows "Pi (legacy)" and the Pi page still works untouched.

## Open questions

None at design time. Implementation may surface choices about exact button labels and copy.
