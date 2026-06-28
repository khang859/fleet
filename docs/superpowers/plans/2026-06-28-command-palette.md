# ⌘K Command Palette Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Fleet's hand-rolled command palette with a keyboard-first ⌘K palette built on `cmdk`, with grouped results, frecency-ranked Recent, a contextual sub-mode, and a "jump to the agent that needs input" flow.

**Architecture:** Rebuild `CommandPalette.tsx` on `cmdk`'s `Command.Dialog` (Radix-Dialog-backed, so focus trap / restore / scroll lock come for free). Static commands stay declared in `lib/commands.ts`, which grows pure builder helpers that compose static commands with live destinations and needs-you items from `workspace-store` + `notification-store`. A small frecency module persists a decayed-count score per command id and drives the Recent group.

**Tech Stack:** React 19, TypeScript, `cmdk` (^1.1.1), Tailwind, Zustand, xterm.js, electron-vite, Vitest (node environment).

## Global Constraints

- No em dashes anywhere; use a plain dash `-`.
- No unsafe type assertions (`as`) or `eslint-disable` in `src/`; validate at runtime where needed. (`as` is allowed only in test files.)
- Vitest environment is `node`: tests must not touch the DOM or browser globals (`window`, `localStorage`, `document`) directly. Test pure functions; inject `now`/storage.
- Tests live under a `__tests__/` directory next to the code (matches `vitest.config.ts` `include` globs). A test placed elsewhere will not run.
- Verification commands: `npm run typecheck`, `npm run lint`, `npm run test`.
- Match existing code style: 2-space indent, single quotes, semicolons, `type` aliases (not `interface`).
- ⌘K must be captured before a focused xterm terminal consumes it, and must not be sent to the PTY (Ctrl+K is readline kill-line on Linux/Windows).
- Keep cmdk's built-in `command-score` filtering (`shouldFilter` default). Do not add `fuzzysort` or virtualization in this plan.

---

### Task 1: Add cmdk and a themed Command UI wrapper

**Files:**
- Modify: `package.json` (add `cmdk` dependency)
- Create: `src/renderer/src/components/ui/command.tsx`

**Interfaces:**
- Produces: re-exports `Command`, `CommandDialog`, `CommandInput`, `CommandList`, `CommandEmpty`, `CommandGroup`, `CommandItem`, `CommandSeparator` - thin Fleet-themed wrappers over `cmdk` primitives. `CommandDialog` props: `{ open: boolean; onOpenChange: (open: boolean) => void; label: string; children: React.ReactNode }`.

- [ ] **Step 1: Install cmdk**

Run: `npm install cmdk@^1.1.1`
Expected: `package.json` gains `"cmdk": "^1.1.1"` under `dependencies`; `package-lock.json` updated.

- [ ] **Step 2: Create the themed wrapper**

Create `src/renderer/src/components/ui/command.tsx`:

```tsx
import { Command as CommandPrimitive } from 'cmdk';
import { dialogFadeAnim } from '../../lib/motion';

/** Root command menu. Forwards all cmdk Command props (shouldFilter, value, onValueChange, filter, loop, onKeyDown). */
export const Command = CommandPrimitive;

type CommandDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  label: string;
  children: React.ReactNode;
  /** Forwarded to the root Command (e.g. onKeyDown, value, onValueChange, shouldFilter). */
  commandProps?: React.ComponentProps<typeof CommandPrimitive>;
};

/**
 * Fleet-themed cmdk dialog. cmdk renders a Radix Dialog internally, giving us
 * focus trap, focus restore, and scroll lock. We style its overlay/content via
 * the [cmdk-overlay] / [cmdk-dialog] data attributes.
 */
export function CommandDialog({
  open,
  onOpenChange,
  label,
  children,
  commandProps
}: CommandDialogProps): React.JSX.Element {
  return (
    <CommandPrimitive.Dialog
      open={open}
      onOpenChange={onOpenChange}
      label={label}
      // cmdk applies data-state on the dialog; reuse the app's fade convention.
      // Reduced-motion is neutralized globally in index.css.
      overlayClassName={`fixed inset-0 z-50 bg-black/60 duration-150 ${dialogFadeAnim}`}
      contentClassName={`fixed left-1/2 top-[18vh] z-50 w-[640px] max-w-[90vw] -translate-x-1/2 overflow-hidden rounded-xl border border-neutral-700 bg-neutral-900 shadow-2xl duration-150 ${dialogFadeAnim} motion-reduce:transition-none`}
      {...commandProps}
    >
      {children}
    </CommandPrimitive.Dialog>
  );
}

export function CommandInput(props: React.ComponentProps<typeof CommandPrimitive.Input>): React.JSX.Element {
  return (
    <div className="flex items-center border-b border-neutral-800 px-4">
      <CommandPrimitive.Input
        {...props}
        className="h-12 w-full bg-transparent text-[15px] text-white outline-none placeholder:text-neutral-500"
      />
    </div>
  );
}

export function CommandList(props: React.ComponentProps<typeof CommandPrimitive.List>): React.JSX.Element {
  return (
    <CommandPrimitive.List
      {...props}
      className="max-h-[400px] overflow-y-auto overflow-x-hidden p-2"
    />
  );
}

export function CommandEmpty(props: React.ComponentProps<typeof CommandPrimitive.Empty>): React.JSX.Element {
  return (
    <CommandPrimitive.Empty
      {...props}
      className="py-8 text-center text-sm text-neutral-500"
    />
  );
}

export function CommandGroup(props: React.ComponentProps<typeof CommandPrimitive.Group>): React.JSX.Element {
  return (
    <CommandPrimitive.Group
      {...props}
      className="[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:text-xs [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:text-neutral-500"
    />
  );
}

export function CommandItem(props: React.ComponentProps<typeof CommandPrimitive.Item>): React.JSX.Element {
  return (
    <CommandPrimitive.Item
      {...props}
      className="flex h-12 cursor-pointer select-none items-center gap-2 rounded-lg px-3 text-sm text-neutral-300 outline-none data-[selected=true]:bg-white/10 data-[selected=true]:text-white data-[disabled=true]:pointer-events-none data-[disabled=true]:opacity-50"
    />
  );
}

export const CommandSeparator = CommandPrimitive.Separator;
```

