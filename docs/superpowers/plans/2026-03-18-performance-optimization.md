# Performance Optimization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Eliminate CPU-heavy polling, unbounded memory growth, and blocking startup ops to keep Fleet running smoothly with 5–15 concurrent agents.

**Architecture:** Six targeted pillars: replace subprocess-based CWD detection with a native syscall, replace dual-polling JSONL watcher with chokidar, batch PTY IPC output into 16ms frames, drive status updates via events instead of timers, cap renderer memory, and unblock app startup.

**Tech Stack:** Electron, Node.js, TypeScript, xterm.js, node-pty, better-sqlite3, chokidar v4, pid-cwd, React, Vitest

**Spec:** `docs/superpowers/specs/2026-03-18-performance-optimization-design.md`

---

## Pre-flight notes

- Run all tests with: `npm test`
- Run a single test file: `npx vitest run src/main/__tests__/foo.test.ts`
- Main process code lives in `src/main/`, renderer in `src/renderer/src/`
- **WAL mode is already enabled** in `starbase/db.ts:44-46` — Pillar 4's WAL sub-task is a no-op, skip it
- `StarCommandTab.tsx` already listens to `STARBASE_STATUS_UPDATE` via `window.fleet.starbase.onStatusUpdate` — Pillar 4 just removes the `setInterval` fallback

---

## Task 1: Install Dependencies

**Files:**

- Modify: `package.json`

- [ ] **Step 1: Install pid-cwd and chokidar**

```bash
npm install pid-cwd chokidar
```

- [ ] **Step 2: Verify install**

```bash
node -e "require('pid-cwd'); require('chokidar'); console.log('ok')"
```

Expected: `ok`

- [ ] **Step 3: Commit**

```bash
git add package.json package-lock.json
git commit -m "chore: add pid-cwd and chokidar dependencies"
```

---

## Task 2: Pillar 1 — Replace lsof with pid-cwd

**Files:**

- Modify: `src/main/cwd-poller.ts`
- Modify: `src/main/ipc-handlers.ts`

### Context

`CwdPoller.readProcCwd()` currently spawns `execFile('lsof', ...)` every 5s per pane on macOS — ~3 subprocesses/second with 15 panes. `pid-cwd` calls `proc_pidinfo` directly with no subprocess. Also: `cwdPoller.stopPolling()` is never called when a PTY exits, leaving zombie timers.

- [ ] **Step 1: Write the failing test for pid-cwd integration**

Create `src/main/__tests__/cwd-poller.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('pid-cwd', () => ({
  default: vi.fn().mockResolvedValue('/tmp/test-cwd')
}));

vi.mock('child_process', () => ({
  execFile: vi.fn()
}));

import { CwdPoller } from '../cwd-poller';
import { EventBus } from '../event-bus';
import type { PtyManager } from '../pty-manager';
import pidCwd from 'pid-cwd';
import { execFile } from 'child_process';

function makeMockPtyManager(cwd = '/old-cwd'): PtyManager {
  return {
    getCwd: vi.fn().mockReturnValue(cwd),
    updateCwd: vi.fn(),
    getPid: vi.fn().mockReturnValue(999),
    paneIds: vi.fn().mockReturnValue([]),
    has: vi.fn().mockReturnValue(true)
  } as unknown as PtyManager;
}

describe('CwdPoller', () => {
  let eventBus: EventBus;
  let poller: CwdPoller;

  beforeEach(() => {
    vi.useFakeTimers();
    eventBus = new EventBus();
  });

  afterEach(() => {
    poller?.stopAll();
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it('uses pid-cwd instead of lsof on macOS', async () => {
    const ptyManager = makeMockPtyManager('/old-cwd');
    poller = new CwdPoller(eventBus, ptyManager);
    poller.startPolling('pane-1', 999);

    await vi.advanceTimersByTimeAsync(5001);

    expect(pidCwd).toHaveBeenCalledWith(999);
    expect(execFile).not.toHaveBeenCalled();
  });

  it('emits cwd-changed when cwd differs', async () => {
    const ptyManager = makeMockPtyManager('/old-cwd');
    poller = new CwdPoller(eventBus, ptyManager);

    const changes: string[] = [];
    eventBus.on('cwd-changed', (e) => changes.push(e.cwd));

    poller.startPolling('pane-1', 999);
    await vi.advanceTimersByTimeAsync(5001);

    expect(changes).toContain('/tmp/test-cwd');
  });

  it('stopPolling clears the timer', async () => {
    const ptyManager = makeMockPtyManager('/old-cwd');
    poller = new CwdPoller(eventBus, ptyManager);

    poller.startPolling('pane-1', 999);
    poller.stopPolling('pane-1');

    await vi.advanceTimersByTimeAsync(10000);

    expect(pidCwd).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to confirm it fails**

```bash
npx vitest run src/main/__tests__/cwd-poller.test.ts
```

Expected: FAIL (pid-cwd not used yet)

- [ ] **Step 3: Update cwd-poller.ts — replace execFile('lsof') with pidCwd**

In `src/main/cwd-poller.ts`, replace the `readProcCwd` function:

```typescript
import { readlink } from 'fs/promises';
import pidCwd from 'pid-cwd';
import { EventBus } from './event-bus';
import type { PtyManager } from './pty-manager';

const POLL_INTERVAL_MS = 5000;

export class CwdPoller {
  private timers = new Map<string, ReturnType<typeof setInterval>>();
  private osc7Seen = new Set<string>();

  constructor(
    private eventBus: EventBus,
    private ptyManager: PtyManager
  ) {}

  startPolling(paneId: string, pid: number): void {
    if (this.timers.has(paneId)) return;

    const timer = setInterval(async () => {
      if (this.osc7Seen.has(paneId)) {
        this.stopPolling(paneId);
        return;
      }
      const cwd = await readProcCwd(pid);
      if (cwd) {
        const current = this.ptyManager.getCwd(paneId);
        if (cwd !== current) {
          this.eventBus.emit('cwd-changed', { type: 'cwd-changed', paneId, cwd });
        }
      }
    }, POLL_INTERVAL_MS);

    this.timers.set(paneId, timer);
  }

  markOsc7Seen(paneId: string): void {
    this.osc7Seen.add(paneId);
  }

  stopPolling(paneId: string): void {
    const timer = this.timers.get(paneId);
    if (timer) {
      clearInterval(timer);
      this.timers.delete(paneId);
    }
    this.osc7Seen.delete(paneId);
  }

