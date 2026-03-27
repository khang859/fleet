# Admiral Claude Code Redesign — Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the custom Anthropic SDK Admiral with a Claude Code PTY instance in a managed workspace, controlled via Fleet CLI over a Unix socket.

**Architecture:** Socket Server in Electron main process receives commands from a thin Fleet CLI binary over a Unix socket, routing them to existing services. AdmiralProcess manages the Claude Code PTY lifecycle and workspace initialization. The Star Command tab renders xterm.js terminal with existing chrome (CRT frame, status bar, galaxy map).

**Tech Stack:** Node.js net module (Unix socket), node-pty (PTY), xterm.js (terminal rendering), Zustand (store), Vitest (tests)

**Spec:** `docs/superpowers/specs/2026-03-17-admiral-claude-code-redesign.md`

---

## File Structure

### New Files

- `src/main/socket-server.ts` — Unix socket server, command routing, ServiceRegistry
- `src/main/fleet-cli.ts` — CLI client logic (connects to socket, sends commands, prints output)
- `src/main/starbase/admiral-process.ts` — AdmiralProcess class (workspace init, PTY lifecycle)
- `src/main/starbase/workspace-templates.ts` — CLAUDE.md, SKILL.md, settings.json template generators
- `src/main/__tests__/socket-server.test.ts` — Socket server unit tests
- `src/main/__tests__/admiral-process.test.ts` — AdmiralProcess unit tests
- `src/main/__tests__/fleet-cli.test.ts` — Fleet CLI integration tests

### Modified Files

- `src/main/pty-manager.ts` — Add optional `env` field to `PtyCreateOptions`
- `src/main/index.ts` — Replace Admiral instantiation with SocketServer + AdmiralProcess
- `src/main/ipc-handlers.ts` — Remove Admiral handlers, add admiral:status-changed
- `src/shared/constants.ts` — Remove Admiral IPC channels, add ADMIRAL_STATUS_CHANGED
- `src/renderer/src/store/star-command-store.ts` — Simplify: remove streaming/message state, add admiralPaneId + admiralStatus
- `src/renderer/src/components/StarCommandTab.tsx` — Replace chat UI with xterm.js terminal
- `src/preload/index.ts` — Remove admiral API, add admiralProcess API

### Deleted Files

- `src/main/starbase/admiral.ts`
- `src/main/starbase/admiral-tools.ts`
- `src/main/starbase/admiral-system-prompt.ts`

---

## Task 1: Socket Server

The foundation — all Fleet CLI commands flow through this.

**Files:**

- Create: `src/main/socket-server.ts`
- Create: `src/main/__tests__/socket-server.test.ts`

- [ ] **Step 1: Write failing test for SocketServer construction and listen**

```typescript
// src/main/__tests__/socket-server.test.ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { SocketServer } from '../socket-server';
import { createConnection } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

function makeRegistry() {
  return {
    crewService: {},
    missionService: {},
    commsService: {},
    sectorService: {},
    cargoService: {},
    supplyRouteService: {},
    configService: {},
    ptyManager: {},
    createTab: vi.fn(),
    db: {}
  } as any;
}

describe('SocketServer', () => {
  let tmp: string;
  let sockPath: string;
  let server: SocketServer;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'fleet-sock-'));
    sockPath = join(tmp, 'fleet.sock');
  });

  afterEach(async () => {
    await server?.stop();
    rmSync(tmp, { recursive: true, force: true });
  });

  it('starts listening on the socket path', async () => {
    server = new SocketServer(sockPath, makeRegistry());
    await server.start();

    // Verify we can connect
    const client = createConnection(sockPath);
    await new Promise<void>((resolve, reject) => {
      client.on('connect', () => {
        client.end();
        resolve();
      });
      client.on('error', reject);
    });
  });

  it('cleans up stale socket file on start', async () => {
    // Create a stale socket file
    const { writeFileSync } = await import('node:fs');
    writeFileSync(sockPath, '');

    server = new SocketServer(sockPath, makeRegistry());
    await server.start();

    const client = createConnection(sockPath);
    await new Promise<void>((resolve, reject) => {
      client.on('connect', () => {
        client.end();
        resolve();
      });
      client.on('error', reject);
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/main/__tests__/socket-server.test.ts`
Expected: FAIL — cannot resolve `../socket-server`

- [ ] **Step 3: Implement SocketServer (listen/stop/stale cleanup)**

