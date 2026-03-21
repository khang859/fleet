# Strict TypeScript Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Eliminate all `as` type casts from source code and all `any` types from the entire codebase, enforced via ESLint.

**Architecture:** Add ESLint rules to enforce no `as` casts in source (allowing `as const`) and no `any` anywhere. Fix violations by: (1) using `better-sqlite3`'s generic `prepare<Bind, Result>()` for DB queries, (2) a `CodedError` helper for error objects, (3) a typed command dispatch map for the runtime core/socket server, (4) proper type narrowing elsewhere.

**Tech Stack:** TypeScript, ESLint (`@typescript-eslint`), better-sqlite3

---

### Task 1: ESLint Configuration

**Files:**
- Modify: `eslint.config.mjs`

- [ ] **Step 1: Enable type-checked linting and add `no-unsafe-type-assertion` rule**

The `no-unsafe-type-assertion` rule requires type-checked linting. Switch from `tseslint.configs.recommended` to `tseslint.configs.recommendedTypeChecked`, add `parserOptions.project`, add `reference/` to ignores, and add the rule for source files:

```typescript
import { defineConfig } from 'eslint/config'
import tseslint from '@electron-toolkit/eslint-config-ts'
import eslintConfigPrettier from '@electron-toolkit/eslint-config-prettier'
import eslintPluginReact from 'eslint-plugin-react'
import eslintPluginReactHooks from 'eslint-plugin-react-hooks'
import eslintPluginReactRefresh from 'eslint-plugin-react-refresh'

export default defineConfig(
  { ignores: ['**/node_modules', '**/dist', '**/out', 'reference/**'] },
  tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        project: ['./tsconfig.node.json', './tsconfig.web.json'],
        tsconfigRootDir: import.meta.dirname,
      }
    }
  },
  eslintPluginReact.configs.flat.recommended,
  eslintPluginReact.configs.flat['jsx-runtime'],
  {
    settings: {
      react: {
        version: 'detect'
      }
    }
  },
  {
    files: ['**/*.{ts,tsx}'],
    plugins: {
      'react-hooks': eslintPluginReactHooks,
      'react-refresh': eslintPluginReactRefresh
    },
    rules: {
      ...eslintPluginReactHooks.configs.recommended.rules,
      ...eslintPluginReactRefresh.configs.vite.rules
    }
  },
  // Ban unsafe type assertions in source files (not tests)
  {
    files: ['src/**/*.{ts,tsx}', 'scripts/**/*.ts'],
    ignores: ['**/__tests__/**'],
    rules: {
      '@typescript-eslint/no-unsafe-type-assertion': 'error',
    }
  },
  eslintConfigPrettier
)
```

Key changes:
- `tseslint.configs.recommended` → `tseslint.configs.recommendedTypeChecked` (enables type-aware rules)
- Added `languageOptions.parserOptions.project` pointing to both tsconfig files
- Added `reference/**` to ignores (not our code)
- Added `no-unsafe-type-assertion: error` for source files only

Note: `@typescript-eslint/no-explicit-any` is already `"error"` via the base config. No change needed for that rule.

- [ ] **Step 2: Verify the rule catches violations**

Run: `npx eslint src/main/ipc-handlers.ts 2>&1 | head -20`
Expected: Errors about `as Error` casts

If type-checked linting causes performance issues or unexpected errors from existing code, troubleshoot before proceeding. Common fixes: ensure tsconfig `include` patterns cover all linted files, add missing files to tsconfig.

- [ ] **Step 3: Commit**

```bash
git add eslint.config.mjs
git commit -m "chore: enable type-checked linting and add no-unsafe-type-assertion rule"
```

---

### Task 2: Typed Database Query Helper

**Files:**
- Modify: `src/main/starbase/comms-service.ts`
- Modify: `src/main/starbase/protocol-service.ts`
- Modify: `src/main/starbase/ships-log.ts`
- Modify: `src/main/starbase/cargo-service.ts`
- Modify: `src/main/starbase/mission-service.ts`
- Modify: `src/main/starbase/crew-service.ts`
- Modify: `src/main/starbase/supply-route-service.ts`
- Modify: `src/main/starbase/sector-service.ts`
- Modify: `src/main/starbase/sentinel.ts`
- Modify: `src/main/starbase/reconciliation.ts`
- Modify: `src/main/starbase/hull.ts`
- Modify: `src/main/starbase/db.ts`

