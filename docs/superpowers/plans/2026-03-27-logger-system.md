# Logger System Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace raw `console.*` calls in the main process with a structured Winston logger that supports level filtering (DEBUG in dev, INFO in prod) and daily-rotated file output.

**Architecture:** A single `src/main/logger.ts` module exports a root Winston instance and a `createLogger(tag)` factory for child loggers. Console transport uses a colorized `[tag] level: message` format; file transport writes JSON to `~/.fleet/logs/fleet-YYYY-MM-DD.log` with 7-day retention.

**Tech Stack:** Winston, winston-daily-rotate-file, Electron `app.isPackaged` for environment detection.

**Note on entry points:** The electron-vite config has three entry points: `index.ts` (main), `fleet-cli.ts`, and `starbase-runtime-process.ts`. The runtime process runs as a child/utility process without access to Electron's `app` module — it already has its own `trace()` function writing to `/tmp/fleet-starbase-runtime.log`. **Do not migrate `starbase-runtime-process.ts`** — it stays as-is.

---

### Task 1: Install Dependencies

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Install winston and winston-daily-rotate-file**

```bash
npm install winston winston-daily-rotate-file
```

- [ ] **Step 2: Verify installation**

```bash
node -e "require('winston'); require('winston-daily-rotate-file'); console.log('OK')"
```

Expected: `OK`

- [ ] **Step 3: Commit**

```bash
git add package.json package-lock.json
git commit -m "feat(logger): add winston and winston-daily-rotate-file dependencies"
```

---

### Task 2: Create Logger Module with Tests

**Files:**
- Create: `src/main/logger.ts`
- Create: `src/main/__tests__/logger.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// src/main/__tests__/logger.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock electron app before importing logger
vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getPath: (name: string) => {
      if (name === 'home') return '/tmp/fleet-logger-test';
      return '/tmp';
    }
  }
}));

// Mock winston-daily-rotate-file to avoid real file I/O in tests
vi.mock('winston-daily-rotate-file', () => {
  const Transport = vi.fn();
  Transport.prototype.on = vi.fn();
  return { default: Transport };
});

describe('logger', () => {
  beforeEach(() => {
    vi.resetModules();
    delete process.env.LOG_LEVEL;
  });

  it('exports createLogger function', async () => {
    const mod = await import('../logger');
    expect(typeof mod.createLogger).toBe('function');
  });

  it('exports root logger instance', async () => {
    const mod = await import('../logger');
    expect(mod.logger).toBeDefined();
    expect(typeof mod.logger.info).toBe('function');
    expect(typeof mod.logger.debug).toBe('function');
    expect(typeof mod.logger.warn).toBe('function');
    expect(typeof mod.logger.error).toBe('function');
  });

  it('createLogger returns a child logger with tag metadata', async () => {
    const mod = await import('../logger');
    const log = mod.createLogger('test-module');
    expect(log).toBeDefined();
    expect(typeof log.info).toBe('function');
    expect(typeof log.debug).toBe('function');
  });

  it('defaults to debug level when app is not packaged', async () => {
    const mod = await import('../logger');
    expect(mod.logger.level).toBe('debug');
  });

  it('respects LOG_LEVEL env var override', async () => {
    process.env.LOG_LEVEL = 'warn';
    const mod = await import('../logger');
    expect(mod.logger.level).toBe('warn');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run src/main/__tests__/logger.test.ts
```

Expected: FAIL — `../logger` module not found.

- [ ] **Step 3: Write the logger module**

