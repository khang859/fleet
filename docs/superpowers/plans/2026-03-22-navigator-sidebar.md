# Navigator Sidebar Display — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Display the Navigator agent in the Admiral Sidebar under the First Officer, showing whether it is idle or running protocol executions.

**Architecture:** Copy existing Navigator sprite PNGs into the renderer assets, add `getStatus()`/`getStatusText()` methods to the `Navigator` class, include navigator status in the starbase snapshot, wire it through the Zustand store, and render a new section in `AdmiralSidebar.tsx` that mirrors the First Officer section.

**Tech Stack:** Electron, React, TypeScript, Zustand, Vitest, node-pty, xterm.js

---

## File Map

| File | Change |
|------|--------|
| `sprites-staging/personas/navigator-*.png` (5 files) | Source — copy only, do not modify |
| `src/renderer/src/assets/navigator-*.png` (5 files) | Create — direct PNG imports for sidebar |
| `sprites-raw/star-command/avatars/navigator-*.png` (5 files) | Create — source for future sprite atlas rebuilds |
| `scripts/assemble-star-command-sprites.ts` | Modify — add navigator avatars to Row 1, expand sheet width |
| `src/renderer/src/assets/star-command-sprites.png` | Regenerated — by running the assembler |
| `src/renderer/src/components/star-command/sc-sprite-atlas.ts` | Regenerated — by running the assembler |
| `src/main/starbase/navigator.ts` | Modify — add `getStatus()` and `getStatusText()` |
| `src/main/__tests__/navigator.test.ts` | Modify — add tests for new methods |
| `src/shared/ipc-api.ts` | Modify — add `navigator?` field to `StarbaseStatusUpdatePayload` |
| `src/main/starbase-runtime-core.ts` | Modify — add `navigator` to `buildSnapshot()` |
| `src/renderer/src/store/star-command-store.ts` | Modify — add `NavigatorStatus` type, store field, and action |
| `src/renderer/src/components/StarCommandTab.tsx` | Modify — wire `p.navigator` snapshot to store |
| `src/renderer/src/components/star-command/AdmiralSidebar.tsx` | Modify — add Navigator section after First Officer |

---

## Task 1: Copy Navigator Sprites to Assets

**Files:**
- Create: `src/renderer/src/assets/navigator-default.png`
- Create: `src/renderer/src/assets/navigator-working.png`
- Create: `src/renderer/src/assets/navigator-standby.png`
- Create: `src/renderer/src/assets/navigator-thinking.png`
- Create: `src/renderer/src/assets/navigator-alert.png`
- Create: `sprites-raw/star-command/avatars/navigator-default.png` (and the other 4)

- [ ] **Step 1: Copy sprites to renderer assets**

```bash
cp sprites-staging/personas/navigator-default.png src/renderer/src/assets/
cp sprites-staging/personas/navigator-working.png src/renderer/src/assets/
cp sprites-staging/personas/navigator-standby.png src/renderer/src/assets/
cp sprites-staging/personas/navigator-thinking.png src/renderer/src/assets/
cp sprites-staging/personas/navigator-alert.png src/renderer/src/assets/
```

- [ ] **Step 2: Copy sprites to sprites-raw for future atlas rebuilds**

```bash
cp sprites-staging/personas/navigator-default.png sprites-raw/star-command/avatars/
cp sprites-staging/personas/navigator-working.png sprites-raw/star-command/avatars/
cp sprites-staging/personas/navigator-standby.png sprites-raw/star-command/avatars/
cp sprites-staging/personas/navigator-thinking.png sprites-raw/star-command/avatars/
cp sprites-staging/personas/navigator-alert.png sprites-raw/star-command/avatars/
```

- [ ] **Step 3: Update the assembler script to include navigator avatars**

Open `scripts/assemble-star-command-sprites.ts`. Make two changes:

**Change 1:** Increase `SHEET_SIZE` from 576 to 640 (Row 1 needs 10 × 64px = 640px to hold 5 crew + 5 navigator):

```ts
const SHEET_SIZE = 640;
```

**Change 2:** After the crew avatars block (around line 208, after the `});` that closes the crew `forEach`), add:

```ts
// ---- Row 1 continued: Navigator avatars (y=64, 64x64 each, after crew) ----
const navigatorVariants = ['default', 'working', 'standby', 'thinking', 'alert'];
navigatorVariants.forEach((variant, i) => {
  entries.push({
    src: join(SPRITES_RAW, 'avatars', `navigator-${variant}.png`),
    w: 64,
    h: 64,
    x: (crewVariants.length + i) * 64,
    y: 64,
    atlasGroup: `navigator-${variant}`,
    frameIndex: 0
  });
});
```

Note: `crewVariants` is already defined above this block (5 crew sprites), so `crewVariants.length` = 5, meaning navigator starts at x=320.

- [ ] **Step 4: Run the assembler to regenerate the sprite sheet and atlas**

```bash
npx tsx scripts/assemble-star-command-sprites.ts
```

Expected: Outputs `star-command-sprites.png` and `sc-sprite-atlas.ts` with no errors. The atlas should now include `navigator-default`, `navigator-working`, `navigator-standby`, `navigator-thinking`, `navigator-alert` entries.

- [ ] **Step 5: Verify atlas contains navigator entries**

Open `src/renderer/src/components/star-command/sc-sprite-atlas.ts` and confirm entries like `'navigator-default': { x: 320, y: 64, ... }` are present.

- [ ] **Step 6: Commit**

```bash
git add src/renderer/src/assets/navigator-*.png sprites-raw/star-command/avatars/navigator-*.png scripts/assemble-star-command-sprites.ts src/renderer/src/assets/star-command-sprites.png src/renderer/src/components/star-command/sc-sprite-atlas.ts
git commit -m "feat: add navigator sprite assets and update sprite atlas"
```

---

## Task 2: Add Status Methods to Navigator Class

**Files:**
- Modify: `src/main/starbase/navigator.ts`
- Modify: `src/main/__tests__/navigator.test.ts`

- [ ] **Step 1: Write the failing tests**

Open `src/main/__tests__/navigator.test.ts`. Add these two test cases inside the existing `describe('Navigator', ...)` block:

```ts
it('getStatus returns standby when no processes running', () => {
  const nav = new Navigator({ db: db.getDb(), configService, starbaseId: 'test-123' });
  expect(nav.getStatus()).toBe('standby');
});

it('getStatus returns working when processes are running', () => {
  const nav = new Navigator({ db: db.getDb(), configService, starbaseId: 'test-123' });
  (nav as unknown as { running: Map<string, unknown> }).running.set('exec-1', {
    proc: { killed: false, kill: vi.fn() },
    executionId: 'exec-1',
    startedAt: Date.now()
  });
  expect(nav.getStatus()).toBe('working');
});

it('getStatusText returns Idle when no processes running', () => {
  const nav = new Navigator({ db: db.getDb(), configService, starbaseId: 'test-123' });
  expect(nav.getStatusText()).toBe('Idle');
});

it('getStatusText returns singular when one process running', () => {
  const nav = new Navigator({ db: db.getDb(), configService, starbaseId: 'test-123' });
  (nav as unknown as { running: Map<string, unknown> }).running.set('exec-1', {
    proc: { killed: false, kill: vi.fn() },
    executionId: 'exec-1',
    startedAt: Date.now()
  });
  expect(nav.getStatusText()).toBe('Running 1 execution');
});

it('getStatusText returns plural when multiple processes running', () => {
  const nav = new Navigator({ db: db.getDb(), configService, starbaseId: 'test-123' });
  const running = (nav as unknown as { running: Map<string, unknown> }).running;
  running.set('exec-1', { proc: { killed: false, kill: vi.fn() }, executionId: 'exec-1', startedAt: Date.now() });
  running.set('exec-2', { proc: { killed: false, kill: vi.fn() }, executionId: 'exec-2', startedAt: Date.now() });
  expect(nav.getStatusText()).toBe('Running 2 executions');
});
```

- [ ] **Step 2: Run tests to confirm they fail**

```bash
npm run test -- navigator
```

Expected: 5 new tests FAIL with "nav.getStatus is not a function" or similar.

- [ ] **Step 3: Add the methods to Navigator class**

Open `src/main/starbase/navigator.ts`. After the `isRunning` method (around line 44), add:

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

- [ ] **Step 4: Run tests to confirm they pass**

```bash
npm run test -- navigator
```

