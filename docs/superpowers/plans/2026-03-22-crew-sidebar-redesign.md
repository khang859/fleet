# Crew Sidebar Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the flat raw-ID crew list in `AdmiralSidebar` with a sector-grouped, mission-first list where each row opens a detail popover with metadata, observe, and recall actions.

**Architecture:** All changes are confined to `AdmiralSidebar.tsx`. A new `CrewPopover` sub-component is defined in the same file and handles its own async state (observe/recall). Radix `Popover` provides correct portal rendering and keyboard dismissal; it is not currently installed and must be added first.

**Tech Stack:** React, TypeScript, Radix UI (`@radix-ui/react-popover`), Tailwind CSS, Zustand (existing store), Vitest (test runner: `npm test`)

**Spec:** `docs/superpowers/specs/2026-03-22-star-command-crew-sidebar-design.md`

---

## File Map

| File | Action |
|------|--------|
| `src/renderer/src/components/star-command/AdmiralSidebar.tsx` | Modify — add `CrewPopover` sub-component, sector grouping, `openCrewId` state, Radix Popover wiring |
| `package.json` | Modify — add `@radix-ui/react-popover` |

No other files change.

---

## Task 1: Install `@radix-ui/react-popover`

**Files:**
- Modify: `package.json`

`@radix-ui/react-popover` is not installed. It must be added before any import can be written.

- [ ] **Step 1: Install the package**

```bash
npm install @radix-ui/react-popover
```

Expected: package added to `node_modules`, `package.json` and `package-lock.json` updated.

- [ ] **Step 2: Verify the import resolves**

```bash
npm run typecheck
```

Expected: no errors (confirms electron-vite can resolve the new package).

- [ ] **Step 3: Commit**

```bash
git add package.json package-lock.json
git commit -m "chore: add @radix-ui/react-popover"
```

---

## Task 2: Add `relativeTime` helper and `CrewPopover` sub-component to `AdmiralSidebar.tsx`

**Files:**
- Modify: `src/renderer/src/components/star-command/AdmiralSidebar.tsx`

Add the `relativeTime` module-level function and the `CrewPopover` component **before** the existing `AdmiralSidebar` export. Do not touch any existing code yet.

- [ ] **Step 1: Add the Radix Popover import and `useState` import**

At the top of `AdmiralSidebar.tsx`, the existing import line is:
```ts
import { useStarCommandStore } from '../../store/star-command-store';
```

Add above it:
```ts
import { useState } from 'react';
import * as Popover from '@radix-ui/react-popover';
```

(`useState` may already be imported — check and add only if missing.)

- [ ] **Step 2: Add the `relativeTime` helper after the existing `STATUS_COLORS` constant**