The `better-sqlite3` `prepare()` method is already generic: `prepare<BindParameters, Result>(sql)`. All `.all()` and `.get()` calls that cast results like `as RowType[]` can be fixed by supplying the generic parameter instead.

- [ ] **Step 1: Fix `db.ts` — pragma and meta query casts**

In `db.ts`, replace casts with generic prepare calls or runtime checks:

```typescript
// Line 32: pragma() returns `any` in @types/better-sqlite3.
// Rewrite to avoid the cast entirely by checking the result at runtime:
const result: unknown = testDb.pragma('integrity_check');
const ok = Array.isArray(result) &&
  result.length > 0 &&
  typeof result[0] === 'object' &&
  result[0] !== null &&
  'integrity_check' in result[0] &&
  result[0].integrity_check === 'ok';
if (!ok) {
  throw new Error('Integrity check failed');
}

// Line 81: use generic prepare
const meta = db.prepare<[], { schema_version: number }>('SELECT schema_version FROM _meta').get();
```

Note: `pragma()` is typed as returning `any` in `@types/better-sqlite3`. Since we ban `any`, we need to either: (a) add `// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion` for this single unavoidable case, or (b) wrap it with a runtime type check as shown above. Prefer (b).

- [ ] **Step 2: Fix `comms-service.ts` — all 5 DB query casts**

Replace each `as TransmissionRow` / `as TransmissionRow[]` cast with a generic prepare call:

```typescript
// Line 128: was .get(transmissionId) as TransmissionRow | undefined
this.db.prepare<[number], TransmissionRow>('...').get(transmissionId);

// Line 134: was .all(crewId) as TransmissionRow[]
this.db.prepare<[string], TransmissionRow>('...').all(crewId);

// Same pattern for lines 149, 194, 227
```

- [ ] **Step 3: Fix `protocol-service.ts` — all 7 DB query casts**

Same pattern — add generic type params to `prepare()` for lines 63, 67, 90, 110, 115, 117, 161.

- [ ] **Step 4: Fix `ships-log.ts` — 2 casts**

Lines 59, 65: `prepare<BindParams, ShipsLogRow>`.

- [ ] **Step 5: Fix `cargo-service.ts` — 4 casts**

Lines 84, 140, 165, 203: `prepare<BindParams, CargoRow>`.

- [ ] **Step 6: Fix `mission-service.ts` — 4 casts**

Lines 147, 169, 179, 189: `prepare<BindParams, MissionRow>`.

- [ ] **Step 7: Fix `crew-service.ts` — 1 cast**

Line 271: `prepare<BindParams, CrewRow>`.

- [ ] **Step 8: Fix `supply-route-service.ts` — 5 casts**

Lines 52, 70, 72, 78, 84: `prepare<BindParams, SupplyRouteRow>`.

- [ ] **Step 9: Fix `sector-service.ts` — 2 casts**

Lines 146, 152: `prepare<BindParams, SectorRow>`.

- [ ] **Step 10: Fix `sentinel.ts` — ~9 casts**

Lines 110, 131, 151, 327, 382, 453, 487, 585, 653. Most are `prepare<[], CrewRow>` or inline row types. Define named types for the inline ones at the top of the file.

- [ ] **Step 11: Fix `reconciliation.ts` — 1 cast**

Line 48: `prepare<[], CrewRow>`.

- [ ] **Step 12: Fix `hull.ts` — DB query cast on line 17**

Line 17: Define an inline type or named type for the dependency query result, use `prepare<[number], DependencyRow>`.

- [ ] **Step 13: Verify all starbase services compile**

Run: `npx tsc --noEmit -p tsconfig.node.json 2>&1 | head -40`
Expected: No errors in starbase/ files

- [ ] **Step 14: Run existing tests**

Run: `npx vitest run src/main/__tests__ --reporter=verbose 2>&1 | tail -20`
Expected: All tests pass

- [ ] **Step 15: Commit**

```bash
git add src/main/starbase/
git commit -m "refactor: use typed prepare<> for all database queries, remove as casts"
```

---

### Task 3: CodedError Helper