```ts
// src/main/logger.ts
import { app } from 'electron';
import { join } from 'node:path';
import winston from 'winston';
import DailyRotateFile from 'winston-daily-rotate-file';

const isDev = !app.isPackaged;
const level = process.env.LOG_LEVEL ?? (isDev ? 'debug' : 'info');

const consoleFormat = winston.format.combine(
  winston.format.timestamp({ format: 'HH:mm:ss.SSS' }),
  winston.format.printf(({ timestamp, level: lvl, message, tag, ...meta }) => {
    const prefix = tag ? `[${tag}]` : '';
    const metaStr = Object.keys(meta).length > 0 ? ` ${JSON.stringify(meta)}` : '';
    return `${timestamp} ${prefix} ${lvl}: ${message}${metaStr}`;
  })
);

const fileFormat = winston.format.combine(winston.format.timestamp(), winston.format.json());

const logDir = join(app.getPath('home'), '.fleet', 'logs');

const transports: winston.transport[] = [
  new winston.transports.Console({
    format: isDev
      ? winston.format.combine(winston.format.colorize({ all: true }), consoleFormat)
      : consoleFormat
  }),
  new DailyRotateFile({
    dirname: logDir,
    filename: 'fleet-%DATE%.log',
    datePattern: 'YYYY-MM-DD',
    maxFiles: '7d',
    format: fileFormat
  })
];

export const logger = winston.createLogger({
  level,
  transports
});

export function createLogger(tag: string): winston.Logger {
  return logger.child({ tag });
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npx vitest run src/main/__tests__/logger.test.ts
```

Expected: All 5 tests PASS.

- [ ] **Step 5: Verify typecheck passes**

```bash
npm run typecheck:node
```

- [ ] **Step 6: Commit**

```bash
git add src/main/logger.ts src/main/__tests__/logger.test.ts
git commit -m "feat(logger): add Winston logger module with child logger factory"
```

---

### Task 3: Migrate `src/main/index.ts`

This is the largest file with ~25 console calls spanning multiple tags (`fleet-main`, `starbase`, `renderer`, `socket-supervisor`, `admiral`, `auto-updater`).

**Files:**
- Modify: `src/main/index.ts`

- [ ] **Step 1: Add logger import and create child loggers at the top of the file**

After the existing imports, add:

```ts
import { createLogger } from './logger';

const log = createLogger('fleet-main');
const starbaseLog = createLogger('starbase');
const updaterLog = createLogger('auto-updater');
```

- [ ] **Step 2: Replace all console.* calls**

Apply these replacements throughout the file:

| Line | Before | After |
|------|--------|-------|
| 70 | `console.log('[fleet-main] startup marker...')` | `log.info('startup marker runtime=spawn-ipc preload=out/preload/index.js')` |
| 202 | `console.log(\`[renderer] ${event.message}\`)` | `log.info(event.message, { source: 'renderer' })` |
| 210 | `console.error(\`[renderer] Failed to load...\`)` | `log.error('failed to load', { source: 'renderer', errorCode, errorDescription })` |
| 248 | `console.log('[debug DOM]', r)` | `log.debug('DOM debug', { result: r })` |
| 250 | `console.log('[debug err]', e)` | `log.debug('DOM debug error', { error: e })` |
| 298 | `console.error('[child-process-gone]', details)` | `log.error('child process gone', { details })` |
| 323 | `console.error('[fleet-cli] Failed to install...')` | `log.error('failed to install CLI binary', { error: err })` |
| 373 | `console.log('[starbase] bootstrap: got admiral...')` | `starbaseLog.info('bootstrap: got admiral bootstrap data', { ... })` |
| 387 | `console.log('[starbase] bootstrap: admiral process...')` | `starbaseLog.info('bootstrap: admiral process created')` |
| 411 | `console.log('[starbase] bootstrap: socket supervisor...')` | `starbaseLog.info('bootstrap: socket supervisor created', { socketPath: SOCKET_PATH })` |
| 440 | `console.error('[socket-supervisor] Failed to start...')` | `starbaseLog.error('socket supervisor failed to start', { error: err })` |
| 446 | `console.log('[starbase] bootstrap: socket supervisor start...')` | `starbaseLog.info('bootstrap: socket supervisor start requested')` |
| 451 | `console.log('[starbase] bootstrap: runtime client...')` | `starbaseLog.info('bootstrap: runtime client bound to command handler')` |
| 457 | `console.log('[starbase] bootstrap: unread comms...')` | `starbaseLog.info('bootstrap: unread comms fetched', { lastUnreadCommsCount })` |
| 471 | `console.log('[starbase] bootstrap: unread memos...')` | `starbaseLog.info('bootstrap: unread memos fetched', { lastUnreadMemosCount })` |
| 478 | `console.log('[starbase] bootstrap: ensured star...')` | `starbaseLog.info('bootstrap: ensured star command tab')` |
| 484 | `console.log('[starbase] bootstrap: initial snapshot...')` | `starbaseLog.info('bootstrap: initial snapshot handled')` |
| 488 | `console.log('[starbase] bootstrap: ready')` | `starbaseLog.info('bootstrap: ready')` |
| 494 | `console.error('[starbase] Failed to initialize...')` | `starbaseLog.error('failed to initialize Star Command database', { error: err })` |
| 576 | `console.error('[admiral] Failed to start...')` | `starbaseLog.error('admiral failed to start', { error: err })` |
| 794 | `console.log('[auto-updater] status:...')` | `updaterLog.info('status', { state: status.state })` |
| 903 | `console.error('Auto-update check failed:...')` | `updaterLog.error('auto-update check failed', { error: err })` |
| 917 | `console.error('[socket-supervisor] stop error:...')` | `starbaseLog.error('socket supervisor stop error', { error: err })` |