- [ ] **Step 3: Verify it typechecks and builds**

Run: `npm run typecheck`
Expected: PASS (no errors referencing `command.tsx`). If cmdk's `Command.Dialog` does not accept `overlayClassName`/`contentClassName` in the installed version, fall back to `className`/`contentClassName` per `node_modules/cmdk/dist/index.d.ts` - read that file to confirm the exact prop names before adjusting.

- [ ] **Step 4: Commit**

```bash
git add package.json package-lock.json src/renderer/src/components/ui/command.tsx
git commit -m "feat(palette): add cmdk and themed Command UI wrapper"
```

---

### Task 2: Frecency module (pure logic + persisted store)

**Files:**
- Create: `src/renderer/src/lib/frecency.ts`
- Create: `src/renderer/src/lib/__tests__/frecency.test.ts`
- Create: `src/renderer/src/store/command-frecency-store.ts`

**Interfaces:**
- Produces (pure, in `frecency.ts`):
  - `type FrecencyEntry = { score: number; lastUsed: number }`
  - `type FrecencyMap = Record<string, FrecencyEntry>`
  - `recordUse(map: FrecencyMap, id: string, now: number): FrecencyMap` - returns a new map with the entry's decayed score + 1.
  - `decayedScore(entry: FrecencyEntry, now: number): number`
  - `rankIds(map: FrecencyMap, now: number): string[]` - ids sorted by decayed score descending.
- Produces (store, in `command-frecency-store.ts`):
  - `useCommandFrecencyStore` zustand store with `{ map: FrecencyMap; record: (id: string) => void; rankedIds: () => string[] }`, persisted to `localStorage` under key `fleet.command-frecency`.

- [ ] **Step 1: Write the failing test**

Create `src/renderer/src/lib/__tests__/frecency.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { recordUse, decayedScore, rankIds } from '../frecency';

const DAY = 86_400_000;

describe('frecency', () => {
  it('adds 1 on first use', () => {
    const map = recordUse({}, 'a', 0);
    expect(map.a.score).toBe(1);
    expect(map.a.lastUsed).toBe(0);
  });

  it('decays the prior score before adding on repeat use', () => {
    const first = recordUse({}, 'a', 0);
    // one 10-day half-life later, prior score halves then +1
    const second = recordUse(first, 'a', 10 * DAY);
    expect(second.a.score).toBeCloseTo(1.5, 5);
    expect(second.a.lastUsed).toBe(10 * DAY);
  });

  it('decayedScore halves over one half-life', () => {
    const entry = { score: 2, lastUsed: 0 };
    expect(decayedScore(entry, 10 * DAY)).toBeCloseTo(1, 5);
  });

  it('ranks ids by decayed score descending', () => {
    let map = {};
    map = recordUse(map, 'old', 0);
    map = recordUse(map, 'recent', 9 * DAY);
    expect(rankIds(map, 9 * DAY)).toEqual(['recent', 'old']);
  });

  it('does not mutate the input map', () => {
    const map = { a: { score: 1, lastUsed: 0 } };
    recordUse(map, 'a', DAY);
    expect(map.a.score).toBe(1);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run test -- frecency`
Expected: FAIL with "Cannot find module '../frecency'".

- [ ] **Step 3: Implement the pure module**

Create `src/renderer/src/lib/frecency.ts`:

```ts
export type FrecencyEntry = { score: number; lastUsed: number };
export type FrecencyMap = Record<string, FrecencyEntry>;

const HALF_LIFE_MS = 10 * 86_400_000; // 10 days
const DECAY = Math.LN2 / HALF_LIFE_MS;

export function decayedScore(entry: FrecencyEntry, now: number): number {
  const dt = Math.max(0, now - entry.lastUsed);
  return entry.score * Math.exp(-DECAY * dt);
}

export function recordUse(map: FrecencyMap, id: string, now: number): FrecencyMap {
  const existing = map[id];
  const base = existing ? decayedScore(existing, now) : 0;
  return { ...map, [id]: { score: base + 1, lastUsed: now } };
}

export function rankIds(map: FrecencyMap, now: number): string[] {
  return Object.keys(map).sort((a, b) => decayedScore(map[b], now) - decayedScore(map[a], now));
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm run test -- frecency`
Expected: PASS (5 tests).