  stopAll(): void {
    for (const paneId of this.timers.keys()) {
      clearInterval(this.timers.get(paneId)!);
    }
    this.timers.clear();
    this.osc7Seen.clear();
  }
}

async function readProcCwd(pid: number): Promise<string | null> {
  if (process.platform === 'linux') {
    try {
      return await readlink(`/proc/${pid}/cwd`);
    } catch {
      return null;
    }
  }

  if (process.platform === 'darwin') {
    try {
      return await pidCwd(pid);
    } catch {
      return null;
    }
  }

  return null;
}
```

- [ ] **Step 4: Fix zombie poller — add stopPolling to PTY exit handler in ipc-handlers.ts**

Find the PTY exit handler in `src/main/ipc-handlers.ts`. It looks something like:

```typescript
ptyManager.onExit(paneId, (exitCode) => {
  // ... existing code ...
});
```

Add `cwdPoller.stopPolling(paneId)` inside the exit callback:

```typescript
ptyManager.onExit(paneId, (exitCode) => {
  cwdPoller.stopPolling(paneId); // ADD THIS LINE
  // ... rest of existing code ...
});
```

- [ ] **Step 5: Run tests**

```bash
npx vitest run src/main/__tests__/cwd-poller.test.ts
```

Expected: all PASS

- [ ] **Step 6: Run full test suite**

```bash
npm test
```

Expected: all existing tests still PASS

- [ ] **Step 7: Commit**

```bash
git add src/main/cwd-poller.ts src/main/ipc-handlers.ts src/main/__tests__/cwd-poller.test.ts
git commit -m "perf: replace lsof subprocess with pid-cwd native syscall; fix zombie poller on PTY exit"
```

---

## Task 3: Pillar 2 — Replace JsonlWatcher with chokidar

**Files:**

- Modify: `src/main/jsonl-watcher.ts` (full rewrite)
- Existing tests: `src/main/__tests__/jsonl-watcher.test.ts` (must still pass — public interface unchanged)

### Context

`JsonlWatcher` runs both `watchFile` (1s poll per file) AND a 1s `setInterval` that re-reads all files — double the work. `fs.watch` on macOS also misses events. The `watchedFiles` Map never evicts deleted files. Chokidar uses FSEvents natively, zero polling at idle, and fires `unlink` for cleanup.

- [ ] **Step 1: Run existing tests to confirm they pass before the rewrite**

```bash
npx vitest run src/main/__tests__/jsonl-watcher.test.ts
```

Expected: all PASS (this is our baseline)

- [ ] **Step 2: Rewrite jsonl-watcher.ts**

Replace the entire file:

```typescript
import chokidar, { type FSWatcher } from 'chokidar';
import { openSync, readSync, closeSync, statSync, existsSync } from 'fs';
import { extname, basename } from 'path';

export type JsonlRecord = {
  type: string;
  message?: {
    content?: Array<{
      type: string;
      name?: string;
      input?: unknown;
    }>;
  };
  data?: {
    type?: string;
    parentToolUseID?: string;
  };
  [key: string]: unknown;
};

type RecordCallback = (sessionId: string, record: JsonlRecord) => void;

type WatchedFile = {
  filePath: string;
  offset: number;
  lineBuffer: string;
};

export class JsonlWatcher {
  private watcher: FSWatcher | null = null;
  private callbacks: RecordCallback[] = [];
  private watchedFiles = new Map<string, WatchedFile>();
  private isReady = false;

  constructor(private watchDir: string) {}

  onRecord(callback: RecordCallback): void {
    this.callbacks.push(callback);
  }

  start(): void {
    if (!existsSync(this.watchDir)) return;

    this.watcher = chokidar.watch(this.watchDir, {
      persistent: false,
      ignoreInitial: false,
      depth: 2,
      awaitWriteFinish: { stabilityThreshold: 50, pollInterval: 10 }
    });

    this.watcher.on('add', (filePath: string) => {
      if (extname(filePath) !== '.jsonl') return;
      if (this.watchedFiles.has(filePath)) return;
      try {
        const stat = statSync(filePath);
        // Files seen before 'ready' are pre-existing: skip to end (no ghost agents)
        // Files seen after 'ready' are new sessions: read from beginning
        const offset = this.isReady ? 0 : stat.size;
        this.watchedFiles.set(filePath, { filePath, offset, lineBuffer: '' });
        // If new file (after ready), read any content already there
        if (this.isReady) {
          const watched = this.watchedFiles.get(filePath)!;
          this.readNewLines(watched);
        }
      } catch {}
    });

    this.watcher.on('ready', () => {
      this.isReady = true;
    });

    this.watcher.on('change', (filePath: string) => {
      if (extname(filePath) !== '.jsonl') return;
      const watched = this.watchedFiles.get(filePath);
      if (watched) this.readNewLines(watched);
    });

    this.watcher.on('unlink', (filePath: string) => {
      this.watchedFiles.delete(filePath);
    });
  }

  stop(): void {
    this.watcher?.close();
    this.watcher = null;
    this.watchedFiles.clear();
    this.isReady = false;
  }

  private readNewLines(watched: WatchedFile): void {
    try {
      const stat = statSync(watched.filePath);
      if (stat.size <= watched.offset) return;

      const bytesToRead = stat.size - watched.offset;
      const buf = Buffer.alloc(bytesToRead);
      const fd = openSync(watched.filePath, 'r');
      readSync(fd, buf, 0, bytesToRead, watched.offset);
      closeSync(fd);
      watched.offset = stat.size;

      const text = watched.lineBuffer + buf.toString('utf-8');
      const lines = text.split('\n');
      watched.lineBuffer = lines.pop() || '';

      const sessionId = basename(watched.filePath, '.jsonl');

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const record = JSON.parse(line) as JsonlRecord;
          for (const cb of this.callbacks) {
            cb(sessionId, record);
          }
        } catch {
          // Skip malformed lines
        }
      }
    } catch {}
  }
}
```

- [ ] **Step 3: Run existing tests**

```bash
npx vitest run src/main/__tests__/jsonl-watcher.test.ts
```

Expected: all PASS. The tests use real temp dirs and `setTimeout` waits — chokidar's FSEvents will fire faster than the old 1s poll, so tests should pass or be faster.

Note: if tests time out, chokidar's `awaitWriteFinish` delay (50ms) may need `WAIT` constant in test reduced from 1500ms to 300ms.

- [ ] **Step 4: Add a test for unlink GC**

Append to `src/main/__tests__/jsonl-watcher.test.ts`:

```typescript
import { unlinkSync } from 'fs';

