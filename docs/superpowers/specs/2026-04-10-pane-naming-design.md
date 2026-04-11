# Pane Naming Design

## Summary

Add named headers to terminal panes that display the live CWD path by default, with the ability to set a custom name via double-click or keyboard shortcut. Headers only appear when a tab contains 2+ panes.

## Motivation

When a tab is split into multiple terminal panes, there's no way to tell them apart at a glance other than by their content. Adding a persistent header with a path or custom name provides wayfinding context and lets users label panes by purpose (e.g., "server", "tests", "logs").

### UX Research Backing

- **NNG "You Are Here"**: UIs should show users where they are now, not just where they can go. The CWD path serves as a persistent location indicator.
- **NNG Progressive Disclosure**: Defer secondary UI to when it's needed. A single pane needs no header since the tab already provides context.
- **NNG Direct Manipulation**: Double-click to rename is classic direct manipulation — interact with the object you want to change.
- **NNG Tabs Used Right**: Labels should be concise descriptions of content. Extends naturally to pane headers as sub-tab identifiers.
- **Baymard Double-Click**: Many users habitually double-click. Our design handles this intentionally (triggers rename) rather than as an error.

## Data Model

Add two optional fields to `PaneLeaf` in `src/shared/types.ts`:

```typescript
type PaneLeaf = {
  // ... existing fields ...
  label?: string;           // custom pane name (undefined = use live CWD)
  labelIsCustom?: boolean;  // true when user has set a custom name
};
```

Both fields are optional for backward compatibility — existing persisted pane trees deserialize without issues. Panes missing these fields display the live CWD path (default behavior).

### Store Actions

Two new actions in the workspace store:

- `renamePane(paneId: string, label: string)` — sets `label` and `labelIsCustom: true` via existing `updateLeafInTree()` helper
- `resetPaneLabel(paneId: string)` — clears `label` and sets `labelIsCustom: false`

## Pane Header Component

A new `PaneHeader` component rendered at the top of each terminal pane inside the pane wrapper in `PaneGrid.tsx`.

### Visibility

The header renders only when the active tab's `splitRoot.type === 'split'` (2+ panes exist). Single-pane tabs show no header and consume zero vertical space.

### Display States

- **Default (no custom label):** Shows the live CWD path from `useCwdStore`, shortened with the existing `shortenPath()` utility
- **Custom name:** Shows the user's label text, plus a small `x` reset button on the right

### Interactions

- **Double-click** the header text: enters inline edit mode (text input replaces the label, auto-selected, Enter to confirm, Escape to cancel)
- **Keyboard shortcut** (`Shift+F2`): enters inline edit mode on the active pane's header (mirrors `F2` for tab rename)
- **Click `x` reset button**: calls `resetPaneLabel()`, returns to live CWD display

### Styling

- Thin bar (~24px height) with muted background matching existing app chrome
- Monospace text, truncated with ellipsis on overflow
- `x` reset button only visible when `labelIsCustom` is true
- Subtle bottom border separating header from terminal content

## Keyboard Shortcut

- `Shift+F2` to rename the active pane (mirrors `F2` for tab rename)
- Registered in `src/renderer/src/lib/shortcuts.ts` as a new `ShortcutDef` and handled in `use-pane-navigation.ts`
- No-op when the active tab has a single pane
- Sets focus to the inline edit input in the active pane's header

## Integration Details

### Existing Hover Toolbar

`PaneToolbar` continues to float independently on hover. No changes. The header sits above the terminal content; the toolbar overlays both as it does today.

### Pane Lifecycle

- **Split:** New panes start with no label (`label` and `labelIsCustom` undefined). Default CWD path displays automatically.
- **Close:** No cleanup needed. The label lives in the tree node removed by `removePaneFromTree()`.
- **Persistence:** Labels serialize/deserialize automatically as part of the existing pane tree in `layout-store.ts`. No migration required.

### Terminal Resize

When the header appears (pane split) or disappears (last sibling closed), the xterm `fit()` addon recalculates dimensions. This is already triggered by layout changes in existing code.

## Scope

- Only terminal panes (no `paneType` or `paneType === 'terminal'`) get headers
- File, image, and markdown panes are unchanged
- No changes to tab labels, sidebar, or other existing UI
