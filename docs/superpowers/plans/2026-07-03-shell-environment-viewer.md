# Shell Environment Viewer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a read-only "Shell Environment" modal, opened from the ⌘K command palette, that shows the environment variables Fleet injected into the focused terminal at spawn time, grouped by provenance.

**Architecture:** At PTY spawn, `PtyManager.create()` captures the resolved env map plus a per-key source tag and stashes an immutable snapshot on the pane's `PtyEntry`. A single `shell-env:get` IPC channel returns that snapshot for a given `paneId`. A renderer modal (mirroring the Notes/Env-Editor modal pattern) renders it: three provenance sections, live search, secret masking, keyboard-first copy.

**Tech Stack:** Electron (main/preload/renderer), node-pty, React + TypeScript, shadcn/ui + Tailwind, lucide-react, vitest.

## Global Constraints

- Never use the em dash character; use a plain hyphen.
- No unsafe type assertions (`as`) in `src/` - use proper typing/validation. `as const` and test files are exempt.
- Read-only tool: no editing, creating, exporting, diffing, or live re-reading. Snapshot is spawn-time only.
- ⌘K command palette only - no pane-toolbar button.
- Provenance shown via section headers only - no per-row badges.
- Mask by default: keys matching `/TOKEN|SECRET|KEY|PASSWORD|PASSWD|CREDENTIAL|AUTH/i` OR any var whose source is `env-sync`. Masked value renders as literal `••••••••` (8 bullets), never blur. Copy always copies the true value even while masked.
- Section order and labels, verbatim: `Fleet built-ins`, `Env Sync`, `Login shell`.
- Footer copy, verbatim: `Snapshot at shell launch (<time>) · variables exported after launch aren't shown.`
- Verification commands: `npm run typecheck`, `npm run lint`, `npm run test`.
- Tests live in `__tests__/` dirs colocated per layer (`src/shared/__tests__/`, `src/renderer/src/__tests__/`).

---

## File Structure

- **Create** `src/shared/shell-env-types.ts` - `EnvSource`, `ShellEnvVar`, `ShellEnvSnapshot` types.
- **Create** `src/shared/shell-env-snapshot.ts` - pure `buildEnvSnapshot()` (no Electron deps; testable).
- **Create** `src/shared/__tests__/shell-env-snapshot.test.ts` - unit tests for the builder.
- **Modify** `src/main/pty-manager.ts` - thread `envSources`, build + stash snapshot, add `getEnvSnapshot()`.
- **Modify** `src/main/ipc-handlers.ts` - build `envSources` in `PTY_CREATE`; register `SHELL_ENV_GET` handler.
- **Modify** `src/shared/ipc-channels.ts` - add `SHELL_ENV_GET` channel constant.
- **Modify** `src/preload/index.ts` - add `shellEnv.get()` to `fleetApi`.
- **Create** `src/renderer/src/components/shell-env/shell-env-view.ts` - pure view helpers (masking, filter, grouping, time format).
- **Create** `src/renderer/src/__tests__/shell-env-view.test.ts` - unit tests for view helpers.
- **Create** `src/renderer/src/components/shell-env/ShellEnvModal.tsx` - the modal component.
- **Modify** `src/renderer/src/App.tsx` - modal state, toggle listener, JSX render.
- **Modify** `src/renderer/src/lib/commands.ts` - add "Shell Environment" command.

---

## Task 1: Shared types + pure snapshot builder

**Files:**
- Create: `src/shared/shell-env-types.ts`
- Create: `src/shared/shell-env-snapshot.ts`
- Test: `src/shared/__tests__/shell-env-snapshot.test.ts`

**Interfaces:**
- Produces:
  - `type EnvSource = 'login-shell' | 'env-sync' | 'fleet-builtin'`
  - `type ShellEnvVar = { key: string; value: string; source: EnvSource }`
  - `type ShellEnvSnapshot = { spawnedAt: number; shellName: string; cwd: string; vars: ShellEnvVar[] }`
  - `buildEnvSnapshot(params: { finalEnv: Record<string, string | undefined>; sources: Record<string, EnvSource>; shellName: string; cwd: string; spawnedAt: number }): ShellEnvSnapshot`

- [ ] **Step 1: Write the types file**

Create `src/shared/shell-env-types.ts`:

```ts
/** Where a spawned shell's environment variable came from. */
export type EnvSource = 'login-shell' | 'env-sync' | 'fleet-builtin';

/** A single environment variable in a spawn-time snapshot. */
export type ShellEnvVar = {
  key: string;
  value: string;
  source: EnvSource;
};

/** Immutable snapshot of the env Fleet injected into a terminal at spawn time. */
export type ShellEnvSnapshot = {
  /** Epoch ms when the PTY was spawned. */
  spawnedAt: number;
  /** Shell binary name, e.g. "zsh". */
  shellName: string;
  /** Working directory the shell spawned in. */
  cwd: string;
  /** Variables, sorted ascending by key. */
  vars: ShellEnvVar[];
};
```

