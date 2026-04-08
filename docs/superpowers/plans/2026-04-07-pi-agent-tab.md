# Pi Agent Tab Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a dedicated `pi` tab type that launches the pi-coding-agent with Fleet-specific extensions for bidirectional integration via WebSocket.

**Architecture:** New `pi` tab type launched via `fleet pi` CLI command. A `PiAgentManager` handles auto-installing pi to `~/.fleet/agents/pi/` and building launch args. A `FleetBridgeServer` runs a WebSocket server for bidirectional communication. Pi extensions bundled in `resources/pi-extensions/` connect back to Fleet via the bridge.

**Tech Stack:** node-pty, xterm.js, ws (npm), pi-coding-agent CLI (`-e` flag for extensions)

---

## File Structure

**New files:**
- `src/main/pi-agent-manager.ts` — Install/version-manage pi, build launch command
- `src/main/fleet-bridge.ts` — WebSocket bridge server for Fleet <-> pi extension communication
- `src/renderer/src/components/PiTab.tsx` — Tab component rendering xterm for pi agent
- `resources/pi-extensions/fleet-bridge.ts` — Core bridge extension connecting to Fleet WS
- `resources/pi-extensions/fleet-files.ts` — `fleet_open` tool for opening files in Fleet
- `resources/pi-extensions/fleet-terminal.ts` — `fleet_run` tool for creating terminal tabs

**Modified files:**
- `package.json` — Add `ws` dependency
- `src/shared/types.ts:15` — Add `'pi'` to Tab type union
- `src/shared/types.ts:42` — Add `'pi'` to PaneLeaf paneType union
- `src/shared/ipc-channels.ts` — Add `PI_OPEN` channel
- `src/shared/ipc-api.ts` — Add `PiOpenPayload` type
- `src/preload/index.ts` — Expose `pi.onOpen` listener
- `src/main/socket-server.ts:354` — Add `pi.open` dispatch case
- `src/main/socket-supervisor.ts:21` — Accept FleetBridgeServer, forward `pi-open` event
- `src/main/index.ts:302` — Instantiate PiAgentManager and FleetBridgeServer, wire events
- `src/main/fleet-cli.ts:325` — Add `pi.open` to COMMAND_MAP, add CLI handler
- `src/main/ipc-handlers.ts` — Add `PI_CREATE` handler for pi-specific PTY creation
- `src/renderer/src/App.tsx:714` — Add `pi` tab rendering branch
- `src/renderer/src/store/workspace-store.ts:245` — Add `addPiTab()` action
- `src/renderer/src/components/Sidebar.tsx:1152` — Add pi tab icon

---

### Task 1: Add `ws` Dependency

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Install ws**

```bash
npm install ws
```

- [ ] **Step 2: Install ws types**

```bash
npm install -D @types/ws
```

- [ ] **Step 3: Verify typecheck passes**

Run: `npm run typecheck`
Expected: PASS (no new errors)

- [ ] **Step 4: Commit**

```bash
git add package.json package-lock.json
git commit -m "chore: add ws dependency for Pi agent WebSocket bridge"
```

---

### Task 2: Type Definitions

**Files:**
- Modify: `src/shared/types.ts`
- Modify: `src/shared/ipc-channels.ts`
- Modify: `src/shared/ipc-api.ts`

- [ ] **Step 1: Add `'pi'` to Tab type union**

In `src/shared/types.ts`, change line 15:

```typescript
// Before:
type?: 'terminal' | 'file' | 'image' | 'images' | 'settings' | 'annotate';

// After:
type?: 'terminal' | 'file' | 'image' | 'images' | 'settings' | 'annotate' | 'pi';
```

- [ ] **Step 2: Add `'pi'` to PaneLeaf paneType union**

In `src/shared/types.ts`, change line 42:

```typescript
// Before:
paneType?: 'terminal' | 'file' | 'image' | 'images';

// After:
paneType?: 'terminal' | 'file' | 'image' | 'images' | 'pi';
```

- [ ] **Step 3: Add IPC channels**

In `src/shared/ipc-channels.ts`, add after the `ANNOTATE_DELETE` line (before the closing `} as const`):

```typescript
  // Pi Agent
  PI_OPEN: 'pi:open',
```

- [ ] **Step 4: Add PiOpenPayload type**

In `src/shared/ipc-api.ts`, add after the `PtyCreateResponse` type:

```typescript
export type PiOpenPayload = {
  cwd: string;
};
```

- [ ] **Step 5: Verify typecheck passes**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/shared/types.ts src/shared/ipc-channels.ts src/shared/ipc-api.ts
git commit -m "feat(pi): add pi tab type and IPC channel definitions"
```

---

### Task 3: PiAgentManager

**Files:**
- Create: `src/main/pi-agent-manager.ts`

- [ ] **Step 1: Create the PiAgentManager**

```typescript
import { join } from 'node:path';
import { homedir } from 'node:os';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createLogger } from './logger';
import { app } from 'electron';

const execFileAsync = promisify(execFile);
const log = createLogger('pi-agent-manager');

const PI_INSTALL_DIR = join(homedir(), '.fleet', 'agents', 'pi');
const PI_PACKAGE = '@mariozechner/pi-coding-agent';
const VERSION_FILE = join(PI_INSTALL_DIR, '.fleet-version');

export class PiAgentManager {
  private installedVersion: string | null = null;
  private installPromise: Promise<void> | null = null;

