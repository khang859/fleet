# Settings Page Design

Convert settings from an overlay modal to a full settings tab, providing more real estate for growing configurations.

## Context

The current settings UI is a 520px modal overlay with 5 horizontal tabs (General, Notifications, Socket, Visualizer, Updates). As Fleet adds more configuration options, the modal is too constrained. UX research from NNG and Baymard confirms: modals are wrong for settings pages -- they constrain space, risk accidental dismissal, and don't support browsing/exploration.

## Approach

Settings becomes a new tab type (`settings`) in the existing workspace tab system. This leverages the existing tab infrastructure (sidebar entry, tab switching, close button) with no new navigation patterns.

## Tab Type & Singleton Behavior

- Add `'settings'` to the `TabType` union in shared types
- When `fleet:toggle-settings` fires: if a settings tab exists, focus it; if not, create one
- Settings tab gets a gear icon in the sidebar, labeled "Settings"
- Closing the settings tab works like closing any other tab
- Only one settings tab can exist at a time -- the create logic enforces this

## Internal Layout

Two-column layout inside the settings tab:

- **Left nav sidebar** (~200px, fixed): List of section labels (General, Notifications, Socket, Visualizer, Updates). Active section highlighted with the same blue indicator style used elsewhere. Slightly different background from the outer sidebar for visual hierarchy.
- **Right content area** (flex-1, scrollable): Renders the active section's form. Single-column layout, labels above fields, white space between groups. Max-width ~640px centered in the content area to prevent stretching on wide screens.

Clicking a nav item swaps the content panel -- no scroll-based navigation.

## Component Architecture

- **`SettingsTab.tsx`** -- Top-level component for the settings tab. Houses two-column layout, manages active section state (default: `general`).
- **Section components** -- One per category: `GeneralSection`, `NotificationsSection`, `SocketSection`, `VisualizerSection`, `UpdatesSection`. Extracted from existing `SettingsModal.tsx` tab content.
- **`SettingsNav.tsx`** -- Left sidebar nav. Receives active section + onChange callback. Simple list of buttons.
- **Debounced text inputs** -- `useDebouncedCallback` hook or inline `setTimeout` pattern wrapping text field onChange handlers at ~300ms delay.

The existing `SettingsModal.tsx` is deleted after migration. Settings store, IPC channels, and types remain untouched.

## Save Behavior

- Toggles, dropdowns, radio buttons: save immediately on change (current behavior, unchanged)
- Text inputs (shell path, font family, font size, scrollback): debounced at 300ms, save on trailing edge
- No explicit save button, no "Saved" toast

## Extensibility

Adding a new settings section requires:
1. Create a new section component
2. Add an entry to the nav list in `SettingsNav.tsx`
3. Add a case to the section renderer in `SettingsTab.tsx`

## UX Research References

Key findings informing this design:

- **NNG: Modals are wrong for settings** -- settings are user-initiated, non-urgent, and not blocking a workflow
- **NNG: Left sidebar nav for settings** -- scalable, scannable (users look left 80% of the time), familiar pattern (VS Code, Slack, Figma)
- **NNG: Labels above fields, single-column layout** -- enables single-fixation scanning
- **NNG: Toggles must save immediately** -- if immediate save isn't feasible, use checkboxes instead
- **Baymard: Reduce perceived friction** -- smart defaults, autodetection, clear section boundaries
- **NNG: Max 5-7 top-level categories** -- beyond that, scanning and recall suffer
