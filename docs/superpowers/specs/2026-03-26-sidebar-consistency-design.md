# Sidebar Consistency Design

**Date:** 2026-03-26
**Status:** Approved

## Problem

The sidebar has several inconsistencies that violate UX best practices identified by Baymard Institute and Nielsen Norman Group research:

1. **Auto-collapse anti-pattern:** Star Command and Images tabs trigger `isFullScreenTab`, which auto-collapses the sidebar. Research shows this "shifting sidebar" causes disorientation — users form spatial mental models and expect navigation landmarks to stay stable.
2. **Collapsed state gaps:** The mini sidebar (44px) has no tooltips on icons, no workspace switcher access, and loses section grouping. NNG data shows hidden navigation cuts discoverability nearly in half (27% usage vs 48%).
3. **Visual inconsistency:** Star Command/Images use rich card components, crew tabs use cyan borders, file/terminal tabs use blue borders — three different visual treatments in the same navigation list with no clear hierarchy.

## Research Basis

- **Baymard:** Sidebar should never switch between roles (navigation vs hidden). Users treat it as a spatial landmark. Task completion takes 22-35% longer with shifting sidebars.
- **NNG:** Hidden navigation used only 27% of the time vs 48% for visible. Icon-only navigation problematic — only 3 icons universally understood. Persistent global navigation must stay stable; contextual right panels are fine.
- **Both:** Collapse should be user-initiated only. Tooltips are critical for icon-only states. Visual consistency builds trust and predictability.

## Design

### Section 1: Layout Changes

**Remove the full-screen tab concept:**

- Remove the `isFullScreenTab` flag from `App.tsx`
- Remove `sidebarManualOpen` state
- Star Command and Images render inside the same `flex-1` content column as PaneGrid, conditionally shown based on `activeTab.type`
- Sidebar always renders at `w-56`, never auto-collapses
- AdmiralSidebar (right panel) still only appears when Star Command is active — contextual right panels are a separate mental model per the research

**Collapse toggle always available:**

- The sidebar collapse/expand toggle moves from being conditional (only on full-screen tabs) to always present in the workspace header area
- Only user interaction changes collapse state — no programmatic triggers

### Section 2: Collapsed Sidebar Improvements

The mini sidebar (44px) gets these additions:

**Tooltips:**
- All icons show tab label on hover with short delay
- Pinned items show their name (e.g., "Star Command", "Images")

**Divider grouping matching expanded state:**
- Pinned section (Star Command, Images icons) at top
- Divider
- Crew icons
- Divider
- File/terminal/image tab icons
- Spacer (flex-1)
- Workspace switcher icon (bottom)
- Settings icon (bottom)

**Workspace popover:**
- Clicking the workspace icon opens a small popover anchored to the icon
- Reuses the existing `WorkspacePicker` dropdown menu content: list of saved workspaces (click to switch), "New Workspace", "Save Current"
- Ensures workspace switching is accessible without expanding the sidebar

**Active state indicators:**
- Background highlight on active tab icon persists in collapsed view

**No auto-collapse triggers remain.** Only the user clicking the toggle changes sidebar state.

### Section 3: Tab Styling Unification

**Non-pinned tabs get a unified row structure:**

```
[icon] Label                [badge]
       /path/to/cwd
```

- **Crew tabs:** Same row structure as file/terminal tabs — sprite avatar as icon, mission name as label, badge for status. Active border color: `cyan-500`
- **File/terminal tabs:** File/terminal icon, label, CWD, badge. Active border color: `blue-500`
- All non-pinned tabs share: same hover states, same close button behavior, same drag-drop support, same context menu pattern

**Pinned items remain visually distinct:**

- Star Command and Images keep their rich card styling (scanlines, thumbnails, glow effects)
- Positioned at the top of the sidebar as a separate visual section
- Separated from the tab list below by a divider
- Not closeable, not draggable

## Files to Modify

- `src/renderer/src/App.tsx` — Remove `isFullScreenTab`, `sidebarManualOpen`; render Star Command/Images in content area; make collapse toggle always available
- `src/renderer/src/components/Sidebar.tsx` — Add collapse toggle to workspace header; unify non-pinned tab styling; add divider grouping
- `src/renderer/src/App.tsx` (mini sidebar section) — Add tooltips, divider grouping, workspace icon with popover, active state indicators
- `src/renderer/src/components/TabItem.tsx` — Ensure crew tabs use same row structure as file/terminal tabs

## Out of Scope

- AdmiralSidebar (right panel) behavior — already correct per research
- Tab ordering or drag-drop changes
- Keyboard shortcuts for sidebar toggle
- Mobile/responsive considerations (desktop app only)