Expected: All navigator tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/main/starbase/navigator.ts src/main/__tests__/navigator.test.ts
git commit -m "feat: add getStatus and getStatusText to Navigator"
```

---

## Task 3: Add Navigator to Starbase Snapshot

**Files:**
- Modify: `src/main/starbase-runtime-core.ts`
- Modify: `src/shared/ipc-api.ts`

- [ ] **Step 1: Add navigator to the shared payload type**

Open `src/shared/ipc-api.ts`. Find `StarbaseStatusUpdatePayload` (around line 292). Add `navigator?` after the `firstOfficer?` field:

```ts
export type StarbaseStatusUpdatePayload = {
  crew?: StarbaseCrewRow[];
  missions?: StarbaseMissionRow[];
  sectors?: StarbaseSectorRow[];
  unreadCount?: number;
  firstOfficer?: { status: 'idle' | 'working' | 'memo'; statusText: string; unreadMemos: number };
  navigator?: { status: 'standby' | 'working'; statusText: string };
};
```

- [ ] **Step 2: Update buildSnapshot**

Open `src/main/starbase-runtime-core.ts`. Find `buildSnapshot()` (around line 768). It currently ends with:

```ts
firstOfficer: {
  status: deps.firstOfficer.getStatus(),
  statusText: deps.firstOfficer.getStatusText(),
  unreadMemos: this.getUnreadMemoCount()
}
```

Add a `navigator` field after it:

```ts
firstOfficer: {
  status: deps.firstOfficer.getStatus(),
  statusText: deps.firstOfficer.getStatusText(),
  unreadMemos: this.getUnreadMemoCount()
},
navigator: {
  status: deps.navigator.getStatus(),
  statusText: deps.navigator.getStatusText()
}
```

- [ ] **Step 3: Typecheck**

```bash
npm run typecheck
```

Expected: No errors.

- [ ] **Step 4: Commit**

```bash
git add src/main/starbase-runtime-core.ts src/shared/ipc-api.ts
git commit -m "feat: include navigator status in starbase snapshot"
```

---

## Task 4: Add NavigatorStatus to the Zustand Store

**Files:**
- Modify: `src/renderer/src/store/star-command-store.ts`

- [ ] **Step 1: Add the NavigatorStatus type**

Open `src/renderer/src/store/star-command-store.ts`. After the `FirstOfficerStatus` type (around line 30), add:

```ts
export type NavigatorStatus = {
  status: 'standby' | 'working';
  statusText: string;
};
```

- [ ] **Step 2: Add navigatorStatus to the StarCommandStore type**

In the `StarCommandStore` type definition, after the `firstOfficerStatus` field, add:

```ts
navigatorStatus: NavigatorStatus;
```

After the `setFirstOfficerStatus` action, add:

```ts
setNavigatorStatus: (status: NavigatorStatus) => void;
```

- [ ] **Step 3: Add initial state and action implementation**

In the `create<StarCommandStore>((set) => ({ ... }))` block, after `firstOfficerStatus: { status: 'idle', statusText: 'Idle', unreadMemos: 0 }`, add:

```ts
navigatorStatus: { status: 'standby', statusText: 'Idle' },
```

After the `setFirstOfficerStatus` implementation, add:

```ts
setNavigatorStatus: (status) => set({ navigatorStatus: status }),
```

- [ ] **Step 4: Typecheck**

```bash
npm run typecheck
```

Expected: No errors.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/store/star-command-store.ts
git commit -m "feat: add NavigatorStatus to star-command store"
```

---

## Task 5: Wire Navigator Snapshot to Store in StarCommandTab

**Files:**
- Modify: `src/renderer/src/components/StarCommandTab.tsx`

- [ ] **Step 1: Destructure setNavigatorStatus from the store**

Open `src/renderer/src/components/StarCommandTab.tsx`. Find the line where `setFirstOfficerStatus` is destructured from `useStarCommandStore()` (search for `setFirstOfficerStatus`). Add `setNavigatorStatus` to the same destructure:

```ts
const { ..., setFirstOfficerStatus, setNavigatorStatus } = useStarCommandStore();
```

- [ ] **Step 2: Handle p.navigator in the snapshot handler**

Find the line `if (p.firstOfficer !== undefined) setFirstOfficerStatus(p.firstOfficer);`. Immediately after it, add:

```ts
if (p.navigator !== undefined) setNavigatorStatus(p.navigator);
```

- [ ] **Step 3: Typecheck**

```bash
npm run typecheck
```

Expected: No errors.

- [ ] **Step 4: Commit**

```bash
git add src/renderer/src/components/StarCommandTab.tsx
git commit -m "feat: wire navigator snapshot to store in StarCommandTab"
```

---

## Task 6: Add Navigator Section to AdmiralSidebar

**Files:**
- Modify: `src/renderer/src/components/star-command/AdmiralSidebar.tsx`

- [ ] **Step 1: Add navigator PNG imports**

Open `src/renderer/src/components/star-command/AdmiralSidebar.tsx`. After the First Officer image imports (the `foDefault`, `foWorking`, `foEscalation`, `foIdle` lines), add:

```ts
import navigatorDefault from '../../assets/navigator-default.png';
import navigatorWorking from '../../assets/navigator-working.png';
import navigatorStandby from '../../assets/navigator-standby.png';
import navigatorThinking from '../../assets/navigator-thinking.png';
import navigatorAlert from '../../assets/navigator-alert.png';
```

- [ ] **Step 2: Add NAVIGATOR_IMAGES map**

After the `FO_IMAGES` constant, add:

```ts
const NAVIGATOR_IMAGES: Record<string, string> = {
  standby: navigatorStandby,
  working: navigatorWorking,
  thinking: navigatorThinking,
  alert: navigatorAlert,
  default: navigatorDefault
};
```

- [ ] **Step 3: Pull navigatorStatus from the store**

In the `AdmiralSidebar` component, find the line that destructures from `useStarCommandStore()`:

```ts
const { crewList, sectors, unreadCount, admiralStatus, admiralStatusText, firstOfficerStatus } =
  useStarCommandStore();
```

Add `navigatorStatus` to the destructure:

```ts
const { crewList, sectors, unreadCount, admiralStatus, admiralStatusText, firstOfficerStatus, navigatorStatus } =
  useStarCommandStore();
```

- [ ] **Step 4: Resolve the navigator image**

After the line `const foSrc = FO_IMAGES[firstOfficerStatus.status] ?? FO_IMAGES.default;`, add:

```ts
const navSrc = NAVIGATOR_IMAGES[navigatorStatus.status] ?? NAVIGATOR_IMAGES.default;
```

- [ ] **Step 5: Add the Navigator JSX section**

Find the closing `</div>` of the First Officer section (it ends just before `{/* Status sections */}` `<div className="px-4 py-4 space-y-4">`). Insert a new Navigator section between them:

```tsx
{/* Navigator */}
<div className="flex flex-col items-center pt-4 pb-4 border-b border-neutral-800">
  <img
    src={navSrc}
    alt="Navigator"
    width={128}
    height={128}
    className="rounded"
    style={{ imageRendering: 'pixelated' as const }}
  />
  <span className="text-xs font-mono text-teal-400 uppercase tracking-widest mt-2">
    Navigator
  </span>
  <div className="flex items-center gap-1.5 mt-1">
    <span
      className={`w-2 h-2 rounded-full ${
        navigatorStatus.status === 'working'
          ? 'bg-teal-400 animate-pulse'
          : 'bg-green-400'
      }`}
    />
    <span className="text-[10px] font-mono text-neutral-500 uppercase tracking-wider">
      {navigatorStatus.statusText}
    </span>
  </div>
</div>
```

- [ ] **Step 6: Typecheck**

```bash
npm run typecheck
```

Expected: No errors.

- [ ] **Step 7: Run all tests**

```bash
npm run test
```

Expected: All tests pass.

- [ ] **Step 8: Commit**

```bash
git add src/renderer/src/components/star-command/AdmiralSidebar.tsx
git commit -m "feat: display Navigator in AdmiralSidebar under First Officer"
```

---

## Verification

Start the app in dev mode and open a Starbase tab:

```bash
npm run dev
```

- Admiral appears at top (192px)
- First Officer appears below (128px)
- Navigator appears below First Officer (128px) showing "IDLE" with a green dot
- If a protocol execution is running, Navigator should show "WORKING" with a teal pulsing dot and "Running N execution(s)" text
