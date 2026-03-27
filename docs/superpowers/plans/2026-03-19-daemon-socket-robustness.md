# Daemon Socket Robustness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Fleet's daemon socket self-healing with health probes, automatic restart, CLI retry, and startup recovery.

**Architecture:** Layered resilience — each layer (ping command, socket supervisor, sentinel health check, CLI retry, startup recovery) is independent and testable. The `SocketSupervisor` wraps `SocketServer`, monitors for failures, and restarts automatically. Sentinel probes via `ping`, CLI retries transient errors.

**Tech Stack:** Node.js `net` module, vitest, TypeScript, existing EventEmitter patterns.

**Spec:** `docs/superpowers/specs/2026-03-19-daemon-socket-robustness-design.md`

---

## File Structure

| File                                           | Action | Responsibility                                                                          |
| ---------------------------------------------- | ------ | --------------------------------------------------------------------------------------- |
| `src/main/socket-server.ts`                    | Modify | Add `ping` command, emit `server-error`/`server-close` events, add `startTime` tracking |
| `src/main/socket-supervisor.ts`                | Create | Wrap `SocketServer`, auto-restart on failure, backoff, concurrent restart guard         |
| `src/main/fleet-cli.ts`                        | Modify | Add `sendWithRetry()` with wait-for-app and ECONNREFUSED retry                          |
| `src/main/starbase/sentinel.ts`                | Modify | Add socket ping health check (sweep #8)                                                 |
| `src/main/index.ts`                            | Modify | Replace `SocketServer` with `SocketSupervisor`, remove dead `SocketApi`, startup ping   |
| `src/main/__tests__/socket-server.test.ts`     | Modify | Add ping command test                                                                   |
| `src/main/__tests__/socket-supervisor.test.ts` | Create | Supervisor restart, backoff, concurrent guard, event proxying tests                     |
| `src/main/__tests__/fleet-cli-retry.test.ts`   | Create | CLI retry tests (wait-for-app, ECONNREFUSED backoff, non-transient fail-fast)           |
| `src/main/__tests__/sentinel-socket.test.ts`   | Create | Sentinel ping check tests                                                               |

---

### Task 1: Add `ping` Command to SocketServer

**Files:**

- Modify: `src/main/socket-server.ts`
- Modify: `src/main/__tests__/socket-server.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `src/main/__tests__/socket-server.test.ts` inside the existing `describe('SocketServer')` block, after the last test:

```typescript
it('responds to ping with pong and uptime', async () => {
  await server.start();

  const response = await sendCommand(socketPath, {
    id: 'req-ping',
    command: 'ping',
    args: {}
  });

  expect(response.id).toBe('req-ping');
  expect(response.ok).toBe(true);
  expect((response.data as any).pong).toBe(true);
  expect(typeof (response.data as any).uptime).toBe('number');
  expect((response.data as any).uptime).toBeGreaterThanOrEqual(0);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/main/__tests__/socket-server.test.ts -t "responds to ping"`
Expected: FAIL — `Unknown command: ping`

- [ ] **Step 3: Add `startTime` tracking and `ping` command**

In `src/main/socket-server.ts`:

Add a `startTime` property:

```typescript
export class SocketServer extends EventEmitter {
  private server: Server | null = null;
  private clients = new Set<Socket>();
  private startTime: number | null = null;  // ADD THIS
```

Set it in `start()` after `this.server.listen(...)` resolves:

```typescript
this.server.listen(this.socketPath, () => {
  this.startTime = Date.now(); // ADD THIS
  resolve();
});
```

Add `ping` case to `dispatch()` as the first case in the switch, before `sector.list`:

```typescript
case 'ping':
  return { pong: true, uptime: this.startTime ? (Date.now() - this.startTime) / 1000 : 0 };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/main/__tests__/socket-server.test.ts -t "responds to ping"`
Expected: PASS

- [ ] **Step 5: Add `server-error` and `server-close` event emission**

The `SocketSupervisor` (Task 2) needs to know when the inner `net.Server` fails. Since `server` is private, have `SocketServer` emit events.

In `src/main/socket-server.ts`, in the `start()` method, after `this.server = createServer(...)` and before `this.server.listen(...)`, add:

```typescript
this.server.on('error', (err) => {
  this.emit('server-error', err);
});

this.server.on('close', () => {
  this.emit('server-close');
});
```

Note: The existing `this.server.on('error', reject)` inside the Promise handles startup errors. The new handler above fires for post-startup errors. Both can coexist — EventEmitter supports multiple listeners.

- [ ] **Step 6: Run all socket-server tests**

Run: `npx vitest run src/main/__tests__/socket-server.test.ts`
Expected: All tests PASS

- [ ] **Step 7: Commit**

```bash
git add src/main/socket-server.ts src/main/__tests__/socket-server.test.ts
git commit -m "feat: add ping health check command and server lifecycle events to SocketServer"
```

---

### Task 2: Create SocketSupervisor

**Files:**

- Create: `src/main/socket-supervisor.ts`
- Create: `src/main/__tests__/socket-supervisor.test.ts`

- [ ] **Step 1: Write failing tests**

Create `src/main/__tests__/socket-supervisor.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createConnection } from 'node:net';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { existsSync, unlinkSync } from 'node:fs';

let SocketSupervisor: typeof import('../socket-supervisor').SocketSupervisor;

function tmpSocket(): string {
  return join(tmpdir(), `fleet-sv-test-${Date.now()}-${Math.random().toString(36).slice(2)}.sock`);
}

function sendPing(socketPath: string): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const client = createConnection(socketPath, () => {
      client.write(JSON.stringify({ id: 'ping-1', command: 'ping', args: {} }) + '\n');
    });
    let buffer = '';
    client.on('data', (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      if (lines.length > 1 && lines[0].trim()) {
        client.end();
        try {
          resolve(JSON.parse(lines[0]));
        } catch (e) {
          reject(e);
        }
      }
    });
    client.on('error', reject);
    setTimeout(() => {
      client.destroy();
      reject(new Error('timeout'));
    }, 3000);
  });
}