- [ ] **Step 3: Remove any `// eslint-disable-next-line no-console` comments that precede migrated lines**

- [ ] **Step 4: Run typecheck and lint**

```bash
npm run typecheck:node && npm run lint
```

- [ ] **Step 5: Commit**

```bash
git add src/main/index.ts
git commit -m "refactor(logger): migrate src/main/index.ts from console.* to Winston"
```

---

### Task 4: Migrate `src/main/pty-manager.ts` and `src/main/ipc-handlers.ts`

**Files:**
- Modify: `src/main/pty-manager.ts`
- Modify: `src/main/ipc-handlers.ts`

- [ ] **Step 1: Migrate pty-manager.ts**

Add at the top after existing imports:

```ts
import { createLogger } from './logger';
const log = createLogger('pty');
```

Replace console calls:
- Line 49-51: `console.log(\`[pty] ${opts.paneId} already exists...\`)` → `log.debug('already exists, returning existing', { paneId: opts.paneId, pid: existing.process.pid })`
- Line 69-71: `console.log(\`[pty] shell="${shell}"...\`)` → `log.debug('spawning', { shell, cwd: opts.cwd, path: process.env.PATH?.substring(0, 80) })`
- Line 195: `console.warn(...)` → `log.warn(...)` with structured metadata

Remove associated `// eslint-disable-next-line no-console` comments.

- [ ] **Step 2: Migrate ipc-handlers.ts**

Add at the top after existing imports:

```ts
import { createLogger } from './logger';
const log = createLogger('ipc');
```

Replace console calls:
- Line 152: `console.log(\`[pty-gc] killed ${killed.length}...\`)` → `log.info('killed orphaned PTYs', { count: killed.length, paneIds: killed })`
- Line 166: `console.error('[layout-save] Failed...')` → `log.error('failed to save workspace', { error: err })`

Remove associated `// eslint-disable-next-line no-console` comments.

- [ ] **Step 3: Run typecheck and lint**

```bash
npm run typecheck:node && npm run lint
```

- [ ] **Step 4: Commit**

```bash
git add src/main/pty-manager.ts src/main/ipc-handlers.ts
git commit -m "refactor(logger): migrate pty-manager and ipc-handlers to Winston"
```

---

### Task 5: Migrate `src/main/socket-supervisor.ts` and `src/main/starbase-runtime-client.ts`

**Files:**
- Modify: `src/main/socket-supervisor.ts`
- Modify: `src/main/starbase-runtime-client.ts`

- [ ] **Step 1: Migrate socket-supervisor.ts**

Add at the top after existing imports:

```ts
import { createLogger } from './logger';
const log = createLogger('socket-supervisor');
```

Replace all console calls (8 total):
- Line 48: `console.error('[socket-supervisor] Max restarts...')` → `log.error('max restarts exceeded in 5-minute window, giving up')`
- Line 62: `console.error('[socket-supervisor] Error stopping...')` → `log.error('error stopping server during restart', { error: err })`
- Line 72: `console.log('[socket-supervisor] Server restarted...')` → `log.info('server restarted successfully')`
- Line 75: `console.error('[socket-supervisor] Restart failed...')` → `log.error('restart failed', { error: err })`
- Line 94: `console.error('[socket-supervisor] Server error...')` → `log.error('server error detected', { error: err.message })`
- Line 95: inline `.catch` → `.catch((e) => log.error('auto-restart failed', { error: e }))`
- Line 100: `console.warn('[socket-supervisor] Server closed...')` → `log.warn('server closed unexpectedly')`
- Line 101: inline `.catch` → `.catch((e) => log.error('auto-restart failed', { error: e }))`

Remove `// eslint-disable-next-line no-console` comments.

- [ ] **Step 2: Migrate starbase-runtime-client.ts**

Add at the top after existing imports:

```ts
import { createLogger } from './logger';
const log = createLogger('starbase-runtime');
```

Replace all console calls (13 total):
- Line 77: `console.log(\`[starbase-runtime] spawned...\`)` → `log.info('spawned', { pid: child.pid ?? 'unknown' })`
- Line 85: `console.log(\`[starbase-runtime:stdout]...\`)` → `log.debug('child stdout', { text })`
- Line 92: `console.error(\`[starbase-runtime:stderr]...\`)` → `log.warn('child stderr', { text })`
- Line 97: `console.error('[starbase-runtime] child process error...')` → `log.error('child process error', { error })`
- Line 104: `console.log('[starbase-runtime] parent received message...')` → `log.debug('parent received message', { ... })`
- Line 118: `console.error('[starbase-runtime] exited...')` → `log.error('exited', { code })`
- Line 162: `console.log('[starbase-runtime] parent sending request...')` → `log.debug('parent sending request', { id, method })`
- Line 173: `console.error('[starbase-runtime] send failed...')` → `log.error('send failed', { id, method, error })`
- Line 205: `console.warn('[starbase-runtime] parent received empty...')` → `log.warn('parent received empty message')`
- Line 212: `console.log('[starbase-runtime] parent handling event...')` → `log.debug('parent handling event', { event: message.event })`
- Line 223: `console.warn('[starbase-runtime] parent received response...')` → `log.warn('parent received response with no pending request', { id: message.id })`
- Line 233: `console.log('[starbase-runtime] parent resolved request...')` → `log.debug('parent resolved request', { id: message.id })`
- Line 240: `console.error('[starbase-runtime] parent rejected request...')` → `log.error('parent rejected request', { id: message.id, error: message.error })`

- [ ] **Step 3: Run typecheck and lint**

```bash
npm run typecheck:node && npm run lint
```

- [ ] **Step 4: Commit**

```bash
git add src/main/socket-supervisor.ts src/main/starbase-runtime-client.ts
git commit -m "refactor(logger): migrate socket-supervisor and starbase-runtime-client to Winston"
```

---

### Task 6: Migrate `src/main/shell-env.ts` and `src/main/install-fleet-cli.ts`

**Files:**
- Modify: `src/main/shell-env.ts`
- Modify: `src/main/install-fleet-cli.ts`

- [ ] **Step 1: Migrate shell-env.ts**

Add at the top after existing imports:

```ts
import { createLogger } from './logger';
const log = createLogger('shell-env');
```

Replace console calls (3 total):
- Line 34: `console.log(\`[shell-env] Resolved PATH...\`)` → `log.debug('resolved PATH', { path: process.env.PATH?.substring(0, 120) })`
- Line 36: `console.warn('[shell-env] Failed to resolve...')` → `log.warn('failed to resolve shell env, falling back to path probing', { error: err })`
- Line 102: `console.log(\`[shell-env] Fallback PATH...\`)` → `log.debug('fallback PATH', { path: process.env.PATH?.substring(0, 120) })`