  constructor() {
    this.loadVersion();
  }

  private loadVersion(): void {
    try {
      if (existsSync(VERSION_FILE)) {
        this.installedVersion = readFileSync(VERSION_FILE, 'utf-8').trim();
      }
    } catch {
      this.installedVersion = null;
    }
  }

  isInstalled(): boolean {
    return this.installedVersion !== null && existsSync(this.getBinPath());
  }

  getBinPath(): string {
    return join(PI_INSTALL_DIR, 'node_modules', '.bin', 'pi');
  }

  getExtensionsDir(): string {
    // In production, resources are in the app's resource path.
    // In dev, they're in the project root.
    const resourcesPath = app.isPackaged
      ? join(process.resourcesPath, 'pi-extensions')
      : join(app.getAppPath(), 'resources', 'pi-extensions');
    return resourcesPath;
  }

  getExtensionPaths(): string[] {
    const dir = this.getExtensionsDir();
    const extensions = ['fleet-bridge.ts', 'fleet-files.ts', 'fleet-terminal.ts'];
    return extensions.map((e) => join(dir, e));
  }

  buildLaunchCommand(bridgePort: number, bridgeToken: string, paneId: string): string {
    const extensionPaths = this.getExtensionPaths();
    const parts: string[] = [];

    // Env vars as prefix (shell inline)
    parts.push(`FLEET_BRIDGE_PORT=${bridgePort}`);
    parts.push(`FLEET_BRIDGE_TOKEN=${bridgeToken}`);
    parts.push(`FLEET_PANE_ID=${paneId}`);

    // Binary
    parts.push(this.quoteArg(this.getBinPath()));

    // Extension flags
    for (const ext of extensionPaths) {
      parts.push('-e', this.quoteArg(ext));
    }

    return parts.join(' ');
  }

  private quoteArg(arg: string): string {
    return arg.includes(' ') ? `"${arg}"` : arg;
  }

  async ensureInstalled(): Promise<void> {
    if (this.isInstalled()) return;

    // Deduplicate concurrent install requests
    if (this.installPromise) return this.installPromise;

    this.installPromise = this.install();
    try {
      await this.installPromise;
    } finally {
      this.installPromise = null;
    }
  }

  private async install(): Promise<void> {
    log.info('Installing pi-coding-agent', { dir: PI_INSTALL_DIR });

    if (!existsSync(PI_INSTALL_DIR)) {
      mkdirSync(PI_INSTALL_DIR, { recursive: true });
    }

    // Initialize a package.json if missing (npm install --prefix requires it)
    const pkgJsonPath = join(PI_INSTALL_DIR, 'package.json');
    if (!existsSync(pkgJsonPath)) {
      writeFileSync(pkgJsonPath, JSON.stringify({ name: 'fleet-pi-agent', private: true }, null, 2));
    }

    const { stdout } = await execFileAsync('npm', ['install', PI_PACKAGE, '--prefix', PI_INSTALL_DIR], {
      timeout: 120_000,
    });
    log.info('Pi agent installed', { output: stdout.slice(0, 200) });

    // Read installed version from the installed package
    try {
      const installedPkg = join(PI_INSTALL_DIR, 'node_modules', PI_PACKAGE.split('/').pop()!, 'package.json');
      // The package is scoped, so the path is node_modules/@mariozechner/pi-coding-agent/package.json
      const scopedPkg = join(PI_INSTALL_DIR, 'node_modules', ...PI_PACKAGE.split('/'), 'package.json');
      const pkgPath = existsSync(scopedPkg) ? scopedPkg : installedPkg;
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8')) as { version: string };
      this.installedVersion = pkg.version;
      writeFileSync(VERSION_FILE, this.installedVersion);
      log.info('Pi agent version', { version: this.installedVersion });
    } catch (err) {
      // Version tracking failed but install succeeded — mark as installed
      this.installedVersion = 'unknown';
      writeFileSync(VERSION_FILE, this.installedVersion);
      log.warn('Could not read pi agent version', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  async checkForUpdates(): Promise<void> {
    if (!this.isInstalled()) return;

    try {
      log.info('Checking for pi-coding-agent updates');
      await execFileAsync('npm', ['update', PI_PACKAGE, '--prefix', PI_INSTALL_DIR], {
        timeout: 60_000,
      });
      this.loadVersion();
      log.info('Pi agent update check complete', { version: this.installedVersion });
    } catch (err) {
      log.warn('Pi agent update check failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
```

- [ ] **Step 2: Verify typecheck passes**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/main/pi-agent-manager.ts
git commit -m "feat(pi): add PiAgentManager for install and launch"
```

---

### Task 4: FleetBridgeServer

**Files:**
- Create: `src/main/fleet-bridge.ts`

- [ ] **Step 1: Create the WebSocket bridge server**

```typescript
import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import { createLogger } from './logger';

const log = createLogger('fleet-bridge');

export type BridgeRequest = {
  id: string;
  type: string;
  payload: Record<string, unknown>;
};

export type BridgeResponse = {
  id: string;
  result?: unknown;
  error?: string;
};

export type BridgeEvent = {
  type: string;
  payload: Record<string, unknown>;
};

type RequestHandler = (
  type: string,
  payload: Record<string, unknown>,
  paneId: string
) => Promise<unknown>;

export class FleetBridgeServer {
  private httpServer: Server | null = null;
  private wss: WebSocketServer | null = null;
  private port = 0;
  private token = '';
  private connections = new Map<string, WebSocket>(); // paneId -> ws
  private requestHandler: RequestHandler | null = null;

  getPort(): number {
    return this.port;
  }

  generateToken(): string {
    this.token = randomUUID();
    return this.token;
  }

  onRequest(handler: RequestHandler): void {
    this.requestHandler = handler;
  }

  async start(): Promise<void> {
    this.token = randomUUID();

    return new Promise((resolve, reject) => {
      this.httpServer = createServer();
      this.wss = new WebSocketServer({ server: this.httpServer });

      this.wss.on('connection', (ws, req) => {
        const url = new URL(req.url ?? '/', `http://localhost`);
        const providedToken = url.searchParams.get('token');
        const paneId = url.searchParams.get('paneId');

        if (providedToken !== this.token) {
          log.warn('Bridge connection rejected: invalid token');
          ws.close(4001, 'Invalid token');
          return;
        }

        if (!paneId) {
          log.warn('Bridge connection rejected: missing paneId');
          ws.close(4002, 'Missing paneId');
          return;
        }

        log.info('Bridge connection accepted', { paneId });
        this.connections.set(paneId, ws);

        ws.on('message', (raw) => {
          void this.handleMessage(raw.toString(), paneId);
        });

        ws.on('close', () => {
          log.info('Bridge connection closed', { paneId });
          this.connections.delete(paneId);
        });

        ws.on('error', (err) => {
          log.error('Bridge connection error', {
            paneId,
            error: err.message,
          });
        });
      });

      this.httpServer.listen(0, '127.0.0.1', () => {
        const addr = this.httpServer!.address();
        if (addr && typeof addr === 'object') {
          this.port = addr.port;
        }
        log.info('Fleet bridge started', { port: this.port });
        resolve();
      });

      this.httpServer.on('error', reject);
    });
  }

  async stop(): Promise<void> {
    for (const ws of this.connections.values()) {
      ws.close();
    }
    this.connections.clear();

    if (this.wss) {
      this.wss.close();
      this.wss = null;
    }

    if (this.httpServer) {
      await new Promise<void>((resolve) => {
        this.httpServer!.close(() => resolve());
      });
      this.httpServer = null;
    }
  }

  /** Send an event to a specific pi tab's extension. */
  sendEvent(paneId: string, event: BridgeEvent): void {
    const ws = this.connections.get(paneId);
    if (ws && ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify(event));
    }
  }

