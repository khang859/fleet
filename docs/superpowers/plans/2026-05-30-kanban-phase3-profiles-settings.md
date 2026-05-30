# Kanban Phase 3 — Profiles & Settings Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Kanban settings section with a worker-profile registry (name → model + skills + system prompt), drive the dispatcher config from settings with live-reload, and materialize the assigned profile into each worker's workspace so `rune --prompt --profile <name>` resolves it end-to-end.

**Architecture:** Worker profiles + dispatcher config live in `FleetSettings.kanban` (electron-store, same per-section deep-merge as every other section — Fleet owns the data). At spawn time the dispatcher resolves the task's assignee to a profile and `spawn-worker` writes it to `<workspace>/.rune/profiles/<name>.md` (next to the `.rune/mcp.json` it already writes). rune resolves profiles from both `~/.rune/profiles` and `<cwd>/.rune/profiles`, so per-workspace materialization is task-scoped and needs no global writes. Dispatcher config changes apply live via a small bridge module (mirrors copilot's `onCopilotSettingsChanged`).

**Tech Stack:** Electron + electron-store, TypeScript, React + Tailwind + shadcn, zustand (renderer settings store), vitest. Worker runtime is `rune` (Go), now on `main` with `--profile` support (rune#12: `internal/profile/profile.go`).

---

## Design refinement vs. the master spec

The approved master design (`docs/superpowers/specs/2026-05-30-kanban-board-design.md`) said the dispatcher materializes profiles into the **global** `~/.rune/profiles/*.md` on save. While confirming rune's profile loader (`reference/rune/cmd/rune/profile.go`), we found rune **also** resolves project-local `<cwd>/.rune/profiles`, with project-local overriding global. We therefore materialize **per-workspace at spawn time** instead of globally. This is strictly better: task-scoped, no clobbering of hand-authored global profiles, no deletion-tracking, and consistent with the `.rune/mcp.json` that `spawn-worker` already writes per workspace. Consequence: the only thing the settings-change hook must do live is **reconfigure the dispatcher** (interval/concurrency) — profile content is read fresh from settings at every spawn.

Two further simplifications (approved during brainstorming): profiles live in `FleetSettings` (no separate store), and the assignee dropdown reads `useSettingsStore().settings.kanban.profiles` directly (no new `listProfiles` IPC — reuse `settings:get`).

## rune profile file format (the materialization target)

From `reference/rune/internal/profile/profile.go` — `ParseMarkdown`:

```markdown
---
name: researcher           # optional (defaults to filename). Validated: ^[a-z0-9][a-z0-9_-]*$
model: claude-opus-4-8     # optional; empty → normal provider resolution
skills: [web-search, docs] # optional; inline list "[a, b]" OR comma-separated
---

<body → Profile.Instructions (the persona/system prompt)>
```

`--model` flag always wins over a profile's `model` (`profileModel` precedence). Skills named but not found on disk are warned, not fatal (`prependProfile`).

## File structure

**Shared**
- `src/shared/types.ts` (modify) — add `WorkerProfile`, `KanbanSettings`, `kanban` field on `FleetSettings`, and `isValidProfileName()` (shared by main + renderer).
- `src/shared/constants.ts` (modify) — add `DEFAULT_SETTINGS.kanban` with seeded `default` + `orchestrator` profiles.

**Main**
- `src/main/settings-store.ts` (modify) — deep-merge `kanban` in `get()`/`set()`.
- `src/main/kanban/profile-file.ts` (create) — pure `renderProfileMarkdown(profile)` (rune format).
- `src/main/kanban/spawn-worker.ts` (modify) — accept resolved `profile`, write `<workspace>/.rune/profiles/<name>.md`.
- `src/main/kanban/kanban-dispatcher.ts` (modify) — `reconfigure(config, intervalMs)`.
- `src/main/kanban/kanban-settings-bridge.ts` (create) — `setKanbanSettingsApplier` / `onKanbanSettingsChanged`.
- `src/main/kanban/kanban-ipc.ts` (modify) — `registerKanbanIpc` takes a create-defaults getter; create handler applies defaults.
- `src/main/ipc-handlers.ts` (modify) — `SETTINGS_SET` calls `onKanbanSettingsChanged()` when `settings.kanban` present.
- `src/main/index.ts` (modify) — dispatcher config from settings, profile resolution at spawn, create-defaults getter, live-reload applier.

**Renderer**
- `src/renderer/src/components/settings/SettingsNav.tsx` (modify) — add `'kanban'` section.
- `src/renderer/src/components/settings/SettingsTab.tsx` (modify) — route `kanban` → `KanbanSection`.
- `src/renderer/src/components/settings/kanban/KanbanSection.tsx` (create) — dispatcher + defaults + profile list.
- `src/renderer/src/components/settings/kanban/ProfileEditor.tsx` (create) — single-profile edit card.
- `src/renderer/src/components/kanban/KanbanDrawer.tsx` (modify) — assignee `<input>` → `<select>`.

**Tests**
- `src/main/__tests__/profile-file.test.ts` (create)
- `src/main/__tests__/settings-store.test.ts` (create)
- `src/main/__tests__/kanban-spawn-worker.test.ts` (extend)
- `src/main/__tests__/kanban-dispatcher.test.ts` (extend)

## Verification commands

- Type check: `npm run typecheck`
- Tests: `npm test` (the `pretest` hook rebuilds `better-sqlite3` for Node's ABI automatically)
- Lint (advisory; baseline is dirty — add zero NEW errors): `npx eslint <changed files>`
- Manual GUI: `npm run dev` (the `predev` hook rebuilds `better-sqlite3` for Electron's ABI)

---

### Task 1: Shared types, defaults, and settings-store merge

**Files:**
- Modify: `src/shared/types.ts` (add types + validator; `FleetSettings` is at lines 127-154)
- Modify: `src/shared/constants.ts` (`DEFAULT_SETTINGS` ends at the `annotate` block)
- Modify: `src/main/settings-store.ts:17-51` (the `get()`/`set()` deep-merges)
- Test: `src/main/__tests__/settings-store.test.ts` (create)

- [ ] **Step 1: Add shared types + validator to `src/shared/types.ts`**

At the top of the file, add the import (the file currently has no kanban import):

```ts
import type { WorkspaceKind } from './kanban-types';
```

Immediately above `export type FleetSettings = {` (line 127), add:

```ts
// ── Kanban worker profiles & settings ──────────────────────────────────────

/** A named worker role materialized to `<workspace>/.rune/profiles/<name>.md`. */
export type WorkerProfile = {
  name: string; // ^[a-z0-9][a-z0-9_-]*$ (rune's validName)
  model: string; // '' → leave to rune's normal provider resolution
  skills: string[];
  instructions: string; // persona / system-prompt body
};

export type KanbanSettings = {
  dispatcher: {
    intervalMs: number;
    maxInProgress: number;
    failureLimit: number;
    claimTtlMs: number;
  };
  defaults: {
    workspaceKind: WorkspaceKind;
    maxRuntimeSeconds: number | null;
  };
  profiles: WorkerProfile[];
};

const PROFILE_NAME_RE = /^[a-z0-9][a-z0-9_-]*$/;

/** Matches rune's profile.validName: lowercase alnum, with - or _ allowed after the first char. */
export function isValidProfileName(name: string): boolean {
  return PROFILE_NAME_RE.test(name);
}
```

Then add the `kanban` field to `FleetSettings` (after the `annotate` block, before the closing `};` at line 154):

```ts
  annotate: {
    retentionDays: number;
  };
  kanban: KanbanSettings;
};
```

- [ ] **Step 2: Add `DEFAULT_SETTINGS.kanban` to `src/shared/constants.ts`**

In `DEFAULT_SETTINGS`, change the `annotate` block's trailing `}` to add the `kanban` section after it:

```ts
  annotate: {
    retentionDays: 3
  },
  kanban: {
    dispatcher: { intervalMs: 5000, maxInProgress: 3, failureLimit: 2, claimTtlMs: 900_000 },
    defaults: { workspaceKind: 'scratch', maxRuntimeSeconds: null },
    profiles: [
      {
        name: 'default',
        model: '',
        skills: [],
        instructions:
          'You are a focused Fleet worker. Complete the assigned kanban task end-to-end, then call kanban_complete with a concise result. If you cannot proceed, call kanban_block with the reason.'
      },
      {
        name: 'orchestrator',
        model: '',
        skills: [],
        instructions:
          'You are the Fleet kanban orchestrator. Break the assigned task into a graph of smaller child tasks using kanban_create and kanban_link, choosing an appropriate worker profile for each child. Do not implement the work yourself.'
      }
    ]
  }
};
```

- [ ] **Step 3: Deep-merge `kanban` in `src/main/settings-store.ts`**

In `get()` (after the `copilot:` line, inside the returned object), add:

```ts
      copilot: { ...DEFAULT_SETTINGS.copilot, ...saved.copilot },
      annotate: { ...DEFAULT_SETTINGS.annotate, ...saved.annotate },
      kanban: {
        ...DEFAULT_SETTINGS.kanban,
        ...saved.kanban,
        dispatcher: { ...DEFAULT_SETTINGS.kanban.dispatcher, ...saved.kanban?.dispatcher },
        defaults: { ...DEFAULT_SETTINGS.kanban.defaults, ...saved.kanban?.defaults },
        profiles: saved.kanban?.profiles ?? DEFAULT_SETTINGS.kanban.profiles
      }
```

In `set()` (after the `copilot:` line, inside `merged`), add:

```ts
      copilot: { ...current.copilot, ...(partial.copilot ?? {}) },
      annotate: { ...current.annotate, ...(partial.annotate ?? {}) },
      kanban: {
        ...current.kanban,
        ...(partial.kanban ?? {}),
        dispatcher: { ...current.kanban.dispatcher, ...(partial.kanban?.dispatcher ?? {}) },
        defaults: { ...current.kanban.defaults, ...(partial.kanban?.defaults ?? {}) },
        profiles: partial.kanban?.profiles ?? current.kanban.profiles
      }
```

> Note: `get()`/`set()` currently do not merge `annotate`; add those lines too (they are shown above) so the new merge block compiles cleanly alongside the existing fields. If `annotate` lines already exist, leave them and add only the `kanban` lines.

- [ ] **Step 4: Write the failing settings-store test**

Create `src/main/__tests__/settings-store.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SettingsStore } from '../settings-store';
import type { FleetSettings } from '../../shared/types';

// Mock electron-store, seeding `defaults` like the real lib does.
vi.mock('electron-store', () => ({
  default: class MockStore {
    private data: Record<string, unknown>;
    constructor(opts?: { defaults?: Record<string, unknown> }) {
      this.data = { ...(opts?.defaults ?? {}) };
    }
    get(key: string, defaultVal?: unknown): unknown {
      return this.data[key] ?? defaultVal;
    }
    set(key: string, value: unknown): void {
      this.data[key] = value;
    }
  }
}));

describe('SettingsStore kanban merge', () => {
  let store: SettingsStore;
  beforeEach(() => {
    store = new SettingsStore();
  });

  it('returns kanban defaults for a fresh store', () => {
    const s = store.get();
    expect(s.kanban.dispatcher.intervalMs).toBe(5000);
    expect(s.kanban.dispatcher.maxInProgress).toBe(3);
    expect(s.kanban.profiles.map((p) => p.name)).toContain('default');
    expect(s.kanban.profiles.map((p) => p.name)).toContain('orchestrator');
  });

  it('merges a partial dispatcher change without dropping siblings or profiles', () => {
    store.set({ kanban: { dispatcher: { intervalMs: 3000 } } } as Partial<FleetSettings>);
    const s = store.get();
    expect(s.kanban.dispatcher.intervalMs).toBe(3000);
    expect(s.kanban.dispatcher.maxInProgress).toBe(3); // sibling preserved
    expect(s.kanban.profiles.length).toBeGreaterThan(0); // profiles preserved
  });

  it('replaces the profiles array wholesale when provided', () => {
    store.set({
      kanban: { profiles: [{ name: 'solo', model: '', skills: [], instructions: 'x' }] }
    } as Partial<FleetSettings>);
    expect(store.get().kanban.profiles.map((p) => p.name)).toEqual(['solo']);
  });
});
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run src/main/__tests__/settings-store.test.ts`
Expected: 3 passing. (If `pretest` hasn't run, prefix with `npm run rebuild:node` — but vitest doesn't touch better-sqlite3 here, so it should pass directly.)

- [ ] **Step 6: Typecheck and commit**

Run: `npm run typecheck`
Expected: clean.

```bash
git add src/shared/types.ts src/shared/constants.ts src/main/settings-store.ts src/main/__tests__/settings-store.test.ts
git commit -m "feat(kanban): add kanban worker-profile + dispatcher settings"
```

---

### Task 2: Profile markdown renderer

**Files:**
- Create: `src/main/kanban/profile-file.ts`
- Test: `src/main/__tests__/profile-file.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/main/__tests__/profile-file.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { renderProfileMarkdown } from '../kanban/profile-file';
import { isValidProfileName } from '../../shared/types';

describe('renderProfileMarkdown', () => {
  it('renders frontmatter with name, model, and inline skills list, then body', () => {
    const md = renderProfileMarkdown({
      name: 'researcher',
      model: 'claude-opus-4-8',
      skills: ['web-search', 'docs'],
      instructions: 'You research things.'
    });
    expect(md).toContain('---\nname: researcher\n');
    expect(md).toContain('model: claude-opus-4-8\n');
    expect(md).toContain('skills: [web-search, docs]\n');
    expect(md.indexOf('---', 4)).toBeGreaterThan(0); // closing fence present
    expect(md.trimEnd().endsWith('You research things.')).toBe(true);
  });

  it('omits the model line when model is empty', () => {
    const md = renderProfileMarkdown({ name: 'a', model: '', skills: [], instructions: 'b' });
    expect(md).not.toContain('model:');
  });

  it('omits the skills line when there are no skills', () => {
    const md = renderProfileMarkdown({ name: 'a', model: '', skills: [], instructions: 'b' });
    expect(md).not.toContain('skills:');
  });
});

describe('isValidProfileName', () => {
  it('accepts lowercase alnum with - and _ after the first char', () => {
    expect(isValidProfileName('researcher')).toBe(true);
    expect(isValidProfileName('a1_b-c')).toBe(true);
  });
  it('rejects uppercase, leading punctuation, spaces, and empty', () => {
    expect(isValidProfileName('Researcher')).toBe(false);
    expect(isValidProfileName('-bad')).toBe(false);
    expect(isValidProfileName('has space')).toBe(false);
    expect(isValidProfileName('')).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/main/__tests__/profile-file.test.ts`
Expected: FAIL — cannot resolve `../kanban/profile-file`.

- [ ] **Step 3: Implement `src/main/kanban/profile-file.ts`**

```ts
import type { WorkerProfile } from '../../shared/types';

/**
 * Renders a worker profile as a rune profile markdown file (YAML-ish frontmatter
 * + persona body), matching reference/rune/internal/profile.ParseMarkdown.
 */
export function renderProfileMarkdown(profile: WorkerProfile): string {
  const lines: string[] = ['---', `name: ${profile.name}`];
  if (profile.model.trim() !== '') lines.push(`model: ${profile.model}`);
  if (profile.skills.length > 0) lines.push(`skills: [${profile.skills.join(', ')}]`);
  lines.push('---', '', profile.instructions.trim(), '');
  return lines.join('\n');
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/main/__tests__/profile-file.test.ts`
Expected: PASS (6 assertions across the cases).

- [ ] **Step 5: Commit**

```bash
git add src/main/kanban/profile-file.ts src/main/__tests__/profile-file.test.ts
git commit -m "feat(kanban): render worker profiles to rune profile markdown"
```

---

### Task 3: Materialize the assigned profile into the worker workspace

**Files:**
- Modify: `src/main/kanban/spawn-worker.ts` (`BuildWorkerInput` interface lines 16-22, `buildWorkerInvocation` lines 33-59)
- Test: `src/main/__tests__/kanban-spawn-worker.test.ts` (extend)

- [ ] **Step 1: Write the failing tests (append to the existing describe block)**

Add these two `it` blocks inside the existing `describe('buildWorkerInvocation', ...)` in `src/main/__tests__/kanban-spawn-worker.test.ts`:

```ts
  it('writes the assigned profile to <workspace>/.rune/profiles/<name>.md', () => {
    const workspace = join(ROOT, 'ws3');
    mkdirSync(workspace, { recursive: true });
    buildWorkerInvocation({
      task: { id: 'p', title: 't', body: '', assignee: 'researcher', modelOverride: null },
      workspace,
      mcpPort: 1,
      runToken: 'x',
      logPath: join(ROOT, 'p.log'),
      profile: {
        name: 'researcher',
        model: 'claude-opus-4-8',
        skills: ['docs'],
        instructions: 'Research.'
      }
    });
    const file = join(workspace, '.rune', 'profiles', 'researcher.md');
    expect(existsSync(file)).toBe(true);
    const md = readFileSync(file, 'utf-8');
    expect(md).toContain('name: researcher');
    expect(md).toContain('model: claude-opus-4-8');
    expect(md).toContain('skills: [docs]');
    expect(md).toContain('Research.');
  });

  it('writes no profiles dir when no profile is provided', () => {
    const workspace = join(ROOT, 'ws4');
    mkdirSync(workspace, { recursive: true });
    buildWorkerInvocation({
      task: { id: 'q', title: 't', body: '', assignee: null, modelOverride: null },
      workspace,
      mcpPort: 1,
      runToken: 'x',
      logPath: join(ROOT, 'q.log')
    });
    expect(existsSync(join(workspace, '.rune', 'profiles'))).toBe(false);
  });
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/main/__tests__/kanban-spawn-worker.test.ts`
Expected: FAIL — `profile` is not a known property / profiles dir not written.

- [ ] **Step 3: Implement the change in `src/main/kanban/spawn-worker.ts`**

Add the import near the top:

```ts
import { renderProfileMarkdown } from './profile-file';
import type { WorkerProfile } from '../../shared/types';
```

Add `profile` to `BuildWorkerInput`:

```ts
export interface BuildWorkerInput {
  task: WorkerTaskInfo;
  workspace: string;
  mcpPort: number;
  runToken: string;
  logPath: string;
  profile?: WorkerProfile | null;
}
```

In `buildWorkerInvocation`, right after the `writeFileSync(mcpConfigPath, ...)` call (before building `prompt`), add:

```ts
  if (input.profile) {
    const profilesDir = join(runeDir, 'profiles');
    mkdirSync(profilesDir, { recursive: true });
    writeFileSync(
      join(profilesDir, `${input.profile.name}.md`),
      renderProfileMarkdown(input.profile)
    );
  }
```

(`spawnRuneWorker` already forwards the whole `BuildWorkerInput` to `buildWorkerInvocation`, so no change there.)

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run src/main/__tests__/kanban-spawn-worker.test.ts`
Expected: PASS (4 tests — the 2 originals + 2 new).

- [ ] **Step 5: Commit**

```bash
git add src/main/kanban/spawn-worker.ts src/main/__tests__/kanban-spawn-worker.test.ts
git commit -m "feat(kanban): materialize assigned profile into worker workspace"
```

---

### Task 4: Dispatcher live reconfigure

**Files:**
- Modify: `src/main/kanban/kanban-dispatcher.ts` (add `reconfigure`; `config`/`intervalMs` live on `this.deps`)
- Test: `src/main/__tests__/kanban-dispatcher.test.ts` (extend)

- [ ] **Step 1: Write the failing test (append a new describe block)**

Add to `src/main/__tests__/kanban-dispatcher.test.ts`:

```ts
describe('KanbanDispatcher.reconfigure', () => {
  beforeEach(() => mkdirSync(TEST_DIR, { recursive: true }));
  afterEach(() => rmSync(TEST_DIR, { recursive: true, force: true }));

  it('applies a new maxInProgress to the next claimAndSpawn', () => {
    const clock = { t: 1000 };
    const store = makeStore(clock);
    for (let i = 0; i < 3; i++) store.createTask({ title: `t${i}`, status: 'ready', assignee: 'r' });
    let spawned = 0;
    const disp = new KanbanDispatcher(store, {
      now: () => clock.t,
      isAlive: () => true,
      spawnWorker: () => ++spawned,
      config: { failureLimit: 2, claimGraceMs: 0, maxInProgress: 1, claimTtlMs: 1000 }
    });
    disp.claimAndSpawn();
    expect(spawned).toBe(1); // cap of 1

    disp.reconfigure({ failureLimit: 2, claimGraceMs: 0, maxInProgress: 3, claimTtlMs: 1000 }, 5000);
    disp.claimAndSpawn();
    expect(spawned).toBe(3); // remaining 2 ready tasks now allowed
    store.close();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/main/__tests__/kanban-dispatcher.test.ts`
Expected: FAIL — `reconfigure` is not a function.

- [ ] **Step 3: Implement `reconfigure` in `src/main/kanban/kanban-dispatcher.ts`**

Add this method to the `KanbanDispatcher` class (e.g. right after `stop()`):

```ts
  /**
   * Apply new config + interval. Per-tick reads pick up `config` immediately;
   * the interval is only read in start(), so restart the timer if it changed.
   */
  reconfigure(config: DispatcherConfig, intervalMs: number): void {
    const intervalChanged = intervalMs !== (this.deps.intervalMs ?? 5000);
    this.deps.config = config;
    this.deps.intervalMs = intervalMs;
    if (this.timer && intervalChanged) {
      this.stop();
      this.start();
    }
  }
```

(`this.deps.config` and `this.deps.intervalMs` are already mutable fields on the `DispatcherDeps` object; `reclaim`/`claimAndSpawn` read `this.deps.config` every call, so updating it is enough for everything except the interval.)

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run src/main/__tests__/kanban-dispatcher.test.ts`
Expected: PASS (existing tests + the new reconfigure test).

- [ ] **Step 5: Commit**

```bash
git add src/main/kanban/kanban-dispatcher.ts src/main/__tests__/kanban-dispatcher.test.ts
git commit -m "feat(kanban): live dispatcher reconfigure"
```

---

### Task 5: Wire settings → dispatcher (config, profile resolution, create defaults, live reload)

**Files:**
- Create: `src/main/kanban/kanban-settings-bridge.ts`
- Modify: `src/main/kanban/kanban-ipc.ts:30` (signature) + create handler lines 52-56
- Modify: `src/main/ipc-handlers.ts` (import + `SETTINGS_SET` handler at 269-274)
- Modify: `src/main/index.ts:750-788` (dispatcher block)

This task is integration wiring; verify with `npm run typecheck` + the full `npm test` suite (the prior tasks' unit tests cover the behaviors).

- [ ] **Step 1: Create the bridge `src/main/kanban/kanban-settings-bridge.ts`**

```ts
// Bridges the generic SETTINGS_SET handler to the kanban subsystem. The kanban
// dispatcher is constructed later in bootstrap than registerIpcHandlers runs,
// so the handler can't close over it directly — it calls through this applier.
// Mirrors the shape of copilot's onCopilotSettingsChanged.
let applier: (() => void) | null = null;

export function setKanbanSettingsApplier(fn: () => void): void {
  applier = fn;
}

export function onKanbanSettingsChanged(): void {
  applier?.();
}
```

- [ ] **Step 2: Hook `SETTINGS_SET` in `src/main/ipc-handlers.ts`**

Add the import next to the existing copilot import (line 69):

```ts
import { onCopilotSettingsChanged } from './copilot/index';
import { onKanbanSettingsChanged } from './kanban/kanban-settings-bridge';
```

Extend the `SETTINGS_SET` handler (lines 269-274):

```ts
  ipcMain.handle(IPC_CHANNELS.SETTINGS_SET, async (_event, settings: Partial<FleetSettings>) => {
    settingsStore.set(settings);
    if (settings.copilot) {
      await onCopilotSettingsChanged();
    }
    if (settings.kanban) {
      onKanbanSettingsChanged();
    }
  });
```

- [ ] **Step 3: Apply create defaults in `src/main/kanban/kanban-ipc.ts`**

Change the function signature (line 30) to accept a defaults getter, and import `WorkspaceKind`:

```ts
import type {
  CreateTaskInput,
  TaskStatus,
  TaskDetail,
  Task,
  WorkspaceKind
} from '../../shared/kanban-types';
```

```ts
export function registerKanbanIpc(
  store: KanbanStore,
  dispatcher: KanbanDispatcher,
  getCreateDefaults: () => { workspaceKind: WorkspaceKind; maxRuntimeSeconds: number | null }
): void {
```

Replace the create handler (lines 52-56):

```ts
  ipcMain.handle(IPC_CHANNELS.KANBAN_CREATE_TASK, (_e, input: CreateTaskInput): Task => {
    const d = getCreateDefaults();
    const task = store.createTask({
      ...input,
      workspaceKind: input.workspaceKind ?? d.workspaceKind,
      maxRuntimeSeconds: input.maxRuntimeSeconds ?? d.maxRuntimeSeconds
    });
    store.appendEvent(task.id, null, 'task_created', { title: task.title });
    return task;
  });
```

- [ ] **Step 4: Wire `src/main/index.ts` dispatcher block (lines 750-788)**

Add imports (near the other kanban imports at the top of the file):

```ts
import { setKanbanSettingsApplier } from './kanban/kanban-settings-bridge';
import type { DispatcherConfig } from './kanban/kanban-dispatcher';
```

Just before `kanbanDispatcher = new KanbanDispatcher(...)` (line 750), add a config builder:

```ts
  const buildDispatcherConfig = (): DispatcherConfig => {
    const d = settingsStore.get().kanban.dispatcher;
    return {
      failureLimit: d.failureLimit,
      claimGraceMs: 30_000, // internal grace window; not user-configurable
      maxInProgress: d.maxInProgress,
      claimTtlMs: d.claimTtlMs
    };
  };
```

In the `spawnWorker` closure (currently lines 767-782), resolve the profile from settings and pass it through:

```ts
    spawnWorker: ({ task, runId, lock, workspace }) => {
      const runToken = randomUUID();
      kanbanMcpRef.registerRun(runToken, { taskId: task.id, runId, role: 'worker' }, lock);
      const profile = task.assignee
        ? (settingsStore.get().kanban.profiles.find((p) => p.name === task.assignee) ?? null)
        : null;
      return spawnRuneWorker({
        task: {
          id: task.id,
          title: task.title,
          body: task.body,
          assignee: task.assignee,
          modelOverride: task.modelOverride
        },
        workspace,
        mcpPort: kanbanMcpPort,
        runToken,
        logPath: join(KANBAN_HOME, 'logs', `${runToken}.log`),
        profile
      });
    },
```

Replace the hardcoded `config`/`intervalMs` lines (784-785):

```ts
    config: buildDispatcherConfig(),
    intervalMs: settingsStore.get().kanban.dispatcher.intervalMs
```

After `kanbanDispatcher.start();` (line 787), replace the `registerKanbanIpc(...)` call and register the live-reload applier:

```ts
  kanbanDispatcher.start();
  registerKanbanIpc(kanbanStore, kanbanDispatcher, () => {
    const d = settingsStore.get().kanban.defaults;
    return { workspaceKind: d.workspaceKind, maxRuntimeSeconds: d.maxRuntimeSeconds };
  });
  setKanbanSettingsApplier(() => {
    kanbanDispatcher?.reconfigure(
      buildDispatcherConfig(),
      settingsStore.get().kanban.dispatcher.intervalMs
    );
  });
```

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: clean. (If `settingsStore` is not already in scope at the kanban bootstrap block, it is the module-level `const settingsStore = new SettingsStore()` at index.ts:62 — no new wiring needed.)

- [ ] **Step 6: Full test run + commit**

Run: `npm test`
Expected: all suites pass (existing 568+ plus the new tests).

```bash
git add src/main/kanban/kanban-settings-bridge.ts src/main/kanban/kanban-ipc.ts src/main/ipc-handlers.ts src/main/index.ts
git commit -m "feat(kanban): drive dispatcher from settings with live reload"
```

---

### Task 6: Kanban settings section UI

**Files:**
- Modify: `src/renderer/src/components/settings/SettingsNav.tsx` (union line 1-9, `ALL_SECTIONS` lines 11-20)
- Modify: `src/renderer/src/components/settings/SettingsTab.tsx` (imports + `SECTION_COMPONENTS`)
- Create: `src/renderer/src/components/settings/kanban/KanbanSection.tsx`
- Create: `src/renderer/src/components/settings/kanban/ProfileEditor.tsx`

UI tasks are verified by `npm run typecheck` + manual GUI check (settings sections in this repo are not unit-tested except `pi`; matching that norm).

- [ ] **Step 1: Add the `kanban` section to `SettingsNav.tsx`**

Extend the union (lines 1-9):

```ts
export type SettingsSection =
  | 'general'
  | 'notifications'
  | 'socket'
  | 'visualizer'
  | 'updates'
  | 'copilot'
  | 'annotate'
  | 'pi'
  | 'kanban';
```

Add to `ALL_SECTIONS` right after the `pi` entry (line 17):

```ts
  { id: 'pi', label: 'Pi Agent' },
  { id: 'kanban', label: 'Kanban' },
```

- [ ] **Step 2: Create `ProfileEditor.tsx`**

`src/renderer/src/components/settings/kanban/ProfileEditor.tsx`:

```tsx
import { isValidProfileName, type WorkerProfile } from '../../../../../shared/types';

export function ProfileEditor({
  profile,
  onChange,
  onDelete
}: {
  profile: WorkerProfile;
  onChange: (next: WorkerProfile) => void;
  onDelete: () => void;
}): React.JSX.Element {
  const nameInvalid = !isValidProfileName(profile.name);
  return (
    <div className="rounded-md border border-neutral-800 bg-neutral-900/50 p-3 space-y-2">
      <div className="flex items-center gap-2">
        <input
          value={profile.name}
          onChange={(e) => onChange({ ...profile, name: e.target.value })}
          placeholder="name"
          className={`flex-1 rounded bg-neutral-800 px-2 py-1 text-sm border ${
            nameInvalid ? 'border-red-500' : 'border-neutral-700'
          }`}
        />
        <button
          onClick={onDelete}
          className="rounded px-2 py-1 text-xs text-red-400 hover:bg-neutral-800"
        >
          Delete
        </button>
      </div>
      {nameInvalid && (
        <p className="text-[10px] text-red-400">
          Lowercase letters, digits, - and _ only; must start with a letter or digit.
        </p>
      )}
      <input
        value={profile.model}
        onChange={(e) => onChange({ ...profile, model: e.target.value })}
        placeholder="model (optional, e.g. claude-opus-4-8)"
        className="w-full rounded bg-neutral-800 px-2 py-1 text-sm border border-neutral-700"
      />
      <input
        value={profile.skills.join(', ')}
        onChange={(e) =>
          onChange({
            ...profile,
            skills: e.target.value
              .split(',')
              .map((s) => s.trim())
              .filter((s) => s !== '')
          })
        }
        placeholder="skills (comma-separated)"
        className="w-full rounded bg-neutral-800 px-2 py-1 text-sm border border-neutral-700"
      />
      <textarea
        value={profile.instructions}
        onChange={(e) => onChange({ ...profile, instructions: e.target.value })}
        rows={4}
        placeholder="System prompt / persona…"
        className="w-full rounded bg-neutral-800 px-2 py-1 text-sm border border-neutral-700"
      />
    </div>
  );
}
```

- [ ] **Step 3: Create `KanbanSection.tsx`**

`src/renderer/src/components/settings/kanban/KanbanSection.tsx`:

```tsx
import { useSettingsStore } from '../../../store/settings-store';
import { SettingRow } from '../SettingRow';
import { ProfileEditor } from './ProfileEditor';
import type { KanbanSettings, WorkerProfile } from '../../../../../shared/types';
import type { WorkspaceKind } from '../../../../../shared/kanban-types';

const WORKSPACE_KINDS: WorkspaceKind[] = ['scratch', 'dir', 'worktree'];

export function KanbanSection(): React.JSX.Element | null {
  const { settings, updateSettings } = useSettingsStore();
  if (!settings) return null;
  const k = settings.kanban;

  const patch = (next: Partial<KanbanSettings>): void => {
    void updateSettings({ kanban: { ...k, ...next } });
  };

  return (
    <div className="space-y-6">
      <section className="space-y-3">
        <h3 className="text-sm font-semibold text-neutral-300">Dispatcher</h3>
        <SettingRow label="Tick interval (ms)">
          <input
            type="number"
            min={1000}
            value={k.dispatcher.intervalMs}
            onChange={(e) =>
              patch({ dispatcher: { ...k.dispatcher, intervalMs: Number(e.target.value) } })
            }
            className="w-28 rounded bg-neutral-800 px-2 py-1 text-sm border border-neutral-700"
          />
        </SettingRow>
        <SettingRow label="Max concurrent workers">
          <input
            type="number"
            min={1}
            value={k.dispatcher.maxInProgress}
            onChange={(e) =>
              patch({ dispatcher: { ...k.dispatcher, maxInProgress: Number(e.target.value) } })
            }
            className="w-28 rounded bg-neutral-800 px-2 py-1 text-sm border border-neutral-700"
          />
        </SettingRow>
        <SettingRow label="Failure limit (before give-up)">
          <input
            type="number"
            min={1}
            value={k.dispatcher.failureLimit}
            onChange={(e) =>
              patch({ dispatcher: { ...k.dispatcher, failureLimit: Number(e.target.value) } })
            }
            className="w-28 rounded bg-neutral-800 px-2 py-1 text-sm border border-neutral-700"
          />
        </SettingRow>
        <SettingRow label="Claim TTL (ms)">
          <input
            type="number"
            min={60000}
            value={k.dispatcher.claimTtlMs}
            onChange={(e) =>
              patch({ dispatcher: { ...k.dispatcher, claimTtlMs: Number(e.target.value) } })
            }
            className="w-32 rounded bg-neutral-800 px-2 py-1 text-sm border border-neutral-700"
          />
        </SettingRow>
      </section>

      <section className="space-y-3">
        <h3 className="text-sm font-semibold text-neutral-300">New-task defaults</h3>
        <SettingRow label="Workspace kind">
          <select
            value={k.defaults.workspaceKind}
            onChange={(e) =>
              patch({
                defaults: { ...k.defaults, workspaceKind: e.target.value as WorkspaceKind }
              })
            }
            className="rounded bg-neutral-800 px-2 py-1 text-sm border border-neutral-700"
          >
            {WORKSPACE_KINDS.map((w) => (
              <option key={w} value={w}>
                {w}
              </option>
            ))}
          </select>
        </SettingRow>
        <SettingRow label="Max runtime (seconds, blank = none)">
          <input
            type="number"
            min={0}
            value={k.defaults.maxRuntimeSeconds ?? ''}
            onChange={(e) =>
              patch({
                defaults: {
                  ...k.defaults,
                  maxRuntimeSeconds: e.target.value === '' ? null : Number(e.target.value)
                }
              })
            }
            className="w-32 rounded bg-neutral-800 px-2 py-1 text-sm border border-neutral-700"
          />
        </SettingRow>
      </section>

      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold text-neutral-300">Worker profiles</h3>
          <button
            onClick={() =>
              patch({
                profiles: [
                  ...k.profiles,
                  { name: '', model: '', skills: [], instructions: '' }
                ]
              })
            }
            className="rounded border border-neutral-700 px-2 py-1 text-xs hover:bg-neutral-800"
          >
            + New profile
          </button>
        </div>
        {k.profiles.length === 0 && (
          <p className="text-xs text-neutral-500">No profiles yet.</p>
        )}
        {k.profiles.map((p, i) => (
          <ProfileEditor
            key={i}
            profile={p}
            onChange={(next: WorkerProfile) =>
              patch({ profiles: k.profiles.map((q, j) => (j === i ? next : q)) })
            }
            onDelete={() => patch({ profiles: k.profiles.filter((_, j) => j !== i) })}
          />
        ))}
      </section>
    </div>
  );
}
```

- [ ] **Step 4: Route the section in `SettingsTab.tsx`**

Add the import:

```ts
import { KanbanSection } from './kanban/KanbanSection';
```

Add to `SECTION_COMPONENTS`:

```ts
  pi: PiSection,
  kanban: KanbanSection
};
```

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: clean.

- [ ] **Step 6: Manual verification**

Run: `npm run dev`. Open Settings → **Kanban**. Verify: dispatcher fields show defaults (5000 / 3 / 2 / 900000); editing a field persists across closing/reopening settings; "New profile" adds a card; an invalid name (e.g. `Bad Name`) shows the red hint; deleting a profile removes it. Confirm `default` and `orchestrator` are present on first run.

- [ ] **Step 7: Commit**

```bash
git add src/renderer/src/components/settings/SettingsNav.tsx src/renderer/src/components/settings/SettingsTab.tsx src/renderer/src/components/settings/kanban/
git commit -m "feat(kanban): settings section with worker-profile registry editor"
```

---

### Task 7: Assignee dropdown in the card drawer

**Files:**
- Modify: `src/renderer/src/components/kanban/KanbanDrawer.tsx` (assignee `<input>` at lines 76-82)

- [ ] **Step 1: Add the settings-store import**

At the top of `KanbanDrawer.tsx`, add:

```ts
import { useSettingsStore } from '../../store/settings-store';
```

Inside the component body (after the existing `useKanbanStore()` destructure, ~line 21), add:

```ts
  const profiles = useSettingsStore((s) => s.settings?.kanban.profiles ?? []);
```

- [ ] **Step 2: Replace the assignee input with a select**

Replace the assignee `<input>` (lines 76-82) with:

```tsx
            <select
              value={assignee}
              onChange={(e) => setAssignee(e.target.value)}
              onBlur={save}
              title="assignee"
              className="flex-1 rounded border border-neutral-700 bg-neutral-950 px-2 py-1 outline-none focus:border-blue-500"
            >
              <option value="">Unassigned</option>
              {assignee !== '' && !profiles.some((p) => p.name === assignee) && (
                <option value={assignee}>{assignee} (unregistered)</option>
              )}
              {profiles.map((p) => (
                <option key={p.name} value={p.name}>
                  {p.name}
                </option>
              ))}
            </select>
```

(The existing `save()` already maps an empty string to `null`, so "Unassigned" clears the assignee correctly. The `(unregistered)` option preserves a legacy freeform assignee that predates the registry.)

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: clean.

- [ ] **Step 4: Manual verification**

Run: `npm run dev`. Open the board, click a task to open the drawer. The assignee field is now a dropdown listing `default`, `orchestrator`, and any custom profiles, plus "Unassigned". Selecting a profile and clicking away (blur) persists it; reopening the drawer shows the saved value.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/components/kanban/KanbanDrawer.tsx
git commit -m "feat(kanban): assignee dropdown sourced from profile registry"
```

---

### Final verification

- [ ] **Step 1: Full gate**

```bash
npm run typecheck   # clean
npm test            # all suites pass (pretest rebuilds better-sqlite3 for Node)
```

- [ ] **Step 2: Lint delta (advisory)**

Run: `npx eslint src/shared/types.ts src/shared/constants.ts src/main/settings-store.ts src/main/kanban/profile-file.ts src/main/kanban/spawn-worker.ts src/main/kanban/kanban-dispatcher.ts src/main/kanban/kanban-settings-bridge.ts src/main/kanban/kanban-ipc.ts src/main/ipc-handlers.ts src/main/index.ts src/renderer/src/components/settings/SettingsNav.tsx src/renderer/src/components/settings/SettingsTab.tsx src/renderer/src/components/settings/kanban/KanbanSection.tsx src/renderer/src/components/settings/kanban/ProfileEditor.tsx src/renderer/src/components/kanban/KanbanDrawer.tsx`
Expected: zero NEW errors on changed files (repo baseline is dirty — see `docs/learnings/2026-05-30-kanban-phase2-lint-baseline-and-ipc-imports.md`).

- [ ] **Step 3: End-to-end manual smoke (optional, requires rune on PATH)**

With `rune` (now on `main` with `--profile`) on PATH: create a profile in Settings → Kanban, create a task assigned to it, and confirm the dispatcher spawns a worker whose workspace contains `.rune/profiles/<name>.md`. Profile resolution is now real (rune#10/#11/#12 are merged), unlike Phase 1's stub-only verification.

## Self-review notes

- **Spec coverage:** dispatcher config (interval/maxInProgress/failureLimit/claimTtl) → Tasks 1,4,5,6; default workspace kind + max runtime → Tasks 1,5,6; worker-profile registry editor → Tasks 1,6; `--profile` materialization → Tasks 2,3,5; assignee dropdown → Task 7; live reload → Tasks 4,5. The master spec's `listProfiles` IPC is intentionally **not** implemented (renderer reads profiles from `settings:get`); global `~/.rune/profiles` materialization is intentionally replaced by per-workspace materialization (see "Design refinement").
- **Deferred (Phase 5, not built here):** orchestrator auto-decompose wiring — only the `orchestrator` profile entry is seeded.
- **Type consistency:** `WorkerProfile`/`KanbanSettings`/`isValidProfileName` defined in `src/shared/types.ts` (Task 1) and consumed unchanged in Tasks 2,3,5,6,7; `DispatcherConfig` reused from `kanban-dispatcher.ts`; `WorkspaceKind` imported from `kanban-types.ts` in both `types.ts` and the section UI.