```typescript
// src/main/socket-server.ts
import { createServer, type Server, type Socket } from 'node:net';
import { existsSync, unlinkSync } from 'node:fs';
import type { CrewService } from './starbase/crew-service';
import type { MissionService } from './starbase/mission-service';
import type { CommsService } from './starbase/comms-service';
import type { SectorService } from './starbase/sector-service';
import type { CargoService } from './starbase/cargo-service';
import type { SupplyRouteService } from './starbase/supply-route-service';
import type { ConfigService } from './starbase/config-service';
import type { PtyManager } from './pty-manager';
import type { StarbaseDB } from './starbase/db';

export interface ServiceRegistry {
  crewService: CrewService;
  missionService: MissionService;
  commsService: CommsService;
  sectorService: SectorService;
  cargoService: CargoService;
  supplyRouteService: SupplyRouteService;
  configService: ConfigService;
  ptyManager: PtyManager;
  createTab: (label: string, cwd: string) => string;
  db: StarbaseDB;
}

export type StateChangeListener = (event: string, data: unknown) => void;

export class SocketServer {
  private server: Server | null = null;
  private clients: Set<Socket> = new Set();
  private onStateChange: StateChangeListener | null = null;

  constructor(
    private sockPath: string,
    private registry: ServiceRegistry
  ) {}

  setOnStateChange(listener: StateChangeListener): void {
    this.onStateChange = listener;
  }

  async start(): Promise<void> {
    // Clean up stale socket
    if (existsSync(this.sockPath)) {
      const isAlive = await this.probeSocket();
      if (isAlive) {
        throw new Error('Another Fleet instance is running');
      }
      unlinkSync(this.sockPath);
    }

    this.server = createServer((client) => this.handleConnection(client));

    return new Promise((resolve, reject) => {
      this.server!.on('error', reject);
      this.server!.listen(this.sockPath, () => resolve());
    });
  }

  async stop(): Promise<void> {
    for (const client of this.clients) {
      client.destroy();
    }
    this.clients.clear();

    return new Promise((resolve) => {
      if (!this.server) return resolve();
      this.server.close(() => {
        if (existsSync(this.sockPath)) unlinkSync(this.sockPath);
        this.server = null;
        resolve();
      });
    });
  }

  private async probeSocket(): Promise<boolean> {
    const { createConnection } = await import('node:net');
    return new Promise((resolve) => {
      const client = createConnection(this.sockPath);
      client.on('connect', () => {
        client.end();
        resolve(true);
      });
      client.on('error', () => resolve(false));
      setTimeout(() => {
        client.destroy();
        resolve(false);
      }, 1000);
    });
  }

  private handleConnection(client: Socket): void {
    this.clients.add(client);
    let buffer = '';

    client.on('data', (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        if (!line.trim()) continue;
        this.handleRequest(client, line);
      }
    });

    client.on('close', () => this.clients.delete(client));
    client.on('error', () => this.clients.delete(client));
  }

  private async handleRequest(client: Socket, raw: string): Promise<void> {
    let id: string | undefined;
    try {
      const req = JSON.parse(raw);
      id = req.id;
      const result = await this.dispatch(req.command, req.args ?? {});
      const response = JSON.stringify({ id, ok: true, data: result });
      client.write(response + '\n');
    } catch (err: any) {
      const response = JSON.stringify({
        id,
        ok: false,
        error: err.message ?? 'Unknown error',
        code: err.code ?? 'INTERNAL_ERROR'
      });
      client.write(response + '\n');
    }
  }

  private async dispatch(command: string, args: Record<string, any>): Promise<unknown> {
    const {
      crewService,
      missionService,
      commsService,
      sectorService,
      cargoService,
      supplyRouteService,
      configService,
      ptyManager,
      createTab,
      db
    } = this.registry;

    switch (command) {
      // Sector commands
      case 'sector.list':
        return sectorService.listSectors();
      case 'sector.info':
        return sectorService.getSector(args.id ?? args.sectorId ?? args.name);
      case 'sector.add':
        return sectorService.addSector(args);
      case 'sector.remove':
        return sectorService.removeSector(args.id ?? args.sectorId ?? args.name);

      // Mission commands
      case 'mission.create': {
        const missionOpts = {
          sectorId: args.sector ?? args.sectorId,
          summary: args.summary,
          prompt: args.prompt
        };
        const result = missionService.createMission(missionOpts);
        this.emitStateChange('mission:changed', result);
        return result;
      }
      case 'mission.list':
        return missionService.listMissions(args);
      case 'mission.status':
        return missionService.getMission(args.id ?? args.missionId);
      case 'mission.cancel': {
        const result = missionService.abortMission(args.id ?? args.missionId);
        this.emitStateChange('mission:changed', result);
        return result;
      }

      // Crew commands
      case 'crew.list':
        return crewService.listCrew();
      case 'crew.deploy': {
        const deployOpts = {
          sectorId: args.sector ?? args.sectorId,
          prompt: args.prompt ?? args.summary ?? '',
          missionId: args.mission ? Number(args.mission) : args.missionId
        };
        const result = await crewService.deployCrew(deployOpts, ptyManager, createTab);
        this.emitStateChange('crew:changed', result);
        return result;
      }
      case 'crew.recall': {
        const crewId = args.crewId ?? args.id;
        await crewService.recallCrew(crewId, ptyManager);
        this.emitStateChange('crew:changed', { crewId });
        return { crewId, status: 'recalled' };
      }
      case 'crew.observe': {
        const raw = crewService.observeCrew(args.crewId ?? args.id);
        // Strip ANSI escape codes to save Admiral context tokens
        return typeof raw === 'string' ? raw.replace(/\x1B\[[0-9;]*[a-zA-Z]/g, '') : raw;
      }

      // Comms commands
      case 'comms.list':
        return commsService.listTransmissions(args);
      case 'comms.read':
        return commsService.readTransmission(args.id ?? args.transmissionId);
      case 'comms.send': {
        const sendOpts = {
          from: 'admiral',
          to: args.to,
          type: args.type ?? 'directive',
          payload: args.message ?? args.payload ?? args._positional?.[0] ?? ''
        };
        const result = commsService.send(sendOpts);
        this.emitStateChange('comms:changed', result);
        return result;
      }
      case 'comms.check':
        return { unread: commsService.getUnread('admiral').length };

      // Cargo commands
      case 'cargo.list':
        return cargoService.listCargo(args);
      case 'cargo.inspect':
        return cargoService.getCargo(args.cargoId);

      // Supply route commands
      case 'supply-route.list':
        return supplyRouteService.listRoutes();
      case 'supply-route.add':
        return supplyRouteService.addRoute(args);
      case 'supply-route.remove':
        return supplyRouteService.removeRoute(args.routeId);

      // Config commands
      case 'config.get':
        return configService.get(args.key);
      case 'config.set':
        return configService.set(args.key, args.value);

      // Log commands
      case 'log.show':
        return db
          .prepare(
            'SELECT * FROM ships_log WHERE (? IS NULL OR crew_id = ?) ORDER BY created_at DESC LIMIT ?'
          )
          .all(args.crew ?? null, args.crew ?? null, args.last ? Number(args.last) : 20);

      default:
        const err = new Error(`Unknown command: ${command}`);
        (err as any).code = 'NOT_FOUND';
        throw err;
    }
  }

  private emitStateChange(event: string, data: unknown): void {
    this.onStateChange?.(event, data);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/main/__tests__/socket-server.test.ts`
Expected: PASS (2 tests)

- [ ] **Step 5: Write failing test for command dispatch**

Add to `src/main/__tests__/socket-server.test.ts`:

```typescript
it('dispatches sector.list and returns result', async () => {
  const registry = makeRegistry();
  registry.sectorService.listSectors = vi
    .fn()
    .mockReturnValue([{ id: 1, name: 'api', root_path: '/tmp/api' }]);

  server = new SocketServer(sockPath, registry);
  await server.start();

  const result = await sendCommand(sockPath, {
    id: 'req-1',
    command: 'sector.list',
    args: {}
  });

  expect(result).toEqual({
    id: 'req-1',
    ok: true,
    data: [{ id: 1, name: 'api', root_path: '/tmp/api' }]
  });
});

it('returns error for unknown command', async () => {
  server = new SocketServer(sockPath, makeRegistry());
  await server.start();

  const result = await sendCommand(sockPath, {
    id: 'req-2',
    command: 'nonexistent',
    args: {}
  });

  expect(result.ok).toBe(false);
  expect(result.code).toBe('NOT_FOUND');
});

// Helper
function sendCommand(sockPath: string, req: any): Promise<any> {
  return new Promise((resolve, reject) => {
    const client = createConnection(sockPath);
    let buffer = '';
    client.on('data', (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      for (const line of lines) {
        if (!line.trim()) continue;
        client.end();
        resolve(JSON.parse(line));
      }
    });
    client.on('error', reject);
    client.on('connect', () => {
      client.write(JSON.stringify(req) + '\n');
    });
  });
}
```

- [ ] **Step 6: Run test to verify it passes**

Run: `npx vitest run src/main/__tests__/socket-server.test.ts`
Expected: PASS (4 tests). The dispatch logic is already implemented.

- [ ] **Step 7: Write failing test for state change events**

Add to `src/main/__tests__/socket-server.test.ts`:

```typescript
it('emits state change events on mutating commands', async () => {
  const registry = makeRegistry();
  registry.commsService.send = vi.fn().mockReturnValue(42);

  server = new SocketServer(sockPath, registry);
  const events: any[] = [];
  server.setOnStateChange((event, data) => events.push({ event, data }));
  await server.start();

  await sendCommand(sockPath, {
    id: 'req-3',
    command: 'comms.send',
    args: { from: 'admiral', to: 'crew-1', type: 'directive', payload: 'hello' }
  });

  expect(events).toHaveLength(1);
  expect(events[0]).toEqual({ event: 'comms:changed', data: 42 });
});
```