- [ ] **Step 2: Write the failing test**

Create `src/shared/__tests__/shell-env-snapshot.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { buildEnvSnapshot } from '../shell-env-snapshot';

describe('buildEnvSnapshot', () => {
  it('tags sources, defaults to login-shell, and forces FLEET_SESSION to fleet-builtin', () => {
    const snap = buildEnvSnapshot({
      finalEnv: {
        PATH: '/usr/bin',
        CLAUDE_CONFIG_DIR: '/cfg',
        MY_SECRET: 'abc',
        FLEET_SESSION: '1'
      },
      sources: { CLAUDE_CONFIG_DIR: 'fleet-builtin', MY_SECRET: 'env-sync' },
      shellName: 'zsh',
      cwd: '/repo',
      spawnedAt: 1000
    });

    expect(snap.spawnedAt).toBe(1000);
    expect(snap.shellName).toBe('zsh');
    expect(snap.cwd).toBe('/repo');
    // sorted ascending by key
    expect(snap.vars.map((v) => v.key)).toEqual([
      'CLAUDE_CONFIG_DIR',
      'FLEET_SESSION',
      'MY_SECRET',
      'PATH'
    ]);
    expect(snap.vars.find((v) => v.key === 'PATH')?.source).toBe('login-shell');
    expect(snap.vars.find((v) => v.key === 'CLAUDE_CONFIG_DIR')?.source).toBe('fleet-builtin');
    expect(snap.vars.find((v) => v.key === 'MY_SECRET')?.source).toBe('env-sync');
    expect(snap.vars.find((v) => v.key === 'FLEET_SESSION')?.source).toBe('fleet-builtin');
  });

  it('drops keys whose value is undefined', () => {
    const snap = buildEnvSnapshot({
      finalEnv: { A: 'x', B: undefined },
      sources: {},
      shellName: 'bash',
      cwd: '/',
      spawnedAt: 0
    });
    expect(snap.vars.map((v) => v.key)).toEqual(['A']);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npm run test -- shell-env-snapshot`
Expected: FAIL - cannot find module `../shell-env-snapshot`.

- [ ] **Step 4: Write the builder**

Create `src/shared/shell-env-snapshot.ts`:

```ts
import type { EnvSource, ShellEnvSnapshot, ShellEnvVar } from './shell-env-types';

/**
 * Build an immutable spawn-time env snapshot from the resolved env map plus a
 * per-key source map. Any key not in `sources` is `login-shell`; `FLEET_SESSION`
 * is always `fleet-builtin` (Fleet adds it unconditionally at spawn).
 */
export function buildEnvSnapshot(params: {
  finalEnv: Record<string, string | undefined>;
  sources: Record<string, EnvSource>;
  shellName: string;
  cwd: string;
  spawnedAt: number;
}): ShellEnvSnapshot {
  const { finalEnv, sources, shellName, cwd, spawnedAt } = params;

  const vars: ShellEnvVar[] = Object.entries(finalEnv)
    .filter((entry): entry is [string, string] => entry[1] !== undefined)
    .map(([key, value]) => ({
      key,
      value,
      source: key === 'FLEET_SESSION' ? 'fleet-builtin' : (sources[key] ?? 'login-shell')
    }));

  vars.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));

  return { spawnedAt, shellName, cwd, vars };
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npm run test -- shell-env-snapshot`
Expected: PASS (2 tests).

- [ ] **Step 6: Commit**

```bash
git add src/shared/shell-env-types.ts src/shared/shell-env-snapshot.ts src/shared/__tests__/shell-env-snapshot.test.ts
git commit -m "feat(shell-env): add snapshot types and pure builder"
```

---

## Task 2: Capture the snapshot at spawn (main process)

**Files:**
- Modify: `src/main/pty-manager.ts`
- Modify: `src/main/ipc-handlers.ts:265-295` (build `envSources` in `PTY_CREATE`)

**Interfaces:**
- Consumes: `buildEnvSnapshot`, `EnvSource`, `ShellEnvSnapshot` from Task 1.
- Produces:
  - `PtyCreateOptions.envSources?: Record<string, EnvSource>`
  - `PtyManager.getEnvSnapshot(paneId: string): ShellEnvSnapshot | null`

- [ ] **Step 1: Add imports to `pty-manager.ts`**

At the top of `src/main/pty-manager.ts`, after the existing imports (line 5), add:

```ts
import { basename } from 'node:path';
import { buildEnvSnapshot } from '../shared/shell-env-snapshot';
import type { EnvSource, ShellEnvSnapshot } from '../shared/shell-env-types';
```

