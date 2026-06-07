# Pane Wait & Output Commands Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add three socket commands — `pane.get-output`, `pane.wait-output`, `pane.wait-status` — so agents and hook scripts can read a pane's recent terminal output and block until output or agent-state conditions are met.

**Architecture:** A new `PaneOutputStore` keeps a capped rolling buffer of raw PTY bytes per pane. `PtyManager` feeds it from the same internal `onData` listener that already exists. The live `SocketServer` gains three handlers: `pane.get-output` reads the store; `pane.wait-output` subscribes to the store's `append` event and resolves when matched output arrives; `pane.wait-status` subscribes to the existing `EventBus` `activity-state-change` event. The socket dispatch model already supports blocking — `handleLine` `await`s `dispatch()` and writes the response when the promise resolves, so a handler can hold the connection open until its condition is met or it times out. No subscription/long-lived-connection layer is needed. The `fleet` CLI gets matching `pane get-output | wait-output | wait-status` subcommands.

**Tech Stack:** TypeScript, Electron main process, Node `net` Unix socket, Node `EventEmitter`, node-pty, Vitest.

**Context for the implementer:**

- This is Phase 3 of an agent-integration roadmap. Phase 2 added `pane.report-agent` / `pane.release-agent` to `src/main/socket-server.ts` and the `ActivityTracker`. Follow the validation style of those handlers.
- There are **two** socket systems in the repo. `src/main/socket-api.ts` + `src/main/socket-command-handler.ts` (`FleetCommandHandler`) is **dead code** — not constructed anywhere in `src/main/index.ts`. Its `get-output` case (a stub at `socket-command-handler.ts:180-185`) is **not** what we implement. Leave that dead stub untouched. The **live** server is `SocketServer` in `src/main/socket-server.ts`, reached via `SocketSupervisor`. All new commands go on `SocketServer`.
- The socket wire protocol: requests are newline-delimited JSON `{ id?, command, args? }`; responses are `{ id?, ok: true, data }` or `{ id?, ok: false, error, code? }`. Handlers are `async` methods on `SocketServer` and return the `data` payload. They throw `CodedError(message, code)` for failures (`src/main/errors.ts`).
- `stripAnsi` already exists and is exported from `src/main/agent-detector.ts:26` — reuse it; do not write a new one.
- Verification commands: `npm run typecheck`, `npm run lint`, `npm run build`. Tests: `npx vitest run`.
- Tests for `SocketServer` call the private `dispatch` method directly as `server['dispatch'](command, args)` — see `src/main/__tests__/socket-server-agent.test.ts`. No socket listen is needed.

---

### Task 1: PaneOutputStore

A per-pane capped rolling buffer of raw PTY output, with an `append` event for `wait-output` subscribers.

**Files:**
- Create: `src/main/pane-output-store.ts`
- Test: `src/main/__tests__/pane-output-store.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/main/__tests__/pane-output-store.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { PaneOutputStore } from '../pane-output-store';

describe('PaneOutputStore', () => {
  it('returns empty string for an unknown pane', () => {
    const store = new PaneOutputStore();
    expect(store.read('nope')).toBe('');
  });

  it('accumulates appended output per pane', () => {
    const store = new PaneOutputStore();
    store.append('p1', 'hello ');
    store.append('p1', 'world');
    store.append('p2', 'other');
    expect(store.read('p1')).toBe('hello world');
    expect(store.read('p2')).toBe('other');
  });

  it('trims the buffer to the cap, keeping the most recent bytes', () => {
    const store = new PaneOutputStore(10);
    store.append('p1', '0123456789');
    store.append('p1', 'ABCDE');
    expect(store.read('p1')).toBe('56789ABCDE');
    expect(store.read('p1').length).toBe(10);
  });

  it('emits an append event with paneId and data', () => {
    const store = new PaneOutputStore();
    const seen: Array<{ paneId: string; data: string }> = [];
    store.on('append', (ev: { paneId: string; data: string }) => seen.push(ev));
    store.append('p1', 'x');
    store.append('p2', 'y');
    expect(seen).toEqual([
      { paneId: 'p1', data: 'x' },
      { paneId: 'p2', data: 'y' }
    ]);
  });

  it('clear() drops a pane buffer', () => {
    const store = new PaneOutputStore();
    store.append('p1', 'data');
    store.clear('p1');
    expect(store.read('p1')).toBe('');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/main/__tests__/pane-output-store.test.ts`
Expected: FAIL — `Cannot find module '../pane-output-store'`.

- [ ] **Step 3: Write the implementation**

Create `src/main/pane-output-store.ts`:

```ts
import { EventEmitter } from 'node:events';

/** Default per-pane cap. 256 KB comfortably holds several thousand lines. */
const DEFAULT_MAX_BYTES = 256 * 1024;

/**
 * PaneOutputStore — a capped rolling buffer of raw PTY output per pane.
 *
 * `PtyManager` appends every byte a PTY emits. `pane.get-output` reads the
 * buffer; `pane.wait-output` subscribes to the `append` event.
 *
 * Emits: `append` with `{ paneId, data }` on every append.
 */
export class PaneOutputStore extends EventEmitter {
  private buffers = new Map<string, string>();

  constructor(private maxBytes: number = DEFAULT_MAX_BYTES) {
    super();
  }

  append(paneId: string, data: string): void {
    let buf = (this.buffers.get(paneId) ?? '') + data;
    if (buf.length > this.maxBytes) {
      buf = buf.slice(buf.length - this.maxBytes);
    }
    this.buffers.set(paneId, buf);
    this.emit('append', { paneId, data });
  }

  read(paneId: string): string {
    return this.buffers.get(paneId) ?? '';
  }

  clear(paneId: string): void {
    this.buffers.delete(paneId);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/main/__tests__/pane-output-store.test.ts`