  /** Send an event to all connected pi extensions. */
  broadcast(event: BridgeEvent): void {
    const data = JSON.stringify(event);
    for (const ws of this.connections.values()) {
      if (ws.readyState === ws.OPEN) {
        ws.send(data);
      }
    }
  }

  private async handleMessage(raw: string, paneId: string): Promise<void> {
    let msg: BridgeRequest;
    try {
      msg = JSON.parse(raw) as BridgeRequest;
    } catch {
      log.warn('Bridge received invalid JSON', { paneId });
      return;
    }

    if (!msg.id || !msg.type) {
      log.warn('Bridge received malformed message', { paneId, msg });
      return;
    }

    const ws = this.connections.get(paneId);
    if (!ws) return;

    try {
      const result = await (this.requestHandler?.(msg.type, msg.payload, paneId) ?? null);
      const response: BridgeResponse = { id: msg.id, result };
      ws.send(JSON.stringify(response));
    } catch (err) {
      const response: BridgeResponse = {
        id: msg.id,
        error: err instanceof Error ? err.message : String(err),
      };
      ws.send(JSON.stringify(response));
    }
  }
}
```

- [ ] **Step 2: Verify typecheck passes**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/main/fleet-bridge.ts
git commit -m "feat(pi): add FleetBridgeServer WebSocket bridge"
```

---

### Task 5: CLI Command (`fleet pi`)

**Files:**
- Modify: `src/main/fleet-cli.ts`
- Modify: `src/main/socket-server.ts`
- Modify: `src/main/socket-supervisor.ts`

- [ ] **Step 1: Add CLI handler for `fleet pi`**

In `src/main/fleet-cli.ts`, add a top-level handler for the `pi` command. Add this block after the `annotate` command handler (after line 633, before the `images config` block):

```typescript
  // ── Top-level "pi" command ───────────────────────────────────────────────
  if (group === 'pi') {
    const cwd = process.cwd();
    const command = 'pi.open';
    const args: Record<string, unknown> = { cwd };

    const cli = new FleetCLI(sockPath);
    try {
      const response = opts?.retry
        ? await cli.sendWithRetry(command, args)
        : await cli.send(command, args);
      if (!response.ok) {
        return `Error: ${response.error ?? 'Unknown error'}`;
      }
      return 'Opening Pi agent in Fleet';
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('ECONNREFUSED') || msg.includes('ENOENT')) {
        return 'Fleet is not running';
      }
      return `Error: ${msg}`;
    }
  }
```

- [ ] **Step 2: Add socket server dispatch case**

In `src/main/socket-server.ts`, add a new case before the `default` case (before line 366):

```typescript
      case 'pi.open': {
        const cwd = typeof args.cwd === 'string' ? args.cwd : undefined;
        if (!cwd) throw new CodedError('pi.open requires a cwd', 'BAD_REQUEST');
        this.emit('pi-open', { cwd });
        return { ok: true };
      }
```

- [ ] **Step 3: Forward `pi-open` event in socket supervisor**