**Files:**
- Create: `src/main/errors.ts`
- Modify: `src/main/socket-server.ts`
- Modify: `src/main/starbase-runtime-core.ts`
- Modify: `src/main/starbase-runtime-process.ts`
- Modify: `src/main/starbase-runtime-client.ts`
- Modify: `src/main/ipc-handlers.ts`

- [ ] **Step 1: Create `src/main/errors.ts`**

```typescript
export class CodedError extends Error {
  constructor(
    message: string,
    public readonly code: string,
  ) {
    super(message);
    this.name = 'CodedError';
  }
}

/** Narrow an unknown catch value to an Error */
export function toError(value: unknown): Error {
  if (value instanceof Error) return value;
  return new Error(String(value));
}

/** Narrow an unknown catch value to an Error, preserving `code` if present */
export function toCodedError(value: unknown): CodedError {
  if (value instanceof CodedError) return value;
  if (value instanceof Error) {
    const code = 'code' in value && typeof value.code === 'string' ? value.code : 'UNKNOWN';
    const coded = new CodedError(value.message, code);
    coded.stack = value.stack;
    return coded;
  }
  return new CodedError(String(value), 'UNKNOWN');
}
```

- [ ] **Step 2: Fix `socket-server.ts` — replace ~56 error casts**

Replace all `new Error(...) as Error & { code: string }; err.code = '...'` patterns with:

```typescript
import { CodedError } from './errors';

// Before:
const err = new Error('message') as Error & { code: string };
err.code = 'BAD_REQUEST';
throw err;

// After:
throw new CodedError('message', 'BAD_REQUEST');
```

Also update the error response handler (around line 170-180) to check for `CodedError`:

```typescript
// In the catch block that builds ErrorResponse:
const coded = toCodedError(err);
return { id: req.id, ok: false, error: coded.message, code: coded.code };
```

- [ ] **Step 3: Fix `socket-server.ts` — replace parameter casts**

The `args as Parameters<Service['method']>[0]` and `args as string` casts need proper narrowing. For each command handler, add validation:

```typescript
// Before:
case 'sector.info': {
  const sectorId = (args.id ?? args.sectorId ?? args.name) as string | undefined;

// After:
case 'sector.info': {
  const raw = args.id ?? args.sectorId ?? args.name;
  const sectorId = typeof raw === 'string' ? raw : undefined;
```

For complex parameter types like `Parameters<SectorService['addSector']>[0]`, validate the required fields exist:

```typescript
// Before:
return sectorService.addSector(args as Parameters<SectorService['addSector']>[0]);

// After — args already has the right shape from the socket protocol, validate at boundary:
if (typeof args.path !== 'string') throw new CodedError('path required', 'BAD_REQUEST');
return sectorService.addSector({ ...args, path: args.path });
```

- [ ] **Step 4: Fix `ipc-handlers.ts` — 4 error casts**

Lines 478, 487, 503, 520: Replace `(err as Error).message` with `toError(err).message`:

```typescript
import { toError } from './errors';
// ...
} catch (err) {
  return { success: false, error: toError(err).message }
}
```

- [ ] **Step 5: Fix `starbase-runtime-process.ts` — 2 casts**

Line 31: `process as ProcessLike` — if `ProcessLike` is a subset of `typeof process`, use `satisfies` or refactor the type.
Line 117: `error as Error & { code?: string }` — use `toCodedError(error)`.

- [ ] **Step 6: Fix `starbase-runtime-client.ts` — 4 casts**

Line 163: `error as Error & { code?: string }` → `toCodedError(error)`
Line 214: `new Error(message.error) as Error & { code?: string }` → `new CodedError(message.error, message.code ?? 'UNKNOWN')`
Lines 247, 250: `message.data as RuntimeEnvelope` / `message as RuntimeEnvelope` → add type guard for `RuntimeEnvelope`

- [ ] **Step 7: Fix `starbase-runtime-core.ts` — error casts and `any`**

Line 251: `new Error(...) as Error & { code?: string }` → `new CodedError(...)`
Line 401: `error as Error` → `toError(error)`
Line 514: `(row: any)` → proper row type from the query

- [ ] **Step 8: Verify compilation**