Expected: PASS — 5 tests.

- [ ] **Step 5: Commit**

```bash
git add src/main/pane-output-store.ts src/main/__tests__/pane-output-store.test.ts
git commit -m "feat(pane): add PaneOutputStore rolling output buffer"
```

---

### Task 2: Feed PaneOutputStore from PtyManager

`PtyManager` already has an internal `proc.onData` listener registered at `create()` time (`src/main/pty-manager.ts:98-109`). Append to the store there, and clear the store when a PTY is killed or exits.

**Files:**
- Modify: `src/main/pty-manager.ts`
- Test: `src/main/__tests__/pty-manager.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `src/main/__tests__/pty-manager.test.ts` (keep existing imports; add the `PaneOutputStore` import next to the existing `PtyManager` import):

```ts
import { PaneOutputStore } from '../pane-output-store';

describe('PtyManager + PaneOutputStore', () => {
  const waitFor = async (cond: () => boolean, timeoutMs = 4000): Promise<void> => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (cond()) return;
      await new Promise((r) => setTimeout(r, 20));
    }
    throw new Error('waitFor timed out');
  };

  it('appends PTY output to the output store', async () => {
    const store = new PaneOutputStore();
    const mgr = new PtyManager(store);
    mgr.create({ paneId: 'p-store', cwd: process.cwd() });
    mgr.write('p-store', 'echo store-marker-123\r');
    await waitFor(() => store.read('p-store').includes('store-marker-123'));
    expect(store.read('p-store')).toContain('store-marker-123');
    mgr.kill('p-store');
  });

  it('clears store output when the PTY is killed', async () => {
    const store = new PaneOutputStore();
    const mgr = new PtyManager(store);
    mgr.create({ paneId: 'p-clear', cwd: process.cwd() });
    mgr.write('p-clear', 'echo x\r');
    await waitFor(() => store.read('p-clear').length > 0);
    mgr.kill('p-clear');
    expect(store.read('p-clear')).toBe('');
  });

  it('works without a store (store is optional)', () => {
    const mgr = new PtyManager();
    const result = mgr.create({ paneId: 'p-nostore', cwd: process.cwd() });
    expect(result.paneId).toBe('p-nostore');
    mgr.kill('p-nostore');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/main/__tests__/pty-manager.test.ts`
Expected: FAIL — `Expected 0 arguments, but got 1` on `new PtyManager(store)` (TS), or the new `describe` block fails.

- [ ] **Step 3: Add the constructor and the store import**

In `src/main/pty-manager.ts`, add the import after the existing imports at the top:

```ts
import type { PaneOutputStore } from './pane-output-store';
```

Add a constructor to the `PtyManager` class, immediately after the field declarations (after `private flushTimer: ReturnType<typeof setInterval> | null = null;`):

```ts
  constructor(private outputStore?: PaneOutputStore) {}
```

- [ ] **Step 4: Append output in the internal data listener**

In `src/main/pty-manager.ts`, the internal listener is registered inside `create()` (currently lines 98-109). Add the store append as the first line of the callback body:

```ts
    entry.dataDisposable = proc.onData((data: string) => {
      this.outputStore?.append(opts.paneId, data);
      entry.outputBuffer += data;
      if (entry.outputBuffer.length > BUFFER_OVERFLOW_BYTES) {
        log.debug('backpressure pause', {
          paneId: opts.paneId,
          bufferBytes: entry.outputBuffer.length
        });
        entry.paused = true;
        this.flushPane(opts.paneId);
        proc.pause();
      }
    });
```

- [ ] **Step 5: Clear the store on kill and on exit**

In `kill()` (currently lines 135-147), add the store clear after `this.dataCallbacks.delete(paneId);`:

```ts
  kill(paneId: string): void {
    const entry = this.ptys.get(paneId);
    if (entry) {
      log.debug('kill', { paneId, pid: entry.process.pid });
      entry.dataDisposable?.dispose();
      entry.exitDisposable?.dispose();
      this.dataCallbacks.delete(paneId);
      this.outputStore?.clear(paneId);
      entry.process.kill();
      this.ptys.delete(paneId);
      this.protectedPtys.delete(paneId);
      this.clearFlushTimerIfEmpty();
    }
  }
```

In the `onExit()` internal callback (currently lines 238-246), add the store clear after `this.dataCallbacks.delete(paneId);`:

```ts
      entry.exitDisposable = entry.process.onExit(({ exitCode }) => {
        log.debug('exit', { paneId, exitCode });
        entry.dataDisposable?.dispose();
        this.dataCallbacks.delete(paneId);
        this.outputStore?.clear(paneId);
        this.ptys.delete(paneId);
        this.protectedPtys.delete(paneId);
        this.clearFlushTimerIfEmpty();
        callback(exitCode);
      });
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx vitest run src/main/__tests__/pty-manager.test.ts`
Expected: PASS — existing tests plus the 3 new ones.

- [ ] **Step 7: Commit**

```bash
git add src/main/pty-manager.ts src/main/__tests__/pty-manager.test.ts
git commit -m "feat(pane): feed PaneOutputStore from PtyManager"
```

---

### Task 3: Wire PaneOutputStore and EventBus into SocketServer

Plumbing only — no new commands yet. `SocketServer` and `SocketSupervisor` gain two new optional constructor params (`paneOutputStore`, `eventBus`); `index.ts` constructs the store, hands it to `PtyManager`, and passes both to the supervisor.

**Files:**
- Modify: `src/main/socket-server.ts:54-62`
- Modify: `src/main/socket-supervisor.ts:22-30` and the `createServer()` method
- Modify: `src/main/index.ts` (around lines 48-49 and 356)

- [ ] **Step 1: Add SocketServer constructor params**

In `src/main/socket-server.ts`, add imports near the top (after the existing `import type { ActivityTracker } from './activity-tracker';`):

```ts
import type { PaneOutputStore } from './pane-output-store';
import type { EventBus } from './event-bus';
```

Change the constructor (currently lines 54-62) to append two optional params:

```ts
  constructor(
    private socketPath: string,
    private imageService?: ImageService,
    private annotateService?: AnnotateService,
    private seqTracker?: SeqTracker,
    private activityTracker?: ActivityTracker,
    private paneOutputStore?: PaneOutputStore,
    private eventBus?: EventBus
  ) {
    super();
  }
```

- [ ] **Step 2: Add SocketSupervisor constructor params and forward them**

In `src/main/socket-supervisor.ts`, add imports near the top (after `import type { ActivityTracker } from './activity-tracker';`):

```ts
import type { PaneOutputStore } from './pane-output-store';
import type { EventBus } from './event-bus';
```

Change the constructor (currently lines 22-30) to append the two params:

```ts
  constructor(
    private socketPath: string,
    private imageService?: ImageService,
    private annotateService?: AnnotateService,
    private seqTracker?: SeqTracker,
    private activityTracker?: ActivityTracker,
    private paneOutputStore?: PaneOutputStore,
    private eventBus?: EventBus
  ) {
    super();
  }
```

In `createServer()`, change the `new SocketServer(...)` line to forward them:

```ts
    const server = new SocketServer(
      this.socketPath,
      this.imageService,
      this.annotateService,
      this.seqTracker,
      this.activityTracker,
      this.paneOutputStore,
      this.eventBus
    );
```

- [ ] **Step 3: Construct the store in index.ts and wire it through**

In `src/main/index.ts`, add the import alongside the other main-process imports (near `import { PtyManager } from './pty-manager';`):

```ts
import { PaneOutputStore } from './pane-output-store';
```

Change the `ptyManager` construction (currently line 49 `const ptyManager = new PtyManager();`) to create the store first:

```ts
const paneOutputStore = new PaneOutputStore();
const ptyManager = new PtyManager(paneOutputStore);
```

Change the `SocketSupervisor` construction (currently line 356) to pass both new args:

```ts
  socketSupervisor = new SocketSupervisor(
    SOCKET_PATH,
    imageService,
    annotateService,
    seqTracker,
    activityTracker,
    paneOutputStore,
    eventBus
  );
```

- [ ] **Step 4: Verify typecheck and existing tests**

Run: `npm run typecheck`
Expected: PASS — no errors.

Run: `npx vitest run`
Expected: PASS — all existing tests still pass (no behavior change yet).

- [ ] **Step 5: Commit**

```bash
git add src/main/socket-server.ts src/main/socket-supervisor.ts src/main/index.ts
git commit -m "feat(pane): inject PaneOutputStore and EventBus into SocketServer"
```

---

### Task 4: pane.get-output command

Reads the current rolling buffer for a pane. Optional `lines` returns only the last N lines; `strip_ansi` (default true) removes ANSI escape codes.

**Files:**
- Modify: `src/main/socket-server.ts` (dispatch switch + module-level helpers)
- Test: `src/main/__tests__/socket-server-wait.test.ts` (new)

- [ ] **Step 1: Write the failing test**

Create `src/main/__tests__/socket-server-wait.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { SocketServer } from '../socket-server';
import { PaneOutputStore } from '../pane-output-store';
import { EventBus } from '../event-bus';
import { ActivityTracker } from '../activity-tracker';
import { SeqTracker } from '../seq-tracker';
import { CodedError } from '../errors';

function makeServer(): {
  server: SocketServer;
  store: PaneOutputStore;
  bus: EventBus;
  tracker: ActivityTracker;
} {
  const store = new PaneOutputStore();
  const bus = new EventBus();
  const tracker = new ActivityTracker(bus, {
    silenceThresholdMs: 5000,
    processPollingIntervalMs: 60_000,
    getProcessName: () => undefined
  });
  const server = new SocketServer(
    '',
    undefined,
    undefined,
    new SeqTracker(),
    tracker,
    store,
    bus
  );
  return { server, store, bus, tracker };
}

describe('SocketServer pane.get-output', () => {
  let ctx: ReturnType<typeof makeServer>;
  beforeEach(() => {
    ctx = makeServer();
  });

  it('returns the buffered output for a pane', async () => {
    ctx.store.append('p1', 'line one\nline two\n');
    const data = await ctx.server['dispatch']('pane.get-output', { pane_id: 'p1' });
    expect(data).toEqual({ output: 'line one\nline two\n', lines: 3 });
  });

  it('returns empty output for an unknown pane', async () => {
    const data = await ctx.server['dispatch']('pane.get-output', { pane_id: 'ghost' });
    expect(data).toEqual({ output: '', lines: 1 });
  });

  it('strips ANSI escape codes by default', async () => {
    ctx.store.append('p1', '\x1b[31mred\x1b[0m text');
    const data = await ctx.server['dispatch']('pane.get-output', { pane_id: 'p1' });
    expect(data).toEqual({ output: 'red text', lines: 1 });
  });

  it('keeps ANSI codes when strip_ansi is false', async () => {
    ctx.store.append('p1', '\x1b[31mred\x1b[0m');
    const data = await ctx.server['dispatch']('pane.get-output', {
      pane_id: 'p1',
      strip_ansi: false
    });
    expect(data).toEqual({ output: '\x1b[31mred\x1b[0m', lines: 1 });
  });

  it('returns only the last N lines when lines is given', async () => {
    ctx.store.append('p1', 'a\nb\nc\nd\ne');
    const data = await ctx.server['dispatch']('pane.get-output', { pane_id: 'p1', lines: 2 });
    expect(data).toEqual({ output: 'd\ne', lines: 2 });
  });

  it('throws BAD_REQUEST when pane_id is missing', async () => {
    await expect(ctx.server['dispatch']('pane.get-output', {})).rejects.toThrow(CodedError);
  });

  it('throws BAD_REQUEST when lines is not a positive integer', async () => {
    ctx.store.append('p1', 'a');
    await expect(
      ctx.server['dispatch']('pane.get-output', { pane_id: 'p1', lines: 0 })
    ).rejects.toThrow(CodedError);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/main/__tests__/socket-server-wait.test.ts`
Expected: FAIL — `pane.get-output` falls through to the `default` case and throws `Unknown command` (code `NOT_FOUND`), so assertions on the expected shape fail.

- [ ] **Step 3: Add module-level helpers and the stripAnsi import**

In `src/main/socket-server.ts`, add the import near the top (after `import { SeqTracker } from './seq-tracker';`):

```ts
import { stripAnsi } from './agent-detector';
```

Add these two helper functions at module scope, just below the `Response` type alias (after `type Response = SuccessResponse | ErrorResponse;`):

```ts
function strArg(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

/** Parse an optional `timeout_ms` arg. Returns `fallback` when absent. */
function parseTimeoutMs(raw: unknown, fallback: number): number {
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    throw new CodedError('timeout_ms must be a positive number', 'BAD_REQUEST');
  }
  return n;
}
```

- [ ] **Step 4: Add the pane.get-output case**

In `src/main/socket-server.ts`, inside the `dispatch()` switch, add this case immediately before the `default:` case (after the `pane.release-agent` case):

```ts
      case 'pane.get-output': {
        const paneId = strArg(args.pane_id);
        if (!paneId) throw new CodedError('pane.get-output requires pane_id', 'BAD_REQUEST');
        if (!this.paneOutputStore) {
          throw new CodedError('pane.get-output not available', 'UNAVAILABLE');
        }
        const stripAnsiOpt = args.strip_ansi !== false;
        let text = this.paneOutputStore.read(paneId);
        if (stripAnsiOpt) text = stripAnsi(text);
        let lines = text.split('\n');
        if (args.lines !== undefined) {
          const n = Number(args.lines);
          if (!Number.isInteger(n) || n <= 0) {
            throw new CodedError(
              'pane.get-output lines must be a positive integer',
              'BAD_REQUEST'
            );
          }
          lines = lines.slice(-n);
        }
        return { output: lines.join('\n'), lines: lines.length };
      }
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run src/main/__tests__/socket-server-wait.test.ts`
Expected: PASS — the 7 `pane.get-output` tests.

- [ ] **Step 6: Commit**

```bash
git add src/main/socket-server.ts src/main/__tests__/socket-server-wait.test.ts
git commit -m "feat(pane): add pane.get-output socket command"
```

---

### Task 5: pane.wait-output command

Blocks until the pane prints output matching a substring (`match`) or a regex (`regex`), or until `timeout_ms` elapses. Matches only output that arrives **after** the call starts — this is the "wait for X to happen" semantic. ANSI codes are stripped before matching unless `strip_ansi` is false.

**Files:**
- Modify: `src/main/socket-server.ts` (dispatch switch)
- Test: `src/main/__tests__/socket-server-wait.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `src/main/__tests__/socket-server-wait.test.ts`:

```ts
describe('SocketServer pane.wait-output', () => {
  let ctx: ReturnType<typeof makeServer>;
  beforeEach(() => {
    ctx = makeServer();
  });

  it('resolves when matching output arrives (substring)', async () => {
    const pending = ctx.server['dispatch']('pane.wait-output', {
      pane_id: 'p1',
      match: 'ready',
      timeout_ms: 2000
    });
    ctx.store.append('p1', 'starting up\n');
    ctx.store.append('p1', 'server ready\n');
    const data = await pending;
    expect(data).toEqual({ matched: true, text: 'starting up\nserver ready\n' });
  });

  it('resolves when matching output arrives (regex)', async () => {
    const pending = ctx.server['dispatch']('pane.wait-output', {
      pane_id: 'p1',
      regex: 'listening on :\\d+',
      timeout_ms: 2000
    });
    ctx.store.append('p1', 'listening on :3000\n');
    const data = await pending;
    expect(data).toEqual({ matched: true, text: 'listening on :3000\n' });
  });

  it('matches across appends that individually do not match', async () => {
    const pending = ctx.server['dispatch']('pane.wait-output', {
      pane_id: 'p1',
      match: 'abcdef',
      timeout_ms: 2000
    });
    ctx.store.append('p1', 'abc');
    ctx.store.append('p1', 'def');
    const data = await pending;
    expect(data).toEqual({ matched: true, text: 'abcdef' });
  });

  it('ignores output from other panes', async () => {
    const pending = ctx.server['dispatch']('pane.wait-output', {
      pane_id: 'p1',
      match: 'ready',
      timeout_ms: 60
    });
    ctx.store.append('p2', 'ready');
    const data = await pending;
    expect(data).toEqual({ matched: false, reason: 'timeout' });
  });

  it('matches against ANSI-stripped text by default', async () => {
    const pending = ctx.server['dispatch']('pane.wait-output', {
      pane_id: 'p1',
      match: 'done',
      timeout_ms: 2000
    });
    ctx.store.append('p1', '\x1b[32mdone\x1b[0m');
    const data = await pending;
    expect(data).toEqual({ matched: true, text: 'done' });
  });

  it('resolves with timeout when no match arrives', async () => {
    const data = await ctx.server['dispatch']('pane.wait-output', {
      pane_id: 'p1',
      match: 'never',
      timeout_ms: 40
    });
    expect(data).toEqual({ matched: false, reason: 'timeout' });
  });

  it('throws BAD_REQUEST when neither match nor regex is given', async () => {
    await expect(
      ctx.server['dispatch']('pane.wait-output', { pane_id: 'p1' })
    ).rejects.toThrow(CodedError);
  });

  it('throws BAD_REQUEST when regex is invalid', async () => {
    await expect(
      ctx.server['dispatch']('pane.wait-output', { pane_id: 'p1', regex: '(' })
    ).rejects.toThrow(CodedError);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/main/__tests__/socket-server-wait.test.ts`
Expected: FAIL — the `pane.wait-output` tests fail (`Unknown command`).

- [ ] **Step 3: Add the pane.wait-output case**

In `src/main/socket-server.ts`, inside the `dispatch()` switch, add this case immediately before the `default:` case (after the `pane.get-output` case):

```ts
      case 'pane.wait-output': {
        const paneId = strArg(args.pane_id);
        if (!paneId) throw new CodedError('pane.wait-output requires pane_id', 'BAD_REQUEST');
        const matchSub = strArg(args.match);
        const matchRe = strArg(args.regex);
        if (!matchSub && !matchRe) {
          throw new CodedError('pane.wait-output requires match or regex', 'BAD_REQUEST');
        }
        let re: RegExp | undefined;
        if (matchRe !== undefined) {
          try {
            re = new RegExp(matchRe);
          } catch {
            throw new CodedError('pane.wait-output regex is invalid', 'BAD_REQUEST');
          }
        }
        const stripAnsiOpt = args.strip_ansi !== false;
        const timeoutMs = parseTimeoutMs(args.timeout_ms, 30_000);
        if (!this.paneOutputStore) {
          throw new CodedError('pane.wait-output not available', 'UNAVAILABLE');
        }
        const store = this.paneOutputStore;
        return await new Promise<unknown>((resolve) => {
          let acc = '';
          let timer: ReturnType<typeof setTimeout>;
          const haystack = (): string => (stripAnsiOpt ? stripAnsi(acc) : acc);
          const matches = (): boolean => {
            const hay = haystack();
            return re ? re.test(hay) : hay.includes(matchSub as string);
          };
          const finish = (result: unknown): void => {
            clearTimeout(timer);
            store.off('append', onAppend);
            resolve(result);
          };
          const onAppend = (ev: { paneId: string; data: string }): void => {
            if (ev.paneId !== paneId) return;
            acc += ev.data;
            if (matches()) finish({ matched: true, text: haystack() });
          };
          timer = setTimeout(() => finish({ matched: false, reason: 'timeout' }), timeoutMs);
          store.on('append', onAppend);
        });
      }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/main/__tests__/socket-server-wait.test.ts`
Expected: PASS — `pane.get-output` and `pane.wait-output` suites.

- [ ] **Step 5: Commit**

```bash
git add src/main/socket-server.ts src/main/__tests__/socket-server-wait.test.ts
git commit -m "feat(pane): add pane.wait-output socket command"
```

---

### Task 6: pane.wait-status command

Blocks until a pane's agent activity state reaches a target value, or until `timeout_ms` elapses. Resolves immediately if the pane is already at the target state. Subscribes to the existing `EventBus` `activity-state-change` event.

**Files:**
- Modify: `src/main/socket-server.ts` (dispatch switch)
- Test: `src/main/__tests__/socket-server-wait.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `src/main/__tests__/socket-server-wait.test.ts`:

```ts
describe('SocketServer pane.wait-status', () => {
  let ctx: ReturnType<typeof makeServer>;
  beforeEach(() => {
    ctx = makeServer();
    ctx.tracker.trackPane('p1');
  });

  it('resolves immediately when the pane is already at the target state', async () => {
    // A freshly tracked pane starts at 'idle'.
    const data = await ctx.server['dispatch']('pane.wait-status', {
      pane_id: 'p1',
      state: 'idle'
    });
    expect(data).toEqual({ reached: true, state: 'idle' });
  });

  it('resolves when the pane transitions to the target state', async () => {
    const pending = ctx.server['dispatch']('pane.wait-status', {
      pane_id: 'p1',
      state: 'needs_me',
      timeout_ms: 2000
    });
    ctx.tracker.onNeedsMe('p1');
    const data = await pending;
    expect(data).toEqual({ reached: true, state: 'needs_me' });
  });

  it('ignores state changes on other panes', async () => {
    ctx.tracker.trackPane('p2');
    const pending = ctx.server['dispatch']('pane.wait-status', {
      pane_id: 'p1',
      state: 'needs_me',
      timeout_ms: 60
    });
    ctx.tracker.onNeedsMe('p2');
    const data = await pending;
    expect(data).toEqual({ reached: false, reason: 'timeout' });
  });

  it('resolves with timeout when the target state is never reached', async () => {
    const data = await ctx.server['dispatch']('pane.wait-status', {
      pane_id: 'p1',
      state: 'error',
      timeout_ms: 40
    });
    expect(data).toEqual({ reached: false, reason: 'timeout' });
  });

  it('throws BAD_REQUEST when state is missing', async () => {
    await expect(
      ctx.server['dispatch']('pane.wait-status', { pane_id: 'p1' })
    ).rejects.toThrow(CodedError);
  });

  it('throws BAD_REQUEST when state is not a valid ActivityState', async () => {
    await expect(
      ctx.server['dispatch']('pane.wait-status', { pane_id: 'p1', state: 'bogus' })
    ).rejects.toThrow(CodedError);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/main/__tests__/socket-server-wait.test.ts`
Expected: FAIL — the `pane.wait-status` tests fail (`Unknown command`).

- [ ] **Step 3: Add the pane.wait-status case**

In `src/main/socket-server.ts`, inside the `dispatch()` switch, add this case immediately before the `default:` case (after the `pane.wait-output` case):

```ts
      case 'pane.wait-status': {
        const paneId = strArg(args.pane_id);
        if (!paneId) throw new CodedError('pane.wait-status requires pane_id', 'BAD_REQUEST');
        const stateRaw = strArg(args.state);
        const validStates: readonly ActivityState[] = [
          'working',
          'idle',
          'needs_me',
          'error',
          'done'
        ];
        if (!stateRaw || !validStates.includes(stateRaw as ActivityState)) {
          throw new CodedError('pane.wait-status requires valid state', 'BAD_REQUEST');
        }
        const target = stateRaw as ActivityState;
        const timeoutMs = parseTimeoutMs(args.timeout_ms, 30_000);
        if (!this.activityTracker || !this.eventBus) {
          throw new CodedError('pane.wait-status not available', 'UNAVAILABLE');
        }
        if (this.activityTracker.getState(paneId) === target) {
          return { reached: true, state: target };
        }
        const bus = this.eventBus;
        return await new Promise<unknown>((resolve) => {
          let timer: ReturnType<typeof setTimeout>;
          const finish = (result: unknown): void => {
            clearTimeout(timer);
            bus.off('activity-state-change', onChange);
            resolve(result);
          };
          const onChange = (ev: { paneId: string; state: ActivityState }): void => {
            if (ev.paneId === paneId && ev.state === target) {
              finish({ reached: true, state: target });
            }
          };
          timer = setTimeout(() => finish({ reached: false, reason: 'timeout' }), timeoutMs);
          bus.on('activity-state-change', onChange);
        });
      }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/main/__tests__/socket-server-wait.test.ts`
Expected: PASS — all three suites (`pane.get-output`, `pane.wait-output`, `pane.wait-status`).

- [ ] **Step 5: Run the full suite and typecheck**

Run: `npm run typecheck`
Expected: PASS.

Run: `npx vitest run`
Expected: PASS — all tests.

- [ ] **Step 6: Commit**

```bash
git add src/main/socket-server.ts src/main/__tests__/socket-server-wait.test.ts
git commit -m "feat(pane): add pane.wait-status socket command"
```

---

### Task 7: Fleet CLI wiring

Expose the three commands as `fleet pane get-output | wait-output | wait-status`. Wait commands must use a socket-send timeout longer than their `timeout_ms` and must not be retried.

**Files:**
- Modify: `src/main/fleet-cli.ts` (`COMMAND_MAP`, `validateCommand`, the pane-args normalization block, the send block, output formatters, `HELP_GROUPS.pane`)
- Test: `src/main/__tests__/fleet-cli.test.ts`

**Background on the CLI flow (read before implementing):**
- `parseArgs` (`fleet-cli.ts:92`) turns `--key value` into `args[key] = value` (string), keeping dashes in the key. A bare `--flag` becomes `args[key] = true`.
- `mapCommand` looks up `COMMAND_MAP['<group>.<action>']`, falling back to the dotted string.
- `validateCommand` runs **after** the pane-args normalization block, so it should check normalized keys (`pane_id`, not `pane`).
- `runCLI` sends via `cli.sendWithRetry` (when `opts.retry`) or `cli.send`. `cli.send(command, args, timeoutMs)` accepts a timeout; default is 60_000.

- [ ] **Step 1: Write the failing test**

Add to `src/main/__tests__/fleet-cli.test.ts` (match the existing import style in that file — it imports `validateCommand` and other helpers from `../fleet-cli`):

```ts
import { validateCommand } from '../fleet-cli';

describe('validateCommand — pane wait commands', () => {
  it('rejects pane.get-output without pane_id', () => {
    expect(validateCommand('pane.get-output', {})).toMatch(/requires --pane/);
  });

  it('accepts pane.get-output with pane_id', () => {
    expect(validateCommand('pane.get-output', { pane_id: 'p1' })).toBeNull();
  });

  it('rejects pane.wait-output without a matcher', () => {
    expect(validateCommand('pane.wait-output', { pane_id: 'p1' })).toMatch(
      /--match or --regex/
    );
  });

  it('accepts pane.wait-output with a match', () => {
    expect(validateCommand('pane.wait-output', { pane_id: 'p1', match: 'x' })).toBeNull();
  });

  it('rejects pane.wait-status without a state', () => {
    expect(validateCommand('pane.wait-status', { pane_id: 'p1' })).toMatch(/--state/);
  });

  it('accepts pane.wait-status with a state', () => {
    expect(
      validateCommand('pane.wait-status', { pane_id: 'p1', state: 'idle' })
    ).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/main/__tests__/fleet-cli.test.ts`
Expected: FAIL — `validateCommand` returns `null` for the new commands (no cases yet), so the `rejects` assertions fail.

- [ ] **Step 3: Add COMMAND_MAP entries**

In `src/main/fleet-cli.ts`, in the `COMMAND_MAP` object, under the `// Pane` comment, add three entries after `'pane.release-agent': 'pane.release-agent'`:

```ts
  // Pane
  'pane.report-agent': 'pane.report-agent',
  'pane.release-agent': 'pane.release-agent',
  'pane.get-output': 'pane.get-output',
  'pane.wait-output': 'pane.wait-output',
  'pane.wait-status': 'pane.wait-status'
```

- [ ] **Step 4: Add validateCommand cases**

In `validateCommand`, add three cases after the existing `case 'pane.release-agent':` block (before `default:`):

```ts
    case 'pane.get-output':
      if (!args.pane_id) return 'Error: pane get-output requires --pane.';
      return null;

    case 'pane.wait-output':
      if (!args.pane_id) return 'Error: pane wait-output requires --pane.';
      if (!args.match && !args.regex)
        return 'Error: pane wait-output requires --match or --regex.';
      return null;

    case 'pane.wait-status':
      if (!args.pane_id) return 'Error: pane wait-status requires --pane.';
      if (!args.state) return 'Error: pane wait-status requires --state.';
      return null;
```

- [ ] **Step 5: Extend the pane-args normalization block**

In `runCLI`, the existing block normalizes `--pane` to `pane_id` for two commands. Replace it so it covers all pane commands and also normalizes `--timeout` to `timeout_ms`:

```ts
  // ── pane commands: normalize --pane to pane_id, --timeout to timeout_ms ──
  if (command.startsWith('pane.')) {
    if (args.pane !== undefined) {
      args.pane_id = args.pane;
      delete args.pane;
    }
    if (args.timeout !== undefined) {
      args.timeout_ms = args.timeout;
      delete args.timeout;
    }
  }
```

- [ ] **Step 6: Use a long, retry-free send for wait commands**

In `runCLI`, find the send block:

```ts
  let response: CLIResponse;
  try {
    response = opts?.retry ? await cli.sendWithRetry(command, args) : await cli.send(command, args);
  } catch (err) {
```

Replace it with:

```ts
  const isWaitCommand = command === 'pane.wait-output' || command === 'pane.wait-status';
  let response: CLIResponse;
  try {
    if (isWaitCommand) {
      const waitMs = typeof args.timeout_ms === 'string' ? Number(args.timeout_ms) : NaN;
      const effectiveWaitMs = Number.isFinite(waitMs) && waitMs > 0 ? waitMs : 30_000;
      response = await cli.send(command, args, effectiveWaitMs + 5_000);
    } else {
      response = opts?.retry
        ? await cli.sendWithRetry(command, args)
        : await cli.send(command, args);
    }
  } catch (err) {
```

(The `effectiveWaitMs + 5_000` gives the server time to return its own `timeout` result before the CLI socket gives up. Wait commands are not retried — retrying would restart the wait.)

- [ ] **Step 7: Add output formatters**

In `runCLI`, the response formatting section has a series of `if (command === ...)` blocks. Add these three blocks immediately after the `// ── image.generate / image.edit formatting ──` block (before the `image.status` block):

```ts
  // ── pane.get-output formatting ──────────────────────────────────────────
  if (command === 'pane.get-output' && isRecord(data)) {
    return toStr(data.output);
  }

  // ── pane.wait-output formatting ─────────────────────────────────────────
  if (command === 'pane.wait-output' && isRecord(data)) {
    return data.matched === true ? toStr(data.text) : 'timeout';
  }

  // ── pane.wait-status formatting ─────────────────────────────────────────
  if (command === 'pane.wait-status' && isRecord(data)) {
    return data.reached === true ? `reached: ${toStr(data.state)}` : 'timeout';
  }
```

- [ ] **Step 8: Extend the pane help text**

In `src/main/fleet-cli.ts`, replace the entire `pane:` entry of `HELP_GROUPS` (currently the block from `pane: \`# fleet pane` through the closing `--seq ...\`,`) with:

```ts
  pane: `# fleet pane

Report agent state and read pane output for hook scripts and agents.

## Usage

  fleet pane report-agent --pane <id> --agent <claude|codex|opencode|pi> \\
                          --state <working|idle|needs_me|error|done> \\
                          --source <string> [--seq <integer>]

  fleet pane release-agent --pane <id> --source <string> [--seq <integer>]

  fleet pane get-output --pane <id> [--lines <n>] [--strip-ansi false]

  fleet pane wait-output --pane <id> (--match <text> | --regex <pattern>) \\
                         [--timeout <ms>] [--strip-ansi false]

  fleet pane wait-status --pane <id> --state <working|idle|needs_me|error|done> \\
                         [--timeout <ms>]

## When to use

\`report-agent\` / \`release-agent\` are used by per-agent hook scripts installed
via \`fleet integration install\` — you usually do not call them directly.

\`get-output\` reads a pane's recent terminal output. \`wait-output\` blocks until
a pane prints matching output. \`wait-status\` blocks until a pane's agent reaches
a target activity state. These let an agent coordinate across panes.

## Arguments

  --pane         Pane ID (set in PTY env as FLEET_PANE_ID).
  --agent        Coding agent identifier.
  --state        Activity state (needs_me corresponds to "blocked/waiting on user").
  --source       Hook source identifier, e.g. "fleet:claude".
  --seq          Monotonic sequence number. Stale reports are silently dropped.
  --lines        get-output: return only the last N lines.
  --strip-ansi   Strip ANSI escape codes. Defaults to true; pass "false" to keep them.
  --match        wait-output: substring to wait for.
  --regex        wait-output: regular expression to wait for.
  --timeout      wait-output / wait-status: max milliseconds to block (default 30000).

## Notes

\`wait-output\` matches output that arrives *after* the call starts. On timeout,
\`wait-output\` and \`wait-status\` print "timeout".

## Examples

\`\`\`bash
fleet pane get-output --pane "$FLEET_PANE_ID" --lines 50
fleet pane wait-output --pane "$FLEET_PANE_ID" --match "Server ready" --timeout 60000
fleet pane wait-status --pane "$FLEET_PANE_ID" --state idle
\`\`\``,
```

- [ ] **Step 9: Run tests and typecheck**

Run: `npx vitest run src/main/__tests__/fleet-cli.test.ts`
Expected: PASS — the 6 new `validateCommand` tests plus existing tests.

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 10: Commit**

```bash
git add src/main/fleet-cli.ts src/main/__tests__/fleet-cli.test.ts
git commit -m "feat(pane): add fleet pane get-output/wait-output/wait-status CLI"
```

---

### Task 8: Documentation

**Files:**
- Modify: `CHANGELOG.md`
- Modify: `CLAUDE.md`

- [ ] **Step 1: Update CHANGELOG.md**

Open `CHANGELOG.md`. Under the existing `## Unreleased` section (it already has Phase 2 bullets), add these bullets:

```markdown
- Added `fleet pane get-output` to read a pane's recent terminal output.
- Added `fleet pane wait-output` to block until a pane prints matching output (substring or regex).
- Added `fleet pane wait-status` to block until a pane's agent reaches a target activity state.
```

- [ ] **Step 2: Update CLAUDE.md**

In `CLAUDE.md`, under the `## Development Notes` section, after the existing "Agent integration installer" bullet, add:

```markdown
- **Pane wait/output commands:** `fleet pane get-output|wait-output|wait-status` let agents read a pane's recent output and block on output or agent-state conditions. Output is captured by `PaneOutputStore` (a per-pane 256 KB rolling buffer) fed from `PtyManager`'s data listener. `wait-output` subscribes to the store's `append` event; `wait-status` subscribes to the `EventBus` `activity-state-change` event. The socket handler holds the connection open until the condition is met or `timeout_ms` elapses. Note: the unused `get-output` stub in the dead `socket-command-handler.ts` is unrelated — the live commands live on `SocketServer`. See `src/main/pane-output-store.ts` and the Phase 3 plan at `docs/superpowers/plans/2026-05-21-pane-wait-commands.md`.
```

- [ ] **Step 3: Run the full verification suite**

Run: `npm run typecheck`
Expected: PASS.

Run: `npx vitest run`
Expected: PASS — all tests.

Run: `npm run build`
Expected: PASS — build succeeds (a pre-existing codemirror dynamic-import warning is expected and unrelated).

- [ ] **Step 4: Commit**

```bash
git add CHANGELOG.md CLAUDE.md
git commit -m "docs: note pane wait/output commands in CHANGELOG and CLAUDE.md"
```

---

## Notes & Deferred Items

- **Dead `get-output` stub:** `src/main/socket-command-handler.ts:180-185` has a stubbed `get-output` in the `FleetCommandHandler` system, which is **not wired into `index.ts`**. This plan implements `pane.get-output` on the live `SocketServer` instead. The dead stub is intentionally left untouched (per the repo's "mention dead code, don't delete it" guidance).
- **Soft-wrap unwrapping:** herdr "unwraps" soft-wrapped terminal lines before matching. This plan matches against raw (ANSI-stripped) bytes including hard newlines only — simpler and sufficient for "wait until X is printed". Unwrapping is deferred (YAGNI).
- **Client disconnect during a wait:** if a CLI client disconnects while a `wait-*` handler is pending, the handler still runs to its `timeout_ms` and then writes to a destroyed socket (a no-op, guarded by `sendResponse`'s `socket.destroyed` check). The `timeout_ms` bounds the leak. Detecting mid-dispatch disconnect is deferred.
- **`wait-output` matches post-call output only.** Output already in the buffer when the call starts is not matched. This is deliberate — it gives a predictable "wait for this to happen next" semantic. `get-output` is the command for inspecting already-printed output.

## Self-Review

- **Spec coverage:** `wait-output` → Task 5; `wait-status` → Task 6; `get-output` → Task 4. Supporting infrastructure (output buffer, DI, CLI) → Tasks 1-3, 7. Docs → Task 8. All three roadmap items covered.
- **Type consistency:** `PaneOutputStore` (`append`/`read`/`clear`, `append` event payload `{ paneId, data }`) is used consistently in Tasks 1, 2, 4, 5. `strArg`/`parseTimeoutMs` helpers defined in Task 4, reused in Tasks 5-6. `ActivityState` union matches `src/shared/types.ts`. `activity-state-change` event payload matches `EventBus`'s `FleetEvent`.
- **Constructor params:** `SocketServer` and `SocketSupervisor` both gain `paneOutputStore?` then `eventBus?` in that order (Task 3); `index.ts` passes them positionally in the same order. Existing test calls that stop at `activityTracker` remain valid because the new params are optional and trailing.
