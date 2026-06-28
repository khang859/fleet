# ⌘K Command Palette - Design

Issue: [#409 - UI: ⌘K command palette - grouped + contextual + jump-to-needy-agent](https://github.com/khang859/fleet/issues/409)
Date: 2026-06-28
Status: Approved, pending implementation plan

## Goal

Replace Fleet's hand-rolled command palette with a keyboard-first, grouped, contextual ⌘K palette modeled on Linear / Raycast / Vercel `cmdk`.
It must support grouped results, a contextual sub-mode scoped to a selected pane/agent, and a featured "jump to the agent that needs input" flow.

## Decisions

These were settled during brainstorming and are fixed for v1.

1. **Foundation: rebuild on `cmdk`.**
   The existing `CommandPalette.tsx` is a custom React component with boolean fuzzy matching, no grouping, and no combobox/listbox ARIA.
   We rebuild on `cmdk` (the engine behind shadcn's `Command`), which provides grouping, scored fuzzy ranking, vim navigation, and correct combobox/listbox ARIA with `aria-activedescendant` out of the box.
2. **Trigger: ⌘K, drop ⌘P+Shift.**
   ⌘K becomes the single trigger, matching the issue title and industry norm.
   The old ⌘P+Shift binding is removed.
3. **In scope for v1:** frecency ranking for the Recent group, and a footer action bar.
4. **Deferred (not v1):** prefix modes (`>`, `@`, `/`, `:`), matched-character highlighting (would require swapping in `fuzzysort`), and list virtualization.
5. **Virtualization: deferred.**
   Fleet realistically has well under 500 total commands + panes + agents.
   We use a scrollable list with a per-group result cap (~50) and native overflow scroll instead, keeping cmdk's keyboard nav and ARIA intact.
   A code comment will note that virtualization can be added if list sizes ever grow.

## Architecture and files

- **Add dependency:** `cmdk`.
- **New `components/ui/command.tsx`:** a styled shadcn-pattern wrapper around `cmdk`, themed to Fleet's `fleet-surface` / `neutral-900` tokens.
- **Rewrite `src/renderer/src/components/CommandPalette.tsx`** on `cmdk`'s `Command.Dialog`.
  `Command.Dialog` is Radix-Dialog-backed, giving focus trap, focus restore, and scroll lock - which the a11y research flagged as required.
  We drop the custom `Overlay` wrapper here, but apply Fleet's existing `lib/motion.ts` animation classes plus `motion-reduce:` variants so the open/close matches the house 150ms style.
- **Evolve `src/renderer/src/lib/commands.ts`** from a flat static list into a registry that composes static commands with dynamically generated destinations and needs-you items (see Item model).
- **New `src/renderer/src/store/command-frecency-store.ts`:** decayed-count frecency, persisted to localStorage.
- **Touch `src/renderer/src/lib/shortcuts.ts`:** rebind `command-palette` to ⌘K (`meta: true, key: 'k'`), remove the shift+p combo.
- **Touch `src/renderer/src/hooks/use-pane-navigation.ts`:** register ⌘K as a capture-phase renderer keydown.
- **Touch the xterm terminal setup:** add an `attachCustomKeyEventHandler` guard that returns `false` for the ⌘K combo so it never leaks into a focused terminal.

## Item model and groups

```ts
type PaletteItem = {
  id: string
  label: string
  section: 'needs-you' | 'recent' | 'command' | 'destination'
  keywords?: string[]
  icon?: LucideIcon
  shortcut?: ShortcutDef        // rendered as a right-aligned kbd chip
  badge?: string                // e.g. "needs you"
  hasActions?: boolean          // ⌘K / → enters this item's contextual panel
  run: () => void
}
```

Static commands stay declared in `commands.ts`.
Destinations (panes / agents / tabs / sessions) and the needs-you list are generated live from `workspace-store` and `notification-store`.

**Section order** (groups auto-hide when empty; cmdk handles this):

1. **Needs you** - agents where `ActivityState === 'needs_me'` (from `notification-store`), pinned to the top.
   This is the "jump to the agent that needs input" flow.
   Enter on a row calls `setActiveTab(tabId)` then `setActivePane(paneId)`.
2. **Recent** - frecency-ranked, shown on zero-query open.
3. **Commands** - the static actions: dispatch new agent, split right/down, close pane, switch overview grouping, answer-blocked-agent, settings, etc.
4. **Destinations** - jump to any pane / agent / tab / session.

Zero-query open shows **Needs you → Recent → Commands**, never blank.
Typing filters and scores across all sections via cmdk's built-in `command-score`.

Note: the issue lists the groups as Commands / Destinations / Recent and names "jump to agent that needs input" as a command.
We promote it to a dedicated **Needs you** section at the top because that is the stronger UX (confirmed during brainstorming).

## Contextual mode

A two-level model built on cmdk's pages stack.

- Top level is the global palette described above.
- On a destination or agent row, **⌘K or →** opens that item's **scoped action panel** (Rename pane, Close pane, Split right/down, Restart/focus agent, Copy session path, etc.).
  The panel is replaced in place, not stacked as a second modal.
- The active context shows as a **breadcrumb pill inside the input** (e.g. `agent: refactor-auth ›`) and is reflected in the input placeholder.
- **Esc** pops the scope first, then closes the palette on a second press.
- **Backspace on an empty input** also pops the scope.
- A single `mode` state is the source of truth so Radix's `onEscapeKeyDown` and cmdk's `onKeyDown` do not both fire.

## Frecency

A decayed-count score per item id: on each run, `score = score * exp(-decay · Δt) + 1`, with roughly a 10-day half-life.
Persisted to localStorage.
Recorded on `run()` (actual execution), not on highlight.

Frecency drives the **Recent** group and zero-query ordering only.
Typed-search ranking stays cmdk's built-in scorer; we deliberately do not pull in `fuzzysort`, so fuzzy ranking and frecency stay cleanly separated.

## Accessibility

- `Command.Dialog` provides combobox / listbox / dialog roles, `aria-activedescendant`, focus trap, focus restore, and scroll lock.
- **Add** an `aria-live="polite"` screen-reader-only announcer for result counts ("12 results") and mode changes ("Switch branch mode, 8 options").
  cmdk ships none.
  Updates are debounced ~250ms and the region exists in the DOM before it receives content.
- **⌘K** is registered at the renderer level in the **capture phase** (never Electron `globalShortcut`, which is system-wide and wrong for an in-app palette).
  The xterm `attachCustomKeyEventHandler` returns `false` for the combo so a focused terminal never swallows it.
- The palette **restores prior pane focus** on close.
- `motion-reduce:` variants use opacity only (no transform) under `prefers-reduced-motion`.
- `:focus-visible` ring on the input; the selected option uses an outline-safe highlight so it survives forced-colors mode.

## Visual spec

The cmdk Vercel theme adapted to Fleet tokens.

- ~640px wide, top-center, roughly 18% from the top.
- 12px dialog radius, ~48px rows, 8px row radius.
- ~400px max list height, native scroll, per-group cap ~50.
- Dim / frosted backdrop.
- Selected row uses a subtle translucent fill, not a saturated accent.
- Right-aligned kbd chips reusing `formatShortcut`.
- **Footer action bar:** left shows the context breadcrumb; right shows `↵ Run` · `⌘K Actions` · `esc Close`.

## Testing and verification

- ⌘K opens the palette from anywhere, including when a terminal pane is focused (verifies the xterm guard).
- Arrow keys navigate with wrap, Enter runs, Esc closes; Esc pops the contextual scope before closing.
- Grouped results render with Needs you pinned on top; groups hide when empty.
- With an agent in `needs_me` state, the Needs you section lists it and Enter jumps focus to that pane.
- ⌘K / → on a destination row opens its scoped action panel; Backspace on empty input pops back.
- Zero-query open is non-blank (Needs you / Recent / Commands).
- Frecency: a recently run command surfaces in Recent on next open.
- `npm run typecheck` and `npm run lint` pass.