- [ ] **Step 8: Run test to verify it passes**

Run: `npx vitest run src/main/__tests__/socket-server.test.ts`
Expected: PASS (5 tests)

- [ ] **Step 9: Commit**

```bash
git add src/main/socket-server.ts src/main/__tests__/socket-server.test.ts
git commit -m "feat: add SocketServer with Unix socket command routing and state change events"
```

---

## Task 2: Fleet CLI Client

The thin CLI binary that the Admiral's Claude Code calls via bash.

**Files:**

- Create: `src/main/fleet-cli.ts`
- Create: `src/main/__tests__/fleet-cli.test.ts`

- [ ] **Step 1: Write failing test for CLI client connection and command send**

```typescript
// src/main/__tests__/fleet-cli.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { SocketServer } from '../socket-server';
import { FleetCLI } from '../fleet-cli';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

describe('FleetCLI', () => {
  let tmp: string;
  let sockPath: string;
  let server: SocketServer;
  let cli: FleetCLI;

  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), 'fleet-cli-'));
    sockPath = join(tmp, 'fleet.sock');

    const registry = {
      sectorService: {
        listSectors: () => [{ id: 1, name: 'api', root_path: '/tmp/api' }]
      },
      commsService: {
        getUnread: () => [
          { id: 1, payload: 'test' },
          { id: 2, payload: 'test2' }
        ],
        listTransmissions: () => []
      }
    } as any;

    server = new SocketServer(sockPath, registry);
    await server.start();
    cli = new FleetCLI(sockPath);
  });

  afterEach(async () => {
    await server?.stop();
    rmSync(tmp, { recursive: true, force: true });
  });

  it('sends a command and returns parsed result', async () => {
    const result = await cli.send('sector.list', {});
    expect(result.ok).toBe(true);
    expect(result.data).toEqual([{ id: 1, name: 'api', root_path: '/tmp/api' }]);
  });

  it('times out if server does not respond', async () => {
    await server.stop();
    await expect(cli.send('sector.list', {}, 500)).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/main/__tests__/fleet-cli.test.ts`
Expected: FAIL — cannot resolve `../fleet-cli`

- [ ] **Step 3: Implement FleetCLI client**

```typescript
// src/main/fleet-cli.ts
import { createConnection, type Socket } from 'node:net';
import { randomUUID } from 'node:crypto';

export interface CLIResponse {
  id: string;
  ok: boolean;
  data?: unknown;
  error?: string;
  code?: string;
}

export class FleetCLI {
  constructor(private sockPath: string) {}

  async send(command: string, args: Record<string, any>, timeoutMs = 60_000): Promise<CLIResponse> {
    const id = randomUUID();
    const req = JSON.stringify({ id, command, args }) + '\n';

    return new Promise((resolve, reject) => {
      const client = createConnection(this.sockPath);
      let buffer = '';
      const timer = setTimeout(() => {
        client.destroy();
        reject(new Error(`Timeout waiting for response to ${command}`));
      }, timeoutMs);

      client.on('connect', () => client.write(req));

      client.on('data', (chunk) => {
        buffer += chunk.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          if (!line.trim()) continue;
          clearTimeout(timer);
          client.end();
          resolve(JSON.parse(line));
          return;
        }
      });

      client.on('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });
  }
}

// --- CLI entrypoint (for ~/.fleet/lib/fleet-cli.js) ---

function stripAnsi(str: string): string {
  return str.replace(/\x1B\[[0-9;]*[a-zA-Z]/g, '');
}

function formatTable(rows: Record<string, any>[], columns?: string[]): string {
  if (rows.length === 0) return '(none)';
  const keys = columns ?? Object.keys(rows[0]);
  const widths = keys.map((k) => Math.max(k.length, ...rows.map((r) => String(r[k] ?? '').length)));
  const header = keys.map((k, i) => k.padEnd(widths[i])).join('  ');
  const sep = widths.map((w) => '-'.repeat(w)).join('  ');
  const body = rows
    .map((r) => keys.map((k, i) => String(r[k] ?? '').padEnd(widths[i])).join('  '))
    .join('\n');
  return `${header}\n${sep}\n${body}`;
}

export async function runCLI(argv: string[], sockPath: string): Promise<string> {
  const cli = new FleetCLI(sockPath);
  const [group, action, ...rest] = argv;
  const args = parseArgs(rest);
  const quiet = !!args.quiet;
  delete args.quiet;

  if (!group || group === '--help') {
    return `Usage: fleet <group> <action> [options]

Groups: crew, mission, comms, sector, cargo, supply-route, config, log

Run 'fleet <group> --help' for details.`;
  }

  const command = `${group}.${action}`;

  let result: CLIResponse;
  try {
    result = await cli.send(command, args);
  } catch (err: any) {
    // In quiet mode (used by hooks), swallow all errors silently
    if (quiet) return '';
    return `Error: ${err.message}`;
  }

  if (!result.ok) {
    if (quiet) return '';
    return `Error: ${result.error}`;
  }

  // Format output based on command
  if (command === 'comms.check') {
    const { unread } = result.data as { unread: number };
    if (unread === 0) return '';
    return `${unread} unread transmission(s) — run: fleet comms list --unread`;
  }

  if (Array.isArray(result.data)) {
    return formatTable(result.data);
  }

  if (typeof result.data === 'string') {
    return stripAnsi(result.data);
  }

  if (typeof result.data === 'object' && result.data !== null) {
    return Object.entries(result.data)
      .map(([k, v]) => `${k}: ${typeof v === 'string' ? stripAnsi(v) : v}`)
      .join('\n');
  }

  return String(result.data ?? 'OK');
}

// CLI entrypoint — this is what gets written to ~/.fleet/lib/fleet-cli.js
// When run as a script, it reads the socket path and calls runCLI
if (typeof process !== 'undefined' && process.argv[1]?.endsWith('fleet-cli.js')) {
  const { join } = await import('node:path');
  const { homedir } = await import('node:os');
  const sockPath = join(homedir(), '.fleet', 'fleet.sock');
  const output = await runCLI(process.argv.slice(2), sockPath);
  if (output) process.stdout.write(output + '\n');
}

function parseArgs(rest: string[]): Record<string, any> {
  const args: Record<string, any> = {};
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg.startsWith('--')) {
      const key = arg.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      const next = rest[i + 1];
      if (!next || next.startsWith('--')) {
        args[key] = true;
      } else {
        args[key] = next;
        i++;
      }
    } else {
      // Positional: first positional is the ID for single-resource commands
      if (!args._positional) args._positional = [];
      args._positional.push(arg);
    }
  }

  // Map common positional patterns
  if (args._positional?.length === 1) {
    // Single positional arg is usually an ID
    args.id = args._positional[0];
  }
  delete args._positional;

  return args;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/main/__tests__/fleet-cli.test.ts`
Expected: PASS (2 tests)

- [ ] **Step 5: Write failing test for runCLI formatting**