it('removes deleted files from watchedFiles (no memory leak)', async () => {
  const callback = vi.fn();
  watcher = new JsonlWatcher(dir);
  watcher.onRecord(callback);
  watcher.start();

  await new Promise((r) => setTimeout(r, 200));

  const filePath = join(projectDir, 'session-gc.jsonl');
  writeFileSync(filePath, JSON.stringify({ type: 'user' }) + '\n');
  await new Promise((r) => setTimeout(r, 500));

  // File is watched — now delete it
  unlinkSync(filePath);
  await new Promise((r) => setTimeout(r, 500));

  // Writing a new file with same name should be treated as new (offset = 0)
  writeFileSync(filePath, JSON.stringify({ type: 'assistant' }) + '\n');
  await new Promise((r) => setTimeout(r, 500));

  // Should have received the new record
  expect(callback).toHaveBeenCalledWith(
    'session-gc',
    expect.objectContaining({ type: 'assistant' })
  );
});
```

- [ ] **Step 5: Run all jsonl tests**

```bash
npx vitest run src/main/__tests__/jsonl-watcher.test.ts
```

Expected: all PASS

- [ ] **Step 6: Run full test suite**

```bash
npm test
```

Expected: all PASS

- [ ] **Step 7: Commit**

```bash
git add src/main/jsonl-watcher.ts src/main/__tests__/jsonl-watcher.test.ts
git commit -m "perf: replace JsonlWatcher polling with chokidar FSEvents; fix deleted-file memory leak"
```

---

## Task 4: Pillar 3 — PTY IPC Batching + Backpressure

**Files:**

- Modify: `src/main/pty-manager.ts`
- Modify: `src/main/__tests__/pty-manager.test.ts`
- Modify: `src/main/ipc-handlers.ts`
- Modify: `src/preload/index.ts`
- Modify: `src/renderer/src/hooks/use-terminal.ts`

### Context

Every `pty.onData` fires an immediate IPC send — hundreds/second during tool use. We coalesce output into 16ms windows with a shared flush timer. Add `pty.pause()`/`resume()` for backpressure at 256KB. Fix listener cleanup (currently `onData`/`onExit` disposables are never stored or disposed).

- [ ] **Step 1: Update the node-pty mock to return disposables**

In `src/main/__tests__/pty-manager.test.ts`, update the mock at the top:

```typescript
vi.mock('node-pty', () => ({
  spawn: vi.fn(() => ({
    pid: 12345,
    onData: vi.fn().mockReturnValue({ dispose: vi.fn() }),
    onExit: vi.fn().mockReturnValue({ dispose: vi.fn() }),
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(),
    pause: vi.fn(),
    resume: vi.fn()
  }))
}));
```

- [ ] **Step 2: Write failing tests for batching and disposable cleanup**

Append to `src/main/__tests__/pty-manager.test.ts`:

```typescript
import * as ptyModule from 'node-pty';

describe('PtyManager batching and cleanup', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    manager = new PtyManager();
  });

  afterEach(() => {
    manager.killAll();
    vi.useRealTimers();
  });

  it('batches onData output and flushes after 16ms', async () => {
    manager.create({ paneId: 'pane-1', cwd: '/tmp', shell: '/bin/zsh' });

    const received: string[] = [];
    manager.onData('pane-1', (data) => received.push(data));

    // Simulate PTY emitting data — call the onData callback registered on the mock PTY
    const mockPty = (ptyModule.spawn as ReturnType<typeof vi.fn>).mock.results[0].value;
    const ptyDataCallback = mockPty.onData.mock.calls[0][0];

    ptyDataCallback('hello ');
    ptyDataCallback('world');

    // Not flushed yet
    expect(received).toHaveLength(0);

    // After 16ms flush
    vi.advanceTimersByTime(16);
    expect(received).toHaveLength(1);
    expect(received[0]).toBe('hello world');
  });

  it('disposes data listener when pane is killed', () => {
    manager.create({ paneId: 'pane-1', cwd: '/tmp', shell: '/bin/zsh' });
    const mockPty = (ptyModule.spawn as ReturnType<typeof vi.fn>).mock.results[0].value;
    const disposable = mockPty.onData.mock.results[0].value;

    manager.onData('pane-1', vi.fn());
    manager.kill('pane-1');

    expect(disposable.dispose).toHaveBeenCalled();
  });

  it('calls pty.pause when buffer exceeds 256KB', () => {
    manager.create({ paneId: 'pane-1', cwd: '/tmp', shell: '/bin/zsh' });
    manager.onData('pane-1', vi.fn());

    const mockPty = (ptyModule.spawn as ReturnType<typeof vi.fn>).mock.results[0].value;
    const ptyDataCallback = mockPty.onData.mock.calls[0][0];

    // Send >256KB of data
    ptyDataCallback('x'.repeat(257 * 1024));

    expect(mockPty.pause).toHaveBeenCalled();
  });

  it('resume calls pty.resume', () => {
    manager.create({ paneId: 'pane-1', cwd: '/tmp', shell: '/bin/zsh' });
    const mockPty = (ptyModule.spawn as ReturnType<typeof vi.fn>).mock.results[0].value;

    manager.resume('pane-1');

    expect(mockPty.resume).toHaveBeenCalled();
  });
});
```

- [ ] **Step 3: Run tests to confirm they fail**

```bash
npx vitest run src/main/__tests__/pty-manager.test.ts
```

Expected: new tests FAIL (no batching yet)

- [ ] **Step 4: Rewrite pty-manager.ts with batching**

Replace `src/main/pty-manager.ts`:

```typescript
import * as pty from 'node-pty';
import { getDefaultShell } from './shell-detection';

export type PtyCreateOptions = {
  paneId: string;
  cwd: string;
  shell?: string;
  cmd?: string;
  cols?: number;
  rows?: number;
  env?: Record<string, string>;
};

export type PtyCreateResult = {
  paneId: string;
  pid: number;
};

type PtyEntry = {
  process: pty.IPty;
  paneId: string;
  cwd: string;
  outputBuffer: string;
  dataDisposable: pty.IDisposable | null;
  exitDisposable: pty.IDisposable | null;
};

