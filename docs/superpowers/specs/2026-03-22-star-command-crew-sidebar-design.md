# Star Command — Crew Sidebar Redesign

**Date:** 2026-03-22
**Status:** Approved
**Scope:** `AdmiralSidebar.tsx` only

## Problem

The crew list in `AdmiralSidebar` shows raw crew IDs and a 2×2px status dot — no mission context, no sector grouping, no token visibility, no recency signal. With multiple agents running, it is not scannable at a glance.

## Research Basis

- **NNG — Visibility of System Status:** Status must be perceivable without interaction. Raw IDs fail recognition-over-recall.
- **NNG — Complex Application Design (Staged Disclosure + Layered Access):** Secondary detail should be accessible without navigating away from the primary screen.
- **NNG — Progressive Disclosure:** Max 2 levels. Show frequently-needed info upfront; detail on demand via popover.
- **NNG — Preattentive Processing:** Use shape and spatial proximity as primary grouping signals; color as secondary.
- **Baymard — List Item Scanning:** Users spend 1–2 seconds per item. The primary label must be human-readable. Mission summary is the user's own language — far more scannable than a UUID-style ID.
- **Baymard — Trigger Indicators:** Clickable rows need hover affordance and clear information scent.

## Design

### 1. Crew List (AdmiralSidebar)

Replace the current flat list with a sector-grouped list.

**Structure:**

```
Crew                              ← existing section header

my-project                        ← sector name (dim sub-header)
  ● Refactor auth middleware  ACTIVE
  ● Fix failing tests         HAILING

api-service
  ● Add rate limiting         ERROR
```

**Row changes:**

- Primary label: `crew.mission_summary?.trim() || crew.id`
- Sector names rendered as dim sub-headers between groups (same `text-[10px] font-mono text-neutral-600` style)
- Each row: `cursor-pointer` + `hover:bg-neutral-800` to signal clickability
- Status dot and status label unchanged
- Sector name fallback: `sector?.name ?? sectorId` (optional chaining — `sector` may not exist in the sectors list)

**Grouping logic** (same pattern as `CrewChips.tsx`):

```ts
const bySector = new Map<string, CrewStatus[]>();
for (const crew of crewList) {
  const list = bySector.get(crew.sector_id) ?? [];
  list.push(crew);
  bySector.set(crew.sector_id, list);
}
```

**Empty state:** When `crewList` is empty, the entire Crew section remains hidden (same behavior as today — the existing `crewList.length > 0` guard is unchanged).

### 2. Crew Detail Popover

Clicking a crew row opens a Radix `Popover` anchored to that row. The popover opens to the **left** (`side="left"` on `Popover.Content`) — the sidebar sits at the right edge of the window so there is no space to the right. Dismissed by clicking outside, pressing Escape, or clicking the close button.

**Layout:**

```
┌─────────────────────────────────────────┐
│ ● ACTIVE                    [✕]         │
│ Refactor auth middleware                │  ← mission_summary, full, wraps
│ crew-abc123def456                       │  ← crew.id, dim monospace
├─────────────────────────────────────────┤
│ Sector      my-project                  │
│ Branch      feat/auth-refactor          │  ← conditional: worktree_branch
│ Deployed    Mar 22, 2:14 PM             │  ← created_at, locale formatted
│ Last seen   2 min ago                   │  ← conditional: last_lifesign relative
│ Tokens      ████████░░  800 / 1000      │  ← conditional: token_budget != null
├─────────────────────────────────────────┤
│ [Observe]              [Recall ▸]       │
│                                         │
│ (observe output or error shown here)    │  ← conditional
└─────────────────────────────────────────┘
```

**Metadata rules:**

- Rows are only rendered when data is present
- `Branch`: only if `crew.worktree_branch` is non-empty
- `Last seen`: only if `crew.last_lifesign` is non-null
- `Tokens`: only if `crew.token_budget != null` (use `!= null` not truthy, so `0` is handled correctly)

**Token bar (plain CSS, no library):**