```ts
function relativeTime(iso: string): string {
  const date = new Date(iso);
  if (isNaN(date.getTime())) return '';
  const diffMs = Date.now() - date.getTime();
  const diffSec = Math.floor(diffMs / 1000);
  if (diffSec < 60) return 'just now';
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin} min ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr} hr ago`;
  return `${Math.floor(diffHr / 24)} days ago`;
}
```

- [ ] **Step 3: Add the `STATUS_LABELS` map after `STATUS_COLORS`**

```ts
const STATUS_LABELS: Record<string, string> = {
  active: 'Active',
  hailing: 'Hailing',
  error: 'Error',
  complete: 'Complete',
  idle: 'Idle',
  lost: 'Lost'
};
```

- [ ] **Step 4: Add the `CrewPopover` component before the `AdmiralSidebar` export**

```tsx
function CrewPopover({
  crew,
  sector,
  onClose
}: {
  crew: CrewStatus;
  sector: SectorInfo | undefined;
  onClose: () => void;
}): React.JSX.Element {
  const { setCrewList } = useStarCommandStore();
  const [observing, setObserving] = useState(false);
  const [output, setOutput] = useState<string | null>(null);
  const [observeError, setObserveError] = useState<string | null>(null);
  const [recallConfirm, setRecallConfirm] = useState(false);
  const [recalling, setRecalling] = useState(false);
  const [recallError, setRecallError] = useState<string | null>(null);

  const handleObserve = async (): Promise<void> => {
    setObserving(true);
    setObserveError(null);
    setOutput(null);
    try {
      const result = await window.fleet.starbase.observeCrew(crew.id);
      setOutput(result);
    } catch (err) {
      setObserveError(err instanceof Error ? err.message : 'Failed to observe');
    }
    setObserving(false);
  };

  const handleRecall = async (): Promise<void> => {
    setRecalling(true);
    setRecallError(null);
    try {
      await window.fleet.starbase.recallCrew(crew.id);
      const updated = await window.fleet.starbase.listCrew();
      setCrewList(updated);
      onClose();
    } catch (err) {
      setRecallError(err instanceof Error ? err.message : 'Failed to recall');
      setRecalling(false);
    }
  };

  const statusDotClass = STATUS_COLORS[crew.status] ?? 'bg-neutral-500';
  const label = crew.mission_summary?.trim() || crew.id;
  const deployedAt = new Date(crew.created_at).toLocaleString();
  const lastSeen = crew.last_lifesign ? relativeTime(crew.last_lifesign) : null;
  const sectorName = sector?.name ?? crew.sector_id;

  return (
    <div className="w-72 bg-neutral-900 border border-neutral-700 rounded-lg shadow-xl text-xs">
      {/* Header */}
      <div className="px-3 pt-3 pb-2 border-b border-neutral-800">
        <div className="flex items-start justify-between gap-2 mb-1">
          <div className="flex items-center gap-1.5">
            <StatusDot color={statusDotClass} />
            <span className="font-mono text-neutral-400 uppercase text-[10px]">
              {STATUS_LABELS[crew.status] ?? crew.status}
            </span>
          </div>
          <button
            onClick={onClose}
            className="text-neutral-600 hover:text-neutral-400 transition-colors leading-none"
          >
            ✕
          </button>
        </div>
        <p className="text-neutral-200 text-sm leading-snug">{label}</p>
        <p className="text-neutral-600 font-mono text-[10px] mt-0.5 truncate">{crew.id}</p>
      </div>

      {/* Metadata */}
      <div className="px-3 py-2 space-y-1.5 border-b border-neutral-800">
        <div className="flex justify-between gap-4">
          <span className="text-neutral-500">Sector</span>
          <span className="text-neutral-300 font-mono truncate">{sectorName}</span>
        </div>
        {crew.worktree_branch && (
          <div className="flex justify-between gap-4">
            <span className="text-neutral-500">Branch</span>
            <span className="text-neutral-300 font-mono truncate">{crew.worktree_branch}</span>
          </div>
        )}
        <div className="flex justify-between gap-4">
          <span className="text-neutral-500">Deployed</span>
          <span className="text-neutral-300">{deployedAt}</span>
        </div>
        {lastSeen && (
          <div className="flex justify-between gap-4">
            <span className="text-neutral-500">Last seen</span>
            <span className="text-neutral-300">{lastSeen}</span>
          </div>
        )}
        {crew.token_budget != null && (
          <div>
            <span className="text-neutral-500">Tokens</span>
            <div
              className="w-full bg-neutral-700 rounded-full h-1.5 mt-1"
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
        )}
      </div>

      {/* Actions */}
      <div className="px-3 py-2 space-y-2">
        <div className="flex items-center justify-between gap-2">
          <button
            onClick={() => { void handleObserve(); }}
            disabled={observing}
            className="text-neutral-400 hover:text-neutral-200 transition-colors disabled:opacity-50"
          >
            {observing ? 'Loading...' : 'Observe'}
          </button>

          {recallConfirm ? (
            <div className="flex items-center gap-1.5 bg-red-950/60 border border-red-800/50 rounded px-2 py-1">
              <span className="text-[10px] text-red-300">Recall?</span>
              <button
                onClick={() => { void handleRecall(); }}
                disabled={recalling}
                className="text-[10px] px-1.5 py-0.5 bg-red-700 hover:bg-red-600 text-white rounded transition-colors"
              >
                {recalling ? '...' : 'Confirm'}
              </button>
              <button
                onClick={() => setRecallConfirm(false)}
                className="text-[10px] text-neutral-400 hover:text-neutral-200 transition-colors"
              >
                Cancel
              </button>
            </div>
          ) : (
            <button
              onClick={() => setRecallConfirm(true)}
              className="text-red-400 hover:text-red-300 transition-colors"
            >
              Recall ▸
            </button>
          )}
        </div>

        {output !== null && (
          <pre className="bg-neutral-950 rounded p-2 font-mono text-neutral-300 text-[10px] whitespace-pre-wrap max-h-32 overflow-y-auto">
            {output || '(no output)'}
          </pre>
        )}
        {observeError && <p className="text-red-400">{observeError}</p>}
        {recallError && <p className="text-red-400">{recallError}</p>}
      </div>
    </div>
  );
}
```

> **Note:** `CrewStatus` and `SectorInfo` are already imported via `useStarCommandStore` — check the existing imports and add explicit type imports if needed: `import type { CrewStatus, SectorInfo } from '../../store/star-command-store';`

- [ ] **Step 5: Typecheck**

```bash
npm run typecheck
```

Expected: no errors. Fix any type errors before proceeding.

- [ ] **Step 6: Commit**

```bash
git add src/renderer/src/components/star-command/AdmiralSidebar.tsx
git commit -m "feat(sidebar): add CrewPopover sub-component with observe/recall"
```

---

## Task 3: Update AdmiralSidebar crew list to sector-grouped + popover wiring

**Files:**
- Modify: `src/renderer/src/components/star-command/AdmiralSidebar.tsx`

This task replaces the existing flat crew list with the sector-grouped popover-enabled version.

- [ ] **Step 1: Add `openCrewId` state and sector grouping inside `AdmiralSidebar`**

Inside the `AdmiralSidebar` function body, after the existing destructuring from `useStarCommandStore`, add:

> Also add `onScroll={() => setOpenCrewId(null)}` to the outermost sidebar `div` (the one with `overflow-y-auto`). This closes any open popover when the user scrolls the sidebar, preventing the popover from floating away from its anchor row.

```ts
const [openCrewId, setOpenCrewId] = useState<string | null>(null);