In `src/main/socket-supervisor.ts`, inside the `createServer()` method (after line 97, after the `file-open` forwarding block), add:

```typescript
    server.on('pi-open', (...args: unknown[]) => {
      this.emit('pi-open', ...args);
    });
```

- [ ] **Step 4: Verify typecheck passes**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/main/fleet-cli.ts src/main/socket-server.ts src/main/socket-supervisor.ts
git commit -m "feat(pi): add fleet pi CLI command and socket dispatch"
```

---

### Task 6: Preload API and IPC Wiring

**Files:**
- Modify: `src/preload/index.ts`
- Modify: `src/main/index.ts`
- Modify: `src/main/ipc-handlers.ts`

- [ ] **Step 1: Add preload listener for pi:open**

In `src/preload/index.ts`, add `PiOpenPayload` to the imports from `../shared/ipc-api` and add within the `contextBridge.exposeInMainWorld('fleet', { ... })` object:

```typescript
    pi: {
      onOpen: (callback: (payload: PiOpenPayload) => void): Unsubscribe =>
        onChannel(IPC_CHANNELS.PI_OPEN, callback),
    },
```

- [ ] **Step 2: Wire pi-open event from socket supervisor to renderer**

In `src/main/index.ts`, after the `socketSupervisor.on('file-open', ...)` block (after line 307), add:

```typescript
  socketSupervisor.on('pi-open', (payload: unknown) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send(IPC_CHANNELS.PI_OPEN, payload);
    }
  });
```

- [ ] **Step 3: Instantiate PiAgentManager and FleetBridgeServer in main**

In `src/main/index.ts`, add imports at the top:

```typescript
import { PiAgentManager } from './pi-agent-manager';
import { FleetBridgeServer } from './fleet-bridge';
```

Add after the existing service instantiation block (after the `annotateService` line, around line 56):

```typescript
const piAgentManager = new PiAgentManager();
const fleetBridge = new FleetBridgeServer();
```

- [ ] **Step 4: Start FleetBridgeServer and wire request handler**

In `src/main/index.ts`, after the socket supervisor start block (after line 312), add:

```typescript
  // Start Fleet bridge for Pi agent extensions
  fleetBridge.onRequest(async (type, payload, _paneId) => {
    switch (type) {
      case 'file.open': {
        const filePath = typeof payload.path === 'string' ? payload.path : '';
        if (!filePath) throw new Error('file.open requires a path');
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send(IPC_CHANNELS.FILE_OPEN_IN_TAB, {
            files: [{ path: filePath, paneType: 'file', label: filePath.split('/').pop() ?? filePath }],
          });
        }
        return { ok: true };
      }
      default:
        throw new Error(`Unknown bridge command: ${type}`);
    }
  });
  fleetBridge.start().catch((err: unknown) => {
    log.error('Fleet bridge failed to start', {
      error: err instanceof Error ? err.message : String(err),
    });
  });
```

- [ ] **Step 5: Add IPC handler for pi PTY creation**

In `src/main/ipc-handlers.ts`, add a new IPC handler. Add `PI_CREATE: 'pi:create'` to `IPC_CHANNELS` in `src/shared/ipc-channels.ts` first. Then in ipc-handlers.ts, add after the PTY_CREATE handler:

Actually — we don't need a separate IPC handler. The existing `PTY_CREATE` handler already supports a `cmd` field in `PtyCreateRequest`. The renderer will use `window.fleet.pty.create({ paneId, cwd, cmd: '<pi command>' })` with the pi binary path and args. But we need the renderer to know the pi command.

Instead, add an IPC handler that returns the pi launch config:

In `src/shared/ipc-channels.ts`, add:

```typescript
  PI_LAUNCH_CONFIG: 'pi:launch-config',
```

In `src/shared/ipc-api.ts`, add:

```typescript
export type PiLaunchConfig = {
  cmd: string;
};
```

In `src/preload/index.ts`, add to the `pi` object:

```typescript
    pi: {
      onOpen: (callback: (payload: PiOpenPayload) => void): Unsubscribe =>
        onChannel(IPC_CHANNELS.PI_OPEN, callback),
      getLaunchConfig: async (paneId: string): Promise<PiLaunchConfig> =>
        typedInvoke(IPC_CHANNELS.PI_LAUNCH_CONFIG, { paneId }),
    },
```

In `src/main/ipc-handlers.ts`, update `registerIpcHandlers` signature to accept `piAgentManager: PiAgentManager` and `fleetBridge: FleetBridgeServer`, then add:

```typescript
  ipcMain.handle(IPC_CHANNELS.PI_LAUNCH_CONFIG, async (_event, req: { paneId: string }) => {
    await piAgentManager.ensureInstalled();
    const token = fleetBridge.generateToken();
    const port = fleetBridge.getPort();
    const cmd = piAgentManager.buildLaunchCommand(port, token, req.paneId);
    return { cmd };
  });
```

Update the `registerIpcHandlers` call in `index.ts` to pass `piAgentManager` and `fleetBridge`.

- [ ] **Step 6: Verify typecheck passes**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add src/shared/ipc-channels.ts src/shared/ipc-api.ts src/preload/index.ts src/main/index.ts src/main/ipc-handlers.ts
git commit -m "feat(pi): wire IPC and preload for pi tab creation"
```

---

### Task 7: Workspace Store — `addPiTab` Action