- [ ] **Step 2: Migrate install-fleet-cli.ts**

Add at the top after existing imports:

```ts
import { createLogger } from './logger';
const log = createLogger('fleet-cli');
```

Replace console calls (3 total):
- Line 150: `console.warn('[fleet-cli] Could not update...')` → `log.warn('could not update shell profile', { error: err })`
- Line 154: `console.log(\`[fleet-cli] Installed fleet CLI...\`)` → `log.info('installed fleet CLI', { path: wrapperPath })`
- Line 197: `console.log(\`[fleet-cli] Added ~/.fleet/bin...\`)` → `log.info('added ~/.fleet/bin to shell profile', { profilePath })`

- [ ] **Step 3: Run typecheck and lint**

```bash
npm run typecheck:node && npm run lint
```

- [ ] **Step 4: Commit**

```bash
git add src/main/shell-env.ts src/main/install-fleet-cli.ts
git commit -m "refactor(logger): migrate shell-env and install-fleet-cli to Winston"
```

---

### Task 7: Migrate Starbase Modules (`src/main/starbase/`)

**Files:**
- Modify: `src/main/starbase/sentinel.ts`
- Modify: `src/main/starbase/hull.ts`
- Modify: `src/main/starbase/first-officer.ts`
- Modify: `src/main/starbase/navigator.ts`
- Modify: `src/main/starbase/reconciliation.ts`
- Modify: `src/main/starbase/worktree-manager.ts`

**Do NOT modify** `src/main/starbase/workspace-templates.ts` — its `console.log` reference is inside a string template (prompt text), not actual logging.

- [ ] **Step 1: Migrate sentinel.ts**

Add at the top after existing imports:

```ts
import { createLogger } from '../logger';
const log = createLogger('sentinel');
```

Replace all console calls (10 total). Pattern: strip `[sentinel]` prefix, use structured metadata for errors. Examples:
- `console.error('[sentinel] Sweep failed:', err)` → `log.error('sweep failed', { error: err })`
- `console.warn(\`[sentinel] Socket ping failed...\`)` → `log.warn('socket ping failed', { failures: this.consecutivePingFailures })`
- `console.error(\`[sentinel] Guidance dispatch error for crew ${row.crew_id}:\`, err)` → `log.error('guidance dispatch error', { crewId: row.crew_id, error: err })`
- `console.error(\`[sentinel] FO dispatch error for mission ${row.mid}:\`, err)` → `log.error('FO dispatch error', { missionId: row.mid, error: err })`
- `console.error(\`[sentinel] Review crew deploy failed...\`)` → `log.error('review crew deploy failed', { missionId: mission.id, error: err })`
- `console.error(\`[sentinel] Fix crew deploy failed...\`)` → `log.error('fix crew deploy failed', { missionId: mission.id, error: err })`
- `console.error(\`[sentinel] prMonitorSweep error...\`)` → `log.error('prMonitorSweep error', { missionId: mission.id, error: err })`
- Remaining calls follow the same pattern.

- [ ] **Step 2: Migrate hull.ts**

Add at the top after existing imports:

```ts
import { createLogger } from '../logger';
const log = createLogger('hull');
```

Replace all console calls (9 total, skip the string template on line 350). Pattern:
- `console.error(\`[hull:${crewId}] stderr:\`, ...)` → `log.warn('crew stderr', { crewId, text: chunk.toString().trim() })`
- `console.error('[hull] cleanup error:', ...)` → `log.error('cleanup error', { error: ... })`
- `console.error(\`[hull:${crewId}] cargo file write failed:\`, ...)` → `log.error('cargo file write failed', { crewId, error: fileErr })`
- `console.error(\`[hull] Failed to remove worktree: ${worktreePath}\`)` → `log.error('failed to remove worktree', { worktreePath })`
- Remaining `console.error('[hull] ...')` calls follow the same pattern.

