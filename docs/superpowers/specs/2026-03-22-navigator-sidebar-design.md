# Navigator Sidebar Display — Design

## Overview

Display the Navigator as a third character in the Admiral Sidebar, positioned immediately below the First Officer. The Navigator is an existing backend agent (`Navigator` class) that executes Protocol runs autonomously. It currently has no UI representation. This change makes it visible to operators so they can see at a glance whether the Navigator is idle or running executions.

---

## Sprites

**Source:** `sprites-staging/personas/` contains 5 Navigator PNGs:
- `navigator-default.png`
- `navigator-working.png`
- `navigator-standby.png`
- `navigator-thinking.png`
- `navigator-alert.png`

**Destination:** Copy all 5 into:
1. `sprites-raw/star-command/avatars/` — source for the sprite atlas assembler
2. `src/renderer/src/assets/` — direct imports used by AdmiralSidebar (matches First Officer pattern)

The sprite sheet layout (`scripts/assemble-star-command-sprites.ts`) needs a new row for the 5 navigator avatars (Row 0 is full at 576px). The atlas TypeScript file regenerates automatically after running the assembler.

---

## Backend

**File:** `src/main/starbase/navigator.ts`

Add two methods to the `Navigator` class, mirroring `FirstOfficer`:

```ts
getStatus(): 'standby' | 'working' {
  return this.running.size > 0 ? 'working' : 'standby';
}

getStatusText(): string {
  const n = this.running.size;
  if (n === 0) return 'Idle';
  return n === 1 ? 'Running 1 execution' : `Running ${n} executions`;
}
```

**File:** `src/main/starbase-runtime-core.ts`

Add `navigator` to `buildSnapshot()`:

```ts
navigator: {
  status: deps.navigator.getStatus(),
  statusText: deps.navigator.getStatusText()
}
```

---

## Store

**File:** `src/renderer/src/store/star-command-store.ts`

Add a `NavigatorStatus` type (similar shape to `FirstOfficerStatus` but without `unreadMemos`):

```ts
export type NavigatorStatus = {
  status: 'standby' | 'working';
  statusText: string;
};
```

Update the `StarCommandStore` **type definition** to include:
- `navigatorStatus: NavigatorStatus`
- `setNavigatorStatus: (status: NavigatorStatus) => void`

Add `navigatorStatus` to the initial state (default: `{ status: 'standby', statusText: 'Idle' }`) and implement `setNavigatorStatus` in the Zustand `create` block.

---

## Renderer Wiring

**File:** `src/renderer/src/components/StarCommandTab.tsx`

Handle `p.navigator` from the snapshot, one line mirroring the First Officer handler:

```ts
if (p.navigator !== undefined) setNavigatorStatus(p.navigator);
```

Also add `setNavigatorStatus` to the destructuring call where `setFirstOfficerStatus` is currently pulled from `useStarCommandStore()`.

---

## UI — AdmiralSidebar

**File:** `src/renderer/src/components/star-command/AdmiralSidebar.tsx`

Add a Navigator section immediately after the First Officer `<div>` block (the one ending with the unread memos button), before the `{/* Status sections */}` `<div className="px-4 py-4 space-y-4">` block. Structure mirrors First Officer exactly:

- Import 5 navigator PNGs from assets
- `NAVIGATOR_IMAGES` map: `standby` → `navigator-standby.png`, `working` → `navigator-working.png`, `default` → `navigator-default.png` (catch-all fallback key, matching the FO pattern)
- Pull `navigatorStatus` from `useStarCommandStore()`
- Render 128×128px `<img>` with `imageRendering: 'pixelated'`
- "Navigator" label in teal mono (`text-xs font-mono text-teal-400 uppercase tracking-widest`)
- Status dot: teal pulse (`bg-teal-400 animate-pulse`) when working, green (`bg-green-400`) when standby — green for standby is intentional, matching the First Officer pattern
- Status text in neutral mono

---

## What is NOT changing

- No new IPC channels — navigator status flows through the existing `starbase.snapshot` event
- No execution list UI — just idle/working indicator (can be added later)
- No new database queries
- The `thinking` and `alert` sprite states are imported but not wired to any status in this iteration; only `standby` and `working` are used