Run: `npx tsc --noEmit -p tsconfig.node.json 2>&1 | head -40`
Expected: No errors

- [ ] **Step 9: Run tests**

Run: `npx vitest run src/main/__tests__ --reporter=verbose 2>&1 | tail -20`
Expected: All tests pass

- [ ] **Step 10: Commit**

```bash
git add src/main/errors.ts src/main/socket-server.ts src/main/starbase-runtime-core.ts \
  src/main/starbase-runtime-process.ts src/main/starbase-runtime-client.ts src/main/ipc-handlers.ts
git commit -m "refactor: replace error type casts with CodedError class and toError helper"
```

---

### Task 4: Typed Runtime Command Dispatch

**Files:**
- Modify: `src/main/starbase-runtime-core.ts`
- Modify: `src/main/starbase-runtime-socket-services.ts`

- [ ] **Step 1: Add typed command map to `starbase-runtime-core.ts`**

The `invoke(method: string, args?: unknown)` method has ~50 `as` casts to narrow `args`. Replace the switch statement with a typed dispatch map:

```typescript
type CommandMap = {
  'runtime.bootstrap': [RuntimeBootstrapArgs, void];
  'sector.get': [string, SectorRow | undefined];
  'sector.add': [Parameters<SectorService['addSector']>[0], SectorRow];
  'sector.remove': [string, void];
  'config.get': [string, unknown];
  'config.set': [{ key: string; value: unknown }, void];
  // ... etc for each command
};

// Then a single typed dispatch function:
private dispatch<K extends keyof CommandMap>(
  method: K,
  args: CommandMap[K][0]
): CommandMap[K][1] { ... }
```

However, since the public API is `invoke(method: string, args?: unknown)` (called from socket protocol), keep that signature but validate args at the boundary using the map types. The simplest approach: keep the switch but add type guards for each case instead of casts.

For simple primitives:
```typescript
case 'sector.get': {
  if (typeof args !== 'string') throw new CodedError('sector ID must be a string', 'BAD_REQUEST');
  return this.requireDeps().sectorService.getSector(args);
}
```

The cleanest approach: at the top of `invoke()`, separate raw args from object args using a type guard:

```typescript
function isRecord(v: unknown): v is Record<string, unknown> {
  return v != null && typeof v === 'object' && !Array.isArray(v);
}

async invoke(method: string, rawArgs?: unknown): Promise<unknown> {
  const args = isRecord(rawArgs) ? rawArgs : undefined;
```

Then for primitives use `rawArgs` with typeof narrowing:
```typescript
case 'sector.get': {
  if (typeof rawArgs !== 'string') throw new CodedError('...', 'BAD_REQUEST');
  return this.requireDeps().sectorService.getSector(rawArgs);
}
```

For object params, construct the parameter explicitly from validated fields:
```typescript
case 'sector.add': {
  if (!args || typeof args.path !== 'string') throw new CodedError('path required', 'BAD_REQUEST');
  return this.requireDeps().sectorService.addSector({
    path: args.path,
    label: typeof args.label === 'string' ? args.label : undefined,
  });
}
```

For commands with many optional fields where explicit construction is impractical, accept the service method parameters as `Record<string, unknown>` and let the service validate internally. This may require updating some service method signatures to accept `Record<string, unknown>` instead of specific types.

- [ ] **Step 2: Fix `starbase-runtime-socket-services.ts` — 9 proxy casts**

The proxy objects don't match `ServiceRegistry` because they return `Promise<unknown>` instead of the exact return types. Define an async version of the registry:

```typescript
// In socket-server.ts or a shared type file, add:
export type AsyncServiceRegistry = {
  [K in keyof ServiceRegistry]: {
    [M in keyof ServiceRegistry[K]]: ServiceRegistry[K][M] extends (...args: infer A) => infer R
      ? (...args: A) => Promise<Awaited<R>>
      : ServiceRegistry[K][M];
  };
};
```

Then change `createSocketRuntimeServices` return type to `AsyncServiceRegistry` and update the `SocketServer` / `dispatch` to accept `AsyncServiceRegistry` instead of `ServiceRegistry`.

Alternatively, if this creates too much churn, accept that the proxy pattern genuinely doesn't match the sync interface and create a `RemoteServiceRegistry` type that matches what the proxies actually return. The socket server's dispatch function should accept `ServiceRegistry | RemoteServiceRegistry`.