const FLUSH_INTERVAL_MS = 16;
const BUFFER_OVERFLOW_BYTES = 256 * 1024;

export class PtyManager {
  private ptys = new Map<string, PtyEntry>();
  private protectedPtys = new Set<string>();
  private dataCallbacks = new Map<string, (data: string) => void>();
  private flushTimer: ReturnType<typeof setInterval> | null = null;

  create(opts: PtyCreateOptions): PtyCreateResult {
    if (this.ptys.has(opts.paneId)) {
      throw new Error(`${opts.paneId} already exists`);
    }

    const shell = opts.shell ?? getDefaultShell();
    const args: string[] = [];

    if (opts.cmd) {
      args.push('-c', `${opts.cmd}; exec ${shell}`);
    }

    console.log(
      `[pty] shell="${shell}" cwd="${opts.cwd}" PATH="${process.env.PATH?.substring(0, 80)}"`
    );
    const proc = pty.spawn(shell, args, {
      name: 'xterm-256color',
      cols: opts.cols ?? 80,
      rows: opts.rows ?? 24,
      cwd: opts.cwd,
      env: opts.env ?? (process.env as Record<string, string>)
    });

    this.ptys.set(opts.paneId, {
      process: proc,
      paneId: opts.paneId,
      cwd: opts.cwd,
      outputBuffer: '',
      dataDisposable: null,
      exitDisposable: null
    });

    return { paneId: opts.paneId, pid: proc.pid };
  }

  write(paneId: string, data: string): void {
    const entry = this.ptys.get(paneId);
    if (entry) {
      entry.process.write(data);
    }
  }

  resize(paneId: string, cols: number, rows: number): void {
    const entry = this.ptys.get(paneId);
    if (entry) {
      entry.process.resize(cols, rows);
    }
  }

  protect(paneId: string): void {
    this.protectedPtys.add(paneId);
  }

  kill(paneId: string): void {
    const entry = this.ptys.get(paneId);
    if (entry) {
      entry.dataDisposable?.dispose();
      entry.exitDisposable?.dispose();
      this.dataCallbacks.delete(paneId);
      entry.process.kill();
      this.ptys.delete(paneId);
      this.protectedPtys.delete(paneId);
    }
  }

  killAll(): void {
    for (const [paneId] of this.ptys) {
      this.kill(paneId);
    }
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
  }

  has(paneId: string): boolean {
    return this.ptys.has(paneId);
  }

  get(paneId: string): PtyEntry | undefined {
    return this.ptys.get(paneId);
  }

  paneIds(): string[] {
    return Array.from(this.ptys.keys());
  }

  getCwd(paneId: string): string | undefined {
    return this.ptys.get(paneId)?.cwd;
  }

  updateCwd(paneId: string, cwd: string): void {
    const entry = this.ptys.get(paneId);
    if (entry) entry.cwd = cwd;
  }

  getPid(paneId: string): number | undefined {
    return this.ptys.get(paneId)?.process.pid;
  }

  gc(activePaneIds: Set<string>): string[] {
    const killed: string[] = [];
    for (const paneId of this.ptys.keys()) {
      if (!activePaneIds.has(paneId) && !this.protectedPtys.has(paneId)) {
        this.kill(paneId);
        killed.push(paneId);
      }
    }
    return killed;
  }

  /** Register a callback that receives batched PTY output every ~16ms. */
  onData(paneId: string, callback: (data: string) => void): void {
    const entry = this.ptys.get(paneId);
    if (!entry) return;

    this.dataCallbacks.set(paneId, callback);

    entry.dataDisposable = entry.process.onData((data: string) => {
      entry.outputBuffer += data;
      if (entry.outputBuffer.length > BUFFER_OVERFLOW_BYTES) {
        this.flushPane(paneId);
        entry.process.pause();
      }
    });

    // Start shared flush timer if not already running
    if (!this.flushTimer) {
      this.flushTimer = setInterval(() => this.flushAll(), FLUSH_INTERVAL_MS);
    }
  }

  /** Resume a paused PTY (called by renderer after consuming a batch). */
  resume(paneId: string): void {
    const entry = this.ptys.get(paneId);
    if (entry) entry.process.resume();
  }

  onExit(paneId: string, callback: (exitCode: number) => void): void {
    const entry = this.ptys.get(paneId);
    if (entry) {
      entry.exitDisposable = entry.process.onExit(({ exitCode }) => {
        this.dataCallbacks.delete(paneId);
        this.ptys.delete(paneId);
        this.protectedPtys.delete(paneId);
        callback(exitCode);
      });
    }
  }

  private flushPane(paneId: string): void {
    const entry = this.ptys.get(paneId);
    if (!entry || !entry.outputBuffer) return;
    const callback = this.dataCallbacks.get(paneId);
    if (callback) {
      callback(entry.outputBuffer);
      entry.outputBuffer = '';
    }
  }

  private flushAll(): void {
    for (const paneId of this.ptys.keys()) {
      this.flushPane(paneId);
    }
  }
}
```

- [ ] **Step 5: Run pty-manager tests**

```bash
npx vitest run src/main/__tests__/pty-manager.test.ts
```

Expected: all PASS

- [ ] **Step 6: Add PTY_DRAIN IPC handler in ipc-handlers.ts**

Find the IPC handler registration in `src/main/ipc-handlers.ts`. Add after the existing PTY handlers:

```typescript
// PTY drain — renderer signals it has consumed a batch; resume the PTY
ipcMain.on(IPC_CHANNELS.PTY_DRAIN, (_event, { paneId }: { paneId: string }) => {
  ptyManager.resume(paneId);
});
```

Also add `PTY_DRAIN` to `src/shared/constants.ts` IPC_CHANNELS:

```typescript
PTY_DRAIN: 'fleet:pty-drain',
```

- [ ] **Step 7: Expose ptyDrain in preload**

In `src/preload/index.ts`, find the `contextBridge.exposeInMainWorld('fleet', ...)` call and add:

```typescript
ptyDrain: (paneId: string) => ipcRenderer.send(IPC_CHANNELS.PTY_DRAIN, { paneId }),
```

- [ ] **Step 8: Call ptyDrain in use-terminal.ts after xterm write**

In `src/renderer/src/hooks/use-terminal.ts`, find where PTY_DATA IPC events are received and xterm writes data. After the `term.write(data)` call, add the drain signal:

```typescript
// After term.write(data, ...) — signal main process the batch was consumed
window.fleet.ptyDrain(options.paneId);
```

The PTY_DATA handler in `use-terminal.ts` looks something like:

```typescript
ipcRenderer.on(IPC_CHANNELS.PTY_DATA, (_event, { paneId, data }) => {
  if (paneId !== options.paneId) return;
  term.write(data, () => {
    window.fleet.ptyDrain(options.paneId); // ADD THIS
  });
});
```

The xterm `write()` callback fires after the data has been rendered to the terminal — this is the right point to signal drain.

- [ ] **Step 9: Run full test suite**

```bash
npm test
```

Expected: all PASS

- [ ] **Step 10: Commit**

```bash
git add src/main/pty-manager.ts src/main/__tests__/pty-manager.test.ts \
        src/main/ipc-handlers.ts src/preload/index.ts \
        src/renderer/src/hooks/use-terminal.ts src/shared/constants.ts