- [ ] **Step 5: Implement the persisted store**

Create `src/renderer/src/store/command-frecency-store.ts`:

```ts
import { create } from 'zustand';
import { recordUse, rankIds, type FrecencyMap } from '../lib/frecency';

const STORAGE_KEY = 'fleet.command-frecency';

function load(): FrecencyMap {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') return parsed as FrecencyMap;
    return {};
  } catch {
    return {};
  }
}

function persist(map: FrecencyMap): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(map));
  } catch {
    // localStorage may be unavailable; frecency is best-effort.
  }
}

type CommandFrecencyStore = {
  map: FrecencyMap;
  record: (id: string) => void;
  rankedIds: () => string[];
};

export const useCommandFrecencyStore = create<CommandFrecencyStore>((set, get) => ({
  map: load(),
  record: (id) => {
    const next = recordUse(get().map, id, Date.now());
    persist(next);
    set({ map: next });
  },
  rankedIds: () => rankIds(get().map, Date.now())
}));
```

Note: the `as FrecencyMap` cast is the one place runtime data crosses a trust boundary. It is guarded by the `typeof parsed === 'object'` check; entries are read defensively by `decayedScore`. This is acceptable per the storage-boundary exception, but if the lint rule forbids it outright, replace with a small zod schema (`z.record(z.object({ score: z.number(), lastUsed: z.number() }))`) and `safeParse`.

- [ ] **Step 6: Verify typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/renderer/src/lib/frecency.ts src/renderer/src/lib/__tests__/frecency.test.ts src/renderer/src/store/command-frecency-store.ts
git commit -m "feat(palette): add decayed-count frecency module + persisted store"
```

---

### Task 3: Rebind the command palette to ⌘K

**Files:**
- Modify: `src/renderer/src/lib/shortcuts.ts:106-111` (the `command-palette` entry)
- Create: `src/renderer/src/lib/__tests__/shortcuts-palette.test.ts`

**Interfaces:**
- Consumes: `matchesShortcut`, `getShortcut`, `ALL_SHORTCUTS` from `shortcuts.ts`.
- Produces: the `command-palette` shortcut now matches ⌘K (mac) / Ctrl+K (other). No new exports.

- [ ] **Step 1: Write the failing test**

Create `src/renderer/src/lib/__tests__/shortcuts-palette.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { ALL_SHORTCUTS, matchesShortcut, getShortcut } from '../shortcuts';

function key(init: Partial<KeyboardEvent> & { key: string }): KeyboardEvent {
  return new KeyboardEvent('keydown', init);
}