- [ ] **Step 3: Verify compilation**

Run: `npx tsc --noEmit -p tsconfig.node.json 2>&1 | head -40`

- [ ] **Step 4: Run tests**

Run: `npx vitest run src/main/__tests__ --reporter=verbose 2>&1 | tail -20`

- [ ] **Step 5: Commit**

```bash
git add src/main/starbase-runtime-core.ts src/main/starbase-runtime-socket-services.ts src/main/socket-server.ts
git commit -m "refactor: type-safe command dispatch, remove parameter and proxy casts"
```

---

### Task 5: Remaining Main Process Source Casts

**Files:**
- Modify: `src/main/index.ts`
- Modify: `src/main/pty-manager.ts`
- Modify: `src/main/jsonl-watcher.ts`
- Modify: `src/main/fleet-cli.ts`
- Modify: `src/main/shell-env.ts`
- Modify: `src/main/socket-command-handler.ts`
- Modify: `src/main/agent-state-tracker.ts`
- Modify: `src/main/install-fleet-cli.ts`
- Modify: `src/main/system-checker.ts`
- Modify: `src/main/starbase/hull.ts`
- Modify: `src/main/starbase/navigator.ts`
- Modify: `src/main/starbase/first-officer.ts`
- Modify: `src/main/starbase/admiral-process.ts`
- Modify: `src/main/starbase/workspace-templates.ts`
- Modify: `src/main/starbase/config-service.ts`
- Modify: `src/main/starbase/error-fingerprint.ts`
- Modify: `src/main/starbase/retention-service.ts`
- Modify: `src/main/starbase/available-memory.ts`

- [ ] **Step 1: Fix `process.env` casts (4 files)**

`process.env` is `Record<string, string | undefined>` but many places cast to `Record<string, string>`. Fix with a spread that filters:

```typescript
// Before:
env: process.env as Record<string, string>

// After — process.env already satisfies node-pty's env type (Record<string, string>):
// Check what the consumer actually needs. If it accepts string | undefined, remove cast.
// If it requires Record<string, string>, use:
env: Object.fromEntries(
  Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] != null)
)
```

Files: `pty-manager.ts:69`, `hull.ts:284`, `admiral-process.ts:170`, `navigator.ts:86`, `first-officer.ts:151`

If the consumer is `node-pty`'s `spawn()`, check its type — if it accepts `Record<string, string | undefined>` or `NodeJS.ProcessEnv`, just remove the cast.

- [ ] **Step 2: Fix JSON.parse casts (3 files)**

```typescript
// jsonl-watcher.ts:161 — JSON.parse(line) as JsonlRecord
// fleet-cli.ts:162 — JSON.parse(line) as CLIResponse
// hull.ts:328 — JSON.parse(line) as ClaudeStreamMessage
// first-officer.ts:420 — JSON.parse(extracted) as Record<string, unknown>

// Fix: Add type guards or validation functions for each type.
// For simple structures, a type predicate:
function isJsonlRecord(value: unknown): value is JsonlRecord {
  return value != null && typeof value === 'object' && 'type' in value;
}

const parsed: unknown = JSON.parse(line);
if (!isJsonlRecord(parsed)) continue; // or throw
```

- [ ] **Step 3: Fix `hull.ts` — Claude message narrowing (lines 450-462)**

The `msg as ClaudeInitMessage`, `msg as ClaudeAssistantMessage`, `msg as ClaudeResultMessage` casts after checking `msg.type` are actually narrowing a discriminated union — if the union is typed correctly, no cast is needed. Check if `ClaudeStreamMessage` is a discriminated union on `type`. If not, make it one.

- [ ] **Step 4: Fix `index.ts` — `handleStarbaseSnapshot(snapshot: any)`**

Line 88: Replace `: any` with the actual snapshot type. Check what data the function receives and type it.

Line 76: `process.platform as HostContextPayload['platform']` — if `HostContextPayload['platform']` is a union like `'darwin' | 'win32' | 'linux'`, this is narrowing from `NodeJS.Platform`. Add a runtime check or define the type to accept `NodeJS.Platform`.

- [ ] **Step 5: Fix `fleet-cli.ts` — remaining casts**