Add to `src/main/__tests__/fleet-cli.test.ts`:

```typescript
import { runCLI } from '../fleet-cli';

it('formats comms.check with 0 unread as empty string', async () => {
  const registry = {
    commsService: {
      getUnread: () => []
    }
  } as any;
  server = new SocketServer(sockPath, registry);
  await server.start();

  const output = await runCLI(['comms', 'check'], sockPath);
  expect(output).toBe('');
});

it('formats comms.check with N unread as notification', async () => {
  const output = await runCLI(['comms', 'check'], sockPath);
  expect(output).toContain('2 unread');
});

it('formats sector.list as table', async () => {
  const output = await runCLI(['sector', 'list'], sockPath);
  expect(output).toContain('api');
  expect(output).toContain('/tmp/api');
});
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx vitest run src/main/__tests__/fleet-cli.test.ts`
Expected: PASS (5 tests)

- [ ] **Step 7: Commit**

```bash
git add src/main/fleet-cli.ts src/main/__tests__/fleet-cli.test.ts
git commit -m "feat: add Fleet CLI client with socket communication and output formatting"
```

---

## Task 3: Workspace Templates

Template generators for CLAUDE.md, SKILL.md, and settings.json.

**Files:**

- Create: `src/main/starbase/workspace-templates.ts`
- Create: `src/main/__tests__/workspace-templates.test.ts`

- [ ] **Step 1: Write failing test for CLAUDE.md generation**

```typescript
// src/main/__tests__/workspace-templates.test.ts
import { describe, it, expect } from 'vitest';
import {
  generateClaudeMd,
  generateSkillMd,
  generateSettings,
  updateAutoSection
} from '../starbase/workspace-templates';

describe('workspace-templates', () => {
  describe('generateClaudeMd', () => {
    it('generates CLAUDE.md with starbase name and sectors', () => {
      const result = generateClaudeMd({
        starbaseName: 'Horizon',
        sectors: [
          { name: 'api', root_path: '/projects/api', stack: 'node', base_branch: 'main' },
          { name: 'web', root_path: '/projects/web', stack: 'react', base_branch: 'main' }
        ]
      });

      expect(result).toContain('# Admiral — Horizon');
      expect(result).toContain('## Prime Directive');
      expect(result).toContain('fleet:auto-start:sectors');
      expect(result).toContain('**api**');
      expect(result).toContain('**web**');
      expect(result).toContain('fleet:auto-end:sectors');
    });
  });

  describe('updateAutoSection', () => {
    it('replaces content between markers, preserving surrounding text', () => {
      const existing = `# Admiral — Horizon

Some custom notes the admiral wrote.

## Sectors
<!-- fleet:auto-start:sectors -->
- **old-sector** — /old/path
<!-- fleet:auto-end:sectors -->

## My Learnings
I learned something important.`;

      const result = updateAutoSection(
        existing,
        'sectors',
        '- **new-sector** — /new/path (go, base: main)'
      );

      expect(result).toContain('Some custom notes');
      expect(result).toContain('**new-sector**');
      expect(result).not.toContain('**old-sector**');
      expect(result).toContain('My Learnings');
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/main/__tests__/workspace-templates.test.ts`
Expected: FAIL — cannot resolve `../starbase/workspace-templates`

- [ ] **Step 3: Implement workspace templates**

```typescript
// src/main/starbase/workspace-templates.ts

interface SectorInfo {
  name: string;
  root_path: string;
  stack?: string;
  base_branch?: string;
}

interface ClaudeMdOptions {
  starbaseName: string;
  sectors: SectorInfo[];
}

export function generateClaudeMd(opts: ClaudeMdOptions): string {
  const sectorLines = opts.sectors
    .map(
      (s) =>
        `- **${s.name}** — ${s.root_path} (${s.stack ?? 'unknown'}, base: ${s.base_branch ?? 'main'})`
    )
    .join('\n');

  return `# Admiral — ${opts.starbaseName}

You are the Admiral of this starbase. You coordinate crew, manage missions,
and oversee all sectors.

## Prime Directive

Your most important job is decomposition. When given a task:
1. Break it into the smallest possible missions
2. Each mission must be completable in a single Claude Code run
3. A mission should have ONE clear objective and take <15 minutes
4. If a mission needs human input or clarification, it's too big — split it
5. Never create a mission that requires interactive input

## Fleet CLI

Use the \`fleet\` command to manage your starbase. See the /fleet skill for
full reference and workflows.

## Sectors
<!-- fleet:auto-start:sectors -->
${sectorLines || '(no sectors registered)'}
<!-- fleet:auto-end:sectors -->

## Rules
- Always check comms before starting new work
- Scope missions tightly — one clear objective per crewmate
- Ask for clarification rather than guessing
- Write docs and learnings in this workspace — they persist across sessions
- On fresh start, run \`fleet crew list\` and \`fleet mission list\` to get situational awareness
`;
}

export function generateSkillMd(): string {
  return `---
name: fleet
description: Manage your starbase — deploy crew, assign missions, check comms, and coordinate across sectors
---

# Fleet Starbase Management

You are the Admiral. Use the \`fleet\` CLI to manage your starbase.

## Core Workflow

1. Check comms: \`fleet comms list --unread\`
2. Review crew status: \`fleet crew list\`
3. Review mission queue: \`fleet mission list\`
4. Take action based on what you find

## When to Deploy Crew vs Do It Yourself

**Deploy crew when:**
- The task requires working in a sector's codebase
- The task is well-scoped with clear acceptance criteria
- Multiple tasks can run in parallel across sectors

**Do it yourself when:**
- The task is about planning, writing docs, or thinking
- You need to coordinate across multiple sectors first
- The user is asking a question, not requesting work

## Command Reference

### Crew
- \`fleet crew list\` — show all active crew and their status
- \`fleet crew deploy --sector <name> --mission <id>\` — deploy a crewmate
- \`fleet crew recall <crewId>\` — recall a crewmate
- \`fleet crew observe <crewId>\` — see recent output from a crewmate's terminal

### Missions
- \`fleet mission create --sector <name> --summary "..." --prompt "..."\` — create a mission
- \`fleet mission list [--status pending|active|complete]\` — list missions
- \`fleet mission status <id>\` — detailed mission status
- \`fleet mission cancel <id>\` — cancel a queued mission

### Comms
- \`fleet comms list [--unread]\` — list transmissions
- \`fleet comms read <id>\` — read a transmission and mark as read
- \`fleet comms send --to <crewId> "message"\` — send a directive
- \`fleet comms check\` — quick unread count

### Sectors
- \`fleet sector list\` — list all registered sectors
- \`fleet sector info <name>\` — sector details (path, stack, branch)

### Cargo
- \`fleet cargo list [--sector <name>]\` — list artifacts produced by crew
- \`fleet cargo inspect <id>\` — inspect an artifact

### Log
- \`fleet log show [--crew <id>] [--last 20]\` — view ships log

## Mission Scoping

When creating missions:
- One clear objective per mission
- Include acceptance criteria in the prompt
- The full \`-p\` prompt should fit in a paragraph
- If you can't describe the mission in one sentence, split it
- Specify the verify command if the sector has tests
- Break large tasks into multiple missions

## Handling Comms

When crew sends a transmission:
- Read it promptly via \`fleet comms read <id>\`
- If they need clarification, respond via \`fleet comms send --to <crewId> "message"\`
- If they're blocked, consider recalling and redeploying with a better prompt
- If they report completion, check cargo and verify

## PR Review Workflow

When you receive a \`pr_review_request\` comm:
1. Read the comms to get the PR details
2. Use \`gh pr diff <number>\` to review the changes
3. Provide feedback via \`fleet comms send\` or approve via \`gh pr review\`

## Recovery (Fresh Start)

On startup or restart, you lose conversation context. Immediately:
1. Run \`fleet crew list\` — check for active crew
2. Run \`fleet mission list\` — check mission queue
3. Run \`fleet comms list --unread\` — catch up on transmissions
4. Review \`docs/\` and \`learnings/\` for accumulated knowledge

## Error Handling

- "Worktree limit reached" → recall idle crew or wait for missions to complete
- "Sector not found" → run \`fleet sector list\` to check available sectors
- "Socket not connected" → Fleet app may not be running, wait and retry
`;
}