- [ ] **Step 3: Migrate first-officer.ts**

Add at the top after existing imports:

```ts
import { createLogger } from '../logger';
const log = createLogger('first-officer');
```

Replace console calls (2 total):
- `console.error(\`[first-officer:${event.crewId}] stderr:\`, ...)` → `log.warn('crew stderr', { crewId: event.crewId, text: chunk.toString().trim() })`
- `console.warn(\`[first-officer] Timeout for ${k}, killing\`)` → `log.warn('timeout, killing', { key: k })`

- [ ] **Step 4: Migrate navigator.ts**

Add at the top after existing imports:

```ts
import { createLogger } from '../logger';
const log = createLogger('navigator');
```

Replace console calls (2 total):
- `console.error(\`[navigator:${event.executionId}] stderr:\`, ...)` → `log.warn('stderr', { executionId: event.executionId, text: chunk.toString().trim() })`
- `console.warn(\`[navigator] Timeout for ${event.executionId}, killing\`)` → `log.warn('timeout, killing', { executionId: event.executionId })`

- [ ] **Step 5: Migrate reconciliation.ts**

Add at the top after existing imports:

```ts
import { createLogger } from '../logger';
const log = createLogger('reconciliation');
```

Replace console calls (2 total):
- `console.error(\`[reconciliation] Failed to remove orphaned worktree: ${fullPath}\`)` → `log.error('failed to remove orphaned worktree', { path: fullPath })`
- `console.error(...)` (line 225) → `log.error(...)` with structured metadata

- [ ] **Step 6: Migrate worktree-manager.ts**

Add at the top after existing imports:

```ts
import { createLogger } from '../logger';
const log = createLogger('worktree');
```

Replace console calls (2 total):
- `console.error(\`[worktree] Failed to remove worktree: ${worktreePath}\`)` → `log.error('failed to remove worktree', { path: worktreePath })`
- `console.error(\`[worktree] Failed to prune worktrees for: ${sectorPath}\`)` → `log.error('failed to prune worktrees', { sectorPath })`

- [ ] **Step 7: Run typecheck and lint**

```bash
npm run typecheck:node && npm run lint
```

- [ ] **Step 8: Commit**

```bash
git add src/main/starbase/sentinel.ts src/main/starbase/hull.ts src/main/starbase/first-officer.ts src/main/starbase/navigator.ts src/main/starbase/reconciliation.ts src/main/starbase/worktree-manager.ts
git commit -m "refactor(logger): migrate starbase modules to Winston"
```

---

### Task 8: Final Verification

**Files:** None (verification only)

- [ ] **Step 1: Run full typecheck**

```bash
npm run typecheck
```

Expected: No errors.

- [ ] **Step 2: Run lint**

```bash
npm run lint
```

Expected: No errors. There should be fewer `no-console` eslint-disable comments now.

- [ ] **Step 3: Run tests**

```bash
npm run test
```

Expected: All tests pass, including the new logger tests.

- [ ] **Step 4: Run build**

```bash
npm run build
```

Expected: Build succeeds. Winston is bundled into the main process output.

- [ ] **Step 5: Verify no remaining console.* in migrated files**

Search for any straggling `console.` calls in migrated files (excluding `starbase-runtime-process.ts` and string templates):

```bash
grep -rn 'console\.\(log\|warn\|error\|debug\)' src/main/*.ts src/main/starbase/*.ts --include='*.ts' | grep -v 'starbase-runtime-process' | grep -v 'workspace-templates'
```

Expected: No output (all migrated).

- [ ] **Step 6: Smoke test in dev mode**

```bash
npm run dev
```

Verify:
- Colorized log output appears in terminal with `[tag] level: message` format
- Log file is created at `~/.fleet/logs/fleet-YYYY-MM-DD.log`
- Log file contains JSON-formatted entries

- [ ] **Step 7: Commit any final fixes (if needed)**