git commit -m "perf: batch PTY output into 16ms frames; add pause/resume backpressure; fix listener disposable cleanup"
```

---

## Task 5: Pillar 4 — Event-Driven Status Updates

**Files:**

- Modify: `src/main/event-bus.ts`
- Modify: `src/main/starbase/crew-service.ts`
- Modify: `src/main/starbase/mission-service.ts`
- Modify: `src/main/starbase/sector-service.ts`
- Modify: `src/main/starbase/comms-service.ts`
- Modify: `src/main/starbase/sentinel.ts`
- Modify: `src/main/index.ts`
- Modify: `src/renderer/src/components/StarCommandTab.tsx`

### Context

Two `setInterval` timers push full DB reads every 5s unconditionally. WAL mode is already enabled. The fix: add `starbase-changed` to EventBus, emit it from every write path, push snapshot only on change. Also: `execSync('du')` in Sentinel blocks the main thread — make it async.

- [ ] **Step 1: Add starbase-changed to EventBus**

In `src/main/event-bus.ts`, add to the `FleetEvent` union:

```typescript
| { type: 'starbase-changed' }
```

The full union should include all existing types plus the new one.

- [ ] **Step 2: Write a complete test for eventBus emission**

Create `src/main/__tests__/starbase-events.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MissionService } from '../starbase/mission-service';
import { SectorService } from '../starbase/sector-service';
import { StarbaseDB } from '../starbase/db';
import type { EventBus } from '../event-bus';
import { rmSync, mkdirSync, writeFileSync } from 'fs';
import { execSync } from 'child_process';
import { join } from 'path';
import { tmpdir } from 'os';

const TEST_DIR = join(tmpdir(), 'fleet-test-starbase-events');

let db: StarbaseDB;
let sectorId: string;

beforeEach(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
  const wsDir = join(TEST_DIR, 'workspace');
  const sectorDir = join(wsDir, 'api');
  mkdirSync(sectorDir, { recursive: true });
  writeFileSync(join(sectorDir, 'index.ts'), '');
  execSync('git init && git checkout -b main', { cwd: sectorDir });
  writeFileSync(join(sectorDir, 'README.md'), '# Test');
  execSync('git add -A && git commit -m "initial"', { cwd: sectorDir });

  const dbDir = join(TEST_DIR, 'starbases');
  db = new StarbaseDB(wsDir, dbDir);
  db.open();

  const sectorSvc = new SectorService(db.getDb(), wsDir);
  const sector = sectorSvc.addSector({ path: 'api' });
  sectorId = sector.id;
});

afterEach(() => {
  db.close();
  rmSync(TEST_DIR, { recursive: true, force: true });
});

describe('starbase-changed event emission', () => {
  it('MissionService.addMission emits starbase-changed', () => {
    const mockEventBus = { emit: vi.fn(), on: vi.fn(), off: vi.fn() } as unknown as EventBus;
    const missionSvc = new MissionService(db.getDb(), mockEventBus);

    missionSvc.addMission({
      sectorId,
      summary: 'test mission',
      prompt: 'do the thing'
    });

    expect(mockEventBus.emit).toHaveBeenCalledWith('starbase-changed', {
      type: 'starbase-changed'
    });
  });

  it('MissionService without eventBus does not throw', () => {
    const missionSvc = new MissionService(db.getDb());
    expect(() =>
      missionSvc.addMission({ sectorId, summary: 'test', prompt: 'test' })
    ).not.toThrow();
  });
});
```

This test proves the pattern end-to-end. The identical mock pattern (`{ emit: vi.fn(), on: vi.fn(), off: vi.fn() }`) applies to all other services.

- [ ] **Step 3: Run test to confirm it fails**

```bash
npx vitest run src/main/__tests__/starbase-events.test.ts
```

Expected: FAIL (MissionService doesn't accept eventBus yet)

- [ ] **Step 4: Add optional eventBus to each service**

**crew-service.ts** — add `eventBus` to `CrewServiceDeps`:

```typescript
import type { EventBus } from '../event-bus';

type CrewServiceDeps = {
  db: Database.Database;
  starbaseId: string;
  sectorService: SectorService;
  missionService: MissionService;
  configService: ConfigService;
  worktreeManager: WorktreeManager;
  eventBus?: EventBus; // ADD
};
```

Then emit after write methods. Example for the deploy/spawn method (find the method that creates a crew row):

```typescript
// After the DB insert/update:
this.deps.eventBus?.emit('starbase-changed', { type: 'starbase-changed' });
```

Add `this.deps.eventBus?.emit('starbase-changed', { type: 'starbase-changed' })` after writes in: `deployCrew` (or `spawnCrew`), `updateCrewStatus`, `deleteCrew` (or equivalent retire/dismiss methods).

**mission-service.ts** — add optional eventBus as second constructor param:

```typescript
import type { EventBus } from '../event-bus'