- [ ] **Step 2: Extend `PtyCreateOptions` and `PtyEntry`**

In `PtyCreateOptions` (ends line 24), add before the closing brace:

```ts
  /** Per-key provenance for env vars Fleet injected (Env Sync / Fleet built-ins). */
  envSources?: Record<string, EnvSource>;
```

In the `PtyEntry` type (lines 31-39), add before the closing brace:

```ts
  snapshot: ShellEnvSnapshot | null;
```

- [ ] **Step 3: Build `finalEnv` once and stash the snapshot**

In `create()`, replace the `pty.spawn(...)` call (lines 106-112) and the `entry` object literal (lines 114-122) with:

```ts
    const finalEnv = { ...(opts.env ?? process.env), FLEET_SESSION: '1' };
    const proc = pty.spawn(shell, args, {
      name: 'xterm-256color',
      cols: opts.cols ?? 80,
      rows: opts.rows ?? 24,
      cwd: opts.cwd,
      env: finalEnv
    });

    const entry: PtyEntry = {
      process: proc,
      paneId: opts.paneId,
      cwd: opts.cwd,
      outputBuffer: '',
      paused: false,
      dataDisposable: null,
      exitDisposable: null,
      snapshot: buildEnvSnapshot({
        finalEnv,
        sources: opts.envSources ?? {},
        shellName: basename(shell),
        cwd: opts.cwd,
        spawnedAt: Date.now()
      })
    };
```

(The idempotent early-return at lines 52-62 runs before this and keeps the original entry, so its snapshot is preserved across HMR re-creates. A killed pane deletes its entry entirely, so a later re-create rebuilds a fresh snapshot - no stale-snapshot path exists.)

- [ ] **Step 4: Add the accessor method**

In `pty-manager.ts`, after `getCwd()` (ends line 201), add:

```ts
  getEnvSnapshot(paneId: string): ShellEnvSnapshot | null {
    return this.ptys.get(paneId)?.snapshot ?? null;
  }
```

- [ ] **Step 5: Build `envSources` in the PTY_CREATE handler**

In `src/main/ipc-handlers.ts`, add the type import near the other shared imports at the top of the file:

```ts
import type { EnvSource } from '../shared/shell-env-types';
```

Replace the `extraEnv` construction and Env-Sync block (lines 265-288) with:

```ts
    const extraEnv: Record<string, string> = {};
    const envSources: Record<string, EnvSource> = {};
    if (claudeConfigDir) {
      extraEnv.CLAUDE_CONFIG_DIR = claudeConfigDir;
      envSources.CLAUDE_CONFIG_DIR = 'fleet-builtin';
    }

    // Resolve the ShellProfile (defaulting to the registry's default if not provided).
    const profileId = req.shellProfileId ?? (await shellProfileRegistry.getDefaultProfileId());
    const profiles = await shellProfileRegistry.enumerate();
    const profile = profiles.find((p) => p.id === profileId);

    // Env Sync: inject decrypted vars for any inject-delivery target whose dir
    // is an ancestor of this terminal's cwd. Resolves to {} when nothing applies.
    // Translate the cwd through the profile's context so a WSL pane's posix cwd
    // resolves to a Windows-accessible path before findNearestConfig walks it.
    if (req.cwd) {
      try {
        const cwd = resolveCtxPath(profile?.pathContext, req.cwd);
        const syncVars = await envSyncManager.getEnvForCwd(cwd);
        Object.assign(extraEnv, syncVars);
        for (const k of Object.keys(syncVars)) envSources[k] = 'env-sync';
      } catch (err) {
        log.warn('env-sync inject failed; continuing without injected vars', {
          error: err instanceof Error ? err.message : String(err)
        });
      }
    }
```

**Note:** this moves the `profile`/`profileId`/`profiles` lines to sit above the Env-Sync block (they were originally at lines 270-273, between `extraEnv` and the Env-Sync block). Keep them exactly once - do not leave the original copies behind.

Then pass `envSources` into `ptyManager.create()` (the call at lines 291-295):

```ts
    const result = ptyManager.create({
      ...req,
      profile,
      env: Object.keys(extraEnv).length > 0 ? { ...process.env, ...extraEnv } : undefined,
      envSources
    });
```

- [ ] **Step 6: Verify typecheck passes**

Run: `npm run typecheck`
Expected: PASS (no errors). This is the verification for this wiring task - the pure logic is already covered by Task 1's tests; spawning real PTYs in a unit test is out of scope.

- [ ] **Step 7: Commit**

```bash
git add src/main/pty-manager.ts src/main/ipc-handlers.ts
git commit -m "feat(shell-env): capture spawn-time env snapshot per pane"
```

---

## Task 3: IPC channel, handler, and preload surface