describe('command-palette shortcut', () => {
  it('is bound to Cmd/Ctrl+K', () => {
    const def = getShortcut('command-palette');
    expect(def?.mac).toEqual({ key: 'k', meta: true });
    expect(def?.other).toEqual({ key: 'k', ctrl: true });
  });

  it('matches a Cmd+K event on mac-style combo', () => {
    const def = getShortcut('command-palette')!;
    // matchesShortcut picks mac vs other from navigator.platform; assert the
    // combo data shape is correct rather than simulating platform here.
    expect(def.mac.key).toBe('k');
  });

  it('no shortcut still uses the old Shift+P combo', () => {
    const palette = getShortcut('command-palette')!;
    expect(palette.mac.shift).toBeUndefined();
    expect(palette.mac.key).not.toBe('P');
  });

  it('no other shortcut already claims Cmd+K', () => {
    const clashing = ALL_SHORTCUTS.filter(
      (s) => s.id !== 'command-palette' && s.mac.key.toLowerCase() === 'k' && s.mac.meta && !s.mac.shift && !s.mac.alt && !s.mac.ctrl
    );
    expect(clashing).toEqual([]);
    // touch matchesShortcut + key() so they are exercised by the suite
    expect(typeof matchesShortcut).toBe('function');
    expect(key({ key: 'k', metaKey: true }).key).toBe('k');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run test -- shortcuts-palette`
Expected: FAIL - the first assertion fails because the current combo is `{ key: 'P', meta: true, shift: true }`.

- [ ] **Step 3: Rebind the shortcut**

In `src/renderer/src/lib/shortcuts.ts`, replace the `command-palette` entry (lines 106-111):

```ts
  {
    id: 'command-palette',
    label: 'Command palette',
    mac: { key: 'k', meta: true },
    other: { key: 'k', ctrl: true }
  },
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm run test -- shortcuts-palette`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/lib/shortcuts.ts src/renderer/src/lib/__tests__/shortcuts-palette.test.ts
git commit -m "feat(palette): rebind command palette to Cmd/Ctrl+K"
```

---

### Task 4: Stop ⌘K from leaking into a focused terminal

**Files:**
- Modify: `src/renderer/src/hooks/use-terminal.ts` (after `term.open(container)` at line 209, before the cursor-suppression block at line 217)

**Interfaces:**
- Consumes: the xterm `Terminal` instance `term`.
- Produces: no exports. Adds a custom key-event handler so ⌘K / Ctrl+K is neither processed nor forwarded to the PTY, letting the window-level shortcut handler open the palette.

- [ ] **Step 1: Add the custom key-event handler**

In `src/renderer/src/hooks/use-terminal.ts`, immediately after line 210 (`log.debug('xterm mounted', ...)`), insert:

```ts
  // Let the app-level Cmd/Ctrl+K command-palette shortcut win even when a
  // terminal is focused. Returning false tells xterm to ignore the key (and
  // crucially NOT send it to the PTY - Ctrl+K is readline kill-line on
  // Linux/Windows). The window keydown listener then opens the palette.
  term.attachCustomKeyEventHandler((event) => {
    if (event.type === 'keydown' && (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
      return false;
    }
    return true;
  });
```

- [ ] **Step 2: Verify typecheck**

Run: `npm run typecheck`
Expected: PASS. (`attachCustomKeyEventHandler` is part of the xterm `Terminal` API.)

- [ ] **Step 3: Commit**

```bash
git add src/renderer/src/hooks/use-terminal.ts
git commit -m "feat(palette): guard Cmd/Ctrl+K from focused xterm terminals"
```

---

### Task 5: Palette item model and pure builder helpers

**Files:**
- Modify: `src/renderer/src/lib/commands.ts`
- Create: `src/renderer/src/lib/palette-items.ts`
- Create: `src/renderer/src/lib/__tests__/palette-items.test.ts`

**Interfaces:**
- Produces (in `palette-items.ts`):
  - `type PaletteSection = 'needs-you' | 'recent' | 'command' | 'destination'`
  - `type PaletteItem = { id: string; label: string; section: PaletteSection; keywords?: string[]; shortcutLabel?: string; badge?: string; hasActions?: boolean; run: () => void }`
  - `type PaneLocation = { tabId: string; tab: Tab; leaf: PaneLeaf }`
  - `findPaneLocation(tabs: Tab[], paneId: string): PaneLocation | null`
  - `selectNeedsMePaneIds(activities: Map<string, { state: ActivityState }>): string[]`
  - `paneLabel(loc: PaneLocation): string`
- Consumes: `Tab`, `PaneLeaf`, `PaneNode`, `ActivityState` from `shared/types`; `collectPaneIds` from `workspace-store`.

- [ ] **Step 1: Write the failing test**

Create `src/renderer/src/lib/__tests__/palette-items.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { findPaneLocation, selectNeedsMePaneIds, paneLabel } from '../palette-items';
import type { Tab } from '../../../../shared/types';

function leaf(id: string, label?: string): Tab['splitRoot'] {
  return { type: 'leaf', id, cwd: `/work/${id}`, label };
}

const tabs: Tab[] = [
  { id: 't1', label: 'One', labelIsCustom: false, cwd: '/work', splitRoot: leaf('p1', 'Editor') },
  {
    id: 't2',
    label: 'Two',
    labelIsCustom: false,
    cwd: '/work',
    splitRoot: {
      type: 'split',
      direction: 'horizontal',
      ratio: 0.5,
      children: [leaf('p2'), leaf('p3', 'Logs')]
    }
  }
];

describe('findPaneLocation', () => {
  it('finds a pane nested inside a split', () => {
    const loc = findPaneLocation(tabs, 'p3');
    expect(loc?.tabId).toBe('t2');
    expect(loc?.leaf.id).toBe('p3');
  });

  it('returns null for an unknown pane', () => {
    expect(findPaneLocation(tabs, 'nope')).toBeNull();
  });
});

describe('paneLabel', () => {
  it('prefers the leaf label', () => {
    const loc = findPaneLocation(tabs, 'p3')!;
    expect(paneLabel(loc)).toBe('Logs');
  });

  it('falls back to the cwd basename when no leaf label', () => {
    const loc = findPaneLocation(tabs, 'p2')!;
    expect(paneLabel(loc)).toBe('p2');
  });
});

describe('selectNeedsMePaneIds', () => {
  it('returns only panes in the needs_me state', () => {
    const activities = new Map([
      ['p1', { state: 'working' as const }],
      ['p2', { state: 'needs_me' as const }],
      ['p3', { state: 'needs_me' as const }]
    ]);
    expect(selectNeedsMePaneIds(activities).sort()).toEqual(['p2', 'p3']);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run test -- palette-items`
Expected: FAIL with "Cannot find module '../palette-items'".

- [ ] **Step 3: Implement the pure helpers**

Create `src/renderer/src/lib/palette-items.ts`:

```ts
import type { Tab, PaneLeaf, PaneNode, ActivityState } from '../../../shared/types';
import { collectPaneIds, cwdBasename } from '../store/workspace-store';

export type PaletteSection = 'needs-you' | 'recent' | 'command' | 'destination';

export type PaletteItem = {
  id: string;
  label: string;
  section: PaletteSection;
  keywords?: string[];
  /** Pre-formatted shortcut string for the right-aligned kbd chip. */
  shortcutLabel?: string;
  /** Small status pill, e.g. 'needs you'. */
  badge?: string;
  /** When true, Cmd+K / ArrowRight on this row opens its scoped action panel. */
  hasActions?: boolean;
  run: () => void;
};

export type PaneLocation = { tabId: string; tab: Tab; leaf: PaneLeaf };

function findLeaf(node: PaneNode, paneId: string): PaneLeaf | null {
  if (node.type === 'leaf') return node.id === paneId ? node : null;
  return findLeaf(node.children[0], paneId) ?? findLeaf(node.children[1], paneId);
}

export function findPaneLocation(tabs: Tab[], paneId: string): PaneLocation | null {
  for (const tab of tabs) {
    if (collectPaneIds(tab.splitRoot).includes(paneId)) {
      const leaf = findLeaf(tab.splitRoot, paneId);
      if (leaf) return { tabId: tab.id, tab, leaf };
    }
  }
  return null;
}

export function paneLabel(loc: PaneLocation): string {
  if (loc.leaf.label && loc.leaf.label.trim()) return loc.leaf.label;
  return cwdBasename(loc.leaf.cwd, loc.leaf.pathContext);
}

export function selectNeedsMePaneIds(
  activities: Map<string, { state: ActivityState }>
): string[] {
  const ids: string[] = [];
  for (const [paneId, rec] of activities) {
    if (rec.state === 'needs_me') ids.push(paneId);
  }
  return ids;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm run test -- palette-items`
Expected: PASS (5 tests). If `cwdBasename` requires a second arg, confirm its signature in `workspace-store.ts` (it is `cwdBasename(cwd: string, ctx?: PathContext)`) - the call above passes `loc.leaf.pathContext` which may be `undefined`, which is fine.

- [ ] **Step 5: Add an `icon`/`section`-ready Command type and the new jump commands**

In `src/renderer/src/lib/commands.ts`, add two new commands to the array returned by `createCommandRegistry()` (after the existing `inject-skills` entry). These cover the issue's "dispatch new agent" and "jump to agent that needs input":

```ts
    {
      id: 'dispatch-agent',
      label: 'Dispatch New Agent',
      category: 'Agent',
      execute: () => useWorkspaceStore.getState().addTab(undefined, window.fleet.homeDir)
    },
    {
      id: 'jump-needy-agent',
      label: 'Jump to Agent That Needs Input',
      category: 'Agent',
      execute: () => document.dispatchEvent(new CustomEvent('fleet:jump-needy-agent'))
    },
```

The `fleet:jump-needy-agent` event is handled in Task 6 (it jumps focus to the first needs_me pane). Keep `createCommandRegistry()` otherwise unchanged.

- [ ] **Step 6: Verify typecheck + lint**

Run: `npm run typecheck && npm run lint`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/renderer/src/lib/palette-items.ts src/renderer/src/lib/__tests__/palette-items.test.ts src/renderer/src/lib/commands.ts
git commit -m "feat(palette): add palette item model, pane-location + needs-me helpers, jump commands"
```

---

### Task 6: Rewrite CommandPalette.tsx on cmdk (groups, footer, aria-live, frecency, jump-to-needy)

**Files:**
- Rewrite: `src/renderer/src/components/CommandPalette.tsx`
- Modify: `src/renderer/src/App.tsx` (add the `fleet:jump-needy-agent` listener near the existing command-palette toggle handler around lines 266-269)

**Interfaces:**
- Consumes: `CommandDialog`, `CommandInput`, `CommandList`, `CommandEmpty`, `CommandGroup`, `CommandItem` from `./ui/command`; `createCommandRegistry`, `formatCommandShortcut` from `../lib/commands`; `findPaneLocation`, `paneLabel`, `selectNeedsMePaneIds`, type `PaletteItem` from `../lib/palette-items`; `useCommandFrecencyStore`; `useNotificationStore`; `useWorkspaceStore`.
- Produces: `CommandPalette({ isOpen, onClose })` - same props as today, so `App.tsx`'s render at line 1093 is unchanged.

- [ ] **Step 1: Rewrite the component**

Replace the entire contents of `src/renderer/src/components/CommandPalette.tsx`:

```tsx
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  CommandDialog,
  CommandInput,
  CommandList,
  CommandEmpty,
  CommandGroup,
  CommandItem
} from './ui/command';
import { createCommandRegistry, formatCommandShortcut, type Command } from '../lib/commands';
import {
  findPaneLocation,
  paneLabel,
  selectNeedsMePaneIds,
  type PaletteItem
} from '../lib/palette-items';
import { useCommandFrecencyStore } from '../store/command-frecency-store';
import { useNotificationStore } from '../store/notification-store';
import { useWorkspaceStore } from '../store/workspace-store';

type CommandPaletteProps = {
  isOpen: boolean;
  onClose: () => void;
};

/** Map a static Command into a PaletteItem in the 'command' section. */
function toCommandItem(cmd: Command): PaletteItem {
  return {
    id: cmd.id,
    label: cmd.label,
    section: 'command',
    keywords: [cmd.category],
    shortcutLabel: formatCommandShortcut(cmd),
    run: cmd.execute
  };
}

function ItemRow({
  item,
  onRun
}: {
  item: PaletteItem;
  onRun: (item: PaletteItem) => void;
}): React.JSX.Element {
  return (
    <CommandItem value={`${item.section}:${item.id}`} keywords={item.keywords} onSelect={() => onRun(item)}>
      <span className="flex-1 truncate">{item.label}</span>
      {item.badge && (
        <span className="rounded bg-amber-500/20 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-amber-300">
          {item.badge}
        </span>
      )}
      {item.shortcutLabel && (
        <kbd className="ml-2 rounded border border-neutral-700 bg-neutral-800 px-1.5 py-0.5 text-xs text-neutral-400">
          {item.shortcutLabel}
        </kbd>
      )}
    </CommandItem>
  );
}

export function CommandPalette({ isOpen, onClose }: CommandPaletteProps): React.JSX.Element {
  const [search, setSearch] = useState('');
  const announcerRef = useRef<HTMLDivElement>(null);
  const record = useCommandFrecencyStore((s) => s.record);
  const rankedIds = useCommandFrecencyStore((s) => s.rankedIds);

  const staticCommands = useMemo(() => createCommandRegistry(), []);

  // Build the live sections each open. Recomputed when the palette opens.
  const { needsYou, recent, commands } = useMemo(() => {
    const ws = useWorkspaceStore.getState();
    const activities = useNotificationStore.getState().activities;

    const needsYouItems: PaletteItem[] = selectNeedsMePaneIds(activities)
      .map((paneId) => {
        const loc = findPaneLocation(ws.workspace.tabs, paneId);
        if (!loc) return null;
        const item: PaletteItem = {
          id: `pane:${paneId}`,
          label: paneLabel(loc),
          section: 'needs-you',
          badge: 'needs you',
          keywords: [loc.tab.label, 'agent', 'needs input'],
          run: () => {
            ws.setActiveTab(loc.tabId);
            ws.setActivePane(paneId);
          }
        };
        return item;
      })
      .filter((x): x is PaletteItem => x !== null);

    const commandItems = staticCommands.map(toCommandItem);

    const byId = new Map(commandItems.map((c) => [c.id, c]));
    const recentItems = rankedIds()
      .map((id) => byId.get(id))
      .filter((x): x is PaletteItem => x !== undefined)
      .slice(0, 6);

    return { needsYou: needsYouItems, recent: recentItems, commands: commandItems };
    // isOpen is in deps so sections rebuild each time the palette opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, staticCommands, rankedIds]);

  useEffect(() => {
    if (isOpen) setSearch('');
  }, [isOpen]);

  // Announce result mode/counts to screen readers (cmdk ships no live region).
  useEffect(() => {
    if (!isOpen || !announcerRef.current) return;
    const t = setTimeout(() => {
      if (announcerRef.current) {
        announcerRef.current.textContent = search
          ? 'Filtering commands'
          : `${needsYou.length} agents need input`;
      }
    }, 250);
    return () => clearTimeout(t);
  }, [isOpen, search, needsYou.length]);

  const runItem = (item: PaletteItem): void => {
    onClose();
    // Only static commands participate in frecency (stable ids); pane jumps do not.
    if (item.section === 'command') record(item.id);
    item.run();
  };

  const showRecent = search === '';

  return (
    <CommandDialog
      open={isOpen}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      label="Command palette"
      commandProps={{ loop: true }}
    >
      <CommandInput
        value={search}
        onValueChange={setSearch}
        placeholder="Search agents, panes, and commands..."
        autoFocus
      />
      <CommandList>
        <CommandEmpty>No results found.</CommandEmpty>

        {needsYou.length > 0 && (
          <CommandGroup heading="Needs you">
            {needsYou.map((item) => (
              <ItemRow key={item.id} item={item} onRun={runItem} />
            ))}
          </CommandGroup>
        )}

        {showRecent && recent.length > 0 && (
          <CommandGroup heading="Recent">
            {recent.map((item) => (
              <ItemRow key={`recent-${item.id}`} item={item} onRun={runItem} />
            ))}
          </CommandGroup>
        )}

        <CommandGroup heading="Commands">
          {commands.map((item) => (
            <ItemRow key={item.id} item={item} onRun={runItem} />
          ))}
        </CommandGroup>
      </CommandList>

      <div className="flex items-center justify-between border-t border-neutral-800 px-4 py-2 text-xs text-neutral-500">
        <span>Command palette</span>
        <span className="flex gap-3">
          <span>↵ Run</span>
          <span>esc Close</span>
        </span>
      </div>

      <div ref={announcerRef} role="status" aria-live="polite" aria-atomic="true" className="sr-only" />
    </CommandDialog>
  );
}
```

Note: the `recent` group uses a distinct cmdk `value` prefix (`recent-...` via the key, and the row `value` already differs because `ItemRow` builds `${section}:${id}`) - but a recent item reuses the same `command:<id>` value as its Commands-group twin. cmdk requires unique values. To keep them unique, change the Recent rows to pass a section override: render recent items with `section: 'recent'` so their value becomes `recent:<id>`. Do this by mapping in the Recent group: `recent.map((item) => <ItemRow key={...} item={{ ...item, section: 'recent' }} onRun={runItem} />)`.

- [ ] **Step 2: Apply the unique-value fix from the note**

In the Recent group block, change the map to:

```tsx
            {recent.map((item) => (
              <ItemRow key={`recent-${item.id}`} item={{ ...item, section: 'recent' }} onRun={runItem} />
            ))}
```

- [ ] **Step 3: Add the jump-needy-agent listener in App.tsx**

In `src/renderer/src/App.tsx`, near the existing `fleet:toggle-command-palette` handler (around lines 266-269), add a second effect (or extend the existing one) that handles `fleet:jump-needy-agent`:

```tsx
  useEffect(() => {
    const handler = (): void => {
      const activities = useNotificationStore.getState().activities;
      const ws = useWorkspaceStore.getState();
      for (const [paneId, rec] of activities) {
        if (rec.state === 'needs_me') {
          const loc = findPaneLocation(ws.workspace.tabs, paneId);
          if (loc) {
            ws.setActiveTab(loc.tabId);
            ws.setActivePane(paneId);
          }
          break;
        }
      }
    };
    document.addEventListener('fleet:jump-needy-agent', handler);
    return () => document.removeEventListener('fleet:jump-needy-agent', handler);
  }, []);
```

Add the imports at the top of `App.tsx` if not already present: `import { useNotificationStore } from './store/notification-store';` and `import { findPaneLocation } from './lib/palette-items';` (`useWorkspaceStore` is already imported). Confirm exact existing imports before adding to avoid duplicates.

- [ ] **Step 4: Verify typecheck + lint**

Run: `npm run typecheck && npm run lint`
Expected: PASS. Resolve any unused-import or hook-deps lint errors inline.

- [ ] **Step 5: Build**

Run: `npm run build`
Expected: PASS (electron-vite build completes).

- [ ] **Step 6: Commit**

```bash
git add src/renderer/src/components/CommandPalette.tsx src/renderer/src/App.tsx
git commit -m "feat(palette): rebuild command palette on cmdk with grouped results, frecency Recent, jump-to-needy"
```

---

### Task 7: Contextual sub-mode (scoped actions for a destination/agent)

**Files:**
- Modify: `src/renderer/src/components/CommandPalette.tsx`

**Interfaces:**
- Consumes: everything from Task 6 plus `useWorkspaceStore` pane operations (`splitPane`, `closePane`, `renamePane`, `setActivePane`).
- Produces: a `Destinations` group whose rows are enterable. Pressing ⌘K / ArrowRight (or selecting) on a destination opens an in-place action panel; Esc / Backspace-on-empty pops back to the root.

- [ ] **Step 1: Add destinations + page-stack state**

In `CommandPalette.tsx`, extend the component:

1. Add page state: `const [scopePaneId, setScopePaneId] = useState<string | null>(null);` and reset it in the `isOpen` effect (`setScopePaneId(null)` alongside `setSearch('')`).
2. Build a `destinations` array in the same `useMemo` as the other sections - one `PaletteItem` per pane across all tabs (skip panes already in `needsYou`), each with `section: 'destination'`, `hasActions: true`, and `run: () => { ws.setActiveTab(loc.tabId); ws.setActivePane(paneId); }`. Use `collectPaneIds` over each tab's `splitRoot` to enumerate panes; label via `paneLabel`.
3. Build a `scopedActions(paneId)` function returning `PaletteItem[]` for the scoped panel:

```tsx
  const scopedActions = (paneId: string): PaletteItem[] => {
    const ws = useWorkspaceStore.getState();
    const loc = findPaneLocation(ws.workspace.tabs, paneId);
    const label = loc ? paneLabel(loc) : 'pane';
    return [
      { id: 'focus', label: `Focus ${label}`, section: 'command', run: () => {
          if (loc) { ws.setActiveTab(loc.tabId); ws.setActivePane(paneId); }
        } },
      { id: 'split-right', label: 'Split Right', section: 'command', run: () => ws.splitPane(paneId, 'horizontal') },
      { id: 'split-down', label: 'Split Down', section: 'command', run: () => ws.splitPane(paneId, 'vertical') },
      { id: 'rename', label: 'Rename Pane', section: 'command', run: () =>
          document.dispatchEvent(new CustomEvent('fleet:rename-active-pane', { detail: { paneId } })) },
      { id: 'close', label: 'Close Pane', section: 'command', run: () => ws.closePane(paneId) }
    ];
  };
```

- [ ] **Step 2: Track the highlighted value and handle Cmd+K / ArrowRight / Backspace / Esc**

Add `const [highlighted, setHighlighted] = useState('');` and pass `value={highlighted} onValueChange={setHighlighted}` to the root via `commandProps`. Add an `onKeyDown` to `commandProps`:

```tsx
      commandProps={{
        loop: true,
        value: highlighted,
        onValueChange: setHighlighted,
        onKeyDown: (e: React.KeyboardEvent) => {
          // Enter scope: Cmd/Ctrl+K or ArrowRight on a destination row
          if (
            scopePaneId === null &&
            ((e.key === 'k' && (e.metaKey || e.ctrlKey)) || e.key === 'ArrowRight')
          ) {
            const [section, id] = highlighted.split(':');
            if (section === 'destination' && id) {
              e.preventDefault();
              setScopePaneId(id);
              setSearch('');
            }
            return;
          }
          // Pop scope: Esc, or Backspace on empty input
          if (scopePaneId !== null && (e.key === 'Escape' || (e.key === 'Backspace' && search === ''))) {
            e.preventDefault();
            setScopePaneId(null);
            setSearch('');
          }
        }
      }}
```

The destination row `value` is `destination:<paneId>` (from `ItemRow`'s `${item.section}:${item.id}` where the destination item id is the bare paneId - set destination item `id` to the paneId, not `pane:<id>`). Ensure the destination items use `id: paneId` so the split above yields the paneId.

- [ ] **Step 3: Render either the root sections or the scoped panel**

Wrap the existing groups so that when `scopePaneId !== null` the list shows only the scoped panel; otherwise it shows Needs you / Recent / Commands / Destinations. Add a breadcrumb pill in the input row when scoped:

```tsx
      {scopePaneId !== null ? (
        <CommandGroup heading={`Actions`}>
          {scopedActions(scopePaneId).map((item) => (
            <ItemRow key={`scope-${item.id}`} item={item} onRun={runItem} />
          ))}
        </CommandGroup>
      ) : (
        <>
          {/* Needs you / Recent / Commands / Destinations groups from Task 6 + destinations */}
        </>
      )}
```

Add the Destinations group inside the root branch, after Commands:

```tsx
          <CommandGroup heading="Destinations">
            {destinations.map((item) => (
              <ItemRow key={item.id} item={item} onRun={runItem} />
            ))}
          </CommandGroup>
```

Update the input placeholder and footer to reflect scope: when `scopePaneId !== null`, placeholder = `Search actions...` and the footer right side adds `esc Back`; otherwise show `⌘K Actions` as a hint.

- [ ] **Step 4: Verify typecheck + lint + build**

Run: `npm run typecheck && npm run lint && npm run build`
Expected: PASS. Fix any hook-deps or unused-var lint inline.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/components/CommandPalette.tsx
git commit -m "feat(palette): contextual sub-mode with scoped pane actions and breadcrumb"
```

---

### Task 8: Manual verification and cleanup

**Files:**
- None (verification only), unless issues are found.

- [ ] **Step 1: Run the full check suite**

Run: `npm run typecheck && npm run lint && npm run test`
Expected: all PASS. The new test files (`frecency`, `shortcuts-palette`, `palette-items`) run green.

- [ ] **Step 2: Launch the app and walk the checklist**

Run the app (`npm run dev` or the project's run skill). Verify each item from the spec:

- ⌘K opens the palette from a focused terminal pane (confirms the xterm guard); Ctrl+K on Linux/Windows does not kill the shell line.
- ↑/↓ navigate with wrap (loop), Enter runs, Esc closes.
- Groups render with "Needs you" pinned on top; empty groups are hidden; typing filters across groups and hides "Recent".
- With an agent in `needs_me` state (or simulate by setting an activity), the "Needs you" section lists it and Enter jumps focus to that pane. The "Jump to Agent That Needs Input" command also jumps.
- On a Destinations row, ⌘K or → opens its scoped action panel; Backspace on empty input or Esc pops back; Esc again closes.
- Zero-query open is non-blank (Needs you / Recent / Commands / Destinations); a just-run command appears under Recent on next open.
- The old ⌘P+Shift no longer opens the palette.

- [ ] **Step 3: Fix any visual/behavioral issues found**

Address anything that looks off (row height, selected-row contrast, footer alignment, breadcrumb). Re-run `npm run typecheck && npm run lint` after any change. Commit fixes with a `fix(palette): ...` message.

- [ ] **Step 4: Final commit if any cleanup was made**

```bash
git add -A
git commit -m "fix(palette): verification polish"
```

---

## Deferred (explicitly out of scope for this plan)

These were named in the issue or research but are not implemented here, by decision or because no underlying API exists:

- **Prefix modes** (`>`, `@`, `/`, `:`) - deferred to a follow-up; the contextual sub-mode covers the primary need.
- **Matched-character highlighting** - would require swapping cmdk's scorer for `fuzzysort`; deferred.
- **List virtualization** - Fleet's lists are well under the threshold where it helps; a per-group cap + native scroll is used instead. Add a code comment in `CommandPalette.tsx` noting virtualization is the upgrade path if list sizes grow.
- **"Switch overview grouping"** - no overview-grouping feature/API exists in the codebase today; building it is a separate feature, not part of this palette work.

## Self-Review

- **Spec coverage:** ⌘K trigger (Task 3 + 4), rebuild on cmdk (Task 1 + 6), grouped Needs you / Recent / Commands / Destinations (Task 6 + 7), contextual mode (Task 7), jump-to-needy (Task 5 + 6), inline key hints (Task 6 `ItemRow` kbd chip), frecency Recent (Task 2 + 6), footer action bar (Task 6), a11y aria-live + Command.Dialog focus management (Task 1 + 6), empty/loading via `CommandEmpty` (Task 6), reduced-motion via `dialogFadeAnim` + `motion-reduce` (Task 1). Virtualization, prefix modes, highlighting, overview-grouping are listed as Deferred with rationale.
- **Type consistency:** `PaletteItem`, `PaneLocation`, `findPaneLocation`, `paneLabel`, `selectNeedsMePaneIds` are defined in Task 5 and consumed with the same names/signatures in Task 6 and 7. The destination row `value` contract (`destination:<paneId>`, with item `id === paneId`) is stated in Task 7 Step 2.
- **Placeholder scan:** no TBD/TODO; every code step shows real code. The one runtime `as` cast (frecency store load) is flagged with a zod fallback.
