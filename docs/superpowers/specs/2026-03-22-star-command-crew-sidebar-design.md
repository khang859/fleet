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
- Sector fallback: `sector.name ?? sector_id`

**Grouping logic** (same pattern as `CrewChips.tsx`):
```ts
const bySector = new Map<string, CrewStatus[]>()
for (const crew of crewList) {
  const list = bySector.get(crew.sector_id) ?? []
  list.push(crew)
  bySector.set(crew.sector_id, list)
}
```

### 2. Crew Detail Popover

Clicking a crew row opens a Radix `Popover` anchored to that row, opening to the right of the sidebar (falls back to left if the viewport clips it). Dismissed by clicking outside or pressing Escape.

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
│ Tokens      ████████░░  800 / 1000      │  ← conditional: token_budget present
├─────────────────────────────────────────┤
│ [Observe]              [Recall ▸]       │
└─────────────────────────────────────────┘
```

**Metadata rules:**
- Only rows with data are rendered (branch, last_lifesign, tokens are all conditional)
- Observe: fetches recent output via `window.fleet.starbase.observeCrew`, displays inline below button
- Recall: two-step confirmation (matches existing pattern in `CrewPanel` and `StarCommandTab`)
- Message field: omitted — sending messages is a deliberate action suited to the full Crew tab, not a sidebar popover

**Token bar (plain CSS, no library):**
```tsx
{crew.token_budget && (
  <div className="w-full bg-neutral-700 rounded-full h-1.5">
    <div
      className="bg-teal-500 h-1.5 rounded-full"
      style={{ width: `${Math.min(100, (crew.tokens_used ?? 0) / crew.token_budget * 100)}%` }}
    />
  </div>
)}
```

**`last_lifesign` relative time** — inline formatter, no library:
- < 60s → "just now"
- < 60m → "X min ago"
- otherwise → "X hr ago"

### 3. State

One new local state in `AdmiralSidebar`:
```ts
const [openCrewId, setOpenCrewId] = useState<string | null>(null)
```

No store changes. All required data (`crewList`, `sectors`, `token_budget`, `tokens_used`, `last_lifesign`) is already in `useStarCommandStore`.

## Files Changed

| File | Change |
|------|--------|
| `src/renderer/src/components/star-command/AdmiralSidebar.tsx` | Sector grouping, mission label, clickable rows, Radix Popover |

## Files Unchanged

| File | Reason |
|------|--------|
| `src/renderer/src/components/star-command/CrewPanel.tsx` | Unchanged — remains the full management view |
| `src/renderer/src/store/star-command-store.ts` | All needed fields already present |
| All other files | No changes required |

## Out of Scope

- Modifications to `CrewPanel` or the Crew tab
- Message/send functionality in the popover
- Token display in the sidebar list row (token detail is popover-only)
- Any store changes