```tsx
{
  crew.token_budget != null && (
    <div>
      <div
        className="w-full bg-neutral-700 rounded-full h-1.5"
        role="progressbar"
        aria-valuemin={0}
        aria-valuenow={crew.tokens_used ?? 0}
        aria-valuemax={crew.token_budget}
      >
        <div
          className="bg-teal-500 h-1.5 rounded-full"
          style={{
            width: `${Math.min(100, ((crew.tokens_used ?? 0) / crew.token_budget) * 100)}%`
          }}
        />
      </div>
      <span className="text-[10px] font-mono text-neutral-500">
        {crew.tokens_used ?? 0} / {crew.token_budget}
      </span>
    </div>
  );
}
```

**`last_lifesign` relative time:**
`last_lifesign` is an ISO 8601 string (e.g. `"2026-03-22T14:10:00.000Z"`). Parse with `new Date(crew.last_lifesign)`. If `isNaN(date.getTime())`, omit the row entirely. Thresholds:

- `< 60s` → "just now"
- `< 60m` → "X min ago"
- `< 24h` → "X hr ago"
- `>= 24h` → "X days ago"

**Observe flow:**

- Button label: "Observe" (idle) → "Loading..." + disabled (in-flight) → "Observe" (done)
- On success: output string displayed in a scrollable `<pre>` block below the button row
- On error: error message displayed in red below the button row (same as `CrewPanel`)
- If the popover is closed while the call is in-flight: the component unmounts; no stale state risk because all local state lives inside the popover content component

**Recall flow:**

- Two-step confirmation: first click shows inline Confirm/Cancel (same pattern as `CrewPanel` and `StarCommandTab`)
- On successful recall: `CrewPopover` calls `window.fleet.starbase.listCrew()` and dispatches `setCrewList` directly (same pattern as `CrewPanel.refresh`), then calls `setOpenCrewId(null)` via the `onClose` prop — the row disappears naturally as `crewList` updates. No `onRefresh` prop is needed on `AdmiralSidebar`.
- On error: show error message in red below the confirmation row

**Close button:** Calls `setOpenCrewId(null)` via an `onClose` prop passed into the popover content component.

**Scroll behavior:** The sidebar is `overflow-y-auto`. Pass the sidebar scroll container as `collisionBoundary` to `Popover.Content` to prevent the popover from floating away if the user scrolls while it is open. Alternatively, attach a scroll listener to the sidebar container that calls `setOpenCrewId(null)` on scroll — simpler and prevents the anchoring drift problem entirely.

### 3. Component Structure

The popover content is an **extracted sub-component** (e.g. `CrewPopover`) that accepts:

```ts
type CrewPopoverProps = {
  crew: CrewStatus;
  sector: SectorInfo | undefined;
  onClose: () => void;
};
```

This scopes observe/recall local state to the popover and keeps `AdmiralSidebar` clean. When `openCrewId` changes, the old `CrewPopover` unmounts, killing any in-flight observe calls naturally.

### 4. State

One new local state in `AdmiralSidebar`:

```ts
const [openCrewId, setOpenCrewId] = useState<string | null>(null);
```

No store changes. All required data (`crewList`, `sectors`, `token_budget`, `tokens_used`, `last_lifesign`) is already in `useStarCommandStore`.

## Files Changed

| File                                                          | Change                                                                                                |
| ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `src/renderer/src/components/star-command/AdmiralSidebar.tsx` | Sector grouping, mission label, clickable rows, Radix Popover + extracted `CrewPopover` sub-component |

## Files Unchanged

| File                                                     | Reason                                       |
| -------------------------------------------------------- | -------------------------------------------- |
| `src/renderer/src/components/star-command/CrewPanel.tsx` | Unchanged — remains the full management view |
| `src/renderer/src/store/star-command-store.ts`           | All needed fields already present            |
| All other files                                          | No changes required                          |

## Out of Scope

- Modifications to `CrewPanel` or the Crew tab
- Message/send functionality in the popover
- Token display in the sidebar list row (token detail is popover-only)
- Any store changes