**Files:**
- Modify: `src/shared/ipc-channels.ts` (inside the `IPC_CHANNELS` literal, before line 323)
- Modify: `src/main/ipc-handlers.ts` (near the Project Notes handlers, ~line 1163)
- Modify: `src/preload/index.ts` (add `shellEnv` block near line 810)

**Interfaces:**
- Consumes: `PtyManager.getEnvSnapshot`, `ShellEnvSnapshot`.
- Produces:
  - `IPC_CHANNELS.SHELL_ENV_GET === 'shell-env:get'`
  - `window.fleet.shellEnv.get(paneId: string): Promise<ShellEnvSnapshot | null>`

- [ ] **Step 1: Add the channel constant**

In `src/shared/ipc-channels.ts`, inside the `IPC_CHANNELS` object (immediately after the `NOTES_WRITE: 'notes:write',` entry near line 263), add:

```ts
  // Shell Environment (read-only spawn-time snapshot)
  SHELL_ENV_GET: 'shell-env:get',
```

- [ ] **Step 2: Register the handler**

In `src/main/ipc-handlers.ts`, after the `NOTES_WRITE` handler (ends ~line 1175), add:

```ts
  // ── Shell Environment ─────────────────────────────────────────────────────
  // Read-only: returns the env snapshot captured for a pane's PTY at spawn time,
  // or null if the pane has no live PTY (e.g. a non-terminal pane).
  ipcMain.handle(IPC_CHANNELS.SHELL_ENV_GET, (_e, paneId: string) =>
    ptyManager.getEnvSnapshot(paneId)
  );
```

- [ ] **Step 3: Add the preload surface**

In `src/preload/index.ts`, add the type import next to the `NoteReadResult` import (line 143):

```ts
import type { ShellEnvSnapshot } from '../shared/shell-env-types';
```

In the `fleetApi` object, immediately after the `notes: { ... }` block (ends ~line 826), add:

```ts
  ,
  shellEnv: {
    get: async (paneId: string): Promise<ShellEnvSnapshot | null> =>
      typedInvoke<ShellEnvSnapshot | null>(IPC_CHANNELS.SHELL_ENV_GET, paneId)
  }
```