export class MissionService {
  constructor(
    private db: Database.Database,
    private eventBus?: EventBus,
  ) {}
```

Emit after `addMission`, `updateMission`, and any completion/status-change methods.

**sector-service.ts** — `SectorService` already takes `(db, workspaceRoot)`, so add `eventBus` as a third optional parameter:

```typescript
import type { EventBus } from '../event-bus'

export class SectorService {
  constructor(
    private db: Database.Database,
    private workspaceRoot: string,
    private eventBus?: EventBus,
  ) {}
```

Emit after `addSector`, `updateSector`, `removeSector`.

**comms-service.ts** — same pattern:

```typescript
import type { EventBus } from '../event-bus'

export class CommsService {
  constructor(
    private db: Database.Database,
    private eventBus?: EventBus,
  ) {}
```

Emit after `send` (the method that inserts a transmission row).

- [ ] **Step 5: Add eventBus to SentinelDeps and emit after comms reset**

In `src/main/starbase/sentinel.ts`:

Add to `SentinelDeps`:

```typescript
import type { EventBus } from '../event-bus';

type SentinelDeps = {
  db: Database.Database;
  configService: ConfigService;
  eventBus?: EventBus; // ADD
};
```

In `runSweep()`, at line ~144 where the comms rate-limit reset happens:

```typescript
// 7. Comms rate limit reset (every 6th sweep = ~60 seconds)
if (this.sweepCount % 6 === 0) {
  db.prepare('UPDATE crew SET comms_count_minute = 0').run();
  this.deps.eventBus?.emit('starbase-changed', { type: 'starbase-changed' }); // ADD
}
```

- [ ] **Step 6: Make getDiskUsage async**

In `src/main/starbase/sentinel.ts`, find `getDiskUsage()`. Replace the `execSync('du -sk ...')` call:

```typescript
import { execFile } from 'child_process'
import { promisify } from 'util'

const execFileAsync = promisify(execFile)

// Replace the synchronous block in getDiskUsage() with:
private async getDiskUsage(): Promise<number | null> {
  const now = Date.now()
  if (this.diskCacheBytes !== null && now - this.diskCacheTime < 60_000) {
    return this.diskCacheBytes
  }

  try {
    const homePath = process.env.HOME ?? '~'
    const worktreePath = `${homePath}/.fleet/worktrees`
    if (!existsSync(worktreePath)) return 0

    const { stdout } = await execFileAsync('du', ['-sk', worktreePath], { timeout: 10_000 })
    const match = stdout.match(/^(\d+)/)
    if (!match) return null

    const kb = parseInt(match[1], 10)
    this.diskCacheBytes = kb * 1024
    this.diskCacheTime = now
    return this.diskCacheBytes
  } catch {
    return null
  }
}
```

Update `runSweep()` to `await getDiskUsage()` since the method is now async.

- [ ] **Step 7: Update index.ts — pass eventBus to all services, add starbase-changed listener, remove 5s setInterval**

In `src/main/index.ts`:

**a)** Pass `eventBus` when constructing each service. Find each construction call:

```typescript
// Change:
missionService = new MissionService(starbaseDb.getDb());
// To:
missionService = new MissionService(starbaseDb.getDb(), eventBus);

// Change:
sectorService = new SectorService(starbaseDb.getDb(), workspacePath);
// To:
sectorService = new SectorService(starbaseDb.getDb(), workspacePath, eventBus);

// Change (add eventBus to crewService deps):
crewService = new CrewService({
  db: starbaseDb.getDb(),
  starbaseId: starbaseDb.getStarbaseId(),
  sectorService,
  missionService,
  configService,
  worktreeManager,
  eventBus // ADD
});

// Change (add eventBus to sentinel deps):
sentinel = new Sentinel({ db: starbaseDb.getDb(), configService, eventBus });
```

Note: `CommsService` and `SectorService` constructors need checking — the `SectorService` constructor currently takes `(db, workspacePath)`, so add `eventBus` as a third parameter.

**b)** Add event-driven status push listener. Find the block where the 5s setInterval is defined (around line 307):

```typescript
// REMOVE this entire block:
// setInterval(() => {
//   const w = mainWindow
//   if (!w || w.isDestroyed()) return
//   w.webContents.send(IPC_CHANNELS.STARBASE_STATUS_UPDATE, {
//     crew: crewService!.listCrew(),
//     ...
//   })
// }, 5000)

// REPLACE with:
eventBus.on('starbase-changed', () => {
  const w = mainWindow;
  if (!w || w.isDestroyed()) return;
  w.webContents.send(IPC_CHANNELS.STARBASE_STATUS_UPDATE, {
    crew: crewService!.listCrew(),
    missions: missionService!.listMissions(),
    sectors: sectorService!.listSectors(),
    unreadCount: commsService!.getUnread('admiral').length
  });
});
```

- [ ] **Step 8: Remove setInterval from StarCommandTab.tsx**

In `src/renderer/src/components/StarCommandTab.tsx`, find lines 107-111:

```typescript
// CHANGE from:
useEffect(() => {
  refreshStatus();
  const interval = setInterval(refreshStatus, 5000);
  return () => clearInterval(interval);
}, [refreshStatus]);

// TO (keep initial fetch, remove polling):
useEffect(() => {
  refreshStatus();
}, [refreshStatus]);
```

The `onStatusUpdate` listener (already present at line 83-98) handles ongoing updates.

- [ ] **Step 9: Run tests**

```bash
npm test
```

Expected: all PASS. If service tests fail due to missing `eventBus` in test deps, add `eventBus: undefined` (optional) to the test construction calls.

- [ ] **Step 10: Commit**

```bash
git add src/main/event-bus.ts \
        src/main/starbase/crew-service.ts \
        src/main/starbase/mission-service.ts \
        src/main/starbase/sector-service.ts \
        src/main/starbase/comms-service.ts \
        src/main/starbase/sentinel.ts \
        src/main/index.ts \
        src/renderer/src/components/StarCommandTab.tsx
git commit -m "perf: replace 5s status polling with event-driven push; make sentinel du async"
```

---

## Task 6: Pillar 5 — Memory Fixes

**Files:**

- Modify: `src/renderer/src/hooks/use-terminal.ts`
- Modify: `src/main/agent-state-tracker.ts`
- Modify: `src/main/__tests__/agent-state-tracker.test.ts`
- Modify: `src/renderer/src/components/star-command/StationHub.tsx`
- Modify: `src/renderer/src/components/StarCommandTab.tsx`
- Modify: `src/renderer/src/components/TerminalPane.tsx` (or wherever git isRepo is called)

### Context

Four independent fixes: reduce xterm scrollback from 10,000→3,000 lines; cap sub-agent Map at 100 entries; pause StationHub RAF when tab not visible; debounce git status check on CWD change.

- [ ] **Step 1: Reduce xterm scrollback**

In `src/renderer/src/hooks/use-terminal.ts`, find the Terminal constructor and change `scrollback`:

```typescript
// Change:
scrollback: 10000,
// To:
scrollback: 3000,
```

No test needed — this is a config value change.

- [ ] **Step 2: Write failing test for sub-agent cap**

In `src/main/__tests__/agent-state-tracker.test.ts`, append:

```typescript
it('caps sub-agents at 100 per agent, evicting the oldest', () => {
  const eventBus = new EventBus();
  const tracker = new AgentStateTracker(eventBus);

  eventBus.emit('pane-created', { type: 'pane-created', paneId: 'pane-1' });

  // Feed 150 sub-agent progress records
  for (let i = 0; i < 150; i++) {
    tracker.handleJsonlRecord('pane-1', {
      type: 'progress',
      data: {
        type: 'agent_progress',
        parentToolUseID: `sub-${i}`
      },
      message: {
        content: [{ type: 'tool_use', name: 'Read' }]
      }
    });
  }

  const state = tracker.getState('pane-1');
  expect(state?.subAgents.length).toBeLessThanOrEqual(100);
});
```

- [ ] **Step 3: Run test to confirm it fails**

```bash
npx vitest run src/main/__tests__/agent-state-tracker.test.ts
```

Expected: FAIL (sub-agents exceed 100)

- [ ] **Step 4: Add eviction to AgentStateTracker**

In `src/main/agent-state-tracker.ts`, find the `handleJsonlRecord` method where sub-agents are added. After adding a new sub-agent entry to `agent.subAgents`, add eviction:

```typescript
// After: agent.subAgents.set(subId, { ... })
// Add:
if (agent.subAgents.size > 100) {
  // Evict the entry with the oldest lastActivity
  let oldestId = '';
  let oldestTime = Infinity;
  for (const [id, sub] of agent.subAgents) {
    if (sub.lastActivity < oldestTime) {
      oldestTime = sub.lastActivity;
      oldestId = id;
    }
  }
  if (oldestId) agent.subAgents.delete(oldestId);
}
```

- [ ] **Step 5: Run agent-state-tracker tests**

```bash
npx vitest run src/main/__tests__/agent-state-tracker.test.ts
```

Expected: all PASS

- [ ] **Step 6: Add isActive prop to StarCommandScene**

Note: `StationHub.tsx` is not rendered anywhere — the RAF animation lives entirely in `StarCommandScene.tsx`. That file already handles `visibilitychange` and window `blur`/`focus` events, but has no tab-level awareness (it keeps running when the user switches to a terminal tab in Fleet). The fix: add an `isActive: boolean` prop to stop/restart the RAF when the Star Command tab is not visible.

In `src/renderer/src/components/star-command/StarCommandScene.tsx`:

**a)** Change the function signature:

```typescript
export function StarCommandScene({ className, isActive = true }: { className?: string; isActive?: boolean }) {
```

**b)** Add a `useEffect` that stops/restarts the RAF based on `isActive`. The existing RAF state is controlled by the `stopped` variable inside the setup `useEffect`. Add a separate effect after the existing one:

```typescript
// Pause/resume RAF when tab-level visibility changes
useEffect(() => {
  // Access stopped/rafRef via a shared ref — add stoppedRef alongside rafRef at the top of the component:
  // const stoppedRef = useRef(false)
  // Then in the frame function use stoppedRef.current instead of the local `stopped` variable
  // See implementation note below
}, [isActive]);
```

**Implementation note:** The current `stopped` variable is local to the setup `useEffect` closure — it can't be accessed from a separate `useEffect`. The refactor is:

1. Add `const stoppedRef = useRef(false)` alongside `rafRef` at the component top level
2. In the setup `useEffect`, replace all `stopped` reads/writes with `stoppedRef.current`
3. Add a new `useEffect` for `isActive`:

```typescript
useEffect(() => {
  if (!isActive) {
    stoppedRef.current = true;
    cancelAnimationFrame(rafRef.current);
  } else {
    if (stoppedRef.current) {
      stoppedRef.current = false;
      lastFrameRef.current = 0;
      rafRef.current = requestAnimationFrame(frame); // frame is not in scope here
    }
  }
}, [isActive]);
```

Since `frame` is defined inside the setup `useEffect` closure, the cleanest approach is to store it in a ref:

Add `const frameRef = useRef<(now: number) => void>(() => {})` at component top level. Inside the setup `useEffect`, after defining `frame`, add `frameRef.current = frame`. Then the `isActive` effect can call `frameRef.current` to restart.

Full pattern:

```typescript
const rafRef = useRef<number>(0);
const stoppedRef = useRef(false);
const frameRef = useRef<(now: number) => void>(() => {});
const lastFrameRef = useRef<number>(0);

// ... in the setup useEffect, after defining frame():
frameRef.current = frame;

// New effect for tab visibility:
useEffect(() => {
  if (!isActive) {
    stoppedRef.current = true;
    cancelAnimationFrame(rafRef.current);
  } else {
    stoppedRef.current = false;
    lastFrameRef.current = 0;
    rafRef.current = requestAnimationFrame(frameRef.current);
  }
}, [isActive]);
```

- [ ] **Step 7: Pass isActive from StarCommandTab to StarCommandScene**

In `src/renderer/src/components/StarCommandTab.tsx`, find the `<StarCommandScene>` render call. Determine whether `StarCommandTab` receives an `isActive`/`isVisible` prop from its parent tab system — check the component's props type. If it does, pass it through:

```typescript
<StarCommandScene isActive={props.isActive} className="..." />
```

If `StarCommandTab` has no such prop (i.e., the tab system unmounts inactive tabs), then `StarCommandScene` already pauses on unmount via its cleanup function — in that case skip this step and simply leave `isActive` at its default `true`.

- [ ] **Step 8: Debounce git check in TerminalPane**

Find `src/renderer/src/components/TerminalPane.tsx` (or wherever `window.fleet.git.isRepo()` is called on CWD change). Add a 500ms debounce using `useRef` for the timer:

```typescript
const gitCheckTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

useEffect(() => {
  if (!currentCwd) {
    /* ... existing not-a-repo handling ... */ return;
  }

  // Debounce: only check git status after CWD stops changing for 500ms
  if (gitCheckTimerRef.current) clearTimeout(gitCheckTimerRef.current);
  gitCheckTimerRef.current = setTimeout(() => {
    window.fleet.git.isRepo(currentCwd).then(/* ... existing handler ... */);
  }, 500);

  return () => {
    if (gitCheckTimerRef.current) clearTimeout(gitCheckTimerRef.current);
  };
}, [currentCwd]);
```

- [ ] **Step 9: Run full test suite**

```bash
npm test
```

Expected: all PASS

- [ ] **Step 10: Commit**

```bash
git add src/renderer/src/hooks/use-terminal.ts \
        src/main/agent-state-tracker.ts \
        src/main/__tests__/agent-state-tracker.test.ts \
        src/renderer/src/components/star-command/StarCommandScene.tsx \
        src/renderer/src/components/StarCommandTab.tsx \
        src/renderer/src/components/TerminalPane.tsx
git commit -m "perf: reduce scrollback to 3000 lines; cap sub-agents at 100; pause StarCommandScene RAF when tab inactive; debounce git check"
```

---

## Task 7: Pillar 6 — Unblock Startup

**Files:**

- Modify: `src/main/starbase/reconciliation.ts`
- Modify: `src/main/index.ts`
- Modify: `src/preload/index.ts`
- Modify: `src/renderer/src/components/StarCommandTab.tsx`

### Context

Two startup blockers: (1) `reconciliation.ts` calls `execSync` for each `git worktree prune` and `git push`, blocking the event loop at launch; (2) Admiral PTY (a full Claude Code process, ~200–400MB) auto-starts on every launch even if the user never opens Star Command.

- [ ] **Step 1: Make reconciliation git ops async**

In `src/main/starbase/reconciliation.ts`:

Add imports at top:

```typescript
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);
```

Find the `git worktree prune` block (around line 65-72):

```typescript
// CHANGE from:
execSync('git worktree prune', { cwd: sector.root_path, stdio: 'pipe' });

// TO:
await execFileAsync('git', ['worktree', 'prune'], {
  cwd: sector.root_path,
  timeout: 10_000
}).catch(() => {
  /* ignore prune failures */
});
```

Find any `git push` calls in the reconciliation function and replace similarly.

- [ ] **Step 2: Run reconciliation tests**

```bash
npx vitest run src/main/__tests__/reconciliation.test.ts
```

Expected: all PASS

- [ ] **Step 3: Add admiral:ensure-started IPC handler in index.ts**

In `src/main/index.ts`:

**a)** Extract `startAdmiralAndWire` into a function that returns the `paneId`:

Find the existing `startAdmiralAndWire` function and make it return the paneId:

```typescript
const startAdmiralAndWire = async (): Promise<string | null> => {
  try {
    const paneId = await admiralProcess!.start();
    ptyManager.onData(paneId, (data) => {
      notificationDetector.scan(paneId, data);
      const w = mainWindow;
      if (w && !w.isDestroyed()) {
        w.webContents.send(IPC_CHANNELS.PTY_DATA, { paneId, data });
      }
    });
    ptyManager.onExit(paneId, (exitCode) => {
      cwdPoller.stopPolling(paneId);
      const w = mainWindow;
      if (w && !w.isDestroyed()) {
        w.webContents.send(IPC_CHANNELS.PTY_EXIT, { paneId, exitCode });
      }
      eventBus.emit('pty-exit', { type: 'pty-exit', paneId, exitCode });
    });
    cwdPoller.startPolling(paneId, ptyManager.getPid(paneId) ?? 0);
    return paneId;
  } catch (err) {
    console.error('[admiral] Failed to start:', err);
    return null;
  }
};
```

**b)** Remove the auto-start call. Find and remove:

```typescript
startAdmiralAndWire();
```

**c)** Add the idempotent IPC handler (place it near other `ipcMain.handle` calls):

```typescript
ipcMain.handle('admiral:ensure-started', async () => {
  if (!admiralProcess) return null;
  // Already running — return existing paneId
  if (admiralProcess.paneId) return admiralProcess.paneId;
  // Currently starting — don't double-spawn; return null.
  // StarCommandTab listens to onStatusChanged and will receive the paneId
  // when Admiral finishes starting.
  if (admiralProcess.status === 'starting') return null;
  // Not started — start it
  return startAdmiralAndWire();
});
```

- [ ] **Step 4: Expose admiral.ensureStarted in preload**

In `src/preload/index.ts`, find the admiral section of the exposed API. Add alongside `getPaneId`:

```typescript
ensureStarted: () => ipcRenderer.invoke('admiral:ensure-started'),
```

- [ ] **Step 5: Call ensureStarted on mount in StarCommandTab.tsx**

In `src/renderer/src/components/StarCommandTab.tsx`, find the mount `useEffect` that calls `window.fleet.admiral.getPaneId()` (around line 64-80):

```typescript
// CHANGE from:
window.fleet.admiral.getPaneId().then((paneId) => {
  if (paneId) {
    setAdmiralPty(paneId, 'running');
  }
});

// TO (ensure-started starts it if not running, returns paneId):
window.fleet.admiral.ensureStarted().then((paneId: string | null) => {
  if (paneId) {
    setAdmiralPty(paneId, 'running');
  }
});
```

- [ ] **Step 6: Run full test suite**

```bash
npm test
```

Expected: all PASS

- [ ] **Step 7: Manual smoke test**

Start the app in dev mode:

```bash
npm run dev
```

Verify:

1. App window appears quickly with no visible delay
2. Star Command tab does NOT auto-open an Admiral PTY — verify in Activity Monitor / `ps aux | grep claude` that no Claude process starts until you open Star Command
3. Opening the Star Command tab starts Admiral normally
4. Terminal panes work normally (type commands, see output)
5. CWD tracking still works (open a pane, `cd /tmp`, verify tab title updates)

- [ ] **Step 8: Commit**

```bash
git add src/main/starbase/reconciliation.ts \
        src/main/index.ts \
        src/preload/index.ts \
        src/renderer/src/components/StarCommandTab.tsx
git commit -m "perf: make reconciliation git ops async; lazy-start Admiral PTY on Star Command open"
```

---

## Final Verification

- [ ] **Run full test suite one last time**

```bash
npm test
```

Expected: all PASS

- [ ] **Build check**

```bash
npm run build
```

Expected: no TypeScript errors

- [ ] **Final commit summary**

All six pillars should now be committed. Run:

```bash
git log --oneline -7
```

You should see 6 perf commits (plus the deps commit) across Tasks 1–7.