const bySector = new Map<string, CrewStatus[]>();
for (const crew of crewList) {
  const list = bySector.get(crew.sector_id) ?? [];
  list.push(crew);
  bySector.set(crew.sector_id, list);
}
```

- [ ] **Step 2: Replace the existing Crew section**

Find the existing Crew section in the JSX (around line 195–212 in the original file):

```tsx
{/* Crew list */}
{crewList.length > 0 && (
  <div>
    <h3 className="text-[10px] font-mono text-neutral-500 uppercase tracking-widest mb-2">
      Crew
    </h3>
    <div className="space-y-1">
      {crewList.map((crew) => (
        <div key={crew.id} className="flex items-center gap-2 py-0.5">
          <StatusDot color={STATUS_COLORS[crew.status] ?? 'bg-neutral-500'} />
          <span className="text-xs text-neutral-300 truncate flex-1">{crew.id}</span>
          <span className="text-[10px] font-mono text-neutral-600 uppercase">
            {crew.status}
          </span>
        </div>
      ))}
    </div>
  </div>
)}
```

Replace it entirely with:

```tsx
{/* Crew list — sector-grouped with popover detail */}
{crewList.length > 0 && (
  <div>
    <h3 className="text-[10px] font-mono text-neutral-500 uppercase tracking-widest mb-2">
      Crew
    </h3>
    {Array.from(bySector.entries()).map(([sectorId, sectorCrew]) => {
      const sector = sectors.find((s) => s.id === sectorId);
      const sectorLabel = sector?.name ?? sectorId;
      return (
        <div key={sectorId} className="mb-2">
          <div className="text-[9px] font-mono text-neutral-600 uppercase tracking-widest mb-1 pl-0.5">
            {sectorLabel}
          </div>
          {sectorCrew.map((crew) => (
            <Popover.Root
              key={crew.id}
              open={openCrewId === crew.id}
              onOpenChange={(open) => setOpenCrewId(open ? crew.id : null)}
            >
              <Popover.Trigger asChild>
                <div className="flex items-center gap-2 py-0.5 pl-2 rounded cursor-pointer hover:bg-neutral-800 transition-colors">
                  <StatusDot color={STATUS_COLORS[crew.status] ?? 'bg-neutral-500'} />
                  <span className="text-xs text-neutral-300 truncate flex-1">
                    {crew.mission_summary?.trim() || crew.id}
                  </span>
                  <span className="text-[10px] font-mono text-neutral-600 uppercase flex-shrink-0">
                    {crew.status}
                  </span>
                </div>
              </Popover.Trigger>
              <Popover.Portal>
                <Popover.Content
                  side="left"
                  sideOffset={8}
                  className="z-50"
                >
                  <CrewPopover
                    crew={crew}
                    sector={sector}
                    onClose={() => setOpenCrewId(null)}
                  />
                </Popover.Content>
              </Popover.Portal>
            </Popover.Root>
          ))}
        </div>
      );
    })}
  </div>
)}
```

- [ ] **Step 3: Typecheck**

```bash
npm run typecheck
```

Expected: no errors.

- [ ] **Step 4: Build to verify no bundler errors**

```bash
npm run build
```

Expected: exits 0 with no errors.

- [ ] **Step 5: Manual smoke test**

Run the app in dev mode (`npm run dev`) and open Star Command. With crew deployed:
- Crew section shows sector sub-headers
- Each row shows mission summary (or ID fallback) + status
- Clicking a row opens the popover to the left
- Popover shows header (status + label + ID), metadata grid, Observe and Recall buttons
- Escape or click-outside closes the popover
- Observe fetches output and shows it in a scrollable block
- Recall shows two-step confirmation; confirming removes the crew row and closes the popover

With no crew deployed: Crew section is hidden (unchanged behavior).

- [ ] **Step 6: Commit**

```bash
git add src/renderer/src/components/star-command/AdmiralSidebar.tsx
git commit -m "feat(sidebar): sector-grouped crew list with mission label and detail popover"
```

---

## Done

All tasks complete. The `AdmiralSidebar` now shows:
- Crew grouped by sector with human-readable mission summaries as primary labels
- Per-row popover (left-anchored, Escape-dismissable) with full metadata, token bar, observe output, and recall confirmation
- No changes to any other file