(The leading `,` closes the preceding `notes` property. If the `notes` block already ends with a trailing comma, omit the extra `,` - match the surrounding object's comma style so the object stays valid. `window.fleet.shellEnv` types itself automatically via `export type FleetApi = typeof fleetApi`.)

- [ ] **Step 4: Verify typecheck passes**

Run: `npm run typecheck`
Expected: PASS. Confirms the channel, handler arg types, and `window.fleet.shellEnv.get` signature all line up.

- [ ] **Step 5: Commit**

```bash
git add src/shared/ipc-channels.ts src/main/ipc-handlers.ts src/preload/index.ts
git commit -m "feat(shell-env): add shell-env:get IPC channel and preload surface"
```

---

## Task 4: Renderer view helpers

**Files:**
- Create: `src/renderer/src/components/shell-env/shell-env-view.ts`
- Test: `src/renderer/src/__tests__/shell-env-view.test.ts`

**Interfaces:**
- Consumes: `EnvSource`, `ShellEnvVar` from `../../../../shared/shell-env-types`.
- Produces:
  - `const SECTIONS: { source: EnvSource; label: string; dotClass: string }[]` (order: fleet-builtin, env-sync, login-shell)
  - `isSecret(v: ShellEnvVar): boolean`
  - `matchesQuery(v: ShellEnvVar, query: string): boolean`
  - `filterVars(vars: ShellEnvVar[], query: string): ShellEnvVar[]`
  - `varsForSection(vars: ShellEnvVar[], source: EnvSource): ShellEnvVar[]`
  - `formatSpawnTime(epochMs: number): string`

- [ ] **Step 1: Write the failing test**

Create `src/renderer/src/__tests__/shell-env-view.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import {
  isSecret,
  matchesQuery,
  filterVars,
  varsForSection,
  SECTIONS
} from '../components/shell-env/shell-env-view';
import type { ShellEnvVar } from '../../../../shared/shell-env-types';

const v = (key: string, value: string, source: ShellEnvVar['source']): ShellEnvVar => ({
  key,
  value,
  source
});

describe('isSecret', () => {
  it('masks secret-looking keys case-insensitively', () => {
    expect(isSecret(v('API_TOKEN', 'x', 'login-shell'))).toBe(true);
    expect(isSecret(v('aws_secret_access_key', 'x', 'login-shell'))).toBe(true);
    expect(isSecret(v('PASSWORD', 'x', 'login-shell'))).toBe(true);
    expect(isSecret(v('PATH', '/bin', 'login-shell'))).toBe(false);
  });
  it('masks all env-sync vars regardless of key', () => {
    expect(isSecret(v('PLAIN', 'x', 'env-sync'))).toBe(true);
  });
});

describe('matchesQuery / filterVars', () => {
  it('matches key or value, case-insensitive; empty query matches all', () => {
    expect(matchesQuery(v('FOO', 'bar', 'login-shell'), 'fo')).toBe(true);
    expect(matchesQuery(v('FOO', 'bar', 'login-shell'), 'BAR')).toBe(true);
    expect(matchesQuery(v('FOO', 'bar', 'login-shell'), 'zzz')).toBe(false);
    expect(matchesQuery(v('FOO', 'bar', 'login-shell'), '')).toBe(true);
  });
  it('filterVars keeps only matching', () => {
    const vars = [v('A', '1', 'login-shell'), v('B', '2', 'login-shell')];
    expect(filterVars(vars, 'A').map((x) => x.key)).toEqual(['A']);
  });
});

describe('varsForSection', () => {
  it('returns only vars of the given source', () => {
    const vars = [v('A', '1', 'env-sync'), v('B', '2', 'login-shell')];
    expect(varsForSection(vars, 'env-sync').map((x) => x.key)).toEqual(['A']);
  });
});

describe('SECTIONS', () => {
  it('is ordered fleet-builtin, env-sync, login-shell', () => {
    expect(SECTIONS.map((s) => s.source)).toEqual(['fleet-builtin', 'env-sync', 'login-shell']);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -- shell-env-view`
Expected: FAIL - cannot find module `shell-env-view`.

- [ ] **Step 3: Write the helpers**

Create `src/renderer/src/components/shell-env/shell-env-view.ts`:

```ts
import type { EnvSource, ShellEnvVar } from '../../../../shared/shell-env-types';

/** Section metadata, in render order: Fleet's own injections first, login dump last. */
export const SECTIONS: { source: EnvSource; label: string; dotClass: string }[] = [
  { source: 'fleet-builtin', label: 'Fleet built-ins', dotClass: 'bg-teal-400' },
  { source: 'env-sync', label: 'Env Sync', dotClass: 'bg-blue-400' },
  { source: 'login-shell', label: 'Login shell', dotClass: 'bg-neutral-500' }
];

const SECRET_RX = /TOKEN|SECRET|KEY|PASSWORD|PASSWD|CREDENTIAL|AUTH/i;

/** Masked by default when the key looks secret OR the var came from Env Sync. */
export function isSecret(v: ShellEnvVar): boolean {
  return v.source === 'env-sync' || SECRET_RX.test(v.key);
}

export function matchesQuery(v: ShellEnvVar, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return v.key.toLowerCase().includes(q) || v.value.toLowerCase().includes(q);
}

export function filterVars(vars: ShellEnvVar[], query: string): ShellEnvVar[] {
  return vars.filter((v) => matchesQuery(v, query));
}

export function varsForSection(vars: ShellEnvVar[], source: EnvSource): ShellEnvVar[] {
  return vars.filter((v) => v.source === source);
}

/** Format epoch ms as a short local time, e.g. "12:34 PM". */
export function formatSpawnTime(epochMs: number): string {
  return new Date(epochMs).toLocaleTimeString(undefined, {
    hour: 'numeric',
    minute: '2-digit'
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test -- shell-env-view`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/components/shell-env/shell-env-view.ts src/renderer/src/__tests__/shell-env-view.test.ts
git commit -m "feat(shell-env): add renderer view helpers with tests"
```

---

## Task 5: ShellEnvModal component

**Files:**
- Create: `src/renderer/src/components/shell-env/ShellEnvModal.tsx`

**Interfaces:**
- Consumes: `window.fleet.shellEnv.get`, `ShellEnvSnapshot`, all Task 4 helpers.
- Produces: `export function ShellEnvModal(props: { isOpen: boolean; onClose: () => void; paneId: string | null }): React.JSX.Element | null`

**Design notes (read before implementing):**
- Mirror the Notes/Env-Editor modal pattern exactly: `if (!isOpen) return null;` then a `bg-black/60` backdrop + `animate-in fade-in-0 zoom-in-95` panel. (These sibling tools do not use the shared `Overlay`/`usePresence`; matching them keeps the three env tools visually consistent. No exit animation, by design.)
- Keyboard model: the search input stays focused (cmdk-style). `ArrowUp`/`ArrowDown` move a selection through the flat list of visible rows; `Enter` copies the selected row's value; `Escape` closes. Per-row reveal is via click / the header "Reveal all" toggle - we intentionally do **not** bind `Space` to reveal because it would clash with typing spaces in the always-focused search field.
- Masked value is a fixed literal `••••••••` span (never an input, never blur). Copy button copies the true value even while masked.

- [ ] **Step 1: Write the component**

Create `src/renderer/src/components/shell-env/ShellEnvModal.tsx`:

```tsx
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Terminal, Search, SearchX, Eye, EyeOff, Copy, Check, X } from 'lucide-react';
import type { ShellEnvSnapshot, ShellEnvVar } from '../../../../shared/shell-env-types';
import {
  SECTIONS,
  isSecret,
  filterVars,
  varsForSection,
  formatSpawnTime
} from './shell-env-view';