export function generateSettings(): string {
  return JSON.stringify(
    {
      hooks: {
        PreToolUse: [
          {
            command: 'fleet comms check --quiet',
            description: 'Check for unread transmissions before taking action'
          }
        ]
      }
    },
    null,
    2
  );
}

export function updateAutoSection(
  content: string,
  sectionName: string,
  newContent: string
): string {
  const startMarker = `<!-- fleet:auto-start:${sectionName} -->`;
  const endMarker = `<!-- fleet:auto-end:${sectionName} -->`;

  const startIdx = content.indexOf(startMarker);
  const endIdx = content.indexOf(endMarker);

  if (startIdx === -1 || endIdx === -1) return content;

  return (
    content.slice(0, startIdx + startMarker.length) +
    '\n' +
    newContent +
    '\n' +
    content.slice(endIdx)
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/main/__tests__/workspace-templates.test.ts`
Expected: PASS (2 tests)

- [ ] **Step 5: Write failing test for generateSkillMd and generateSettings**

Add to `src/main/__tests__/workspace-templates.test.ts`:

```typescript
describe('generateSkillMd', () => {
  it('generates SKILL.md with frontmatter and command reference', () => {
    const result = generateSkillMd();
    expect(result).toContain('name: fleet');
    expect(result).toContain('fleet crew deploy');
    expect(result).toContain('## Mission Scoping');
    expect(result).toContain('## PR Review Workflow');
    expect(result).toContain('## Recovery');
  });
});

describe('generateSettings', () => {
  it('generates settings.json with PreToolUse hook', () => {
    const result = generateSettings();
    const parsed = JSON.parse(result);
    expect(parsed.hooks.PreToolUse).toHaveLength(1);
    expect(parsed.hooks.PreToolUse[0].command).toContain('fleet comms check');
  });
});
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx vitest run src/main/__tests__/workspace-templates.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 7: Commit**

```bash
git add src/main/starbase/workspace-templates.ts src/main/__tests__/workspace-templates.test.ts
git commit -m "feat: add workspace template generators for CLAUDE.md, SKILL.md, and settings.json"
```

---

## Task 4: Extend PtyManager + AdmiralProcess

Add `env` support to PtyManager, then implement workspace initialization and PTY lifecycle.

**Files:**

- Modify: `src/main/pty-manager.ts` — add optional `env` field to `PtyCreateOptions`
- Create: `src/main/starbase/admiral-process.ts`
- Create: `src/main/__tests__/admiral-process.test.ts`

- [ ] **Step 0: Add `env` field to PtyCreateOptions**

In `src/main/pty-manager.ts`, add `env?: Record<string, string>` to `PtyCreateOptions` (line 4-11). Then use it in `create()` (line 47):

```typescript
// PtyCreateOptions — add:
env?: Record<string, string>;

// In create(), line 47, change:
env: process.env as Record<string, string>,
// to:
env: opts.env ?? process.env as Record<string, string>,
```

- [ ] **Step 1: Write failing test for ensureWorkspace**

```typescript
// src/main/__tests__/admiral-process.test.ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { AdmiralProcess } from '../starbase/admiral-process';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

describe('AdmiralProcess', () => {
  let tmp: string;
  let workspace: string;
  let admiral: AdmiralProcess;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'fleet-admiral-'));
    workspace = join(tmp, 'admiral');
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  describe('ensureWorkspace', () => {
    it('creates workspace directory structure and files', async () => {
      admiral = new AdmiralProcess({
        workspace,
        starbaseName: 'TestBase',
        sectors: [{ name: 'api', root_path: '/tmp/api', stack: 'node', base_branch: 'main' }],
        ptyManager: {} as any,
        fleetBinPath: '/tmp/fleet/bin'
      });

      await admiral.ensureWorkspace();

      expect(existsSync(join(workspace, 'CLAUDE.md'))).toBe(true);
      expect(existsSync(join(workspace, '.claude', 'skills', 'fleet', 'SKILL.md'))).toBe(true);
      expect(existsSync(join(workspace, '.claude', 'settings.json'))).toBe(true);
      expect(existsSync(join(workspace, 'docs'))).toBe(true);
      expect(existsSync(join(workspace, 'learnings'))).toBe(true);
      expect(existsSync(join(workspace, '.git'))).toBe(true);

      const claude = readFileSync(join(workspace, 'CLAUDE.md'), 'utf-8');
      expect(claude).toContain('Admiral — TestBase');
      expect(claude).toContain('**api**');
    });

    it('updates auto-generated sections on re-run without overwriting custom content', async () => {
      admiral = new AdmiralProcess({
        workspace,
        starbaseName: 'TestBase',
        sectors: [{ name: 'api', root_path: '/tmp/api', stack: 'node', base_branch: 'main' }],
        ptyManager: {} as any,
        fleetBinPath: '/tmp/fleet/bin'
      });

      await admiral.ensureWorkspace();

      // Simulate Admiral adding custom content
      const { writeFileSync } = await import('node:fs');
      const claudePath = join(workspace, 'CLAUDE.md');
      let content = readFileSync(claudePath, 'utf-8');
      content = content.replace('## Rules', '## My Notes\nI learned something.\n\n## Rules');
      writeFileSync(claudePath, content);

      // Re-run with different sectors
      admiral = new AdmiralProcess({
        workspace,
        starbaseName: 'TestBase',
        sectors: [{ name: 'web', root_path: '/tmp/web', stack: 'react', base_branch: 'main' }],
        ptyManager: {} as any,
        fleetBinPath: '/tmp/fleet/bin'
      });

      await admiral.ensureWorkspace();

      const updated = readFileSync(claudePath, 'utf-8');
      expect(updated).toContain('My Notes');
      expect(updated).toContain('I learned something');
      expect(updated).toContain('**web**');
      expect(updated).not.toContain('**api**');
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/main/__tests__/admiral-process.test.ts`
Expected: FAIL — cannot resolve `../starbase/admiral-process`

- [ ] **Step 3: Implement AdmiralProcess**

```typescript
// src/main/starbase/admiral-process.ts
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execSync } from 'node:child_process';
import {
  generateClaudeMd,
  generateSkillMd,
  generateSettings,
  updateAutoSection
} from './workspace-templates';
import type { PtyManager } from '../pty-manager';

interface SectorInfo {
  name: string;
  root_path: string;
  stack?: string;
  base_branch?: string;
}

export interface AdmiralProcessOpts {
  workspace: string;
  starbaseName: string;
  sectors: SectorInfo[];
  ptyManager: PtyManager;
  fleetBinPath: string;
}

export type AdmiralStatus = 'running' | 'stopped' | 'starting';

export class AdmiralProcess {
  readonly workspace: string;
  private starbaseName: string;
  private sectors: SectorInfo[];
  private ptyManager: PtyManager;
  private fleetBinPath: string;

  paneId: string | null = null;
  status: AdmiralStatus = 'stopped';

  private onStatusChange: ((status: AdmiralStatus, error?: string) => void) | null = null;

  constructor(opts: AdmiralProcessOpts) {
    this.workspace = opts.workspace;
    this.starbaseName = opts.starbaseName;
    this.sectors = opts.sectors;
    this.ptyManager = opts.ptyManager;
    this.fleetBinPath = opts.fleetBinPath;
  }

  setOnStatusChange(listener: (status: AdmiralStatus, error?: string) => void): void {
    this.onStatusChange = listener;
  }

  updateSectors(sectors: SectorInfo[]): void {
    this.sectors = sectors;
  }

  async ensureWorkspace(): Promise<void> {
    // Create directories
    const dirs = [
      this.workspace,
      join(this.workspace, '.claude', 'skills', 'fleet'),
      join(this.workspace, 'docs'),
      join(this.workspace, 'learnings')
    ];
    for (const dir of dirs) {
      mkdirSync(dir, { recursive: true });
    }

    // Git init if needed
    if (!existsSync(join(this.workspace, '.git'))) {
      execSync('git init', { cwd: this.workspace, stdio: 'ignore' });
    }

    // CLAUDE.md — update auto sections if exists, generate fresh if not
    const claudePath = join(this.workspace, 'CLAUDE.md');
    if (existsSync(claudePath)) {
      let content = readFileSync(claudePath, 'utf-8');
      const sectorLines = this.sectors
        .map(
          (s) =>
            `- **${s.name}** — ${s.root_path} (${s.stack ?? 'unknown'}, base: ${s.base_branch ?? 'main'})`
        )
        .join('\n');
      content = updateAutoSection(content, 'sectors', sectorLines || '(no sectors registered)');
      writeFileSync(claudePath, content);
    } else {
      writeFileSync(
        claudePath,
        generateClaudeMd({
          starbaseName: this.starbaseName,
          sectors: this.sectors
        })
      );
    }

    // SKILL.md — always overwrite (managed by Fleet, not Admiral-authored)
    writeFileSync(
      join(this.workspace, '.claude', 'skills', 'fleet', 'SKILL.md'),
      generateSkillMd()
    );

    // settings.json — always overwrite
    writeFileSync(join(this.workspace, '.claude', 'settings.json'), generateSettings());
  }

  async start(): Promise<string> {
    this.status = 'starting';
    this.onStatusChange?.('starting');

    await this.ensureWorkspace();

    try {
      const env = { ...process.env } as Record<string, string>;
      env.PATH = `${this.fleetBinPath}:${env.PATH ?? ''}`;

      const admiralPaneId = `admiral-${Date.now()}`;
      const { paneId } = this.ptyManager.create({
        paneId: admiralPaneId,
        cwd: this.workspace,
        cmd: 'claude --dangerously-skip-permissions',
        env
      });

      this.paneId = paneId;
      this.status = 'running';
      this.onStatusChange?.('running');

      this.ptyManager.protect(paneId);

      this.ptyManager.onExit(paneId, () => {
        this.paneId = null;
        this.status = 'stopped';
        this.onStatusChange?.('stopped');
      });

      return paneId;
    } catch (err: any) {
      this.status = 'stopped';
      const msg = err.message?.includes('ENOENT')
        ? 'Claude Code not found. Install with: npm install -g @anthropic-ai/claude-code'
        : err.message;
      this.onStatusChange?.('stopped', msg);
      throw err;
    }
  }

  async stop(): Promise<void> {
    if (this.paneId) {
      this.ptyManager.kill(this.paneId);
      this.paneId = null;
    }
    this.status = 'stopped';
    this.onStatusChange?.('stopped');
  }

  async restart(): Promise<string> {
    await this.stop();
    return this.start();
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/main/__tests__/admiral-process.test.ts`
Expected: PASS (2 tests)

- [ ] **Step 5: Commit**

```bash
git add src/main/starbase/admiral-process.ts src/main/__tests__/admiral-process.test.ts
git commit -m "feat: add AdmiralProcess with workspace initialization and PTY lifecycle"
```

---

## Task 5: Wire Socket Server + AdmiralProcess into Main Process

Connect the new components to the Electron app bootstrap.

**Files:**

- Modify: `src/main/index.ts` — replace Admiral with SocketServer + AdmiralProcess
- Modify: `src/main/ipc-handlers.ts` — remove Admiral handlers, add admiral:status-changed
- Modify: `src/shared/constants.ts` — update IPC channels

- [ ] **Step 1: Update IPC channels in constants.ts**

Read `src/shared/constants.ts` and remove Admiral streaming channels (lines ~47-52), add `ADMIRAL_STATUS_CHANGED` and `ADMIRAL_RESTART`.

In `src/shared/constants.ts`, remove:

```typescript
ADMIRAL_SEND: 'admiral:send-message',
ADMIRAL_GET_HISTORY: 'admiral:get-history',
ADMIRAL_RESET: 'admiral:reset',
ADMIRAL_STREAM_CHUNK: 'admiral:stream-chunk',
ADMIRAL_STREAM_END: 'admiral:stream-end',
ADMIRAL_STREAM_ERROR: 'admiral:stream-error',
```

Add:

```typescript
ADMIRAL_STATUS_CHANGED: 'admiral:status-changed',
ADMIRAL_RESTART: 'admiral:restart',
ADMIRAL_PANE_ID: 'admiral:pane-id',
```

- [ ] **Step 2: Update ipc-handlers.ts**

Remove the Admiral handlers block (lines ~203-229). Remove `admiral` parameter from `registerIpcHandlers`. Add new handlers for admiral status:

```typescript
// Add to registerIpcHandlers params:
admiralProcess?: AdmiralProcess | null

// Add these handlers:
if (admiralProcess) {
  ipcMain.handle(IPC_CHANNELS.ADMIRAL_PANE_ID, () => admiralProcess.paneId)
  ipcMain.handle(IPC_CHANNELS.ADMIRAL_RESTART, async () => {
    const paneId = await admiralProcess.restart()
    return paneId
  })
}
```

- [ ] **Step 3: Update index.ts bootstrap**

Replace Admiral instantiation (lines ~184-212) with SocketServer + AdmiralProcess:

```typescript
// Remove:
// import { Admiral } from './starbase/admiral'
// admiral = new Admiral({ ... })

// Add:
import { SocketServer } from './socket-server';
import { AdmiralProcess } from './starbase/admiral-process';
import { join } from 'node:path';
import { homedir } from 'node:os';

const fleetHome = join(homedir(), '.fleet');
const sockPath =
  process.platform === 'win32' ? '\\\\.\\pipe\\fleet' : join(fleetHome, 'fleet.sock');
const fleetBinPath = join(fleetHome, 'bin');

// Socket Server
const socketServer = new SocketServer(sockPath, {
  crewService,
  missionService,
  commsService,
  sectorService,
  cargoService,
  supplyRouteService,
  configService,
  ptyManager,
  createTab,
  db
});

socketServer.setOnStateChange((event, data) => {
  if (!w.isDestroyed()) {
    w.webContents.send(IPC_CHANNELS.STARBASE_STATUS_UPDATE, { event, data });
  }
});

await socketServer.start();

// Admiral Process
const admiralWorkspace = join(fleetHome, 'starbase', starbaseId, 'admiral');
const admiralProcess = new AdmiralProcess({
  workspace: admiralWorkspace,
  starbaseName: starbaseName,
  sectors: sectorService.listSectors(),
  ptyManager,
  fleetBinPath
});

admiralProcess.setOnStatusChange((status, error) => {
  if (!w.isDestroyed()) {
    w.webContents.send(IPC_CHANNELS.ADMIRAL_STATUS_CHANGED, {
      status,
      paneId: admiralProcess.paneId,
      error
    });
  }
});

const admiralPaneId = await admiralProcess.start();
```

Pass `admiralProcess` to `registerIpcHandlers` instead of `admiral`.

- [ ] **Step 4: Verify the app builds**

Run: `npm run build`
Expected: Build succeeds (may have type errors to fix — adjust import paths as needed)

- [ ] **Step 5: Commit**

```bash
git add src/shared/constants.ts src/main/ipc-handlers.ts src/main/index.ts
git commit -m "feat: wire SocketServer and AdmiralProcess into Electron main process"
```

---

## Task 6: Star Command Tab UI — Terminal Replacement

Replace the custom chat UI with xterm.js terminal.

**Files:**

- Modify: `src/renderer/src/store/star-command-store.ts` — simplify state
- Modify: `src/renderer/src/components/StarCommandTab.tsx` — replace chat with terminal
- Modify: `src/preload/index.ts` — update exposed APIs

- [ ] **Step 1: Simplify the Zustand store**

Read `src/renderer/src/store/star-command-store.ts`. Remove message/streaming state. Replace with:

```typescript
interface StarCommandStore {
  // Admiral PTY
  admiralPaneId: string | null;
  admiralStatus: 'running' | 'stopped' | 'starting';
  admiralError: string | null;

  // Starbase state (kept from before)
  crewList: CrewStatus[];
  missionQueue: MissionInfo[];
  sectors: SectorInfo[];
  unreadCount: number;

  // Visual state (kept)
  admiralAvatarState: 'standby' | 'thinking' | 'speaking' | 'alert';

  // Actions
  setAdmiralPty: (
    paneId: string | null,
    status: 'running' | 'stopped' | 'starting',
    error?: string | null
  ) => void;
  setCrewList: (crew: CrewStatus[]) => void;
  setMissionQueue: (missions: MissionInfo[]) => void;
  setSectors: (sectors: SectorInfo[]) => void;
  setUnreadCount: (count: number) => void;
  setAdmiralAvatarState: (state: 'standby' | 'thinking' | 'speaking' | 'alert') => void;
}
```

Remove: `messages`, `isStreaming`, `streamBuffer`, `contextPercentUsed`, `showCompactedNotice`, and all message/stream actions (`addUserMessage`, `appendStreamText`, `addToolCallMessage`, `addToolResultMessage`, `finalizeAssistantMessage`, `clearMessages`).

- [ ] **Step 2: Update the preload API**

In `src/preload/index.ts`, remove the `admiral` API object (sendMessage, getHistory, reset, onStreamChunk, etc.). Add:

```typescript
admiralProcess: {
  getPaneId: () => ipcRenderer.invoke('admiral:pane-id'),
  restart: () => ipcRenderer.invoke('admiral:restart'),
  onStatusChanged: (cb: (data: { status: string; paneId: string | null; error?: string }) => void) =>
    ipcRenderer.on('admiral:status-changed', (_e, data) => cb(data)),
}
```

- [ ] **Step 3: Replace StarCommandTab chat area with xterm.js terminal**

Read `src/renderer/src/components/StarCommandTab.tsx`. The chat message list and input bar get replaced with a terminal component. The terminal connects to `admiralPaneId` the same way crew terminal tabs work (via TerminalPane or the useTerminal hook).

Key changes:

- Remove: message list rendering, input bar, send handler, stream IPC listeners
- Add: useEffect to listen for `admiral:status-changed`, set store state
- Add: on mount, call `window.fleet.admiralProcess.getPaneId()` to get initial paneId
- Add: render TerminalPane (or similar xterm component) when admiralPaneId is set
- Add: "Admiral offline" overlay with restart button when status === 'stopped'
- Add: listener for `starbase:status-update` events from SocketServer state changes — update crewList, missionQueue, unreadCount in store when `crew:changed`, `mission:changed`, `comms:changed` events arrive
- Keep: CRT frame wrapping, status bar, crew chips, galaxy map scene sidebar

The terminal area should use the existing terminal rendering pattern from TerminalPane.tsx — a div ref with the useTerminal hook that creates an xterm.js Terminal and attaches it to the paneId via the PTY IPC bridge.

The status bar data source changes from Admiral-driven push to SocketServer-driven push. Add a useEffect that listens to `starbase:status-update` and refreshes the relevant store slices based on the event type.

- [ ] **Step 4: Test manually**

Run: `npm run dev`

1. Open Fleet
2. Star Command tab should show xterm.js terminal
3. Claude Code should be running in the terminal
4. Status bar should show crew/mission counts
5. Galaxy map sidebar should render

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/store/star-command-store.ts src/renderer/src/components/StarCommandTab.tsx src/preload/index.ts
git commit -m "feat: replace Star Command chat UI with xterm.js terminal for Admiral Claude Code"
```

---

## Task 7: Fleet CLI Binary Installation

Ensure the `fleet` binary is available in the Admiral's PTY environment.

**Files:**

- Modify: `src/main/index.ts` — add CLI installation on startup
- Create: `scripts/install-fleet-cli.ts` — CLI installer script

- [ ] **Step 1: Create CLI installer**

```typescript
// scripts/install-fleet-cli.ts
// Called from main process on startup to ensure ~/.fleet/bin/fleet exists

import { mkdirSync, writeFileSync, chmodSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

export function installFleetCLI(fleetCliSource: string): string {
  const fleetHome = join(homedir(), '.fleet');
  const binDir = join(fleetHome, 'bin');
  const libDir = join(fleetHome, 'lib');
  const binPath = join(binDir, 'fleet');

  mkdirSync(binDir, { recursive: true });
  mkdirSync(libDir, { recursive: true });

  // Write the CLI logic
  writeFileSync(join(libDir, 'fleet-cli.js'), fleetCliSource);

  // Write the shell wrapper
  // Use the system's node since we're in dev; in production, use Electron's bundled node
  const wrapper = `#!/bin/bash
exec node "${join(libDir, 'fleet-cli.js')}" "$@"
`;
  writeFileSync(binPath, wrapper);
  chmodSync(binPath, 0o755);

  return binDir;
}
```

- [ ] **Step 2: Create the CLI entrypoint script**

The CLI entrypoint imports from `fleet-cli.ts` and calls `runCLI` with `process.argv`. This file gets written to `~/.fleet/lib/fleet-cli.js` at startup.

Create a build step or inline the CLI logic. The simplest approach: the main process reads the compiled `fleet-cli.js` from the app bundle and copies it to `~/.fleet/lib/`.

For dev mode, the wrapper can point directly to the source:

```bash
#!/bin/bash
exec npx tsx "/path/to/fleet/src/main/fleet-cli.ts" "$@"
```

For production, the compiled JS is copied from `resources/fleet-cli.js`.

- [ ] **Step 3: Wire into main process startup**

In `src/main/index.ts`, call `installFleetCLI()` before starting AdmiralProcess. Pass the returned `binDir` as `fleetBinPath`.

- [ ] **Step 4: Test manually**

Run: `npm run dev`

1. Check `~/.fleet/bin/fleet` exists and is executable
2. Run `~/.fleet/bin/fleet --help` — should print usage
3. Run `~/.fleet/bin/fleet sector list` — should return data from running Fleet app

- [ ] **Step 5: Commit**

```bash
git add scripts/install-fleet-cli.ts src/main/index.ts
git commit -m "feat: add Fleet CLI binary installation on app startup"
```

---

## Task 8: Delete Old Admiral Code

Remove the replaced code.

**Files:**

- Delete: `src/main/starbase/admiral.ts`
- Delete: `src/main/starbase/admiral-tools.ts`
- Delete: `src/main/starbase/admiral-system-prompt.ts`
- Modify: `src/main/index.ts` — remove old imports
- Modify: any files importing deleted modules

- [ ] **Step 1: Delete the three Admiral files**

```bash
rm src/main/starbase/admiral.ts
rm src/main/starbase/admiral-tools.ts
rm src/main/starbase/admiral-system-prompt.ts
```

- [ ] **Step 2: Remove old imports and references**

Search the codebase for imports of the deleted files:

```bash
grep -r "admiral-tools\|admiral-system-prompt\|from.*admiral'" src/ --include="*.ts" --include="*.tsx"
```

Fix any remaining references. Key places:

- `src/main/index.ts` — remove `import { Admiral }` line
- `src/main/ipc-handlers.ts` — remove `Admiral` type import if still referenced
- Any test files that import the old Admiral

- [ ] **Step 3: Remove @anthropic-ai/sdk dependency if no longer used**

Check if `@anthropic-ai/sdk` is used anywhere else:

```bash
grep -r "anthropic" src/ --include="*.ts" --include="*.tsx"
```

If the Admiral was the only consumer, remove it:

```bash
npm uninstall @anthropic-ai/sdk
```

- [ ] **Step 4: Verify build succeeds**

Run: `npm run build`
Expected: Clean build with no errors

- [ ] **Step 5: Run all tests**

Run: `npx vitest run`
Expected: All tests pass (old Admiral tests should have been removed with the files)

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "refactor: remove old Admiral Anthropic SDK implementation

Replaced by AdmiralProcess (Claude Code PTY) + Fleet CLI + SocketServer."
```

---

## Task 9: Integration Testing

End-to-end verification that all components work together.

**Files:**

- Create: `src/main/__tests__/admiral-integration.test.ts`

- [ ] **Step 1: Write integration test for full flow**

```typescript
// src/main/__tests__/admiral-integration.test.ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { SocketServer } from '../socket-server';
import { FleetCLI, runCLI } from '../fleet-cli';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

describe('Admiral Integration', () => {
  let tmp: string;
  let sockPath: string;
  let server: SocketServer;

  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), 'fleet-integ-'));
    sockPath = join(tmp, 'fleet.sock');
  });

  afterEach(async () => {
    await server?.stop();
    rmSync(tmp, { recursive: true, force: true });
  });

  it('full CLI workflow: list sectors, check comms, create mission', async () => {
    const missions: any[] = [];
    const registry = {
      sectorService: {
        listSectors: () => [{ id: 1, name: 'api', root_path: '/tmp/api', stack: 'node' }]
      },
      commsService: {
        getUnread: () => []
      },
      missionService: {
        createMission: (args: any) => {
          const m = { id: missions.length + 1, ...args, status: 'pending' };
          missions.push(m);
          return m;
        },
        listMissions: () => missions
      }
    } as any;

    server = new SocketServer(sockPath, registry);
    await server.start();

    // Step 1: List sectors
    const sectors = await runCLI(['sector', 'list'], sockPath);
    expect(sectors).toContain('api');

    // Step 2: Check comms (should be silent)
    const comms = await runCLI(['comms', 'check'], sockPath);
    expect(comms).toBe('');

    // Step 3: Create mission
    const mission = await runCLI(
      ['mission', 'create', '--sector', 'api', '--summary', 'Add tests'],
      sockPath
    );
    expect(mission).toContain('Add tests');

    // Step 4: List missions
    const missionList = await runCLI(['mission', 'list'], sockPath);
    expect(missionList).toContain('Add tests');
  });
});
```

- [ ] **Step 2: Run integration test**

Run: `npx vitest run src/main/__tests__/admiral-integration.test.ts`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/main/__tests__/admiral-integration.test.ts
git commit -m "test: add Admiral integration test for full CLI workflow"
```

---

## Summary

| Task | Component           | New Files                       | Key Deliverable                          |
| ---- | ------------------- | ------------------------------- | ---------------------------------------- |
| 1    | Socket Server       | `socket-server.ts` + test       | Unix socket command routing              |
| 2    | Fleet CLI           | `fleet-cli.ts` + test           | CLI client with formatting               |
| 3    | Workspace Templates | `workspace-templates.ts` + test | CLAUDE.md, SKILL.md, settings generators |
| 4    | AdmiralProcess      | `admiral-process.ts` + test     | Workspace init + PTY lifecycle           |
| 5    | Main Process Wiring | (modify existing)               | Connect SocketServer + AdmiralProcess    |
| 6    | Star Command UI     | (modify existing)               | xterm.js terminal replaces chat          |
| 7    | CLI Installation    | `install-fleet-cli.ts`          | Binary on PATH for Admiral               |
| 8    | Cleanup             | (delete old files)              | Remove Admiral SDK code                  |
| 9    | Integration Test    | `admiral-integration.test.ts`   | End-to-end verification                  |