**Files:**
- Modify: `src/renderer/src/store/workspace-store.ts`

- [ ] **Step 1: Add `addPiTab` action to the store interface**

Find the `WorkspaceStore` type/interface and add:

```typescript
addPiTab: (cwd: string) => string;
```

- [ ] **Step 2: Implement `addPiTab`**

Add after the existing `addTab` method:

```typescript
    addPiTab: (cwd) => {
      const leaf: PaneLeaf = { type: 'leaf', id: generateId(), cwd, paneType: 'pi' };
      const tab: Tab = {
        id: generateId(),
        label: 'Pi Agent',
        labelIsCustom: true,
        cwd,
        type: 'pi',
        splitRoot: leaf,
      };
      logTabs.debug('addPiTab', { tabId: tab.id, cwd, paneId: leaf.id });
      set((state) => ({
        workspace: {
          ...state.workspace,
          tabs: [...state.workspace.tabs, tab],
        },
        activeTabId: tab.id,
        activePaneId: leaf.id,
        isDirty: true,
      }));
      return leaf.id;
    },
```

- [ ] **Step 3: Verify typecheck passes**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/renderer/src/store/workspace-store.ts
git commit -m "feat(pi): add addPiTab action to workspace store"
```

---

### Task 8: PiTab Component

**Files:**
- Create: `src/renderer/src/components/PiTab.tsx`

- [ ] **Step 1: Create the PiTab component**

```tsx
import { useRef, useState, useEffect } from 'react';
import { useTerminal } from '../hooks/use-terminal';
import type { Tab } from '../../../shared/types';

type PiTabProps = {
  tab: Tab;
  isActive: boolean;
  fontFamily?: string;
  fontSize?: number;
};

export function PiTab({ tab, isActive, fontFamily, fontSize }: PiTabProps): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null);
  const paneId = tab.splitRoot.type === 'leaf' ? tab.splitRoot.id : '';
  const [piReady, setPiReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const launchConfigRef = useRef<{ cmd: string } | null>(null);

  // Fetch pi launch config before creating the PTY
  useEffect(() => {
    let cancelled = false;
    void window.fleet.pi.getLaunchConfig(paneId).then((config) => {
      if (cancelled) return;
      launchConfigRef.current = config;
      setPiReady(true);
    }).catch((err: unknown) => {
      if (cancelled) return;
      setError(err instanceof Error ? err.message : String(err));
    });
    return () => { cancelled = true; };
  }, []);

  // Once config is loaded, useTerminal creates the PTY with the pi command
  // We need to defer useTerminal until piReady, but hooks can't be conditional.
  // Instead, we render the terminal container only when ready and use a key
  // to force remount.
  if (error) {
    return (
      <div className="h-full w-full flex items-center justify-center bg-[#151515] text-red-400 text-sm p-4">
        <div className="max-w-md text-center">
          <p className="font-medium mb-2">Failed to launch Pi agent</p>
          <p className="text-neutral-400">{error}</p>
        </div>
      </div>
    );
  }

  if (!piReady) {
    return (
      <div className="h-full w-full flex items-center justify-center bg-[#151515] text-neutral-400 text-sm">
        Installing Pi agent...
      </div>
    );
  }

  return (
    <PiTerminal
      key={paneId}
      paneId={paneId}
      cwd={tab.cwd}
      isActive={isActive}
      fontFamily={fontFamily}
      fontSize={fontSize}
      launchConfig={launchConfigRef.current!}
    />
  );
}