export function ShellEnvModal({
  isOpen,
  onClose,
  paneId
}: {
  isOpen: boolean;
  onClose: () => void;
  paneId: string | null;
}): React.JSX.Element | null {
  const [snapshot, setSnapshot] = useState<ShellEnvSnapshot | null>(null);
  const [loading, setLoading] = useState(false);
  const [query, setQuery] = useState('');
  const [revealAll, setRevealAll] = useState(false);
  const [revealed, setRevealed] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState(0);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Load the snapshot each time the modal opens for the focused pane.
  useEffect(() => {
    if (!isOpen) return;
    setQuery('');
    setRevealAll(false);
    setRevealed(new Set());
    setSelected(0);
    if (!paneId) {
      setSnapshot(null);
      return;
    }
    setLoading(true);
    let cancelled = false;
    void window.fleet.shellEnv.get(paneId).then((snap) => {
      if (cancelled) return;
      setSnapshot(snap);
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [isOpen, paneId]);

  // Autofocus the search input on open.
  useEffect(() => {
    if (isOpen) inputRef.current?.focus();
  }, [isOpen]);

  // Flat list of currently-visible rows, in section order, for keyboard nav.
  const visible = useMemo(() => {
    if (!snapshot) return [] as ShellEnvVar[];
    const filtered = filterVars(snapshot.vars, query);
    return SECTIONS.flatMap((s) => varsForSection(filtered, s.source));
  }, [snapshot, query]);

  useEffect(() => {
    setSelected((i) => Math.min(i, Math.max(0, visible.length - 1)));
  }, [visible.length]);

  const copyValue = useCallback((v: ShellEnvVar) => {
    void navigator.clipboard.writeText(v.value);
    setCopiedKey(v.key);
    setTimeout(() => setCopiedKey((k) => (k === v.key ? null : k)), 1200);
  }, []);

  const toggleReveal = useCallback((key: string) => {
    setRevealed((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        setSelected((i) => Math.min(i + 1, visible.length - 1));
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSelected((i) => Math.max(i - 1, 0));
      } else if (e.key === 'Enter') {
        e.preventDefault();
        const v = visible[selected];
        if (v) copyValue(v);
      }
    },
    [visible, selected, copyValue, onClose]
  );

  if (!isOpen) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 duration-150 animate-in fade-in-0"
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        onKeyDown={onKeyDown}
        className="flex max-h-[72vh] w-[640px] max-w-[92vw] flex-col overflow-hidden rounded-xl border border-neutral-800 bg-neutral-900 shadow-2xl duration-150 animate-in fade-in-0 zoom-in-95"
      >
        {/* Header */}
        <div className="flex items-center gap-3 border-b border-neutral-800 px-5 py-3">
          <div className="flex items-center gap-2 text-neutral-100">
            <Terminal size={16} className="text-neutral-400" />
            <h2 className="text-sm font-semibold">
              {snapshot ? snapshot.shellName : 'Shell Environment'}
            </h2>
          </div>
          {snapshot?.cwd && (
            <div
              title={snapshot.cwd}
              className="flex items-center gap-1.5 rounded-md bg-neutral-800 px-2.5 py-1 text-xs text-neutral-300"
            >
              <span className="max-w-[260px] truncate">{snapshot.cwd}</span>
            </div>
          )}
          <button
            onClick={() => setRevealAll((v) => !v)}
            className="ml-auto flex items-center gap-1.5 rounded-md px-2 py-1 text-xs text-neutral-300 transition hover:bg-neutral-800 active:scale-95"
          >
            {revealAll ? <EyeOff size={13} /> : <Eye size={13} />}
            {revealAll ? 'Hide all' : 'Reveal all'}
          </button>
          <button
            onClick={onClose}
            className="rounded-md p-1.5 text-neutral-500 transition-colors hover:bg-neutral-800 hover:text-white active:scale-90"
            aria-label="Close shell environment"
          >
            <X size={16} />
          </button>
        </div>

        {/* Search */}
        <div className="relative px-5 py-2.5">
          <Search
            size={14}
            className="pointer-events-none absolute left-7 top-1/2 -translate-y-1/2 text-neutral-500"
          />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Filter variables…"
            className="h-8 w-full rounded-md border border-neutral-800 bg-neutral-950 pl-8 pr-3 font-mono text-xs text-neutral-200 placeholder:font-sans placeholder:text-neutral-600 focus-visible:border-neutral-600 focus-visible:outline-none"
          />
        </div>

        {/* Body */}
        <div className="flex-1 min-h-0 overflow-y-auto overscroll-contain pb-2">
          {loading ? null : !snapshot ? (
            <div className="flex h-40 flex-col items-center justify-center gap-2 text-neutral-500">
              <Terminal size={24} className="text-neutral-600" />
              <p className="text-sm">No shell in this pane</p>
            </div>
          ) : visible.length === 0 ? (
            <div className="flex h-40 flex-col items-center justify-center gap-2">
              <SearchX size={24} className="text-neutral-600" />
              <p className="text-sm text-neutral-400">No variables match &lsquo;{query}&rsquo;</p>
            </div>
          ) : (
            SECTIONS.map((section) => {
              const rows = varsForSection(filterVars(snapshot.vars, query), section.source);
              if (rows.length === 0) return null;
              return (
                <div key={section.source}>
                  <div className="sticky top-0 z-10 flex items-center gap-2 bg-neutral-900/95 px-5 pb-1.5 pt-4 backdrop-blur-sm">
                    <span className={`h-2 w-2 rounded-full ${section.dotClass}`} />
                    <span className="text-[11px] font-medium uppercase tracking-wider text-neutral-500">
                      {section.label}
                    </span>
                    <span className="text-[11px] text-neutral-600">· {rows.length}</span>
                  </div>
                  {rows.map((v) => {
                    const reveal = revealAll || revealed.has(v.key);
                    const masked = isSecret(v) && !reveal;
                    const isSelected = visible[selected]?.key === v.key;
                    return (
                      <div
                        key={v.key}
                        className={`group mx-2 grid h-8 grid-cols-[minmax(140px,max-content)_1fr_auto] items-center rounded-md px-3 ${
                          isSelected ? 'bg-neutral-800/60' : 'hover:bg-neutral-800/50'
                        }`}
                      >
                        <span
                          className={`truncate pr-4 font-mono text-xs font-medium ${
                            isSelected ? 'text-neutral-50' : 'text-neutral-200'
                          }`}
                        >
                          {v.key}
                        </span>
                        <span
                          title={masked ? undefined : v.value}
                          className="truncate font-mono text-xs text-neutral-400"
                        >
                          {masked ? '••••••••' : v.value}
                        </span>
                        <span className="flex items-center gap-0.5 opacity-0 transition group-hover:opacity-100 focus-within:opacity-100">
                          {isSecret(v) && (
                            <button
                              onClick={() => toggleReveal(v.key)}
                              title={reveal ? 'Hide value' : 'Reveal value'}
                              className="flex h-6 w-6 items-center justify-center rounded-md text-neutral-500 hover:bg-neutral-800 hover:text-neutral-300"
                            >
                              {reveal ? <EyeOff size={13} /> : <Eye size={13} />}
                            </button>
                          )}
                          <button
                            onClick={() => copyValue(v)}
                            title="Copy value"
                            className="flex h-6 w-6 items-center justify-center rounded-md text-neutral-500 hover:bg-neutral-800 hover:text-neutral-300"
                          >
                            {copiedKey === v.key ? (
                              <Check size={13} className="text-emerald-400" />
                            ) : (
                              <Copy size={13} />
                            )}
                          </button>
                        </span>
                      </div>
                    );
                  })}
                </div>
              );
            })
          )}
        </div>

        {/* Footer */}
        {snapshot && (
          <div className="flex items-center justify-between border-t border-neutral-800 px-5 py-2 text-[11px] text-neutral-500">
            <span>
              Snapshot at shell launch ({formatSpawnTime(snapshot.spawnedAt)}) · variables exported
              after launch aren&rsquo;t shown.
            </span>
            <span>{snapshot.vars.length} variables</span>
          </div>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Verify typecheck + lint pass**

Run: `npm run typecheck && npm run lint`
Expected: PASS. (No dedicated unit test - the component's pure logic lives in Task 4's tested helpers; the component is verified live in Task 7.)

- [ ] **Step 3: Commit**

```bash
git add src/renderer/src/components/shell-env/ShellEnvModal.tsx
git commit -m "feat(shell-env): add read-only ShellEnvModal component"
```

---

## Task 6: Wire into App + command palette

**Files:**
- Modify: `src/renderer/src/App.tsx` (import, state, toggle effect, JSX)
- Modify: `src/renderer/src/lib/commands.ts` (command entry)

**Interfaces:**
- Consumes: `ShellEnvModal`, `activePaneId` from the workspace store, the `fleet:toggle-shell-env` DOM event.

- [ ] **Step 1: Import the modal in App.tsx**

In `src/renderer/src/App.tsx`, next to the `NotesModal` import (line 52), add:

```tsx
import { ShellEnvModal } from './components/shell-env/ShellEnvModal';
```

- [ ] **Step 2: Add open state**

After the `notesOpen` state (line 181), add:

```tsx
  const [shellEnvOpen, setShellEnvOpen] = useState(false);
```

- [ ] **Step 3: Add the toggle listener**

After the Project-notes toggle effect (ends line 347), add:

```tsx
  // Shell environment modal toggle
  useEffect(() => {
    const handler = (): void => setShellEnvOpen((prev) => !prev);
    document.addEventListener('fleet:toggle-shell-env', handler);
    return () => document.removeEventListener('fleet:toggle-shell-env', handler);
  }, []);
```

- [ ] **Step 4: Render the modal**

After the `<NotesModal ... />` render block (ends line 1196), add:

```tsx
      <ShellEnvModal
        isOpen={shellEnvOpen}
        onClose={() => setShellEnvOpen(false)}
        paneId={activePaneId}
      />
```

- [ ] **Step 5: Add the command palette entry**

In `src/renderer/src/lib/commands.ts`, inside the array returned by `createCommandRegistry()`, add a new command (place it near the `settings`/`shortcuts` entries in the `App`/`View` area):

```ts
    {
      id: 'shell-env',
      label: 'Shell Environment',
      category: 'View',
      keywords: ['env', 'environment', 'variables', 'shell', 'export'],
      execute: () => document.dispatchEvent(new CustomEvent('fleet:toggle-shell-env'))
    },
```

- [ ] **Step 6: Verify typecheck + lint pass**

Run: `npm run typecheck && npm run lint`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/renderer/src/App.tsx src/renderer/src/lib/commands.ts
git commit -m "feat(shell-env): wire modal into app and command palette"
```

---

## Task 7: End-to-end verification

**Files:** none (verification only).

- [ ] **Step 1: Full verification suite**

Run: `npm run typecheck && npm run lint && npm run test`
Expected: all PASS.

- [ ] **Step 2: Live smoke test via fleet-drive**

Start the app: `npm run dev` (in a background shell).

Then, from the repo root, exercise the flow (see `scripts/drive/README.md`):

```bash
npm run drive -- keys 'Meta+K'
npm run drive -- type 'input[placeholder]' 'Shell Environment'
npm run drive -- keys 'Enter'
npm run drive -- screenshot
```

Read the screenshot and confirm:
1. Modal opens showing the focused terminal's shell name + cwd in the header.
2. Three sections appear in order: **Fleet built-ins** (contains `FLEET_SESSION`), **Env Sync** (only if configured), **Login shell** (the bulk).
3. Secret-looking keys and all Env-Sync vars render as `••••••••`.
4. Footer shows the spawn time and the "variables exported after launch aren't shown" caveat.

- [ ] **Step 3: Verify interactions**

- Type in the search box → list live-filters, section headers persist with updated counts.
- Click a row's Eye icon → that value reveals; click "Reveal all" → all reveal.
- Click a row's Copy icon → icon flips to a green check for ~1.2s; paste elsewhere confirms the true value copied (even for a still-masked row).
- Arrow keys move the selection highlight; Enter copies the selected row's value; Esc closes.

- [ ] **Step 4: Verify the no-shell empty state**

Focus a non-terminal pane (e.g. a markdown or image pane), then ⌘K → "Shell Environment". Confirm the modal shows the centered "No shell in this pane" empty state.

- [ ] **Step 5: Final commit (if any fixes were needed)**

```bash
git add -A
git commit -m "fix(shell-env): address issues found in e2e verification"
```

---

## Self-Review Notes

- **Spec coverage:** spawn-time snapshot (Tasks 1-2), provenance tagging + section grouping (Tasks 1/4/5), single `shell-env:get` IPC (Task 3), ⌘K-only entry (Task 6), masking + reveal + copy-true-value (Tasks 4-5), search preserving sections/counts (Task 5), keyboard-first flow (Task 5), footer caveat + timestamp (Task 5), no-shell empty state (Tasks 5/7), non-goals enforced (no edit UI anywhere). All covered.
- **Deliberate deviations from the spec, flagged for reviewer:**
  1. **Motion:** the spec mentioned `dialogFadeAnim`/`usePresence`; this plan instead mirrors the sibling Notes/Env-Editor modals' simpler `if (!isOpen) return null` + enter-only `animate-in` (no exit animation), for visual consistency with the two adjacent env tools. Switch to the shared `<Overlay>` later if exit animation is wanted app-wide.
  2. **Space-to-reveal:** dropped, because the search input is always focused and Space must type a literal space. Reveal is via click + "Reveal all"; keyboard covers navigate/copy/close.
- **Type consistency:** `EnvSource`/`ShellEnvVar`/`ShellEnvSnapshot` defined in Task 1 and consumed unchanged in Tasks 2-6; `buildEnvSnapshot` and `getEnvSnapshot` signatures match their call sites; `SECTIONS`/`isSecret`/`filterVars`/`varsForSection`/`formatSpawnTime` names identical across Task 4 definition, its test, and Task 5 usage.