function makeMockServices() {
  return {
    crewService: { listCrew: vi.fn().mockReturnValue([]) },
    missionService: { listMissions: vi.fn().mockReturnValue([]) },
    commsService: {
      getRecent: vi.fn().mockReturnValue([]),
      getUnread: vi.fn().mockReturnValue([])
    },
    sectorService: { listSectors: vi.fn().mockReturnValue([]) },
    cargoService: { listCargo: vi.fn().mockReturnValue([]) },
    supplyRouteService: { listRoutes: vi.fn().mockReturnValue([]) },
    configService: { get: vi.fn().mockReturnValue('val'), set: vi.fn() },
    shipsLog: { query: vi.fn().mockReturnValue([]) }
  } as any;
}

describe('SocketSupervisor', () => {
  let socketPath: string;
  let supervisor: InstanceType<typeof SocketSupervisor>;
  let services: ReturnType<typeof makeMockServices>;

  beforeEach(async () => {
    ({ SocketSupervisor } = await import('../socket-supervisor'));
    socketPath = tmpSocket();
    services = makeMockServices();
  });

  afterEach(async () => {
    await supervisor?.stop();
    try {
      unlinkSync(socketPath);
    } catch {}
  });

  it('starts and accepts ping', async () => {
    supervisor = new SocketSupervisor(socketPath, services);
    await supervisor.start();

    const response = await sendPing(socketPath);
    expect(response.ok).toBe(true);
    expect((response.data as any).pong).toBe(true);
  });

  it('proxies state-change events from inner SocketServer', async () => {
    supervisor = new SocketSupervisor(socketPath, services);
    await supervisor.start();

    const events: string[] = [];
    supervisor.on('state-change', (event: string) => {
      events.push(event);
    });

    // Trigger a state-change via a command that emits one
    const client = createConnection(socketPath, () => {
      client.write(
        JSON.stringify({ id: 'x', command: 'comms.send', args: { to: 'crew-1', message: 'hi' } }) +
          '\n'
      );
    });
    await new Promise<void>((resolve) => {
      client.on('data', () => {
        client.end();
        resolve();
      });
      setTimeout(() => {
        client.destroy();
        resolve();
      }, 2000);
    });

    expect(events).toContain('comms:changed');
  });

  it('exposes restart() method that restarts the server', async () => {
    supervisor = new SocketSupervisor(socketPath, services);
    await supervisor.start();

    const restartedPromise = new Promise<void>((resolve) => {
      supervisor.on('restarted', resolve);
    });

    await supervisor.restart();
    await restartedPromise;

    // Server should still respond after restart
    const response = await sendPing(socketPath);
    expect(response.ok).toBe(true);
  });

  it('concurrent restart calls are deduplicated', async () => {
    supervisor = new SocketSupervisor(socketPath, services);
    await supervisor.start();

    let restartCount = 0;
    supervisor.on('restarted', () => restartCount++);

    // Fire two restarts simultaneously
    await Promise.all([supervisor.restart(), supervisor.restart()]);
    // Wait a tick for events
    await new Promise((r) => setTimeout(r, 100));

    expect(restartCount).toBe(1);
  });

  it('stops cleanly', async () => {
    supervisor = new SocketSupervisor(socketPath, services);
    await supervisor.start();
    await supervisor.stop();
    expect(existsSync(socketPath)).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/main/__tests__/socket-supervisor.test.ts`
Expected: FAIL — `Cannot find module '../socket-supervisor'`

- [ ] **Step 3: Implement SocketSupervisor**

Create `src/main/socket-supervisor.ts`:

```typescript
import { EventEmitter } from 'node:events';
import { SocketServer, type ServiceRegistry } from './socket-server';

const MAX_RESTARTS = 5;
const WINDOW_MS = 5 * 60 * 1000; // 5 minutes
const INITIAL_BACKOFF_MS = 1000;
const MAX_BACKOFF_MS = 30_000;

export class SocketSupervisor extends EventEmitter {
  private server: SocketServer | null = null;
  private isRestarting = false;
  private isStopped = false;
  private restartTimestamps: number[] = [];
  private backoffMs = INITIAL_BACKOFF_MS;

  constructor(
    private socketPath: string,
    private services: ServiceRegistry
  ) {
    super();
  }

  async start(): Promise<void> {
    this.isStopped = false;
    this.server = this.createServer();
    await this.server.start();
  }

  async stop(): Promise<void> {
    this.isStopped = true;
    if (this.server) {
      await this.server.stop();
      this.server = null;
    }
  }

  async restart(): Promise<void> {
    if (this.isRestarting || this.isStopped) return;
    this.isRestarting = true;

    try {
      // Check sliding window
      const now = Date.now();
      this.restartTimestamps = this.restartTimestamps.filter((t) => now - t < WINDOW_MS);

      if (this.restartTimestamps.length >= MAX_RESTARTS) {
        console.error('[socket-supervisor] Max restarts exceeded in 5-minute window, giving up');
        this.emit('failed');
        return;
      }

      // Backoff delay (skip on first restart)
      if (this.restartTimestamps.length > 0) {
        await new Promise((r) => setTimeout(r, this.backoffMs));
        this.backoffMs = Math.min(this.backoffMs * 2, MAX_BACKOFF_MS);
      }

      // Stop existing server
      if (this.server) {
        try {
          await this.server.stop();
        } catch (err) {
          console.error('[socket-supervisor] Error stopping server during restart:', err);
        }
        this.server = null;
      }

      // Bail if stopped during backoff
      if (this.isStopped) return;

      // Create and start new server
      this.server = this.createServer();
      await this.server.start();

      this.restartTimestamps.push(Date.now());
      console.log('[socket-supervisor] Server restarted successfully');
      this.emit('restarted');
    } catch (err) {
      console.error('[socket-supervisor] Restart failed:', err);
      this.restartTimestamps.push(Date.now());
      // Will retry on next trigger
    } finally {
      this.isRestarting = false;
    }
  }

  private createServer(): SocketServer {
    const server = new SocketServer(this.socketPath, this.services);

    // Proxy state-change events
    server.on('state-change', (...args: unknown[]) => {
      this.emit('state-change', ...args);
    });

    // Monitor for post-startup failures
    server.on('server-error', (err: Error) => {
      console.error('[socket-supervisor] Server error detected:', err.message);
      this.restart().catch((e) => console.error('[socket-supervisor] Auto-restart failed:', e));
    });

    server.on('server-close', () => {
      if (!this.isStopped) {
        console.warn('[socket-supervisor] Server closed unexpectedly');
        this.restart().catch((e) => console.error('[socket-supervisor] Auto-restart failed:', e));
      }
    });

    return server;
  }

  /** Reset backoff after a period of stability. Call from Sentinel on successful ping. */
  resetBackoff(): void {
    this.backoffMs = INITIAL_BACKOFF_MS;
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/main/__tests__/socket-supervisor.test.ts`
Expected: All PASS

- [ ] **Step 5: Commit**

```bash
git add src/main/socket-supervisor.ts src/main/__tests__/socket-supervisor.test.ts
git commit -m "feat: add SocketSupervisor with auto-restart, backoff, and concurrent restart guard"
```

---

### Task 3: Add CLI Retry with Wait-for-App

**Files:**

- Modify: `src/main/fleet-cli.ts`
- Create: `src/main/__tests__/fleet-cli-retry.test.ts`

- [ ] **Step 1: Write failing tests**

Create `src/main/__tests__/fleet-cli-retry.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { FleetCLI } from '../fleet-cli';
import { SocketServer } from '../socket-server';
import { join } from 'path';
import { tmpdir } from 'os';
import { unlinkSync, existsSync } from 'fs';
import { createServer } from 'net';

function tmpSocket(): string {
  return join(
    tmpdir(),
    `fleet-retry-test-${Date.now()}-${Math.random().toString(36).slice(2)}.sock`
  );
}

function makeMockServices() {
  return {
    crewService: { listCrew: () => [] },
    missionService: { listMissions: () => [] },
    commsService: { getRecent: () => [], getUnread: () => [] },
    sectorService: { listSectors: () => [] },
    cargoService: { listCargo: () => [] },
    supplyRouteService: { listRoutes: () => [] },
    configService: { get: () => 'val', set: () => {} },
    shipsLog: { query: () => [] }
  } as any;
}

describe('FleetCLI.sendWithRetry', () => {
  it('succeeds immediately when socket is available', async () => {
    const socketPath = tmpSocket();
    const server = new SocketServer(socketPath, makeMockServices());
    await server.start();

    try {
      const cli = new FleetCLI(socketPath);
      const result = await cli.sendWithRetry('ping', {});
      expect(result.ok).toBe(true);
      expect((result.data as any).pong).toBe(true);
    } finally {
      await server.stop();
    }
  });

  it('retries on ECONNREFUSED and eventually fails', async () => {
    // Socket file exists but nothing is listening (create and immediately close a server)
    const socketPath = tmpSocket();
    const srv = createServer();
    await new Promise<void>((resolve) => srv.listen(socketPath, resolve));
    await new Promise<void>((resolve) => srv.close(resolve));
    // Socket file may or may not exist now — remove it to simulate ENOENT
    try {
      unlinkSync(socketPath);
    } catch {}

    const cli = new FleetCLI(socketPath);
    const result = await cli.sendWithRetry(
      'ping',
      {},
      { waitForAppMs: 0, maxRetries: 2, initialBackoffMs: 50 }
    );
    expect(result.ok).toBe(false);
  });

  it('waits for socket file to appear', async () => {
    const socketPath = tmpSocket();
    expect(existsSync(socketPath)).toBe(false);

    // Start server after 300ms delay
    const server = new SocketServer(socketPath, makeMockServices());
    setTimeout(() => server.start(), 300);

    const cli = new FleetCLI(socketPath);
    const result = await cli.sendWithRetry('ping', {}, { waitForAppMs: 3000, pollIntervalMs: 100 });

    expect(result.ok).toBe(true);
    expect((result.data as any).pong).toBe(true);

    await server.stop();
  });

  it('fails immediately on non-transient errors', async () => {
    const socketPath = tmpSocket();
    const server = new SocketServer(socketPath, makeMockServices());
    await server.start();

    try {
      const cli = new FleetCLI(socketPath);
      const result = await cli.sendWithRetry('unknown.command', {});
      // Should not retry — unknown command is not transient
      expect(result.ok).toBe(false);
      expect(result.code).toBe('NOT_FOUND');
    } finally {
      await server.stop();
    }
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/main/__tests__/fleet-cli-retry.test.ts`
Expected: FAIL — `cli.sendWithRetry is not a function`

- [ ] **Step 3: Implement `sendWithRetry`**

In `src/main/fleet-cli.ts`, add to the `FleetCLI` class after the `send()` method:

```typescript
export interface RetryOptions {
  maxRetries?: number;
  initialBackoffMs?: number;
  backoffMultiplier?: number;
  waitForAppMs?: number;
  pollIntervalMs?: number;
}

// Add this inside the FleetCLI class:

async sendWithRetry(
  command: string,
  args: Record<string, unknown>,
  opts: RetryOptions = {},
): Promise<CLIResponse> {
  const {
    maxRetries = 4,
    initialBackoffMs = 200,
    backoffMultiplier = 2,
    waitForAppMs = 15_000,
    pollIntervalMs = 500,
  } = opts;

  // Wait for socket file if it doesn't exist
  if (waitForAppMs > 0) {
    if (!existsSync(this.sockPath)) {
      process.stderr.write('Waiting for Fleet app to start...\n');
      const deadline = Date.now() + waitForAppMs;
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, pollIntervalMs));
        if (existsSync(this.sockPath)) break;
      }
      if (!existsSync(this.sockPath)) {
        return {
          id: '',
          ok: false,
          error: `Fleet app not running (no socket at ${this.sockPath})`,
          code: 'ENOENT',
        };
      }
    }
  }

  // Retry loop for transient connection errors
  let backoff = initialBackoffMs;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const result = await this.send(command, args);

    // Transient connection error codes worth retrying
    const TRANSIENT_CODES = new Set(['ECONNREFUSED', 'ENOENT', 'ECONNRESET']);

    // Non-transient errors: fail immediately
    if (!result.ok && !TRANSIENT_CODES.has(result.code ?? '')) {
      return result;
    }

    // Success or last attempt: return
    if (result.ok || attempt === maxRetries) {
      return result;
    }

    // Transient error: retry with backoff
    process.stderr.write(`Connection failed (${result.code}), retrying (${attempt + 1}/${maxRetries})...\n`);
    await new Promise((r) => setTimeout(r, backoff));
    backoff = Math.min(backoff * backoffMultiplier, 10_000);
  }

  // Should not reach here, but satisfy TypeScript
  return { id: '', ok: false, error: 'Retry exhausted', code: 'RETRY_EXHAUSTED' };
}
```

Also:

- Add `import { existsSync } from 'node:fs';` at the top of `fleet-cli.ts` (alongside existing imports)
- Place the `RetryOptions` interface right after the `CLIResponse` interface at the top of the file (outside the class)

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/main/__tests__/fleet-cli-retry.test.ts`
Expected: All PASS

- [ ] **Step 5: Wire `sendWithRetry` into `runCLI`**

In `src/main/fleet-cli.ts`, in the `runCLI()` function, change:

```typescript
// Before (around line 256):
response = await cli.send(command, args);

// After:
response = await cli.sendWithRetry(command, args);
```

- [ ] **Step 6: Run existing fleet-cli tests to ensure no regression**

Run: `npx vitest run src/main/__tests__/fleet-cli.test.ts`
Expected: All PASS

- [ ] **Step 7: Commit**

```bash
git add src/main/fleet-cli.ts src/main/__tests__/fleet-cli-retry.test.ts
git commit -m "feat: add sendWithRetry to FleetCLI with wait-for-app and ECONNREFUSED backoff"
```

---

### Task 4: Add Sentinel Socket Health Check

**Files:**

- Modify: `src/main/starbase/sentinel.ts`
- Create: `src/main/__tests__/sentinel-socket.test.ts`

- [ ] **Step 1: Write failing test**

Create `src/main/__tests__/sentinel-socket.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Sentinel } from '../starbase/sentinel';
import { SocketSupervisor } from '../socket-supervisor';
import { join } from 'path';
import { tmpdir } from 'os';
import { unlinkSync } from 'fs';

function tmpSocket(): string {
  return join(
    tmpdir(),
    `fleet-sentinel-test-${Date.now()}-${Math.random().toString(36).slice(2)}.sock`
  );
}

function makeMockServices() {
  return {
    crewService: { listCrew: vi.fn().mockReturnValue([]) },
    missionService: { listMissions: vi.fn().mockReturnValue([]) },
    commsService: {
      getRecent: vi.fn().mockReturnValue([]),
      getUnread: vi.fn().mockReturnValue([])
    },
    sectorService: { listSectors: vi.fn().mockReturnValue([]) },
    cargoService: { listCargo: vi.fn().mockReturnValue([]) },
    supplyRouteService: { listRoutes: vi.fn().mockReturnValue([]) },
    configService: { get: vi.fn().mockReturnValue('val'), set: vi.fn() },
    shipsLog: { query: vi.fn().mockReturnValue([]) }
  } as any;
}

// Minimal mock DB for Sentinel (it runs SQL queries)
function makeMockDb() {
  const prepared = {
    all: vi.fn().mockReturnValue([]),
    run: vi.fn(),
    get: vi.fn()
  };
  return {
    prepare: vi.fn().mockReturnValue(prepared)
  } as any;
}

describe('Sentinel socket health check', () => {
  let socketPath: string;
  let supervisor: SocketSupervisor;

  beforeEach(async () => {
    socketPath = tmpSocket();
    supervisor = new SocketSupervisor(socketPath, makeMockServices());
    await supervisor.start();
  });

  afterEach(async () => {
    await supervisor.stop();
    try {
      unlinkSync(socketPath);
    } catch {}
  });

  it('successful ping resets consecutive failure count', async () => {
    const configService = {
      get: vi.fn((key: string) => {
        if (key === 'lifesign_interval_sec') return 10;
        if (key === 'lifesign_timeout_sec') return 30;
        if (key === 'worktree_disk_budget_gb') return 50;
        return null;
      })
    };
    const sentinel = new Sentinel({
      db: makeMockDb(),
      configService: configService as any,
      supervisor,
      socketPath
    });

    // Run a sweep — should succeed ping
    await sentinel.runSweep();

    // No restart should have been triggered
    const restartSpy = vi.spyOn(supervisor, 'restart');
    expect(restartSpy).not.toHaveBeenCalled();
  });

  it('triggers restart after 3 consecutive ping failures', async () => {
    // Stop the supervisor so pings fail
    await supervisor.stop();

    const configService = {
      get: vi.fn((key: string) => {
        if (key === 'lifesign_interval_sec') return 10;
        if (key === 'lifesign_timeout_sec') return 30;
        if (key === 'worktree_disk_budget_gb') return 50;
        return null;
      })
    };

    // Create a new supervisor ref (stopped) just for the sentinel to call restart on
    const stoppedSupervisor = new SocketSupervisor(socketPath, makeMockServices());
    const restartSpy = vi.spyOn(stoppedSupervisor, 'restart').mockResolvedValue();

    const sentinel = new Sentinel({
      db: makeMockDb(),
      configService: configService as any,
      supervisor: stoppedSupervisor,
      socketPath
    });

    // 3 sweeps with failed pings
    await sentinel.runSweep();
    await sentinel.runSweep();
    await sentinel.runSweep();

    expect(restartSpy).toHaveBeenCalledTimes(1); // Only on 3rd failure
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/main/__tests__/sentinel-socket.test.ts`
Expected: FAIL — Sentinel constructor doesn't accept `supervisor` or `socketPath`

- [ ] **Step 3: Implement Sentinel socket ping check**

In `src/main/starbase/sentinel.ts`:

Add imports at the top:

```typescript
import { createConnection } from 'node:net';
import type { SocketSupervisor } from '../socket-supervisor';
```

Update `SentinelDeps` type:

```typescript
type SentinelDeps = {
  db: Database.Database;
  configService: ConfigService;
  eventBus?: EventBus;
  supervisor?: SocketSupervisor;
  socketPath?: string;
};
```

Add a property to track consecutive failures:

```typescript
export class Sentinel {
  private interval: ReturnType<typeof setInterval> | null = null;
  private sweepCount = 0;
  private diskCacheBytes: number | null = null;
  private diskCacheTime = 0;
  private lastAlertLevel: Record<string, string | null> = {};
  private consecutivePingFailures = 0;  // ADD THIS
```

Add the ping method and call it at the end of `runSweep()`:

```typescript
// Add at the end of runSweep(), after sweep #7 (comms rate limit reset):

// 8. Socket health check
if (this.deps.supervisor && this.deps.socketPath) {
  await this.checkSocketHealth();
}
```

Add the `checkSocketHealth` private method:

```typescript
private async checkSocketHealth(): Promise<void> {
  const { supervisor, socketPath } = this.deps;
  if (!supervisor || !socketPath) return;

  const healthy = await this.pingSocket(socketPath, 3000);

  if (healthy) {
    this.consecutivePingFailures = 0;
    supervisor.resetBackoff();
    return;
  }

  this.consecutivePingFailures++;
  console.warn(`[sentinel] Socket ping failed (${this.consecutivePingFailures}/3)`);

  if (this.consecutivePingFailures >= 3) {
    console.error('[sentinel] Socket unresponsive, triggering restart');
    this.consecutivePingFailures = 0;

    const alertLevel = 'warning';
    if (this.lastAlertLevel['socket_health'] !== alertLevel) {
      this.lastAlertLevel['socket_health'] = alertLevel;
      this.deps.db.prepare(
        "INSERT INTO comms (to_crew, type, payload) VALUES ('admiral', 'socket_restart', ?)",
      ).run(JSON.stringify({ reason: '3 consecutive ping failures' }));
      this.deps.db.prepare(
        "INSERT INTO ships_log (event_type, detail) VALUES ('socket_restart', ?)",
      ).run(JSON.stringify({ reason: '3 consecutive ping failures' }));
    }

    supervisor.restart().catch((err) => {
      console.error('[sentinel] Supervisor restart failed:', err);
    });
  }
}

private pingSocket(socketPath: string, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      socket.destroy();
      resolve(false);
    }, timeoutMs);

    const socket = createConnection(socketPath, () => {
      socket.write(JSON.stringify({ id: 'sentinel-ping', command: 'ping', args: {} }) + '\n');
    });

    let buffer = '';
    socket.on('data', (chunk) => {
      buffer += chunk.toString();
      if (buffer.includes('\n')) {
        clearTimeout(timer);
        socket.end();
        try {
          const parsed = JSON.parse(buffer.split('\n')[0]);
          resolve(parsed.ok === true && parsed.data?.pong === true);
        } catch {
          resolve(false);
        }
      }
    });

    socket.on('error', () => {
      clearTimeout(timer);
      resolve(false);
    });
  });
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/main/__tests__/sentinel-socket.test.ts`
Expected: All PASS

- [ ] **Step 5: Run existing sentinel-related tests (if any) to check for regressions**

Run: `npx vitest run src/main/__tests__/`
Expected: All PASS

- [ ] **Step 6: Commit**

```bash
git add src/main/starbase/sentinel.ts src/main/__tests__/sentinel-socket.test.ts
git commit -m "feat: add socket ping health check to Sentinel sweep loop"
```

---

### Task 5: Integrate into index.ts

**Files:**

- Modify: `src/main/index.ts`

- [ ] **Step 1: Remove dead SocketApi code**

In `src/main/index.ts`:

Remove the import (line 14):

```typescript
// DELETE: import { SocketApi } from './socket-api'
```

Remove the instantiation (line 55):

```typescript
// DELETE: const socketApi = new SocketApi(SOCKET_PATH, commandHandler)
```

Remove the stop call in `shutdownAll()` (line 672):

```typescript
// DELETE: socketApi.stop()
```

- [ ] **Step 2: Add SocketSupervisor import and variable**

Add import near the existing socket-server import:

```typescript
import { SocketSupervisor } from './socket-supervisor';
```

Change the module-level variable (around line 45):

```typescript
// Before:
let socketServer: SocketServer | null = null;

// After:
let socketSupervisor: SocketSupervisor | null = null;
```

- [ ] **Step 3: Replace SocketServer creation with SocketSupervisor**

In the starbase initialization block (around lines 217-238), replace:

```typescript
// Before:
socketServer = new SocketServer(SOCKET_PATH, {
  crewService: crewService!,
  missionService: missionService!,
  commsService: commsService!,
  sectorService: sectorService!,
  cargoService: cargoService!,
  supplyRouteService: supplyRouteService!,
  configService: configService!,
  shipsLog
});

socketServer.on('state-change', (event: string, data: unknown) => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(IPC_CHANNELS.STARBASE_STATUS_UPDATE, { event, data });
  }
});

socketServer.start().catch((err) => {
  console.error('[socket-server] Failed to start:', err);
});

// After:
socketSupervisor = new SocketSupervisor(SOCKET_PATH, {
  crewService: crewService!,
  missionService: missionService!,
  commsService: commsService!,
  sectorService: sectorService!,
  cargoService: cargoService!,
  supplyRouteService: supplyRouteService!,
  configService: configService!,
  shipsLog
});

socketSupervisor.on('state-change', (event: string, data: unknown) => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(IPC_CHANNELS.STARBASE_STATUS_UPDATE, { event, data });
  }
});

socketSupervisor.on('restarted', () => {
  console.log('[socket-supervisor] Socket server restarted');
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(IPC_CHANNELS.STARBASE_STATUS_UPDATE, {
      event: 'socket:restarted',
      data: {}
    });
  }
});

socketSupervisor.on('failed', () => {
  console.error('[socket-supervisor] Socket server permanently failed');
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(IPC_CHANNELS.STARBASE_STATUS_UPDATE, {
      event: 'socket:failed',
      data: {}
    });
  }
});

socketSupervisor.start().catch((err) => {
  console.error('[socket-supervisor] Failed to start:', err);
});
```

- [ ] **Step 4: Pass supervisor to Sentinel**

Update the Sentinel creation (around line 342):

```typescript
// Before:
sentinel = new Sentinel({ db: starbaseDb.getDb(), configService, eventBus });

// After:
sentinel = new Sentinel({
  db: starbaseDb.getDb(),
  configService,
  eventBus,
  supervisor: socketSupervisor ?? undefined,
  socketPath: SOCKET_PATH
});
```

- [ ] **Step 5: Update shutdownAll()**

In `shutdownAll()`:

```typescript
// Before:
socketServer?.stop().catch((err) => console.error('[socket-server] stop error:', err));

// After:
socketSupervisor?.stop().catch((err) => console.error('[socket-supervisor] stop error:', err));
```

- [ ] **Step 6: Remove unused SocketServer import if no longer directly used**

Check if `SocketServer` is still imported anywhere in `index.ts`. If not, remove the import:

```typescript
// DELETE if unused: import { SocketServer } from './socket-server'
```

- [ ] **Step 7: Build check**

Run: `npx electron-vite build`
Expected: Build succeeds with no TypeScript errors

- [ ] **Step 8: Run all tests**

Run: `npx vitest run`
Expected: All tests PASS

- [ ] **Step 9: Commit**

```bash
git add src/main/index.ts
git commit -m "feat: integrate SocketSupervisor into app lifecycle, remove dead SocketApi"
```

---

### Task 6: Final Verification

- [ ] **Step 1: Run full test suite**

Run: `npx vitest run`
Expected: All tests PASS

- [ ] **Step 2: Build the app**

Run: `npx electron-vite build`
Expected: Clean build, no errors

- [ ] **Step 3: Verify no linting errors in changed files**

Run: `npx eslint src/main/socket-server.ts src/main/socket-supervisor.ts src/main/fleet-cli.ts src/main/starbase/sentinel.ts src/main/index.ts`
Expected: No errors

- [ ] **Step 4: Commit any fixes**

If any fixes were needed from steps 1-3, commit them:

```bash
git add -u
git commit -m "fix: address lint and build issues in socket robustness implementation"
```