Lines 1176, 1188: `data as Record<string, unknown>[]` and `data as Record<string, unknown>`. Add type guards before these conversions.

- [ ] **Step 6: Fix `socket-command-handler.ts` — `as PaneSplit` (line 337)**

Check if the object literal satisfies `PaneSplit` structurally. Use `satisfies PaneSplit` instead.

- [ ] **Step 7: Fix `config-service.ts` — typed `get()` return**

`ConfigService.get()` returns `unknown` because it reads arbitrary JSON from the DB. Other files (like `retention-service.ts` and `sentinel.ts`) cast its result with `as number`, `as string`, etc. Fix by adding typed convenience methods:

```typescript
getNumber(key: string): number {
  const val = this.get(key);
  if (typeof val !== 'number') throw new Error(`Config '${key}' is not a number`);
  return val;
}

getString(key: string): string {
  const val = this.get(key);
  if (typeof val !== 'string') throw new Error(`Config '${key}' is not a string`);
  return val;
}
```

Then at call sites, replace `configService.get('key') as number` with `configService.getNumber('key')`.

Alternatively, keep `get()` returning `unknown` and add `typeof` narrowing at each call site. Choose whichever approach creates less code — if most callers expect numbers, typed convenience methods are cleaner.

- [ ] **Step 8: Fix remaining starbase files**

- `workspace-templates.ts` — check all casts, use typed prepare for DB queries, type guards for JSON.parse
- `error-fingerprint.ts` — check casts, likely JSON.parse or string narrowing
- `retention-service.ts` — DB query casts (use typed prepare), config value casts (fixed by Step 7)
- `available-memory.ts` — check casts

- [ ] **Step 9: Verify compilation**

Run: `npx tsc --noEmit -p tsconfig.node.json 2>&1 | head -40`

- [ ] **Step 10: Run tests**

Run: `npx vitest run src/main/__tests__ --reporter=verbose 2>&1 | tail -20`

- [ ] **Step 11: Commit**

```bash
git add src/main/ src/shared/
git commit -m "refactor: remove remaining as casts from main process source files"
```

---

### Task 6: Renderer + Preload Casts

**Files:**
- Modify: `src/renderer/src/App.tsx`
- Modify: `src/renderer/src/components/Sidebar.tsx`
- Modify: `src/renderer/src/components/PaneToolbar.tsx`
- Modify: `src/renderer/src/components/WorkspacePicker.tsx`
- Modify: `src/renderer/src/components/TerminalPane.tsx`
- Modify: `src/renderer/src/components/GitChangesModal.tsx`
- Modify: `src/renderer/src/components/QuickOpenOverlay.tsx`
- Modify: `src/renderer/src/components/SettingsModal.tsx`
- Modify: `src/renderer/src/components/StarCommandConfig.tsx`
- Modify: `src/renderer/src/components/StarCommandTab.tsx`
- Modify: `src/renderer/src/components/ImageViewerPane.tsx`
- Modify: `src/renderer/src/components/star-command/LogsPanel.tsx`
- Modify: `src/renderer/src/components/star-command/CommsPanel.tsx`
- Modify: `src/renderer/src/components/star-command/CrewPanel.tsx`
- Modify: `src/renderer/src/components/star-command/MissionsPanel.tsx`
- Modify: `src/renderer/src/components/star-command/MemoPanel.tsx`
- Modify: `src/renderer/src/components/star-command/Avatar.tsx`
- Modify: `src/renderer/src/components/star-command/AdmiralSidebar.tsx`
- Modify: `src/renderer/src/components/star-command/scene-utils.ts`
- Modify: `src/renderer/src/components/star-command/sc-sprite-atlas.ts`
- Modify: `src/renderer/src/components/star-command/sc-sprite-loader.ts`
- Modify: `src/renderer/src/components/visualizer/starfield.ts`
- Modify: `src/renderer/src/components/visualizer/SpaceCanvas.tsx`
- Modify: `src/renderer/src/components/visualizer/asteroids.ts`
- Modify: `src/renderer/src/components/visualizer/aurora.ts`
- Modify: `src/renderer/src/hooks/use-terminal.ts`
- Modify: `src/renderer/src/hooks/use-terminal-drop.ts`
- Modify: `src/renderer/src/hooks/use-notifications.ts`
- Modify: `src/preload/index.ts`