/** Inner component that mounts after launch config is ready. */
function PiTerminal({
  paneId,
  cwd,
  isActive,
  fontFamily,
  fontSize,
  launchConfig,
}: {
  paneId: string;
  cwd: string;
  isActive: boolean;
  fontFamily?: string;
  fontSize?: number;
  launchConfig: { cmd: string };
}): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null);
  const [isScrolledUp, setIsScrolledUp] = useState(false);

  const { focus, scrollToBottom } = useTerminal(containerRef, {
    paneId,
    cwd,
    isActive,
    fontFamily,
    fontSize,
    cursorHidden: true,
    onScrollStateChange: setIsScrolledUp,
  });

  // Create PTY with pi command — the useTerminal hook creates a bare shell PTY,
  // but we need to override with the pi command. We do this by using the cmd field
  // in the PTY create request. However useTerminal calls pty.create internally.
  // We need to pass the cmd through a different mechanism.
  //
  // The approach: we'll inject the pi command and env vars via a custom PTY create.
  // Since useTerminal's pty.create doesn't support cmd/env, we'll skip it by using
  // attachOnly mode and manually create the PTY first.
  //
  // Actually — looking at PtyCreateRequest, it has a `cmd` field. But useTerminal
  // calls `window.fleet.pty.create({ paneId, cwd })` without cmd. We need to
  // create the PTY ourselves before useTerminal mounts.

  // Wait — useTerminal creates PTY on mount if not already created (createdPtys Set).
  // If we pre-create via IPC, useTerminal will see it in createdPtys and skip.
  // But we can't import createdPtys... Let's use attachOnly mode instead.

  useEffect(() => {
    // Create the Pi PTY directly via IPC with cmd field
    void window.fleet.pty.create({
      paneId,
      cwd,
      cmd: launchConfig.cmd,
    });
  }, [paneId, cwd, launchConfig.cmd]);

  return (
    <div
      className="relative h-full w-full overflow-hidden p-3 bg-[#151515]"
      onClick={() => focus()}
    >
      <div ref={containerRef} className="h-full w-full" />
      {isScrolledUp && (
        <button
          className="absolute bottom-3 right-3 z-40 flex items-center gap-1.5 rounded-md bg-neutral-800/90 px-2.5 py-1.5 text-xs text-neutral-300 shadow-lg backdrop-blur-sm hover:bg-neutral-700 transition-colors"
          onClick={(e) => {
            e.stopPropagation();
            scrollToBottom();
            focus();
          }}
          tabIndex={-1}
          aria-label="Scroll to bottom"
        >
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
            <path d="M2 4l4 4 4-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          <span>Bottom</span>
        </button>
      )}
    </div>
  );
}
```

**Note:** There's a subtlety here — `useTerminal` calls `window.fleet.pty.create` internally. But we need to pass `cmd` and custom env vars. There are two approaches:

**Option A:** Modify `useTerminal` to accept an optional `cmd` parameter and pass it through to `pty.create`. This is cleaner.

**Option B:** Use `attachOnly: true` and create the PTY manually before mounting. This avoids modifying the shared hook.

Go with **Option A** — it's a small change to the shared hook. In `src/renderer/src/hooks/use-terminal.ts`, add `cmd?: string` to `UseTerminalOptions` (line 15). Then in the `createTerminal` function, where it calls `window.fleet.pty.create` (line 292), pass `cmd: options.cmd`.

Update `PiTerminal` to not manually create the PTY — instead pass `cmd` through `useTerminal`:

```tsx
function PiTerminal({
  paneId,
  cwd,
  isActive,
  fontFamily,
  fontSize,
  launchConfig,
}: {
  paneId: string;
  cwd: string;
  isActive: boolean;
  fontFamily?: string;
  fontSize?: number;
  launchConfig: { cmd: string };
}): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null);
  const [isScrolledUp, setIsScrolledUp] = useState(false);

  const { focus, scrollToBottom } = useTerminal(containerRef, {
    paneId,
    cwd,
    cmd: launchConfig.cmd,
    isActive,
    fontFamily,
    fontSize,
    cursorHidden: true,
    onScrollStateChange: setIsScrolledUp,
  });

  return (
    <div
      className="relative h-full w-full overflow-hidden p-3 bg-[#151515]"
      onClick={() => focus()}
    >
      <div ref={containerRef} className="h-full w-full" />
      {isScrolledUp && (
        <button
          className="absolute bottom-3 right-3 z-40 flex items-center gap-1.5 rounded-md bg-neutral-800/90 px-2.5 py-1.5 text-xs text-neutral-300 shadow-lg backdrop-blur-sm hover:bg-neutral-700 transition-colors"
          onClick={(e) => {
            e.stopPropagation();
            scrollToBottom();
            focus();
          }}
          tabIndex={-1}
          aria-label="Scroll to bottom"
        >
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
            <path d="M2 4l4 4 4-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          <span>Bottom</span>
        </button>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Add `cmd` support to useTerminal**

In `src/renderer/src/hooks/use-terminal.ts`, add to `UseTerminalOptions` (after line 17):

```typescript
  /** Shell command to run instead of default shell (e.g. pi agent binary). */
  cmd?: string;
```

Then in `PtyCreateRequest` in `src/shared/ipc-api.ts`, the `cmd` field already exists. In `createTerminal`, update the `pty.create` call at line 292:

```typescript
    void window.fleet.pty.create({
      paneId: options.paneId,
      cwd: options.cwd,
      cmd: options.cmd,
      workspaceId: options.workspaceId
    }).then(() => {
```

- [ ] **Step 3: Verify typecheck passes**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/renderer/src/components/PiTab.tsx src/renderer/src/hooks/use-terminal.ts
git commit -m "feat(pi): add PiTab component with xterm rendering"
```

---

### Task 9: App.tsx Rendering and Sidebar Integration

**Files:**
- Modify: `src/renderer/src/App.tsx`
- Modify: `src/renderer/src/components/Sidebar.tsx`

- [ ] **Step 1: Add pi:open IPC listener in App.tsx**

In `src/renderer/src/App.tsx`, add after the `file:open-in-tab` useEffect (after line 242):

```typescript
  // Open Pi agent tab via IPC (fleet pi CLI command)
  useEffect(() => {
    const cleanup = window.fleet.pi.onOpen((payload) => {
      useWorkspaceStore.getState().addPiTab(payload.cwd);
    });
    return () => {
      cleanup();
    };
  }, []);
```

- [ ] **Step 2: Add pi tab rendering branch**

In the tab rendering section (around line 714), add a branch for `pi` tabs. Change:

```typescript
      ) : tab.type === 'settings' ? (
        <SettingsTab />
      ) : (
```

To:

```typescript
      ) : tab.type === 'settings' ? (
        <SettingsTab />
      ) : tab.type === 'pi' ? (
        <PiTab
          tab={tab}
          isActive={tab.id === activeTabId}
          fontFamily={settings?.general.fontFamily}
          fontSize={settings?.general.fontSize}
        />
      ) : (
```

Add the import at the top of App.tsx:

```typescript
import { PiTab } from './components/PiTab';
```

- [ ] **Step 3: Add pi tab icon in Sidebar**

In `src/renderer/src/components/Sidebar.tsx`, at line 1152-1160, update the icon logic:

```typescript
              let icon: React.ReactNode;
              if (tab.type === 'pi') {
                icon = <Bot size={14} />;
              } else if (isFile) {
                const leafs2 = collectPaneLeafs(tab.splitRoot);
                const fileBasename = leafs2[0]?.filePath?.split('/').pop() ?? tab.label;
                icon =
                  tab.type === 'image' ? <ImageIcon size={14} /> : getFileIcon(fileBasename, 14);
              } else {
                icon = <Terminal size={14} />;
              }
```

Add `Bot` to the lucide-react import at line 5:

```typescript
import { Settings, Terminal, ImageIcon, ChevronRight, Bot } from 'lucide-react';
```

- [ ] **Step 4: Verify typecheck passes**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/App.tsx src/renderer/src/components/Sidebar.tsx
git commit -m "feat(pi): render PiTab in App and add sidebar icon"
```

---

### Task 10: Pi Extensions

**Files:**
- Create: `resources/pi-extensions/fleet-bridge.ts`
- Create: `resources/pi-extensions/fleet-files.ts`
- Create: `resources/pi-extensions/fleet-terminal.ts`

- [ ] **Step 1: Create the fleet-bridge extension**

```typescript
import type { ExtensionAPI } from '@mariozechner/pi-coding-agent';

const RECONNECT_DELAY_MS = 2000;
const MAX_RECONNECT_ATTEMPTS = 10;

type BridgeClient = {
  send: (type: string, payload: Record<string, unknown>) => Promise<unknown>;
  onEvent: (handler: (type: string, payload: Record<string, unknown>) => void) => void;
  isConnected: () => boolean;
};

export default function fleetBridge(pi: ExtensionAPI): void {
  const port = process.env.FLEET_BRIDGE_PORT;
  const token = process.env.FLEET_BRIDGE_TOKEN;
  const paneId = process.env.FLEET_PANE_ID ?? 'unknown';

  if (!port || !token) {
    return; // Not running inside Fleet
  }

  let ws: WebSocket | null = null;
  let reconnectAttempts = 0;
  let requestId = 0;
  const pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  const eventHandlers: Array<(type: string, payload: Record<string, unknown>) => void> = [];

  function connect(): void {
    const url = `ws://127.0.0.1:${port}/?token=${token}&paneId=${paneId}`;
    ws = new WebSocket(url);

    ws.onopen = () => {
      reconnectAttempts = 0;
    };

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(String(event.data)) as Record<string, unknown>;
        // Response to a request
        if (typeof msg.id === 'string' && pending.has(msg.id)) {
          const handler = pending.get(msg.id)!;
          pending.delete(msg.id);
          if (msg.error) {
            handler.reject(new Error(String(msg.error)));
          } else {
            handler.resolve(msg.result);
          }
          return;
        }
        // Event from Fleet
        if (typeof msg.type === 'string') {
          const payload = (msg.payload ?? {}) as Record<string, unknown>;
          for (const handler of eventHandlers) {
            handler(msg.type, payload);
          }
        }
      } catch {
        // Ignore parse errors
      }
    };

    ws.onclose = () => {
      ws = null;
      if (reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
        reconnectAttempts++;
        setTimeout(connect, RECONNECT_DELAY_MS);
      }
    };

    ws.onerror = () => {
      // onclose will fire after this
    };
  }

  const client: BridgeClient = {
    send(type, payload) {
      return new Promise((resolve, reject) => {
        if (!ws || ws.readyState !== WebSocket.OPEN) {
          reject(new Error('Fleet bridge not connected'));
          return;
        }
        const id = String(++requestId);
        pending.set(id, { resolve, reject });
        ws.send(JSON.stringify({ id, type, payload }));

        // Timeout after 10s
        setTimeout(() => {
          if (pending.has(id)) {
            pending.delete(id);
            reject(new Error('Fleet bridge request timed out'));
          }
        }, 10_000);
      });
    },
    onEvent(handler) {
      eventHandlers.push(handler);
    },
    isConnected() {
      return ws !== null && ws.readyState === WebSocket.OPEN;
    },
  };

  // Store on pi metadata for other extensions to access
  (pi as unknown as Record<string, unknown>).metadata ??= {};
  ((pi as unknown as Record<string, unknown>).metadata as Record<string, unknown>).fleetBridge = client;

  connect();
}
```

**Note:** The exact `ExtensionAPI` interface depends on pi-coding-agent's actual types. The metadata approach may need adjustment based on how pi handles inter-extension communication. If `pi.metadata` isn't available, a global variable or event-based approach can be used instead. This will need verification during implementation.

- [ ] **Step 2: Create the fleet-files extension**

```typescript
import type { ExtensionAPI } from '@mariozechner/pi-coding-agent';

