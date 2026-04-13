# Mascot Tab & Icon Cleanup

**Date:** 2026-03-29
**Status:** Approved

## Summary

Extract the mascot selection grid from the copilot settings page into its own top-level view, and replace all emoji/text-symbol icons across the copilot panel with Lucide React icon components.

## Motivation

The settings page mixes configuration (sound, hooks) with personalization (mascot). Giving mascots their own tab makes both views cleaner. The emoji icons (⚙, ←, ○, etc.) look inconsistent and should be proper SVG icons.

## Design

### 1. New `mascots` top-level view

- Add `'mascots'` to the `CopilotView` union type in `copilot-store.ts`
- Create `MascotPicker.tsx` — extracted from the mascot grid currently in `CopilotSettings.tsx`
  - Header: `<ChevronLeft />` back button + "Mascots" title
  - Body: mascot grid with 48px thumbnail previews, blue highlight on selected
  - Back button navigates to `'sessions'` view
- Add a `<PawPrint />` icon button in the `SessionList` header (next to the settings gear) to navigate to the mascots view
- Remove the mascot selection section from `CopilotSettings.tsx`
- Add routing in `App.tsx`: render `MascotPicker` when `view === 'mascots'`

### 2. Icon replacements (Lucide React)

| Location                    | File                  | Current | Lucide Replacement |
| --------------------------- | --------------------- | ------- | ------------------ |
| SessionList settings button | `SessionList.tsx`     | `⚙`     | `<Settings />`     |
| SessionList mascot button   | `SessionList.tsx`     | (new)   | `<PawPrint />`     |
| CopilotSettings back button | `CopilotSettings.tsx` | `←`     | `<ChevronLeft />`  |
| SessionDetail back button   | `SessionDetail.tsx`   | `←`     | `<ChevronLeft />`  |
| MascotPicker back button    | `MascotPicker.tsx`    | (new)   | `<ChevronLeft />`  |
| Badge: idle                 | `badge.tsx`           | `○`     | `<Circle />`       |
| Badge: running              | `badge.tsx`           | `◎`     | `<CircleDot />`    |
| Badge: permission           | `badge.tsx`           | `△`     | `<Triangle />`     |
| Badge: error                | `badge.tsx`           | `■`     | `<Square />`       |
| Badge: complete             | `badge.tsx`           | `✓`     | `<Check />`        |

### 3. Settings page (after extraction)

Remains with:

- Notification sound dropdown
- Claude Code installation status alert
- Hooks management toggle

## Files to modify

- `src/renderer/copilot/src/store/copilot-store.ts` — add `'mascots'` to `CopilotView`
- `src/renderer/copilot/src/App.tsx` — add routing for mascots view
- `src/renderer/copilot/src/components/SessionList.tsx` — add mascot button, replace gear emoji
- `src/renderer/copilot/src/components/CopilotSettings.tsx` — remove mascot section, replace back arrow
- `src/renderer/copilot/src/components/SessionDetail.tsx` — replace back arrow
- `src/renderer/copilot/src/components/ui/badge.tsx` — replace status symbols with Lucide icons

## Files to create

- `src/renderer/copilot/src/components/MascotPicker.tsx` — new mascot selection view