- [ ] **Step 1: Fix `WebkitAppRegion` CSS property casts (6 files)**

The `{ WebkitAppRegion: 'drag' } as React.CSSProperties` pattern exists in App.tsx, PaneToolbar.tsx, WorkspacePicker.tsx, Sidebar.tsx, StarCommandTab.tsx. Fix by extending the CSS type:

Check if `WebkitAppRegion` is already in `React.CSSProperties` in the installed `@types/react` version. If not, add a module augmentation in `src/renderer/src/env.d.ts`:

```typescript
declare module 'react' {
  interface CSSProperties {
    WebkitAppRegion?: 'drag' | 'no-drag';
  }
}
```

With the module augmentation, all `as React.CSSProperties` casts on WebkitAppRegion objects can be removed.

- [ ] **Step 2: Fix DOM element casts**

```typescript
// Sidebar.tsx:63 — (e.currentTarget as HTMLElement).getBoundingClientRect()
// currentTarget is already typed as HTMLElement on React mouse events — may not need cast.
// Check the event type. If it's React.MouseEvent<HTMLDivElement>, currentTarget is HTMLDivElement.

// QuickOpenOverlay.tsx:92 — listRef.current?.children[selectedIndex] as HTMLElement
// children[i] returns Element. Use: (el instanceof HTMLElement) guard.

// GitChangesModal.tsx:84 — e.target as HTMLElement
// Use type guard: if (e.target instanceof HTMLElement) { ... }

// TerminalPane.tsx:52 — (e as CustomEvent).detail
// Check the event listener type. If it's a custom event, type the listener properly.
```

- [ ] **Step 3: Fix IPC response casts in renderer components**

Multiple components cast `window.fleet.starbase.*` responses. The fix is to properly type the preload API bridge in `src/preload/index.ts` so that each method returns the correct type:

```typescript
// In preload/index.ts, ensure the starbase bridge methods have proper return types:
starbase: {
  memoList: (): Promise<MemoInfo[]> => ipcRenderer.invoke(IPC_CHANNELS.STARBASE_CMD, 'memo.list'),
  retentionStats: (): Promise<RetentionStats> => ipcRenderer.invoke(IPC_CHANNELS.STARBASE_CMD, 'retention.stats'),
  // etc.
}
```

Once the preload bridge returns typed results, the renderer casts disappear.

Check `src/preload/index.ts` for the full list of starbase bridge methods and add return types to each.

Files affected: `StarCommandConfig.tsx`, `CommsPanel.tsx`, `CrewPanel.tsx`, `MissionsPanel.tsx`, `MemoPanel.tsx`, `LogsPanel.tsx`, `StarCommandTab.tsx`

- [ ] **Step 4: Fix `scene-utils.ts` and `SpaceCanvas.tsx` — status casts**

`status as PodState['status']` — this is narrowing a string to a union. Use a type guard:

```typescript
function isValidStatus(s: string): s is PodState['status'] {
  return VALID_POD_STATUSES.has(s);
}
const status = isValidStatus(c.status) ? c.status : 'idle';
```

- [ ] **Step 5: Fix `SettingsModal.tsx` — `Object.keys` cast**

`Object.keys(NOTIFICATION_LABELS) as NotificationKey[]` — `Object.keys` returns `string[]`. Use a typed keys helper:

```typescript
const notificationKeys = Object.keys(NOTIFICATION_LABELS) as Array<keyof typeof NOTIFICATION_LABELS>;
// Or define a const array of keys separately
const NOTIFICATION_KEYS: NotificationKey[] = ['permission', 'error', 'info', 'subtle'];
```

Wait — this is still `as`. Better:
```typescript
// Define the keys array as the source of truth:
const NOTIFICATION_KEYS = ['permission', 'error', 'info', 'subtle'] as const;
// as const is allowed! Then:
{NOTIFICATION_KEYS.map((key) => ( ... ))}
```

- [ ] **Step 6: Fix `starfield.ts` — OffscreenCanvas cast**

Line 238: `getContext('2d') as OffscreenCanvasRenderingContext2D` — `getContext('2d')` returns `OffscreenCanvasRenderingContext2D | null`. Add null check:

```typescript
const offCtx = this.farCache.getContext('2d');
if (!offCtx) return;
```

- [ ] **Step 7: Fix `preload/index.ts` — platform cast**

Line 92: `process.platform as HostContextPayload['platform']` — same fix as Task 5 Step 4.

- [ ] **Step 8: Fix remaining renderer casts**

Go through each remaining file and apply the appropriate pattern (type guard, typed API, null check, etc.).

- [ ] **Step 9: Verify compilation**

Run: `npx tsc --noEmit -p tsconfig.web.json 2>&1 | head -40`

- [ ] **Step 10: Run full test suite**

Run: `npx vitest run --reporter=verbose 2>&1 | tail -20`

- [ ] **Step 11: Commit**

```bash
git add src/renderer/ src/preload/
git commit -m "refactor: remove all as casts from renderer and preload source files"
```

---

### Task 7: Scripts

**Files:**
- Modify: `scripts/generate-image.ts`
- Modify: `scripts/assemble-sprites.ts`
- Modify: `scripts/assemble-star-command-sprites.ts`
- Modify: `scripts/remove-background.ts`

- [ ] **Step 1: Fix `generate-image.ts` — 2 casts**

Lines 81, 108: `response.json() as Promise<GenerateResponse>` — `fetch().json()` returns `Promise<unknown>`. Add a type guard or validate:

```typescript
const data: unknown = await response.json();
// Add validation or assert structure
```

- [ ] **Step 2: Fix `assemble-sprites.ts` and `assemble-star-command-sprites.ts`**

Check and fix any remaining casts.

- [ ] **Step 3: Verify scripts compile**

Run: `npx tsc --noEmit -p tsconfig.node.json 2>&1 | head -20`

- [ ] **Step 4: Commit**

```bash
git add scripts/
git commit -m "refactor: remove as casts from build scripts"
```

---

### Task 8: Test File `any` Cleanup

**Files:**
- Modify: `src/main/__tests__/hull.test.ts`
- Modify: `src/main/__tests__/sentinel-socket.test.ts`
- Modify: `src/main/__tests__/first-officer.test.ts`

Note: `as` casts in test files are allowed. Only `any` types need fixing.

- [ ] **Step 1: Fix `hull.test.ts` — 4 `any` annotations**

```typescript
// Line 12: let mockProc: any → use a partial type
let mockProc: EventEmitter & { stdin: { write: ReturnType<typeof vi.fn> }; kill: ReturnType<typeof vi.fn> } | null = null;

// Line 17: (..._args: any[]) → (..._args: unknown[])
spawn: vi.fn((..._args: unknown[]) => mockProc),

// Line 602: (c: any) => c.type → type the callback parameter
// Line 603: (c: any) => c.verified → type the callback parameter
// These map over cargo rows — type as the CargoRow or { type: string; verified: number }
```

- [ ] **Step 2: Fix `sentinel-socket.test.ts` — no `any` annotations (only `as any` casts, which are allowed)**

Verify — if there are `: any` annotations, fix them.

- [ ] **Step 3: Fix `first-officer.test.ts` — no `any` annotations**

Verify — if there are `: any` annotations, fix them.

- [ ] **Step 4: Run tests**

Run: `npx vitest run src/main/__tests__ --reporter=verbose 2>&1 | tail -20`

- [ ] **Step 5: Commit**

```bash
git add src/main/__tests__/
git commit -m "refactor: remove any types from test files"
```

---

### Task 9: Final Verification

- [ ] **Step 1: Run full ESLint check**

Run: `npx eslint . 2>&1 | tail -30`
Expected: No `no-unsafe-type-assertion` or `no-explicit-any` errors

- [ ] **Step 2: Run full TypeScript check**

Run: `npx tsc --noEmit -p tsconfig.node.json && npx tsc --noEmit -p tsconfig.web.json`
Expected: No errors

- [ ] **Step 3: Run full test suite**

Run: `npx vitest run --reporter=verbose 2>&1 | tail -30`
Expected: All tests pass

- [ ] **Step 4: Final commit if any stragglers**

```bash
git add -A
git status  # verify only expected files
git commit -m "chore: final strict typescript cleanup"
```