export default function fleetFiles(pi: ExtensionAPI): void {
  const metadata = ((pi as unknown as Record<string, unknown>).metadata ?? {}) as Record<string, unknown>;

  pi.registerTool({
    name: 'fleet_open',
    description: 'Open a file in the Fleet editor. Use this when you want the user to see a file in Fleet\'s built-in editor tab.',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Absolute path to the file to open',
        },
      },
      required: ['path'],
    },
    async execute({ path }: { path: string }) {
      const bridge = metadata.fleetBridge as {
        send: (type: string, payload: Record<string, unknown>) => Promise<unknown>;
        isConnected: () => boolean;
      } | undefined;

      if (!bridge || !bridge.isConnected()) {
        return { error: 'Fleet bridge not connected. Fleet-specific tools are unavailable.' };
      }

      try {
        await bridge.send('file.open', { path });
        return { success: true, message: `Opened ${path} in Fleet editor` };
      } catch (err) {
        return { error: err instanceof Error ? err.message : String(err) };
      }
    },
  });
}
```

- [ ] **Step 3: Create the fleet-terminal extension**

```typescript
import type { ExtensionAPI } from '@mariozechner/pi-coding-agent';

export default function fleetTerminal(pi: ExtensionAPI): void {
  const metadata = ((pi as unknown as Record<string, unknown>).metadata ?? {}) as Record<string, unknown>;

  pi.registerTool({
    name: 'fleet_run',
    description: 'Run a command in a new Fleet terminal tab. Use this to run background tasks (like dev servers, builds, or tests) in a separate terminal while continuing your work.',
    parameters: {
      type: 'object',
      properties: {
        command: {
          type: 'string',
          description: 'The shell command to run',
        },
        cwd: {
          type: 'string',
          description: 'Working directory for the command (optional, defaults to current directory)',
        },
      },
      required: ['command'],
    },
    async execute({ command, cwd }: { command: string; cwd?: string }) {
      const bridge = metadata.fleetBridge as {
        send: (type: string, payload: Record<string, unknown>) => Promise<unknown>;
        isConnected: () => boolean;
      } | undefined;

      if (!bridge || !bridge.isConnected()) {
        return { error: 'Fleet bridge not connected. Fleet-specific tools are unavailable.' };
      }

      try {
        await bridge.send('terminal.run', { command, cwd });
        return { success: true, message: `Running "${command}" in a new Fleet terminal` };
      } catch (err) {
        return { error: err instanceof Error ? err.message : String(err) };
      }
    },
  });
}
```

- [ ] **Step 4: Commit**

```bash
mkdir -p resources/pi-extensions
git add resources/pi-extensions/fleet-bridge.ts resources/pi-extensions/fleet-files.ts resources/pi-extensions/fleet-terminal.ts
git commit -m "feat(pi): add Fleet pi extensions for bridge, files, and terminal"
```

---

### Task 11: Wire `terminal.run` Bridge Command

**Files:**
- Modify: `src/main/index.ts`

- [ ] **Step 1: Add terminal.run handler to bridge request handler**

In `src/main/index.ts`, in the `fleetBridge.onRequest` switch statement, add:

```typescript
      case 'terminal.run': {
        const command = typeof payload.command === 'string' ? payload.command : '';
        const cwd = typeof payload.cwd === 'string' ? payload.cwd : undefined;
        if (!command) throw new Error('terminal.run requires a command');
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send(IPC_CHANNELS.PI_OPEN, {
            // Reuse PI_OPEN is wrong — we need a terminal, not a pi tab.
            // Use the file-open-in-tab pattern but for terminals.
            // Actually, we should send a custom event that the renderer handles.
          });
        }
        return { ok: true };
      }
```

Actually — there's no existing IPC for "create a terminal tab with a command". For v1, let's skip the `terminal.run` bridge command and ship with just `file.open`. We can add `terminal.run` in a follow-up once we add a `cmd` parameter to `addTab` in the workspace store.

Remove the `terminal.run` case and the `fleet-terminal.ts` extension from the v1 scope. Leave the extension file in place but mark it as a stub:

```typescript
import type { ExtensionAPI } from '@mariozechner/pi-coding-agent';

// Stub — terminal.run bridge command not yet implemented.
// Will be enabled once Fleet supports creating terminal tabs with commands via IPC.
export default function fleetTerminal(_pi: ExtensionAPI): void {
  // No-op for now
}
```

- [ ] **Step 2: Commit**

```bash
git add src/main/index.ts resources/pi-extensions/fleet-terminal.ts
git commit -m "feat(pi): wire file.open bridge handler, stub terminal.run"
```

---

### Task 12: Electron Builder — Bundle Pi Extensions

**Files:**
- Modify: `electron-builder.yml` (or equivalent build config)

- [ ] **Step 1: Check build config for extraResources**

Look at the electron-builder config to understand how resources are bundled. If `resources/` is already included, no change needed. If not, add `pi-extensions` to `extraResources`:

```yaml
extraResources:
  - from: resources/pi-extensions
    to: pi-extensions
```

- [ ] **Step 2: Verify build works**

Run: `npm run build`
Expected: PASS

- [ ] **Step 3: Commit (if changes were needed)**

```bash
git add electron-builder.yml
git commit -m "chore: bundle pi-extensions in app resources"
```

---

### Task 13: Integration Test — End-to-End Verification

- [ ] **Step 1: Verify typecheck**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 2: Verify lint**

Run: `npm run lint`
Expected: PASS (or only pre-existing warnings)

- [ ] **Step 3: Verify build**

Run: `npm run build`
Expected: PASS

- [ ] **Step 4: Manual smoke test**

1. Start Fleet in dev mode (`npm run dev`)
2. Open a terminal tab
3. Run `fleet pi` in the terminal
4. Verify: A new tab appears with "Pi Agent" label and Bot icon
5. Verify: Pi agent TUI loads (or shows install progress then loads)
6. Verify: Pi agent is running in the correct working directory

- [ ] **Step 5: Final commit if any fixes were needed**

```bash
git add -A
git commit -m "fix(pi): address integration issues from smoke test"
```
