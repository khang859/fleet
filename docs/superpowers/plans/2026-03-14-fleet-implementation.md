# Fleet Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a cross-platform terminal multiplexer Electron app with notification detection, a socket API for automation, and a pixel-art agent visualizer.

**Architecture:** Layered core — Layer 1 (terminal multiplexer) is the foundation, with Layer 2 (notifications), Layer 3 (socket API), and Layer 4 (agent visualizer) as loosely coupled modules that hook into the core via an internal event bus. All detection and state management runs in the main process; the renderer is a pure consumer via IPC.

**Tech Stack:** Electron, electron-vite, React, TypeScript, xterm.js, node-pty, shadcn/ui, Tailwind CSS, electron-store, electron-updater.

**Spec:** `docs/superpowers/specs/2026-03-14-fleet-design.md`

---

## File Structure

```
src/
  main/
    index.ts                         # Electron main process entry, creates BrowserWindow
    pty-manager.ts                   # Map<paneId, IPty>, spawn/resize/kill PTY processes
    ipc-handlers.ts                  # registers all IPC channels, bridges renderer <-> main
    layout-store.ts                  # electron-store wrapper for workspace persistence
    shell-detection.ts               # cross-platform default shell detection
    notification-detector.ts         # scans PTY data for OSC sequences + patterns
    event-bus.ts                     # typed EventEmitter for cross-module communication
    socket-api.ts                    # Unix socket / named pipe JSON-over-newline server
    agent-state-tracker.ts           # maintains Map<paneId, AgentVisualState> from event bus
    jsonl-watcher.ts                 # watches ~/.claude/projects/ for JSONL transcript files

  preload/
    index.ts                         # contextBridge exposing typed IPC API to renderer

  renderer/
    index.html                       # HTML entry point
    main.tsx                         # React entry, mounts <App />
    App.tsx                          # root layout: sidebar + pane grid + visualizer panel
    types.ts                         # renderer-side types (mirrors shared types)

    components/
      Sidebar.tsx                    # vertical tab list with badges, workspace picker
      WorkspacePicker.tsx            # dropdown/modal for create/save/load/delete workspaces
      TabItem.tsx                    # single tab in sidebar with label, badge, context menu
      PaneGrid.tsx                   # recursive split tree renderer with resize handles
      TerminalPane.tsx               # mounts xterm.js instance, wires IPC data flow
      SearchBar.tsx                  # Cmd+F search overlay for active pane
      SettingsModal.tsx              # settings panel (general, notifications, socket, visualizer)
      ShortcutsPanel.tsx             # keyboard shortcuts overlay

    components/visualizer/
      VisualizerPanel.tsx            # toggleable drawer/tab panel wrapping the canvas
      OfficeCanvas.tsx               # React component wrapping <canvas>, render loop
      office-renderer.ts             # tilemap + furniture + character rendering
      characters.ts                  # character state machine, animations, BFS pathfinding
      sprites.ts                     # sprite loading, ImageBitmap cache, hue-shifting
      matrix-effect.ts               # spawn/despawn green rain overlay
      office-state.ts                # desk assignment, office layout management

    hooks/
      use-terminal.ts                # xterm.js lifecycle (create, attach, dispose)
      use-pane-navigation.ts         # keyboard navigation between panes
      use-notifications.ts           # listens to IPC notification events, manages badge/sound

    store/
      workspace-store.ts             # React state for active workspace, tabs, panes
      notification-store.ts          # notification badge state in renderer
      visualizer-store.ts            # agent visual state in renderer (from IPC)
      settings-store.ts              # settings state, synced with electron-store

  shared/
    types.ts                         # Workspace, Tab, PaneNode, PaneLeaf, etc. (shared main+renderer)
    constants.ts                     # IPC channel names, defaults, socket paths
    ipc-api.ts                       # typed IPC API contract (request/response shapes)

  assets/
    sounds/
      chime.mp3                      # notification chime
    sprites/                         # pixel-art PNGs (tilemap, furniture, characters)

electron-builder.yml                 # electron-builder config for macOS + Windows
```

---

## Chunk 0: Project Scaffolding

### Task 0.1: Scaffold electron-vite project

**Files:**
- Create: `package.json`, `electron-builder.yml`, `electron.vite.config.ts`, `tsconfig.json`, `tsconfig.node.json`, `tsconfig.web.json`
- Create: `src/main/index.ts`, `src/preload/index.ts`, `src/renderer/index.html`, `src/renderer/main.tsx`

- [x] **Step 1: Scaffold the project into a temp directory and merge into repo**

Run:
```bash
cd /tmp && npm create @quick-start/electron@latest fleet-scaffold -- --template react-ts
cd /Users/khangnguyen/Development/fleet
cp -r /tmp/fleet-scaffold/. .
rm -rf /tmp/fleet-scaffold
```

This copies the scaffolded files into the existing repo root. Existing files (`docs/`, `reference/`, `CLAUDE.md`, `.git/`) are preserved — the scaffold doesn't create conflicting files.

- [x] **Step 2: Install dependencies and verify the scaffold runs**

Run:
```bash
npm install && npm run dev
```

Expected: Terminal output includes `electron-vite dev server running` before the Electron window spawns. Close the window to stop the process.

- [x] **Step 3: Commit scaffold**

```bash
git add -A
git commit -m "chore: scaffold electron-vite project with React + TypeScript template"
```

### Task 0.2: Install core dependencies

**Files:**
- Modify: `package.json`

- [x] **Step 1: Install production dependencies**

Run:
```bash
npm install xterm @xterm/addon-webgl @xterm/addon-canvas @xterm/addon-search @xterm/addon-fit @xterm/addon-unicode11 node-pty electron-store electron-updater
```

- [x] **Step 2: Install UI dependencies (shadcn/ui + Tailwind)**

Run:
```bash
npm install -D tailwindcss @tailwindcss/vite
npm install tailwind-merge clsx class-variance-authority lucide-react
npm install @radix-ui/react-context-menu @radix-ui/react-dialog @radix-ui/react-dropdown-menu @radix-ui/react-tooltip @radix-ui/react-switch @radix-ui/react-select @radix-ui/react-separator
```

- [x] **Step 3: Configure Tailwind**

Create `src/renderer/index.css`:
```css
@import "tailwindcss";
```

Update `electron.vite.config.ts` to include the Tailwind Vite plugin for the renderer:
```ts
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  // ... main and preload configs unchanged
  renderer: {
    plugins: [react(), tailwindcss()],
    // ... rest unchanged
  }
})
```

- [x] **Step 4: Verify dependencies install and app still runs**

Run:
```bash
npm run dev
```

Expected: Electron window opens without errors. No import errors in console.

- [x] **Step 5: Commit dependencies**

```bash
git add package.json package-lock.json electron.vite.config.ts src/renderer/index.css
git commit -m "chore: add xterm.js, node-pty, shadcn/ui, and Tailwind dependencies"
```

### Task 0.3: Create shared types and constants

**Files:**
- Create: `src/shared/types.ts`
- Create: `src/shared/constants.ts`
- Create: `src/shared/ipc-api.ts`

- [x] **Step 1: Write shared types**

Create `src/shared/types.ts`:
```ts
export type Workspace = {
  id: string;
  label: string;
  tabs: Tab[];
};

export type Tab = {
  id: string;
  label: string;
  cwd: string;
  splitRoot: PaneNode;
};

export type PaneNode = PaneSplit | PaneLeaf;

export type PaneSplit = {
  type: 'split';
  direction: 'horizontal' | 'vertical';
  ratio: number;
  children: [PaneNode, PaneNode];
};

export type PaneLeaf = {
  type: 'leaf';
  id: string;
  ptyPid?: number;
  shell?: string;
  cwd: string;
};

export type NotificationLevel = 'permission' | 'error' | 'info' | 'subtle';

// Called NotificationEvent (not NotificationState as in spec) to distinguish
// the IPC transport event from any persistent state. Maps 1:1 to spec's NotificationState.
export type NotificationEvent = {
  paneId: string;
  level: NotificationLevel;
  timestamp: number;
};

export type AgentVisualState = {
  paneId: string;
  label: string;
  state: 'working' | 'reading' | 'idle' | 'walking' | 'needs-permission' | 'waiting' | 'not-agent';
  currentTool?: string;
  subAgents: AgentVisualState[];
  uptime: number;
};

export type FleetSettings = {
  general: {
    defaultShell: string;
    scrollbackSize: number;
    fontFamily: string;
    fontSize: number;
    theme: 'dark' | 'light';
  };
  notifications: {
    taskComplete: { badge: boolean; sound: boolean; os: boolean };
    needsPermission: { badge: boolean; sound: boolean; os: boolean };
    processExitError: { badge: boolean; sound: boolean; os: boolean };
    processExitClean: { badge: boolean; sound: boolean; os: boolean };
  };
  socketApi: {
    enabled: boolean;
    socketPath: string;
  };
  visualizer: {
    panelMode: 'drawer' | 'tab';
  };
};
```

- [x] **Step 2: Write shared constants**

Create `src/shared/constants.ts`:

Note: `IPC_CHANNELS` and `DEFAULT_SETTINGS` are safe for both main and renderer contexts. `SOCKET_PATH` and `CLAUDE_PROJECTS_DIR` use Node.js built-ins and must only be imported from main/preload — never from renderer code.

```ts
import { join } from 'path';
import { homedir } from 'os';

export const IPC_CHANNELS = {
  PTY_CREATE: 'pty:create',
  PTY_DATA: 'pty:data',
  PTY_INPUT: 'pty:input',
  PTY_RESIZE: 'pty:resize',
  PTY_KILL: 'pty:kill',
  PTY_EXIT: 'pty:exit',
  LAYOUT_SAVE: 'layout:save',
  LAYOUT_LOAD: 'layout:load',
  LAYOUT_LIST: 'layout:list',
  LAYOUT_DELETE: 'layout:delete',
  NOTIFICATION: 'notification',
  PANE_FOCUSED: 'pane:focused',
  AGENT_STATE: 'agent:state',
  SETTINGS_GET: 'settings:get',
  SETTINGS_SET: 'settings:set',
} as const;

export const DEFAULT_SCROLLBACK = 10_000;

// --- Main-process only (Node.js built-ins) ---
// Do NOT import these from renderer code.

export const SOCKET_PATH =
  process.platform === 'win32'
    ? '\\\\.\\pipe\\fleet'
    : join(homedir(), '.fleet', 'fleet.sock');

export const CLAUDE_PROJECTS_DIR = join(homedir(), '.claude', 'projects');

export const DEFAULT_SETTINGS: import('./types').FleetSettings = {
  general: {
    defaultShell: '',
    scrollbackSize: DEFAULT_SCROLLBACK,
    fontFamily: 'monospace',
    fontSize: 14,
    theme: 'dark',
  },
  notifications: {
    taskComplete: { badge: true, sound: false, os: false },
    needsPermission: { badge: true, sound: true, os: true },
    processExitError: { badge: true, sound: false, os: false },
    processExitClean: { badge: false, sound: false, os: false },
  },
  socketApi: {
    enabled: true,
    socketPath: '',
  },
  visualizer: {
    panelMode: 'drawer',
  },
};
```

- [x] **Step 3: Write IPC API contract**

Create `src/shared/ipc-api.ts`:
```ts
import type { Workspace, PaneLeaf, NotificationEvent, AgentVisualState, FleetSettings } from './types';

export type PtyCreateRequest = {
  paneId: string;
  cwd: string;
  shell?: string;
  cmd?: string;
};

export type PtyCreateResponse = {
  paneId: string;
  pid: number;
};

export type PtyDataPayload = {
  paneId: string;
  data: string;
};

export type PtyInputPayload = {
  paneId: string;
  data: string;
};

export type PtyResizePayload = {
  paneId: string;
  cols: number;
  rows: number;
};

export type PtyExitPayload = {
  paneId: string;
  exitCode: number;
};

export type LayoutSaveRequest = {
  workspace: Workspace;
};

export type LayoutListResponse = {
  workspaces: Workspace[];
};

export type NotificationPayload = NotificationEvent;

export type PaneFocusedPayload = {
  paneId: string;
};

export type AgentStatePayload = {
  states: AgentVisualState[];
};
```

- [x] **Step 4: Type-check to verify all types compile**

Run:
```bash
npx tsc --noEmit
```

Expected: TypeScript compiler exits with code 0, no diagnostics printed.

- [x] **Step 5: Commit shared types**

```bash
git add src/shared/
git commit -m "feat: add shared types, constants, and IPC API contract"
```

### Task 0.4: Set up preload script with typed IPC

**Files:**
- Modify: `src/preload/index.ts`

- [x] **Step 1: Write the preload script**

Replace `src/preload/index.ts`:
```ts
import { contextBridge, ipcRenderer } from 'electron';
import { IPC_CHANNELS } from '../shared/constants';
import type {
  PtyCreateRequest,
  PtyCreateResponse,
  PtyDataPayload,
  PtyInputPayload,
  PtyResizePayload,
  PtyExitPayload,
  LayoutSaveRequest,
  LayoutListResponse,
  NotificationPayload,
  PaneFocusedPayload,
  AgentStatePayload,
} from '../shared/ipc-api';
import type { Workspace, FleetSettings } from '../shared/types';

const fleetApi = {
  pty: {
    create: (req: PtyCreateRequest): Promise<PtyCreateResponse> =>
      ipcRenderer.invoke(IPC_CHANNELS.PTY_CREATE, req),
    input: (payload: PtyInputPayload): void =>
      ipcRenderer.send(IPC_CHANNELS.PTY_INPUT, payload),
    resize: (payload: PtyResizePayload): void =>
      ipcRenderer.send(IPC_CHANNELS.PTY_RESIZE, payload),
    kill: (paneId: string): void =>
      ipcRenderer.send(IPC_CHANNELS.PTY_KILL, paneId),
    onData: (callback: (payload: PtyDataPayload) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, payload: PtyDataPayload) => callback(payload);
      ipcRenderer.on(IPC_CHANNELS.PTY_DATA, handler);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.PTY_DATA, handler);
    },
    onExit: (callback: (payload: PtyExitPayload) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, payload: PtyExitPayload) => callback(payload);
      ipcRenderer.on(IPC_CHANNELS.PTY_EXIT, handler);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.PTY_EXIT, handler);
    },
  },
  layout: {
    save: (req: LayoutSaveRequest): Promise<void> =>
      ipcRenderer.invoke(IPC_CHANNELS.LAYOUT_SAVE, req),
    load: (workspaceId: string): Promise<Workspace> =>
      ipcRenderer.invoke(IPC_CHANNELS.LAYOUT_LOAD, workspaceId),
    list: (): Promise<LayoutListResponse> =>
      ipcRenderer.invoke(IPC_CHANNELS.LAYOUT_LIST),
    delete: (workspaceId: string): Promise<void> =>
      ipcRenderer.invoke(IPC_CHANNELS.LAYOUT_DELETE, workspaceId),
  },
  notifications: {
    onNotification: (callback: (payload: NotificationPayload) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, payload: NotificationPayload) => callback(payload);
      ipcRenderer.on(IPC_CHANNELS.NOTIFICATION, handler);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.NOTIFICATION, handler);
    },
    paneFocused: (payload: PaneFocusedPayload): void =>
      ipcRenderer.send(IPC_CHANNELS.PANE_FOCUSED, payload),
  },
  agentState: {
    onStateUpdate: (callback: (payload: AgentStatePayload) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, payload: AgentStatePayload) => callback(payload);
      ipcRenderer.on(IPC_CHANNELS.AGENT_STATE, handler);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.AGENT_STATE, handler);
    },
  },
  settings: {
    get: (): Promise<FleetSettings> =>
      ipcRenderer.invoke(IPC_CHANNELS.SETTINGS_GET),
    set: (settings: Partial<FleetSettings>): Promise<void> =>
      ipcRenderer.invoke(IPC_CHANNELS.SETTINGS_SET, settings),
  },
};

contextBridge.exposeInMainWorld('fleet', fleetApi);

export type FleetApi = typeof fleetApi;
```

- [x] **Step 2: Add global type declaration for the renderer**

Create `src/renderer/env.d.ts`:
```ts
import type { FleetApi } from '../preload/index';

declare global {
  interface Window {
    fleet: FleetApi;
  }
}
```

- [x] **Step 3: Type-check to verify everything compiles**

Run:
```bash
npx tsc --noEmit
```

Expected: TypeScript compiler exits with code 0, no diagnostics printed.

- [x] **Step 4: Commit preload script**

```bash
git add src/preload/index.ts src/renderer/env.d.ts
git commit -m "feat: add typed preload script with IPC bridge"
```

---

## Chunk 1: Terminal Core (Layer 1)

The main process modules for shell detection, PTY management, layout persistence, and IPC — plus the renderer components for the terminal UI.

### Task 1.1: Shell detection module

**Files:**
- Create: `src/main/shell-detection.ts`
- Create: `src/main/__tests__/shell-detection.test.ts`

- [x] **Step 1: Set up Vitest for main process tests**

Run:
```bash
npm install -D vitest
```

Add to `package.json` scripts:
```json
"test": "vitest run",
"test:watch": "vitest"
```

Create `vitest.config.ts` at the project root:
```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/main/__tests__/**/*.test.ts'],
  },
});
```

- [x] **Step 2: Write the failing test**

Create `src/main/__tests__/shell-detection.test.ts`:
```ts
import { describe, it, expect, vi } from 'vitest';
import { getDefaultShell } from '../shell-detection';

describe('getDefaultShell', () => {
  it('returns SHELL env var on non-win32 platforms', () => {
    vi.stubGlobal('process', { ...process, platform: 'darwin', env: { SHELL: '/bin/zsh' } });
    expect(getDefaultShell()).toBe('/bin/zsh');
    vi.unstubAllGlobals();
  });

  it('falls back to /bin/zsh when SHELL is unset on non-win32', () => {
    vi.stubGlobal('process', { ...process, platform: 'darwin', env: {} });
    expect(getDefaultShell()).toBe('/bin/zsh');
    vi.unstubAllGlobals();
  });
});
```

- [x] **Step 3: Run test to verify it fails**

Run:
```bash
npm test
```

Expected: FAIL — `Cannot find module '../shell-detection'`

- [x] **Step 4: Write the implementation**

Create `src/main/shell-detection.ts`:
```ts
import { execSync } from 'child_process';

export function getDefaultShell(): string {
  if (process.platform === 'win32') {
    return hasWSL() ? 'wsl.exe' : 'powershell.exe';
  }
  return process.env.SHELL ?? '/bin/zsh';
}

export function hasWSL(): boolean {
  try {
    execSync('wsl.exe --status', { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

export function getWSLDistros(): string[] {
  try {
    const output = execSync('wsl.exe --list --quiet', { encoding: 'utf-8' });
    return output
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}
```

- [x] **Step 5: Run test to verify it passes**

Run:
```bash
npm test
```

Expected: PASS — 2 tests pass.

- [x] **Step 6: Commit**

```bash
git add vitest.config.ts package.json package-lock.json src/main/shell-detection.ts src/main/__tests__/shell-detection.test.ts
git commit -m "feat: add cross-platform shell detection with tests"
```

### Task 1.2: PTY manager

**Files:**
- Create: `src/main/pty-manager.ts`
- Create: `src/main/__tests__/pty-manager.test.ts`

- [x] **Step 1: Write the failing test**

Create `src/main/__tests__/pty-manager.test.ts`:
```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PtyManager } from '../pty-manager';

// Mock node-pty since we can't spawn real PTYs in unit tests
vi.mock('node-pty', () => ({
  spawn: vi.fn(() => ({
    pid: 12345,
    onData: vi.fn(),
    onExit: vi.fn(),
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(),
  })),
}));

describe('PtyManager', () => {
  let manager: PtyManager;

  beforeEach(() => {
    manager = new PtyManager();
  });

  it('creates a PTY and stores it by paneId', () => {
    const result = manager.create({
      paneId: 'pane-1',
      cwd: '/tmp',
      shell: '/bin/zsh',
    });
    expect(result.paneId).toBe('pane-1');
    expect(result.pid).toBe(12345);
    expect(manager.has('pane-1')).toBe(true);
  });

  it('kills a PTY and removes it from the map', () => {
    manager.create({ paneId: 'pane-1', cwd: '/tmp', shell: '/bin/zsh' });
    manager.kill('pane-1');
    expect(manager.has('pane-1')).toBe(false);
  });

  it('returns all active pane IDs', () => {
    manager.create({ paneId: 'pane-1', cwd: '/tmp', shell: '/bin/zsh' });
    manager.create({ paneId: 'pane-2', cwd: '/tmp', shell: '/bin/zsh' });
    expect(manager.paneIds()).toEqual(['pane-1', 'pane-2']);
  });

  it('throws when creating a duplicate paneId', () => {
    manager.create({ paneId: 'pane-1', cwd: '/tmp', shell: '/bin/zsh' });
    expect(() =>
      manager.create({ paneId: 'pane-1', cwd: '/tmp', shell: '/bin/zsh' })
    ).toThrow('pane-1 already exists');
  });
});
```

- [x] **Step 2: Run test to verify it fails**

Run:
```bash
npm test
```

Expected: FAIL — `Cannot find module '../pty-manager'`

- [x] **Step 3: Write the implementation**

Create `src/main/pty-manager.ts`:
```ts
import * as pty from 'node-pty';
import { getDefaultShell } from './shell-detection';

export type PtyCreateOptions = {
  paneId: string;
  cwd: string;
  shell?: string;
  cmd?: string;
  cols?: number;
  rows?: number;
};

export type PtyCreateResult = {
  paneId: string;
  pid: number;
};

type PtyEntry = {
  process: pty.IPty;
  paneId: string;
};

export class PtyManager {
  private ptys = new Map<string, PtyEntry>();

  create(opts: PtyCreateOptions): PtyCreateResult {
    if (this.ptys.has(opts.paneId)) {
      throw new Error(`${opts.paneId} already exists`);
    }

    const shell = opts.shell ?? getDefaultShell();
    const args: string[] = [];

    if (opts.cmd) {
      // Run the command then exec back into an interactive shell so the pane
      // stays alive after the command exits (e.g., `claude` finishes a task).
      args.push('-c', `${opts.cmd}; exec ${shell}`);
    }

    const proc = pty.spawn(shell, args, {
      name: 'xterm-256color',
      cols: opts.cols ?? 80,
      rows: opts.rows ?? 24,
      cwd: opts.cwd,
      env: process.env as Record<string, string>,
    });

    this.ptys.set(opts.paneId, { process: proc, paneId: opts.paneId });

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

  kill(paneId: string): void {
    const entry = this.ptys.get(paneId);
    if (entry) {
      entry.process.kill();
      this.ptys.delete(paneId);
    }
  }

  killAll(): void {
    for (const [paneId] of this.ptys) {
      this.kill(paneId);
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

  onData(paneId: string, callback: (data: string) => void): void {
    const entry = this.ptys.get(paneId);
    if (entry) {
      entry.process.onData(callback);
    }
  }

  onExit(paneId: string, callback: (exitCode: number) => void): void {
    const entry = this.ptys.get(paneId);
    if (entry) {
      entry.process.onExit(({ exitCode }) => {
        this.ptys.delete(paneId);
        callback(exitCode);
      });
    }
  }
}
```

- [x] **Step 4: Run test to verify it passes**

Run:
```bash
npm test
```

Expected: PASS — 4 tests pass.

- [x] **Step 5: Commit**

```bash
git add src/main/pty-manager.ts src/main/__tests__/pty-manager.test.ts
git commit -m "feat: add PTY manager with spawn/kill/resize lifecycle"
```

### Task 1.3: Layout store (workspace persistence)

**Files:**
- Create: `src/main/layout-store.ts`
- Create: `src/main/__tests__/layout-store.test.ts`

- [x] **Step 1: Write the failing test**

Create `src/main/__tests__/layout-store.test.ts`:
```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { LayoutStore } from '../layout-store';

// Mock electron-store
vi.mock('electron-store', () => {
  return {
    default: vi.fn().mockImplementation(() => {
      const data: Record<string, unknown> = {};
      return {
        get: vi.fn((key: string, defaultVal?: unknown) => data[key] ?? defaultVal),
        set: vi.fn((key: string, value: unknown) => { data[key] = value; }),
        delete: vi.fn((key: string) => { delete data[key]; }),
      };
    }),
  };
});

describe('LayoutStore', () => {
  let store: LayoutStore;

  beforeEach(() => {
    store = new LayoutStore();
  });

  it('returns empty list when no workspaces saved', () => {
    expect(store.list()).toEqual([]);
  });

  it('saves and loads a workspace', () => {
    const workspace = {
      id: 'ws-1',
      label: 'Test',
      tabs: [{
        id: 'tab-1',
        label: 'Shell',
        cwd: '/tmp',
        splitRoot: { type: 'leaf' as const, id: 'pane-1', cwd: '/tmp' },
      }],
    };
    store.save(workspace);
    expect(store.load('ws-1')).toEqual(workspace);
  });

  it('lists all saved workspaces', () => {
    store.save({ id: 'ws-1', label: 'A', tabs: [] });
    store.save({ id: 'ws-2', label: 'B', tabs: [] });
    const list = store.list();
    expect(list).toHaveLength(2);
    expect(list.map((w) => w.id)).toEqual(['ws-1', 'ws-2']);
  });

  it('deletes a workspace', () => {
    store.save({ id: 'ws-1', label: 'A', tabs: [] });
    store.delete('ws-1');
    expect(store.load('ws-1')).toBeUndefined();
  });
});
```

- [x] **Step 2: Run test to verify it fails**

Run:
```bash
npm test
```

Expected: FAIL — `Cannot find module '../layout-store'`

- [x] **Step 3: Write the implementation**

Create `src/main/layout-store.ts`:
```ts
import Store from 'electron-store';
import type { Workspace } from '../shared/types';

type StoreSchema = {
  workspaces: Record<string, Workspace>;
};

export class LayoutStore {
  private store: Store<StoreSchema>;

  constructor() {
    this.store = new Store<StoreSchema>({
      name: 'fleet-layouts',
      defaults: {
        workspaces: {},
      },
    });
  }

  save(workspace: Workspace): void {
    const workspaces = this.store.get('workspaces', {});
    workspaces[workspace.id] = workspace;
    this.store.set('workspaces', workspaces);
  }

  load(workspaceId: string): Workspace | undefined {
    const workspaces = this.store.get('workspaces', {});
    return workspaces[workspaceId];
  }

  list(): Workspace[] {
    const workspaces = this.store.get('workspaces', {});
    return Object.values(workspaces);
  }

  delete(workspaceId: string): void {
    const workspaces = this.store.get('workspaces', {});
    delete workspaces[workspaceId];
    this.store.set('workspaces', workspaces);
  }
}
```

- [x] **Step 4: Run test to verify it passes**

Run:
```bash
npm test
```

Expected: PASS — 4 tests pass.

- [x] **Step 5: Commit**

```bash
git add src/main/layout-store.ts src/main/__tests__/layout-store.test.ts
git commit -m "feat: add layout store for workspace persistence via electron-store"
```

### Task 1.4: Event bus

**Files:**
- Create: `src/main/event-bus.ts`
- Create: `src/main/__tests__/event-bus.test.ts`

- [x] **Step 1: Write the failing test**

Create `src/main/__tests__/event-bus.test.ts`:
```ts
import { describe, it, expect, vi } from 'vitest';
import { EventBus, FleetEvent } from '../event-bus';

describe('EventBus', () => {
  it('emits and receives typed events', () => {
    const bus = new EventBus();
    const callback = vi.fn();
    bus.on('notification', callback);

    const event: FleetEvent = {
      type: 'notification',
      paneId: 'pane-1',
      level: 'permission',
      timestamp: Date.now(),
    };
    bus.emit('notification', event);

    expect(callback).toHaveBeenCalledWith(event);
  });

  it('supports multiple listeners on the same event', () => {
    const bus = new EventBus();
    const cb1 = vi.fn();
    const cb2 = vi.fn();
    bus.on('notification', cb1);
    bus.on('notification', cb2);

    bus.emit('notification', { type: 'notification', paneId: 'p', level: 'info', timestamp: 0 });

    expect(cb1).toHaveBeenCalled();
    expect(cb2).toHaveBeenCalled();
  });

  it('removes a listener with off()', () => {
    const bus = new EventBus();
    const callback = vi.fn();
    bus.on('notification', callback);
    bus.off('notification', callback);

    bus.emit('notification', { type: 'notification', paneId: 'p', level: 'info', timestamp: 0 });

    expect(callback).not.toHaveBeenCalled();
  });

  it('emits pane lifecycle events', () => {
    const bus = new EventBus();
    const callback = vi.fn();
    bus.on('pane-created', callback);

    bus.emit('pane-created', { type: 'pane-created', paneId: 'pane-1' });

    expect(callback).toHaveBeenCalledWith({ type: 'pane-created', paneId: 'pane-1' });
  });
});
```

- [x] **Step 2: Run test to verify it fails**

Run:
```bash
npm test
```

Expected: FAIL — `Cannot find module '../event-bus'`

- [x] **Step 3: Write the implementation**

Create `src/main/event-bus.ts`:
```ts
import { EventEmitter } from 'events';
import type { NotificationLevel } from '../shared/types';

export type FleetEvent =
  | { type: 'notification'; paneId: string; level: NotificationLevel; timestamp: number }
  | { type: 'pane-created'; paneId: string }
  | { type: 'pane-closed'; paneId: string }
  | { type: 'pty-exit'; paneId: string; exitCode: number }
  | { type: 'agent-state-change'; paneId: string; state: string; tool?: string }
  | { type: 'workspace-loaded'; workspaceId: string };

type EventMap = {
  [K in FleetEvent['type']]: Extract<FleetEvent, { type: K }>;
};

export class EventBus {
  private emitter = new EventEmitter();

  on<K extends keyof EventMap>(event: K, listener: (data: EventMap[K]) => void): void {
    this.emitter.on(event, listener);
  }

  off<K extends keyof EventMap>(event: K, listener: (data: EventMap[K]) => void): void {
    this.emitter.off(event, listener);
  }

  emit<K extends keyof EventMap>(event: K, data: EventMap[K]): void {
    this.emitter.emit(event, data);
  }
}
```

- [x] **Step 4: Run test to verify it passes**

Run:
```bash
npm test
```

Expected: PASS — 4 tests pass.

- [x] **Step 5: Commit**

```bash
git add src/main/event-bus.ts src/main/__tests__/event-bus.test.ts
git commit -m "feat: add typed event bus for cross-module communication"
```

### Task 1.5: IPC handlers (wiring main process together)

**Files:**
- Create: `src/main/ipc-handlers.ts`
- Modify: `src/main/index.ts`

- [x] **Step 1: Write the IPC handlers**

Create `src/main/ipc-handlers.ts`:
```ts
import { ipcMain, BrowserWindow } from 'electron';
import { IPC_CHANNELS } from '../shared/constants';
import type {
  PtyCreateRequest,
  PtyDataPayload,
  PtyInputPayload,
  PtyResizePayload,
  PtyExitPayload,
  LayoutSaveRequest,
  LayoutListResponse,
  PaneFocusedPayload,
} from '../shared/ipc-api';
import type { Workspace } from '../shared/types';
import { PtyManager } from './pty-manager';
import { LayoutStore } from './layout-store';
import { EventBus } from './event-bus';

export function registerIpcHandlers(
  ptyManager: PtyManager,
  layoutStore: LayoutStore,
  eventBus: EventBus,
  getWindow: () => BrowserWindow | null,
): void {
  // PTY handlers
  ipcMain.handle(IPC_CHANNELS.PTY_CREATE, (_event, req: PtyCreateRequest) => {
    const result = ptyManager.create(req);
    const win = getWindow();

    ptyManager.onData(req.paneId, (data) => {
      win?.webContents.send(IPC_CHANNELS.PTY_DATA, { paneId: req.paneId, data } satisfies PtyDataPayload);
    });

    ptyManager.onExit(req.paneId, (exitCode) => {
      win?.webContents.send(IPC_CHANNELS.PTY_EXIT, { paneId: req.paneId, exitCode } satisfies PtyExitPayload);
      eventBus.emit('pty-exit', { type: 'pty-exit', paneId: req.paneId, exitCode });
    });

    eventBus.emit('pane-created', { type: 'pane-created', paneId: req.paneId });
    return result;
  });

  ipcMain.on(IPC_CHANNELS.PTY_INPUT, (_event, payload: PtyInputPayload) => {
    ptyManager.write(payload.paneId, payload.data);
  });

  ipcMain.on(IPC_CHANNELS.PTY_RESIZE, (_event, payload: PtyResizePayload) => {
    ptyManager.resize(payload.paneId, payload.cols, payload.rows);
  });

  ipcMain.on(IPC_CHANNELS.PTY_KILL, (_event, paneId: string) => {
    ptyManager.kill(paneId);
    eventBus.emit('pane-closed', { type: 'pane-closed', paneId });
  });

  // Layout handlers
  ipcMain.handle(IPC_CHANNELS.LAYOUT_SAVE, (_event, req: LayoutSaveRequest) => {
    layoutStore.save(req.workspace);
  });

  ipcMain.handle(IPC_CHANNELS.LAYOUT_LOAD, (_event, workspaceId: string): Workspace | undefined => {
    return layoutStore.load(workspaceId);
  });

  ipcMain.handle(IPC_CHANNELS.LAYOUT_LIST, (): LayoutListResponse => {
    return { workspaces: layoutStore.list() };
  });

  ipcMain.handle(IPC_CHANNELS.LAYOUT_DELETE, (_event, workspaceId: string) => {
    layoutStore.delete(workspaceId);
  });

  // Notification handlers
  ipcMain.on(IPC_CHANNELS.PANE_FOCUSED, (_event, payload: PaneFocusedPayload) => {
    // Clear notification state for this pane — consumed by notification system in Layer 2
  });

  // Settings handlers (stub — full implementation in Layer 5)
  ipcMain.handle(IPC_CHANNELS.SETTINGS_GET, () => {
    const { DEFAULT_SETTINGS } = require('../shared/constants');
    return DEFAULT_SETTINGS;
  });

  ipcMain.handle(IPC_CHANNELS.SETTINGS_SET, (_event, _settings) => {
    // Stub — settings persistence added in Layer 5
  });
}
```

- [x] **Step 2: Wire up main process entry point**

Replace `src/main/index.ts` with:
```ts
import { app, BrowserWindow } from 'electron';
import { join } from 'path';
import { PtyManager } from './pty-manager';
import { LayoutStore } from './layout-store';
import { EventBus } from './event-bus';
import { registerIpcHandlers } from './ipc-handlers';

let mainWindow: BrowserWindow | null = null;
const ptyManager = new PtyManager();
const layoutStore = new LayoutStore();
const eventBus = new EventBus();

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
    },
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 12, y: 12 },
  });

  if (process.env.ELECTRON_RENDERER_URL) {
    mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'));
  }
}

app.whenReady().then(() => {
  registerIpcHandlers(ptyManager, layoutStore, eventBus, () => mainWindow);
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  ptyManager.killAll();
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
```

- [x] **Step 3: Type-check**

Run:
```bash
npx tsc --noEmit
```

Expected: TypeScript compiler exits with code 0.

- [x] **Step 4: Commit**

```bash
git add src/main/ipc-handlers.ts src/main/index.ts
git commit -m "feat: add IPC handlers wiring PTY manager, layout store, and event bus"
```

### Task 1.6: Workspace store (renderer state)

**Files:**
- Create: `src/renderer/store/workspace-store.ts`

- [x] **Step 1: Install zustand**

Run:
```bash
npm install zustand
```

- [x] **Step 2: Write the workspace store**

Create `src/renderer/store/workspace-store.ts`:
```ts
import { create } from 'zustand';
import type { Workspace, Tab, PaneNode, PaneLeaf, PaneSplit } from '../../shared/types';

function generateId(): string {
  return crypto.randomUUID();
}

function createLeaf(cwd: string): PaneLeaf {
  return { type: 'leaf', id: generateId(), cwd };
}

type WorkspaceStore = {
  workspace: Workspace;
  activeTabId: string | null;
  activePaneId: string | null;

  // Tab actions
  addTab: (label: string, cwd: string) => string;
  closeTab: (tabId: string) => void;
  renameTab: (tabId: string, label: string) => void;
  setActiveTab: (tabId: string) => void;

  // Pane actions
  splitPane: (paneId: string, direction: 'horizontal' | 'vertical') => string;
  closePane: (paneId: string) => void;
  setActivePane: (paneId: string) => void;
  resizeSplit: (splitNodePath: number[], ratio: number) => void;

  // Workspace actions
  loadWorkspace: (workspace: Workspace) => void;
  setWorkspace: (workspace: Workspace) => void;

  // Helpers
  findTab: (tabId: string) => Tab | undefined;
  getAllPaneIds: () => string[];
};

function removePaneFromTree(node: PaneNode, paneId: string): PaneNode | null {
  if (node.type === 'leaf') {
    return node.id === paneId ? null : node;
  }

  const [left, right] = node.children;
  if (left.type === 'leaf' && left.id === paneId) return right;
  if (right.type === 'leaf' && right.id === paneId) return left;

  const newLeft = removePaneFromTree(left, paneId);
  const newRight = removePaneFromTree(right, paneId);

  if (!newLeft) return newRight;
  if (!newRight) return newLeft;

  return { ...node, children: [newLeft, newRight] };
}

function collectPaneIds(node: PaneNode): string[] {
  if (node.type === 'leaf') return [node.id];
  return [...collectPaneIds(node.children[0]), ...collectPaneIds(node.children[1])];
}

export const useWorkspaceStore = create<WorkspaceStore>((set, get) => ({
  workspace: { id: 'default', label: 'Default', tabs: [] },
  activeTabId: null,
  activePaneId: null,

  addTab: (label, cwd) => {
    const leaf = createLeaf(cwd);
    const tab: Tab = { id: generateId(), label, cwd, splitRoot: leaf };
    set((state) => ({
      workspace: {
        ...state.workspace,
        tabs: [...state.workspace.tabs, tab],
      },
      activeTabId: tab.id,
      activePaneId: leaf.id,
    }));
    return leaf.id;
  },

  closeTab: (tabId) => {
    set((state) => {
      const tabs = state.workspace.tabs.filter((t) => t.id !== tabId);
      const nextTab = tabs.length > 0 ? tabs[tabs.length - 1] : null;
      return {
        workspace: { ...state.workspace, tabs },
        activeTabId: nextTab?.id ?? null,
        activePaneId: nextTab ? collectPaneIds(nextTab.splitRoot)[0] ?? null : null,
      };
    });
  },

  renameTab: (tabId, label) => {
    set((state) => ({
      workspace: {
        ...state.workspace,
        tabs: state.workspace.tabs.map((t) =>
          t.id === tabId ? { ...t, label } : t,
        ),
      },
    }));
  },

  setActiveTab: (tabId) => {
    const tab = get().workspace.tabs.find((t) => t.id === tabId);
    if (tab) {
      const paneIds = collectPaneIds(tab.splitRoot);
      set({ activeTabId: tabId, activePaneId: paneIds[0] ?? null });
    }
  },

  splitPane: (paneId, direction) => {
    const newLeaf = createLeaf(get().workspace.tabs.find((t) =>
      collectPaneIds(t.splitRoot).includes(paneId)
    )?.cwd ?? '/');

    function splitNode(node: PaneNode): PaneNode {
      if (node.type === 'leaf' && node.id === paneId) {
        return {
          type: 'split',
          direction,
          ratio: 0.5,
          children: [node, newLeaf],
        };
      }
      if (node.type === 'split') {
        return {
          ...node,
          children: [splitNode(node.children[0]), splitNode(node.children[1])],
        };
      }
      return node;
    }

    set((state) => ({
      workspace: {
        ...state.workspace,
        tabs: state.workspace.tabs.map((tab) => ({
          ...tab,
          splitRoot: splitNode(tab.splitRoot),
        })),
      },
      activePaneId: newLeaf.id,
    }));

    return newLeaf.id;
  },

  closePane: (paneId) => {
    set((state) => {
      const tabs = state.workspace.tabs
        .map((tab) => {
          const newRoot = removePaneFromTree(tab.splitRoot, paneId);
          if (!newRoot) return null;
          return { ...tab, splitRoot: newRoot };
        })
        .filter((t): t is Tab => t !== null);

      const currentTab = tabs.find((t) => t.id === state.activeTabId);
      const nextPaneId = currentTab
        ? collectPaneIds(currentTab.splitRoot)[0] ?? null
        : null;

      return {
        workspace: { ...state.workspace, tabs },
        activeTabId: currentTab?.id ?? tabs[0]?.id ?? null,
        activePaneId: nextPaneId,
      };
    });
  },

  setActivePane: (paneId) => set({ activePaneId: paneId }),

  resizeSplit: (_splitNodePath, _ratio) => {
    // Resize is handled by updating ratio at the given path in the split tree
    // Implementation deferred to the PaneGrid drag handler which has the path context
  },

  loadWorkspace: (workspace) => {
    const firstTab = workspace.tabs[0];
    const firstPane = firstTab ? collectPaneIds(firstTab.splitRoot)[0] : null;
    set({
      workspace,
      activeTabId: firstTab?.id ?? null,
      activePaneId: firstPane ?? null,
    });
  },

  setWorkspace: (workspace) => set({ workspace }),

  findTab: (tabId) => get().workspace.tabs.find((t) => t.id === tabId),

  getAllPaneIds: () => {
    return get().workspace.tabs.flatMap((tab) => collectPaneIds(tab.splitRoot));
  },
}));
```

- [x] **Step 3: Type-check**

Run:
```bash
npx tsc --noEmit
```

Expected: TypeScript compiler exits with code 0.

- [x] **Step 4: Commit**

```bash
git add src/renderer/store/workspace-store.ts package.json package-lock.json
git commit -m "feat: add zustand workspace store with tab/pane management"
```

### Task 1.7: TerminalPane component

**Files:**
- Create: `src/renderer/hooks/use-terminal.ts`
- Create: `src/renderer/components/TerminalPane.tsx`

- [x] **Step 1: Write the xterm.js lifecycle hook**

Create `src/renderer/hooks/use-terminal.ts`:
```ts
import { useEffect, useRef } from 'react';
import { Terminal } from 'xterm';
import { WebglAddon } from '@xterm/addon-webgl';
import { CanvasAddon } from '@xterm/addon-canvas';
import { FitAddon } from '@xterm/addon-fit';
import { SearchAddon } from '@xterm/addon-search';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import 'xterm/css/xterm.css';

export type UseTerminalOptions = {
  paneId: string;
  cwd: string;
  fontSize?: number;
  fontFamily?: string;
  scrollback?: number;
};

export function useTerminal(
  containerRef: React.RefObject<HTMLDivElement | null>,
  options: UseTerminalOptions,
) {
  const termRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const searchAddonRef = useRef<SearchAddon | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const term = new Terminal({
      fontSize: options.fontSize ?? 14,
      fontFamily: options.fontFamily ?? 'monospace',
      scrollback: options.scrollback ?? 10_000,
      cursorBlink: true,
      theme: {
        background: '#1a1a2e',
        foreground: '#e0e0e0',
      },
    });

    const fitAddon = new FitAddon();
    const searchAddon = new SearchAddon();
    const unicodeAddon = new Unicode11Addon();

    term.loadAddon(fitAddon);
    term.loadAddon(searchAddon);
    term.loadAddon(unicodeAddon);
    term.unicode.activeVersion = '11';

    term.open(container);

    // Try WebGL, fall back to canvas
    try {
      const webgl = new WebglAddon();
      webgl.onContextLoss(() => {
        webgl.dispose();
        term.loadAddon(new CanvasAddon());
      });
      term.loadAddon(webgl);
    } catch {
      term.loadAddon(new CanvasAddon());
    }

    fitAddon.fit();

    termRef.current = term;
    fitAddonRef.current = fitAddon;
    searchAddonRef.current = searchAddon;

    // Wire IPC data flow
    const cleanup = window.fleet.pty.onData(({ paneId, data }) => {
      if (paneId === options.paneId) {
        term.write(data);
      }
    });

    term.onData((data) => {
      window.fleet.pty.input({ paneId: options.paneId, data });
    });

    // Create PTY
    window.fleet.pty.create({
      paneId: options.paneId,
      cwd: options.cwd,
    });

    // Handle resize
    const resizeObserver = new ResizeObserver(() => {
      fitAddon.fit();
      window.fleet.pty.resize({
        paneId: options.paneId,
        cols: term.cols,
        rows: term.rows,
      });
    });
    resizeObserver.observe(container);

    return () => {
      cleanup();
      resizeObserver.disconnect();
      term.dispose();
    };
  }, [options.paneId]);

  return {
    term: termRef,
    fit: () => fitAddonRef.current?.fit(),
    search: (query: string) => searchAddonRef.current?.findNext(query),
    searchPrevious: (query: string) => searchAddonRef.current?.findPrevious(query),
  };
}
```

- [x] **Step 2: Write the TerminalPane component**

Create `src/renderer/components/TerminalPane.tsx`:
```tsx
import { useRef } from 'react';
import { useTerminal } from '../hooks/use-terminal';

type TerminalPaneProps = {
  paneId: string;
  cwd: string;
  isActive: boolean;
  onFocus: () => void;
};

export function TerminalPane({ paneId, cwd, isActive, onFocus }: TerminalPaneProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const { fit } = useTerminal(containerRef, { paneId, cwd });

  return (
    <div
      ref={containerRef}
      className={`h-full w-full overflow-hidden ${isActive ? 'ring-1 ring-blue-500/50' : ''}`}
      onFocus={onFocus}
      onClick={() => {
        onFocus();
        fit();
      }}
    />
  );
}
```

- [x] **Step 3: Type-check**

Run:
```bash
npx tsc --noEmit
```

Expected: TypeScript compiler exits with code 0.

- [x] **Step 4: Commit**

```bash
git add src/renderer/hooks/use-terminal.ts src/renderer/components/TerminalPane.tsx
git commit -m "feat: add TerminalPane component with xterm.js WebGL rendering"
```

### Task 1.8: PaneGrid component (recursive split tree)

**Files:**
- Create: `src/renderer/components/PaneGrid.tsx`

- [x] **Step 1: Write the PaneGrid component**

Create `src/renderer/components/PaneGrid.tsx`:
```tsx
import { useCallback, useRef, useState } from 'react';
import type { PaneNode } from '../../shared/types';
import { TerminalPane } from './TerminalPane';

type PaneGridProps = {
  root: PaneNode;
  activePaneId: string | null;
  onPaneFocus: (paneId: string) => void;
};

export function PaneGrid({ root, activePaneId, onPaneFocus }: PaneGridProps) {
  return (
    <div className="h-full w-full">
      <PaneNodeRenderer
        node={root}
        activePaneId={activePaneId}
        onPaneFocus={onPaneFocus}
      />
    </div>
  );
}

type PaneNodeRendererProps = {
  node: PaneNode;
  activePaneId: string | null;
  onPaneFocus: (paneId: string) => void;
};

function PaneNodeRenderer({ node, activePaneId, onPaneFocus }: PaneNodeRendererProps) {
  if (node.type === 'leaf') {
    return (
      <TerminalPane
        paneId={node.id}
        cwd={node.cwd}
        isActive={node.id === activePaneId}
        onFocus={() => onPaneFocus(node.id)}
      />
    );
  }

  const isHorizontal = node.direction === 'horizontal';

  return (
    <div
      className="flex h-full w-full"
      style={{ flexDirection: isHorizontal ? 'row' : 'column' }}
    >
      <div
        style={{
          [isHorizontal ? 'width' : 'height']: `${node.ratio * 100}%`,
          [isHorizontal ? 'height' : 'width']: '100%',
        }}
      >
        <PaneNodeRenderer
          node={node.children[0]}
          activePaneId={activePaneId}
          onPaneFocus={onPaneFocus}
        />
      </div>

      <ResizeHandle
        direction={node.direction}
        onResize={() => {
          // Ratio update is handled by the parent container's size change
          // A full implementation would update the workspace store's split ratio
        }}
      />

      <div
        style={{
          [isHorizontal ? 'width' : 'height']: `${(1 - node.ratio) * 100}%`,
          [isHorizontal ? 'height' : 'width']: '100%',
        }}
      >
        <PaneNodeRenderer
          node={node.children[1]}
          activePaneId={activePaneId}
          onPaneFocus={onPaneFocus}
        />
      </div>
    </div>
  );
}

type ResizeHandleProps = {
  direction: 'horizontal' | 'vertical';
  onResize: (delta: number) => void;
};

function ResizeHandle({ direction, onResize }: ResizeHandleProps) {
  const isHorizontal = direction === 'horizontal';

  function handlePointerDown(e: React.PointerEvent) {
    e.preventDefault();
    const startPos = isHorizontal ? e.clientX : e.clientY;

    function handlePointerMove(moveEvent: PointerEvent) {
      const currentPos = isHorizontal ? moveEvent.clientX : moveEvent.clientY;
      onResize(currentPos - startPos);
    }

    function handlePointerUp() {
      document.removeEventListener('pointermove', handlePointerMove);
      document.removeEventListener('pointerup', handlePointerUp);
    }

    document.addEventListener('pointermove', handlePointerMove);
    document.addEventListener('pointerup', handlePointerUp);
  }

  return (
    <div
      onPointerDown={handlePointerDown}
      className={`
        flex-shrink-0 bg-neutral-800 hover:bg-blue-500 transition-colors
        ${isHorizontal ? 'w-1 cursor-col-resize' : 'h-1 cursor-row-resize'}
      `}
    />
  );
}
```

- [x] **Step 2: Type-check**

Run:
```bash
npx tsc --noEmit
```

Expected: TypeScript compiler exits with code 0.

- [x] **Step 3: Commit**

```bash
git add src/renderer/components/PaneGrid.tsx
git commit -m "feat: add recursive PaneGrid component with split tree rendering"
```

### Task 1.9: Sidebar with tabs

**Files:**
- Create: `src/renderer/components/TabItem.tsx`
- Create: `src/renderer/components/Sidebar.tsx`

- [x] **Step 1: Write the TabItem component**

Create `src/renderer/components/TabItem.tsx`:
```tsx
type TabItemProps = {
  id: string;
  label: string;
  isActive: boolean;
  onClick: () => void;
  onClose: () => void;
  onRename: (newLabel: string) => void;
};

export function TabItem({ id, label, isActive, onClick, onClose, onRename }: TabItemProps) {
  return (
    <div
      className={`
        group flex items-center gap-2 px-3 py-2 cursor-pointer rounded-md text-sm
        ${isActive ? 'bg-neutral-700 text-white' : 'text-neutral-400 hover:bg-neutral-800 hover:text-neutral-200'}
      `}
      onClick={onClick}
    >
      <div className="flex-1 truncate">{label}</div>
      <button
        className="opacity-0 group-hover:opacity-100 text-neutral-500 hover:text-neutral-300 transition-opacity"
        onClick={(e) => {
          e.stopPropagation();
          onClose();
        }}
      >
        ×
      </button>
    </div>
  );
}
```

- [x] **Step 2: Write the Sidebar component**

Create `src/renderer/components/Sidebar.tsx`:
```tsx
import { TabItem } from './TabItem';
import { useWorkspaceStore } from '../store/workspace-store';

export function Sidebar() {
  const { workspace, activeTabId, setActiveTab, closeTab, renameTab, addTab } =
    useWorkspaceStore();

  return (
    <div className="flex flex-col h-full w-56 bg-neutral-900 border-r border-neutral-800">
      {/* Workspace label */}
      <div className="px-3 py-3 text-xs font-semibold text-neutral-500 uppercase tracking-wider">
        {workspace.label}
      </div>

      {/* Tab list */}
      <div className="flex-1 overflow-y-auto px-2 space-y-0.5">
        {workspace.tabs.map((tab) => (
          <TabItem
            key={tab.id}
            id={tab.id}
            label={tab.label}
            isActive={tab.id === activeTabId}
            onClick={() => setActiveTab(tab.id)}
            onClose={() => closeTab(tab.id)}
            onRename={(newLabel) => renameTab(tab.id, newLabel)}
          />
        ))}
      </div>

      {/* New tab button */}
      <div className="p-2 border-t border-neutral-800">
        <button
          className="w-full px-3 py-1.5 text-sm text-neutral-400 hover:text-white hover:bg-neutral-800 rounded-md transition-colors"
          onClick={() => addTab('Shell', '/')}
        >
          + New Tab
        </button>
      </div>
    </div>
  );
}
```

- [x] **Step 3: Type-check**

Run:
```bash
npx tsc --noEmit
```

Expected: TypeScript compiler exits with code 0.

- [x] **Step 4: Commit**

```bash
git add src/renderer/components/TabItem.tsx src/renderer/components/Sidebar.tsx
git commit -m "feat: add Sidebar with vertical tab list"
```

### Task 1.10: Root App layout

**Files:**
- Modify: `src/renderer/App.tsx`
- Modify: `src/renderer/main.tsx`

- [x] **Step 1: Write the App component**

Replace `src/renderer/App.tsx`:
```tsx
import { useEffect } from 'react';
import { Sidebar } from './components/Sidebar';
import { PaneGrid } from './components/PaneGrid';
import { useWorkspaceStore } from './store/workspace-store';

export function App() {
  const { workspace, activeTabId, activePaneId, setActivePane, addTab } =
    useWorkspaceStore();

  const activeTab = workspace.tabs.find((t) => t.id === activeTabId);

  // Create a default tab on first load if workspace is empty
  useEffect(() => {
    if (workspace.tabs.length === 0) {
      addTab('Shell', '/');
    }
  }, []);

  // Handle PTY exit
  useEffect(() => {
    const cleanup = window.fleet.pty.onExit(({ paneId, exitCode }) => {
      // Optionally auto-close pane on clean exit
      // For now, leave the pane open showing exit code
    });
    return cleanup;
  }, []);

  return (
    <div className="flex h-screen w-screen bg-neutral-950 text-white overflow-hidden">
      <Sidebar />
      <main className="flex-1 min-w-0">
        {activeTab ? (
          <PaneGrid
            root={activeTab.splitRoot}
            activePaneId={activePaneId}
            onPaneFocus={(paneId) => {
              setActivePane(paneId);
              window.fleet.notifications.paneFocused({ paneId });
            }}
          />
        ) : (
          <div className="flex items-center justify-center h-full text-neutral-600">
            No tabs open. Press Cmd+T to create one.
          </div>
        )}
      </main>
    </div>
  );
}
```

- [x] **Step 2: Update renderer entry point**

Replace `src/renderer/main.tsx`:
```tsx
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './index.css';

const root = document.getElementById('root');
if (root) {
  createRoot(root).render(
    <StrictMode>
      <App />
    </StrictMode>
  );
}
```

- [x] **Step 3: Run the app end-to-end**

Run:
```bash
npm run dev
```

Expected: Electron window opens showing a sidebar on the left with one "Shell" tab and a terminal pane on the right. The terminal should have a working shell session (typing commands, seeing output).

- [x] **Step 4: Commit**

```bash
git add src/renderer/App.tsx src/renderer/main.tsx
git commit -m "feat: add root App layout with sidebar and terminal pane grid"
```

### Task 1.11: Keyboard shortcuts for tabs and panes

**Files:**
- Create: `src/renderer/hooks/use-pane-navigation.ts`

- [x] **Step 1: Write the keyboard shortcut hook**

Create `src/renderer/hooks/use-pane-navigation.ts`:
```ts
import { useEffect } from 'react';
import { useWorkspaceStore } from '../store/workspace-store';

export function usePaneNavigation() {
  const { workspace, activeTabId, activePaneId, addTab, closePane, splitPane, setActiveTab } =
    useWorkspaceStore();

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      const mod = e.metaKey || e.ctrlKey;

      if (mod && e.key === 't') {
        e.preventDefault();
        addTab('Shell', '/');
      }

      if (mod && e.key === 'w') {
        e.preventDefault();
        if (activePaneId) closePane(activePaneId);
      }

      if (mod && e.key === 'd' && !e.shiftKey) {
        e.preventDefault();
        if (activePaneId) splitPane(activePaneId, 'horizontal');
      }

      if (mod && e.shiftKey && e.key === 'D') {
        e.preventDefault();
        if (activePaneId) splitPane(activePaneId, 'vertical');
      }

      // Cmd+[ / Cmd+] to navigate panes
      if (mod && (e.key === '[' || e.key === ']')) {
        e.preventDefault();
        const allPaneIds = useWorkspaceStore.getState().getAllPaneIds();
        const currentIndex = activePaneId ? allPaneIds.indexOf(activePaneId) : -1;
        const nextIndex = e.key === ']'
          ? (currentIndex + 1) % allPaneIds.length
          : (currentIndex - 1 + allPaneIds.length) % allPaneIds.length;
        if (allPaneIds[nextIndex]) {
          useWorkspaceStore.getState().setActivePane(allPaneIds[nextIndex]);
        }
      }

      // Cmd+1-9 to switch tabs
      if (mod && e.key >= '1' && e.key <= '9') {
        e.preventDefault();
        const index = parseInt(e.key) - 1;
        const tab = workspace.tabs[index];
        if (tab) setActiveTab(tab.id);
      }
    }

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [workspace, activeTabId, activePaneId, addTab, closePane, splitPane, setActiveTab]);
}
```

- [x] **Step 2: Add the hook to App.tsx**

Add to the top of the `App` component function body:
```ts
usePaneNavigation();
```

And add the import:
```ts
import { usePaneNavigation } from './hooks/use-pane-navigation';
```

- [x] **Step 3: Verify shortcuts work**

Run:
```bash
npm run dev
```

Expected: `Cmd+T` creates a new tab, `Cmd+D` splits horizontally, `Cmd+Shift+D` splits vertically, `Cmd+W` closes a pane, `Cmd+1`/`Cmd+2` switches tabs.

- [x] **Step 4: Commit**

```bash
git add src/renderer/hooks/use-pane-navigation.ts src/renderer/App.tsx
git commit -m "feat: add keyboard shortcuts for tab and pane management"
```

### Task 1.12: Search bar

**Files:**
- Create: `src/renderer/components/SearchBar.tsx`

- [x] **Step 1: Write the SearchBar component**

Create `src/renderer/components/SearchBar.tsx`:
```tsx
import { useState, useEffect, useRef } from 'react';

type SearchBarProps = {
  isOpen: boolean;
  onClose: () => void;
  onSearch: (query: string) => void;
  onSearchPrevious: (query: string) => void;
};

export function SearchBar({ isOpen, onClose, onSearch, onSearchPrevious }: SearchBarProps) {
  const [query, setQuery] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (isOpen) {
      inputRef.current?.focus();
    } else {
      setQuery('');
    }
  }, [isOpen]);

  if (!isOpen) return null;

  return (
    <div className="absolute top-0 right-0 z-10 m-2 flex items-center gap-1 bg-neutral-800 border border-neutral-700 rounded-md px-2 py-1 shadow-lg">
      <input
        ref={inputRef}
        type="text"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            if (e.shiftKey) {
              onSearchPrevious(query);
            } else {
              onSearch(query);
            }
          }
          if (e.key === 'Escape') {
            onClose();
          }
        }}
        placeholder="Search..."
        className="bg-transparent text-sm text-white outline-none w-48 placeholder-neutral-500"
      />
      <button
        onClick={onClose}
        className="text-neutral-500 hover:text-white text-sm"
      >
        ×
      </button>
    </div>
  );
}
```

- [x] **Step 2: Wire Cmd+F to toggle search in App.tsx**

This will be integrated when we connect search to the active pane's xterm.js SearchAddon. For now, add `Cmd+F` handling to the keyboard hook in `use-pane-navigation.ts`:

Add to the `handleKeyDown` function:
```ts
if (mod && e.key === 'f') {
  e.preventDefault();
  // Toggle search — will be wired to SearchBar state in App.tsx
  document.dispatchEvent(new CustomEvent('fleet:toggle-search'));
}
```

- [x] **Step 3: Commit**

```bash
git add src/renderer/components/SearchBar.tsx src/renderer/hooks/use-pane-navigation.ts
git commit -m "feat: add search bar component with Cmd+F toggle"
```

---

## Chunk 2: Notification System (Layer 2)

Watches PTY data streams for OSC sequences and patterns, routes events through the event bus, and renders badges, sounds, and OS notifications.

### Task 2.1: Notification detector (main process)

**Files:**
- Create: `src/main/notification-detector.ts`
- Create: `src/main/__tests__/notification-detector.test.ts`

- [x] **Step 1: Write the failing test**

Create `src/main/__tests__/notification-detector.test.ts`:
```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NotificationDetector } from '../notification-detector';
import { EventBus } from '../event-bus';

describe('NotificationDetector', () => {
  let eventBus: EventBus;
  let detector: NotificationDetector;

  beforeEach(() => {
    eventBus = new EventBus();
    detector = new NotificationDetector(eventBus);
  });

  it('detects OSC 9 task completion and emits info notification', () => {
    const callback = vi.fn();
    eventBus.on('notification', callback);

    detector.scan('pane-1', 'some output\x1b]9;task done\x07more output');

    expect(callback).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'notification',
        paneId: 'pane-1',
        level: 'info',
      }),
    );
  });

  it('detects OSC 777 notification', () => {
    const callback = vi.fn();
    eventBus.on('notification', callback);

    detector.scan('pane-1', 'output\x1b]777;notify;title;body\x07rest');

    expect(callback).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'notification',
        paneId: 'pane-1',
        level: 'info',
      }),
    );
  });

  it('detects Claude Code permission prompts', () => {
    const callback = vi.fn();
    eventBus.on('notification', callback);

    detector.scan('pane-1', 'Do you want to allow this action? (y/n)');

    expect(callback).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'notification',
        paneId: 'pane-1',
        level: 'permission',
      }),
    );
  });

  it('does not emit for unrecognized output', () => {
    const callback = vi.fn();
    eventBus.on('notification', callback);

    detector.scan('pane-1', 'regular terminal output here');

    expect(callback).not.toHaveBeenCalled();
  });

  it('does not emit notification for tmux DCS sequences', () => {
    const callback = vi.fn();
    eventBus.on('notification', callback);

    detector.scan('pane-1', 'output\x1bPtmux;\x1b\x1b]stuff\x07\x1b\\rest');

    // tmux DCS is not a notification — tmux label detection is a Layer 1 sidebar concern
    expect(callback).not.toHaveBeenCalled();
  });
});
```

- [x] **Step 2: Run test to verify it fails**

Run:
```bash
npm test
```

Expected: FAIL — `Cannot find module '../notification-detector'`

- [x] **Step 3: Write the implementation**

Create `src/main/notification-detector.ts`:
```ts
import { EventBus } from './event-bus';
import type { NotificationLevel } from '../shared/types';

// Permission prompt patterns from Claude Code and similar tools
const PERMISSION_PATTERNS = [
  /Do you want to (?:allow|proceed|continue)/i,
  /\(y\/n\)\s*$/,
  /Allow this action\?/i,
  /Press Enter to confirm/i,
];

export class NotificationDetector {
  private eventBus: EventBus;

  constructor(eventBus: EventBus) {
    this.eventBus = eventBus;
  }

  scan(paneId: string, data: string): void {
    this.checkOSC9(paneId, data);
    this.checkOSC777(paneId, data);
    this.checkPermissionPrompt(paneId, data);
  }

  private emitNotification(paneId: string, level: NotificationLevel): void {
    this.eventBus.emit('notification', {
      type: 'notification',
      paneId,
      level,
      timestamp: Date.now(),
    });
  }

  private checkOSC9(paneId: string, data: string): void {
    // Note: OSC 9 is also used by iTerm2 for Growl notifications.
    // Claude Code uses it for task completion. May need tighter matching
    // if false positives arise from other terminal apps.
    if (data.includes('\x1b]9;')) {
      this.emitNotification(paneId, 'info');
    }
  }

  private checkOSC777(paneId: string, data: string): void {
    if (data.includes('\x1b]777;')) {
      this.emitNotification(paneId, 'info');
    }
  }

  private checkPermissionPrompt(paneId: string, data: string): void {
    for (const pattern of PERMISSION_PATTERNS) {
      if (pattern.test(data)) {
        this.emitNotification(paneId, 'permission');
        return;
      }
    }
  }

}
```

- [x] **Step 4: Run test to verify it passes**

Run:
```bash
npm test
```

Expected: PASS — 5 tests pass.

- [x] **Step 5: Commit**

```bash
git add src/main/notification-detector.ts src/main/__tests__/notification-detector.test.ts
git commit -m "feat: add notification detector for OSC 9/777 and permission prompts"
```

### Task 2.2: Wire notification detector into PTY data flow

**Files:**
- Modify: `src/main/ipc-handlers.ts`

- [x] **Step 1: Update ipc-handlers.ts to scan PTY output**

Add `NotificationDetector` import and parameter to `registerIpcHandlers`:

```ts
import { NotificationDetector } from './notification-detector';
```

Update the function signature:
```ts
export function registerIpcHandlers(
  ptyManager: PtyManager,
  layoutStore: LayoutStore,
  eventBus: EventBus,
  notificationDetector: NotificationDetector,
  getWindow: () => BrowserWindow | null,
): void {
```

In the `PTY_CREATE` handler, update the `onData` callback to scan before forwarding:

```ts
    ptyManager.onData(req.paneId, (data) => {
      // Scan for notifications BEFORE forwarding to renderer
      notificationDetector.scan(req.paneId, data);

      win?.webContents.send(IPC_CHANNELS.PTY_DATA, { paneId: req.paneId, data } satisfies PtyDataPayload);
    });
```

- [x] **Step 2: Update main/index.ts to create and pass the detector**

Add to `src/main/index.ts` imports and instantiation:
```ts
import { NotificationDetector } from './notification-detector';

const notificationDetector = new NotificationDetector(eventBus);
```

Update the `registerIpcHandlers` call:
```ts
  registerIpcHandlers(ptyManager, layoutStore, eventBus, notificationDetector, () => mainWindow);
```

- [x] **Step 3: Type-check**

Run:
```bash
npx tsc --noEmit
```

Expected: TypeScript compiler exits with code 0.

- [x] **Step 4: Commit**

```bash
git add src/main/ipc-handlers.ts src/main/index.ts
git commit -m "feat: wire notification detector into PTY data flow"
```

### Task 2.3: Notification state manager (main process)

**Files:**
- Create: `src/main/notification-state.ts`
- Create: `src/main/__tests__/notification-state.test.ts`

- [x] **Step 1: Write the failing test**

Create `src/main/__tests__/notification-state.test.ts`:
```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NotificationStateManager } from '../notification-state';
import { EventBus } from '../event-bus';

describe('NotificationStateManager', () => {
  let eventBus: EventBus;
  let manager: NotificationStateManager;

  beforeEach(() => {
    eventBus = new EventBus();
    manager = new NotificationStateManager(eventBus);
  });

  it('tracks notification state per pane', () => {
    eventBus.emit('notification', {
      type: 'notification',
      paneId: 'pane-1',
      level: 'permission',
      timestamp: 1000,
    });

    expect(manager.getState('pane-1')).toEqual({
      paneId: 'pane-1',
      level: 'permission',
      timestamp: 1000,
    });
  });

  it('clears notification state when pane is focused', () => {
    eventBus.emit('notification', {
      type: 'notification',
      paneId: 'pane-1',
      level: 'info',
      timestamp: 1000,
    });

    manager.clearPane('pane-1');

    expect(manager.getState('pane-1')).toBeUndefined();
  });

  it('keeps highest priority notification per pane', () => {
    eventBus.emit('notification', {
      type: 'notification',
      paneId: 'pane-1',
      level: 'info',
      timestamp: 1000,
    });

    eventBus.emit('notification', {
      type: 'notification',
      paneId: 'pane-1',
      level: 'permission',
      timestamp: 2000,
    });

    expect(manager.getState('pane-1')?.level).toBe('permission');
  });

  it('returns all active notifications', () => {
    eventBus.emit('notification', {
      type: 'notification',
      paneId: 'pane-1',
      level: 'info',
      timestamp: 1000,
    });
    eventBus.emit('notification', {
      type: 'notification',
      paneId: 'pane-2',
      level: 'permission',
      timestamp: 2000,
    });

    const all = manager.getAllStates();
    expect(all).toHaveLength(2);
  });

  it('clears state when pane is closed', () => {
    eventBus.emit('notification', {
      type: 'notification',
      paneId: 'pane-1',
      level: 'info',
      timestamp: 1000,
    });

    eventBus.emit('pane-closed', { type: 'pane-closed', paneId: 'pane-1' });

    expect(manager.getState('pane-1')).toBeUndefined();
  });
});
```

- [x] **Step 2: Run test to verify it fails**

Run:
```bash
npm test
```

Expected: FAIL — `Cannot find module '../notification-state'`

- [x] **Step 3: Write the implementation**

Create `src/main/notification-state.ts`:
```ts
import { EventBus } from './event-bus';
import type { NotificationLevel } from '../shared/types';

type NotificationRecord = {
  paneId: string;
  level: NotificationLevel;
  timestamp: number;
};

const PRIORITY: Record<NotificationLevel, number> = {
  permission: 3,
  error: 2,
  info: 1,
  subtle: 0,
};

export class NotificationStateManager {
  private states = new Map<string, NotificationRecord>();

  constructor(private eventBus: EventBus) {
    eventBus.on('notification', (event) => {
      const existing = this.states.get(event.paneId);
      if (!existing || PRIORITY[event.level] >= PRIORITY[existing.level]) {
        this.states.set(event.paneId, {
          paneId: event.paneId,
          level: event.level,
          timestamp: event.timestamp,
        });
      }
    });

    eventBus.on('pane-closed', (event) => {
      this.states.delete(event.paneId);
    });
  }

  getState(paneId: string): NotificationRecord | undefined {
    return this.states.get(paneId);
  }

  getAllStates(): NotificationRecord[] {
    return Array.from(this.states.values());
  }

  clearPane(paneId: string): void {
    this.states.delete(paneId);
  }
}
```

- [x] **Step 4: Run test to verify it passes**

Run:
```bash
npm test
```

Expected: PASS — 5 tests pass.

- [x] **Step 5: Commit**

```bash
git add src/main/notification-state.ts src/main/__tests__/notification-state.test.ts
git commit -m "feat: add notification state manager with priority tracking"
```

### Task 2.4: Forward notifications to renderer via IPC

**Files:**
- Modify: `src/main/index.ts`
- Modify: `src/main/ipc-handlers.ts`

- [x] **Step 1: Create NotificationStateManager in main and forward events to renderer**

Update `src/main/index.ts` — add imports and instantiation:
```ts
import { NotificationStateManager } from './notification-state';

// Module-level — will also be consumed by socket API (Layer 3) for `get-state`
const notificationState = new NotificationStateManager(eventBus);
```

Add event forwarding after `registerIpcHandlers`:
```ts
  // Forward notification events to renderer
  eventBus.on('notification', (event) => {
    mainWindow?.webContents.send(IPC_CHANNELS.NOTIFICATION, {
      paneId: event.paneId,
      level: event.level,
      timestamp: event.timestamp,
    });
  });
```

- [x] **Step 2: Handle pane-focused IPC to clear notification state**

Update `src/main/ipc-handlers.ts` — add `NotificationStateManager` as a parameter:

```ts
import { NotificationStateManager } from './notification-state';
```

Update function signature:
```ts
export function registerIpcHandlers(
  ptyManager: PtyManager,
  layoutStore: LayoutStore,
  eventBus: EventBus,
  notificationDetector: NotificationDetector,
  notificationState: NotificationStateManager,
  getWindow: () => BrowserWindow | null,
): void {
```

Update the `PANE_FOCUSED` handler:
```ts
  ipcMain.on(IPC_CHANNELS.PANE_FOCUSED, (_event, payload: PaneFocusedPayload) => {
    notificationState.clearPane(payload.paneId);
  });
```

Update the `registerIpcHandlers` call in `src/main/index.ts`:
```ts
  registerIpcHandlers(ptyManager, layoutStore, eventBus, notificationDetector, notificationState, () => mainWindow);
```

- [x] **Step 3: Type-check**

Run:
```bash
npx tsc --noEmit
```

Expected: TypeScript compiler exits with code 0.

- [x] **Step 4: Commit**

```bash
git add src/main/index.ts src/main/ipc-handlers.ts
git commit -m "feat: forward notifications to renderer and handle pane focus clearing"
```

### Task 2.5: Notification store and badges (renderer)

**Files:**
- Create: `src/renderer/store/notification-store.ts`
- Create: `src/renderer/hooks/use-notifications.ts`
- Modify: `src/renderer/components/TabItem.tsx`

- [x] **Step 1: Write the notification store**

Create `src/renderer/store/notification-store.ts`:
```ts
import { create } from 'zustand';
import type { NotificationLevel } from '../../shared/types';

type NotificationRecord = {
  paneId: string;
  level: NotificationLevel;
  timestamp: number;
};

type NotificationStore = {
  notifications: Map<string, NotificationRecord>;
  setNotification: (record: NotificationRecord) => void;
  clearPane: (paneId: string) => void;
  getTabBadge: (paneIds: string[]) => NotificationLevel | null;
};

const PRIORITY: Record<NotificationLevel, number> = {
  permission: 3,
  error: 2,
  info: 1,
  subtle: 0,
};

export const useNotificationStore = create<NotificationStore>((set, get) => ({
  notifications: new Map(),

  setNotification: (record) => {
    set((state) => {
      const next = new Map(state.notifications);
      const existing = next.get(record.paneId);
      if (!existing || PRIORITY[record.level] >= PRIORITY[existing.level]) {
        next.set(record.paneId, record);
      }
      return { notifications: next };
    });
  },

  clearPane: (paneId) => {
    set((state) => {
      const next = new Map(state.notifications);
      next.delete(paneId);
      return { notifications: next };
    });
  },

  getTabBadge: (paneIds) => {
    const { notifications } = get();
    let highest: NotificationLevel | null = null;
    let highestPriority = -1;

    for (const paneId of paneIds) {
      const record = notifications.get(paneId);
      if (record && PRIORITY[record.level] > highestPriority) {
        highest = record.level;
        highestPriority = PRIORITY[record.level];
      }
    }
    return highest;
  },
}));
```

- [x] **Step 2: Write the notifications hook**

Create `src/renderer/hooks/use-notifications.ts`:
```ts
import { useEffect } from 'react';
import { useNotificationStore } from '../store/notification-store';

export function useNotifications() {
  const { setNotification } = useNotificationStore();

  useEffect(() => {
    const cleanup = window.fleet.notifications.onNotification((payload) => {
      setNotification({
        paneId: payload.paneId,
        level: payload.level,
        timestamp: payload.timestamp,
      });
    });
    return cleanup;
  }, [setNotification]);
}
```

- [x] **Step 3: Add badge to TabItem**

Update `src/renderer/components/TabItem.tsx` to accept and render a badge:

```tsx
import type { NotificationLevel } from '../../shared/types';

type TabItemProps = {
  id: string;
  label: string;
  isActive: boolean;
  badge: NotificationLevel | null;
  onClick: () => void;
  onClose: () => void;
  onRename: (newLabel: string) => void;
};

const BADGE_COLORS: Record<NotificationLevel, string> = {
  permission: 'bg-amber-500',
  error: 'bg-red-500',
  info: 'bg-blue-500',
  subtle: 'bg-neutral-600',
};

export function TabItem({ id, label, isActive, badge, onClick, onClose, onRename }: TabItemProps) {
  return (
    <div
      className={`
        group flex items-center gap-2 px-3 py-2 cursor-pointer rounded-md text-sm
        ${isActive ? 'bg-neutral-700 text-white' : 'text-neutral-400 hover:bg-neutral-800 hover:text-neutral-200'}
      `}
      onClick={onClick}
    >
      {badge && !isActive && (
        <span className={`w-2 h-2 rounded-full flex-shrink-0 ${BADGE_COLORS[badge]}`} />
      )}
      <div className="flex-1 truncate">{label}</div>
      <button
        className="opacity-0 group-hover:opacity-100 text-neutral-500 hover:text-neutral-300 transition-opacity"
        onClick={(e) => {
          e.stopPropagation();
          onClose();
        }}
      >
        ×
      </button>
    </div>
  );
}
```

- [x] **Step 4: Update Sidebar to pass badge prop**

Update `src/renderer/components/Sidebar.tsx` — add imports and badge computation:

```tsx
import { useNotificationStore } from '../store/notification-store';
```

Inside the `Sidebar` component, add:
```ts
const { getTabBadge } = useNotificationStore();
```

Inline this helper directly in `Sidebar.tsx`:
```ts
function collectPaneIds(node: import('../../shared/types').PaneNode): string[] {
  if (node.type === 'leaf') return [node.id];
  return [...collectPaneIds(node.children[0]), ...collectPaneIds(node.children[1])];
}
```

Update the `TabItem` render to pass the badge:
```tsx
<TabItem
  key={tab.id}
  id={tab.id}
  label={tab.label}
  isActive={tab.id === activeTabId}
  badge={getTabBadge(collectPaneIds(tab.splitRoot))}
  onClick={() => setActiveTab(tab.id)}
  onClose={() => closeTab(tab.id)}
  onRename={(newLabel) => renameTab(tab.id, newLabel)}
/>
```

- [x] **Step 5: Add useNotifications hook to App.tsx**

Add to `src/renderer/App.tsx` imports:
```ts
import { useNotifications } from './hooks/use-notifications';
```

Call at the top of the `App` component body:
```ts
useNotifications();
```

- [x] **Step 6: Type-check**

Run:
```bash
npx tsc --noEmit
```

Expected: TypeScript compiler exits with code 0.

- [x] **Step 7: Commit**

```bash
git add src/renderer/store/notification-store.ts src/renderer/hooks/use-notifications.ts src/renderer/components/TabItem.tsx src/renderer/components/Sidebar.tsx src/renderer/App.tsx
git commit -m "feat: add notification badges on sidebar tabs with priority rendering"
```

### Task 2.6: OS notifications and sound

**Files:**
- Modify: `src/main/index.ts`
- Create: `src/assets/sounds/chime.mp3` (placeholder)

- [x] **Step 1: Add OS notification dispatch in main process**

Add `Notification` to the existing electron import at the top of `src/main/index.ts`:
```ts
import { app, BrowserWindow, Notification } from 'electron';
```

Add `DEFAULT_SETTINGS` to imports:
```ts
import { DEFAULT_SETTINGS } from '../shared/constants';
```

Then add a second `eventBus.on('notification', ...)` listener after the existing one:
eventBus.on('notification', (event) => {
  const settings = DEFAULT_SETTINGS; // Will read from settings store in Layer 5

  // Determine which settings key maps to this notification level
  const settingsKey = {
    permission: 'needsPermission',
    error: 'processExitError',
    info: 'taskComplete',
    subtle: 'processExitClean',
  }[event.level] as keyof typeof settings.notifications;

  const config = settings.notifications[settingsKey];

  // OS notification
  if (config.os && Notification.isSupported()) {
    const notif = new Notification({
      title: 'Fleet',
      body: event.level === 'permission'
        ? 'An agent needs your permission'
        : 'Task completed',
    });
    notif.on('click', () => {
      mainWindow?.show();
      mainWindow?.focus();
      // Send a focus-pane command to the renderer (distinct from PANE_FOCUSED
      // which flows renderer→main). The renderer listens for this to switch panes.
      mainWindow?.webContents.send('fleet:focus-pane', { paneId: event.paneId });
    });
    notif.show();
  }
});
```

- [x] **Step 2: Add sound playback in renderer**

Update `src/renderer/hooks/use-notifications.ts` to play a chime:

```ts
import { useEffect, useRef } from 'react';
import { useNotificationStore } from '../store/notification-store';

export function useNotifications() {
  const { setNotification } = useNotificationStore();
  const audioRef = useRef<HTMLAudioElement | null>(null);

  useEffect(() => {
    // Create audio element for notification chime.
    // For now, use a data URI for a short beep tone. Replace with a proper
    // chime.mp3 asset when available (import and set audio.src to the asset URL).
    const audio = new Audio();
    // Generate a minimal WAV beep as a data URI (440Hz, 100ms)
    const sampleRate = 8000;
    const duration = 0.1;
    const samples = sampleRate * duration;
    const buffer = new ArrayBuffer(44 + samples);
    const view = new DataView(buffer);
    // WAV header
    const writeString = (offset: number, str: string) => {
      for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
    };
    writeString(0, 'RIFF');
    view.setUint32(4, 36 + samples, true);
    writeString(8, 'WAVE');
    writeString(12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate, true);
    view.setUint16(32, 1, true);
    view.setUint16(34, 8, true);
    writeString(36, 'data');
    view.setUint32(40, samples, true);
    for (let i = 0; i < samples; i++) {
      view.setUint8(44 + i, 128 + 64 * Math.sin((2 * Math.PI * 440 * i) / sampleRate));
    }
    const blob = new Blob([buffer], { type: 'audio/wav' });
    audio.src = URL.createObjectURL(blob);
    audio.volume = 0.3;
    audioRef.current = audio;
  }, []);

  useEffect(() => {
    const cleanup = window.fleet.notifications.onNotification((payload) => {
      setNotification({
        paneId: payload.paneId,
        level: payload.level,
        timestamp: payload.timestamp,
      });

      // Play sound for permission notifications (default behavior)
      if (payload.level === 'permission' && audioRef.current) {
        audioRef.current.play().catch(() => {
          // Audio play may be blocked by browser autoplay policy — ignore
        });
      }
    });
    return cleanup;
  }, [setNotification]);
}
```

- [x] **Step 3: Type-check**

Run:
```bash
npx tsc --noEmit
```

Expected: TypeScript compiler exits with code 0.

- [x] **Step 4: Commit**

```bash
git add src/main/index.ts src/renderer/hooks/use-notifications.ts
git commit -m "feat: add OS notifications and sound playback for permission prompts"
```

### Task 2.7: Process exit notifications

**Files:**
- Modify: `src/main/index.ts`

- [x] **Step 1: Emit notification on PTY exit**

Add to the event bus subscriptions in `src/main/index.ts`:

```ts
  eventBus.on('pty-exit', (event) => {
    const level = event.exitCode !== 0 ? 'error' : 'subtle';
    eventBus.emit('notification', {
      type: 'notification',
      paneId: event.paneId,
      level,
      timestamp: Date.now(),
    });
  });
```

- [x] **Step 2: Type-check**

Run:
```bash
npx tsc --noEmit
```

Expected: TypeScript compiler exits with code 0.

- [x] **Step 3: Commit**

```bash
git add src/main/index.ts
git commit -m "feat: emit error/subtle notification on PTY process exit"
```

---

## Chunk 3: Socket API (Layer 3)

A JSON-over-newline server on a local Unix socket (macOS) or named pipe (Windows). Exposes Fleet's internals for scripts and agent automation.

### Task 3.1: Socket server core

**Files:**
- Create: `src/main/socket-api.ts`
- Create: `src/main/__tests__/socket-api.test.ts`

- [x] **Step 1: Write the failing test**

Create `src/main/__tests__/socket-api.test.ts`:
```ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SocketApi, SocketCommandHandler } from '../socket-api';
import { createServer, createConnection } from 'net';
import { join } from 'path';
import { tmpdir } from 'os';
import { unlinkSync } from 'fs';

function tmpSocket(): string {
  return join(tmpdir(), `fleet-test-${Date.now()}-${Math.random().toString(36).slice(2)}.sock`);
}

describe('SocketApi', () => {
  let socketPath: string;
  let api: SocketApi;
  let handler: SocketCommandHandler;

  beforeEach(() => {
    socketPath = tmpSocket();
    handler = {
      handleCommand: vi.fn().mockResolvedValue({ ok: true, data: { message: 'hello' } }),
    };
    api = new SocketApi(socketPath, handler);
  });

  afterEach(async () => {
    await api.stop();
    try { unlinkSync(socketPath); } catch {}
  });

  it('starts and accepts a connection', async () => {
    await api.start();

    const response = await sendCommand(socketPath, { type: 'get-state', id: '1' });
    expect(response.ok).toBe(true);
  });

  it('routes commands to the handler', async () => {
    await api.start();

    await sendCommand(socketPath, { type: 'list-tabs', id: '2' });

    expect(handler.handleCommand).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'list-tabs', id: '2' }),
    );
  });

  it('returns error for malformed JSON', async () => {
    await api.start();

    const response = await sendRaw(socketPath, 'not json\n');
    expect(response.ok).toBe(false);
    expect(response.error).toContain('Invalid JSON');
  });

  it('returns error response from handler', async () => {
    handler.handleCommand = vi.fn().mockResolvedValue({
      ok: false,
      error: 'pane not found: abc',
    });
    await api.start();

    const response = await sendCommand(socketPath, { type: 'focus-pane', id: '3', paneId: 'abc' });
    expect(response.ok).toBe(false);
    expect(response.error).toBe('pane not found: abc');
  });
});

// Helper: send a JSON command and read the response
function sendCommand(socketPath: string, cmd: Record<string, unknown>): Promise<Record<string, unknown>> {
  return sendRaw(socketPath, JSON.stringify(cmd) + '\n');
}

function sendRaw(socketPath: string, data: string): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const client = createConnection(socketPath, () => {
      client.write(data);
    });
    let buffer = '';
    client.on('data', (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      if (lines.length > 1) {
        client.end();
        resolve(JSON.parse(lines[0]));
      }
    });
    client.on('error', reject);
    setTimeout(() => { client.end(); reject(new Error('timeout')); }, 3000);
  });
}
```

- [x] **Step 2: Run test to verify it fails**

Run:
```bash
npm test
```

Expected: FAIL — `Cannot find module '../socket-api'`

- [x] **Step 3: Write the implementation**

Create `src/main/socket-api.ts`:
```ts
import { createServer, Server, Socket } from 'net';
import { mkdirSync } from 'fs';
import { dirname } from 'path';

export interface SocketCommandHandler {
  handleCommand(cmd: SocketCommand): Promise<SocketResponse>;
}

export type SocketCommand = {
  type: string;
  id?: string;
  [key: string]: unknown;
};

export type SocketResponse = {
  ok: boolean;
  id?: string;
  error?: string;
  [key: string]: unknown;
};

export class SocketApi {
  private server: Server | null = null;
  private clients = new Set<Socket>();
  private subscriptions = new Map<Socket, Set<string>>();

  constructor(
    private socketPath: string,
    private handler: SocketCommandHandler,
  ) {}

  async start(): Promise<void> {
    // Ensure parent directory exists
    mkdirSync(dirname(this.socketPath), { recursive: true });

    // Remove stale socket file
    try {
      const { unlinkSync } = await import('fs');
      unlinkSync(this.socketPath);
    } catch {}

    return new Promise((resolve, reject) => {
      this.server = createServer((socket) => {
        this.clients.add(socket);
        let buffer = '';

        socket.on('data', (chunk) => {
          buffer += chunk.toString();
          const lines = buffer.split('\n');
          buffer = lines.pop() ?? '';

          for (const line of lines) {
            if (!line.trim()) continue;
            this.handleLine(socket, line);
          }
        });

        socket.on('close', () => {
          this.clients.delete(socket);
          this.subscriptions.delete(socket);
        });

        socket.on('error', () => {
          this.clients.delete(socket);
          this.subscriptions.delete(socket);
        });
      });

      this.server.listen(this.socketPath, () => {
        // Set socket permissions to owner-only (Unix)
        if (process.platform !== 'win32') {
          const { chmodSync } = require('fs');
          chmodSync(this.socketPath, 0o600);
        }
        resolve();
      });

      this.server.on('error', reject);
    });
  }

  async stop(): Promise<void> {
    for (const client of this.clients) {
      client.destroy();
    }
    this.clients.clear();
    this.subscriptions.clear();

    return new Promise((resolve) => {
      if (this.server) {
        this.server.close(() => resolve());
      } else {
        resolve();
      }
    });
  }

  broadcastEvent(eventType: string, data: Record<string, unknown>): void {
    const message = JSON.stringify({ event: eventType, ...data }) + '\n';
    for (const [socket, events] of this.subscriptions) {
      if (events.has(eventType)) {
        socket.write(message);
      }
    }
  }

  private async handleLine(socket: Socket, line: string): Promise<void> {
    let cmd: SocketCommand;
    try {
      cmd = JSON.parse(line);
    } catch {
      this.sendResponse(socket, { ok: false, error: 'Invalid JSON' });
      return;
    }

    // Handle subscribe specially — accumulates event types across calls
    if (cmd.type === 'subscribe') {
      const events = Array.isArray(cmd.events) ? cmd.events as string[] : [];
      const existing = this.subscriptions.get(socket) ?? new Set();
      for (const e of events) existing.add(e);
      this.subscriptions.set(socket, existing);
      this.sendResponse(socket, { ok: true, id: cmd.id });
      return;
    }

    try {
      const response = await this.handler.handleCommand(cmd);
      this.sendResponse(socket, { ...response, id: cmd.id });
    } catch (err) {
      this.sendResponse(socket, {
        ok: false,
        id: cmd.id,
        error: err instanceof Error ? err.message : 'Unknown error',
      });
    }
  }

  private sendResponse(socket: Socket, response: SocketResponse): void {
    if (!socket.destroyed) {
      socket.write(JSON.stringify(response) + '\n');
    }
  }
}
```

- [x] **Step 4: Run test to verify it passes**

Run:
```bash
npm test
```

Expected: PASS — 4 tests pass.

- [x] **Step 5: Commit**

```bash
git add src/main/socket-api.ts src/main/__tests__/socket-api.test.ts
git commit -m "feat: add socket API server with JSON-over-newline protocol"
```

### Task 3.2: Command handler (routes socket commands to Fleet internals)

**Files:**
- Create: `src/main/socket-command-handler.ts`
- Create: `src/main/__tests__/socket-command-handler.test.ts`

- [x] **Step 1: Write the failing test**

Create `src/main/__tests__/socket-command-handler.test.ts`:
```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { FleetCommandHandler } from '../socket-command-handler';
import { PtyManager } from '../pty-manager';
import { LayoutStore } from '../layout-store';
import { EventBus } from '../event-bus';
import { NotificationStateManager } from '../notification-state';

vi.mock('node-pty', () => ({
  spawn: vi.fn(() => ({
    pid: 12345,
    onData: vi.fn(),
    onExit: vi.fn(),
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(),
  })),
}));

vi.mock('electron-store', () => {
  return {
    default: vi.fn().mockImplementation(() => {
      const data: Record<string, unknown> = {};
      return {
        get: vi.fn((key: string, defaultVal?: unknown) => data[key] ?? defaultVal),
        set: vi.fn((key: string, value: unknown) => { data[key] = value; }),
        delete: vi.fn((key: string) => { delete data[key]; }),
      };
    }),
  };
});

describe('FleetCommandHandler', () => {
  let handler: FleetCommandHandler;
  let ptyManager: PtyManager;
  let layoutStore: LayoutStore;
  let eventBus: EventBus;

  beforeEach(() => {
    ptyManager = new PtyManager();
    layoutStore = new LayoutStore();
    eventBus = new EventBus();
    const notificationState = new NotificationStateManager(eventBus);
    handler = new FleetCommandHandler(ptyManager, layoutStore, eventBus, notificationState);
  });

  it('handles list-workspaces', async () => {
    const result = await handler.handleCommand({ type: 'list-workspaces' });
    expect(result.ok).toBe(true);
    expect(result.workspaces).toEqual([]);
  });

  it('handles new-tab', async () => {
    const result = await handler.handleCommand({
      type: 'new-tab',
      label: 'test',
      cmd: 'echo hello',
      cwd: '/tmp',
    });
    expect(result.ok).toBe(true);
    expect(result.tabId).toBeDefined();
    expect(result.paneId).toBeDefined();
  });

  it('handles list-panes after new-tab', async () => {
    const tabResult = await handler.handleCommand({
      type: 'new-tab',
      label: 'test',
      cwd: '/tmp',
    });
    const result = await handler.handleCommand({
      type: 'list-panes',
      tabId: tabResult.tabId,
    });
    expect(result.ok).toBe(true);
    expect(result.panes).toHaveLength(1);
  });

  it('handles get-state', async () => {
    const result = await handler.handleCommand({ type: 'get-state' });
    expect(result.ok).toBe(true);
    expect(result.workspace).toBeDefined();
    expect(result.notifications).toBeDefined();
  });

  it('returns error for unknown command', async () => {
    const result = await handler.handleCommand({ type: 'nonexistent' });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('Unknown command');
  });

  it('returns error for invalid paneId', async () => {
    const result = await handler.handleCommand({
      type: 'focus-pane',
      paneId: 'does-not-exist',
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('not found');
  });
});
```

- [x] **Step 2: Run test to verify it fails**

Run:
```bash
npm test
```

Expected: FAIL — `Cannot find module '../socket-command-handler'`

- [x] **Step 3: Write the implementation**

Create `src/main/socket-command-handler.ts`:
```ts
import { randomUUID } from 'crypto';
import type { SocketCommand, SocketResponse, SocketCommandHandler } from './socket-api';
import type { PtyManager } from './pty-manager';
import type { LayoutStore } from './layout-store';
import type { EventBus } from './event-bus';
import type { NotificationStateManager } from './notification-state';
import type { Workspace, Tab, PaneLeaf } from '../shared/types';

type ManagedTab = Tab & { paneIds: string[] };

export class FleetCommandHandler implements SocketCommandHandler {
  private workspace: Workspace = { id: 'default', label: 'Default', tabs: [] };
  private tabs = new Map<string, ManagedTab>();

  private getWindow: (() => import('electron').BrowserWindow | null) | null = null;

  constructor(
    private ptyManager: PtyManager,
    private layoutStore: LayoutStore,
    private eventBus: EventBus,
    private notificationState: NotificationStateManager,
  ) {}

  setWindowGetter(getter: () => import('electron').BrowserWindow | null): void {
    this.getWindow = getter;
  }

  async handleCommand(cmd: SocketCommand): Promise<SocketResponse> {
    switch (cmd.type) {
      case 'list-workspaces':
        return { ok: true, workspaces: this.layoutStore.list() };

      case 'load-workspace': {
        const ws = this.layoutStore.load(cmd.workspaceId as string);
        if (!ws) return { ok: false, error: `workspace not found: ${cmd.workspaceId}` };
        this.workspace = ws;
        this.eventBus.emit('workspace-loaded', { type: 'workspace-loaded', workspaceId: ws.id });
        return { ok: true };
      }

      case 'list-tabs':
        return {
          ok: true,
          tabs: this.workspace.tabs.map((t) => ({
            id: t.id,
            label: t.label,
            cwd: t.cwd,
          })),
        };

      case 'new-tab': {
        const paneId = randomUUID();
        const tabId = randomUUID();
        const cwd = (cmd.cwd as string) ?? '/';
        const label = (cmd.label as string) ?? 'Shell';

        const leaf: PaneLeaf = { type: 'leaf', id: paneId, cwd };
        const tab: Tab = { id: tabId, label, cwd, splitRoot: leaf };

        this.workspace.tabs.push(tab);
        this.tabs.set(tabId, { ...tab, paneIds: [paneId] });

        // Create PTY
        const ptyResult = this.ptyManager.create({
          paneId,
          cwd,
          cmd: cmd.cmd as string | undefined,
        });

        this.eventBus.emit('pane-created', { type: 'pane-created', paneId });

        return { ok: true, tabId, paneId, pid: ptyResult.pid };
      }

      case 'close-tab': {
        const tabId = cmd.tabId as string;
        const tabIndex = this.workspace.tabs.findIndex((t) => t.id === tabId);
        if (tabIndex === -1) return { ok: false, error: `tab not found: ${tabId}` };

        const tab = this.workspace.tabs[tabIndex];
        const paneIds = this.collectPaneIds(tab.splitRoot);
        for (const pid of paneIds) {
          this.ptyManager.kill(pid);
          this.eventBus.emit('pane-closed', { type: 'pane-closed', paneId: pid });
        }
        this.workspace.tabs.splice(tabIndex, 1);
        this.tabs.delete(tabId);
        return { ok: true };
      }

      case 'list-panes': {
        const tabId = cmd.tabId as string;
        const tab = this.workspace.tabs.find((t) => t.id === tabId);
        if (!tab) return { ok: false, error: `tab not found: ${tabId}` };

        const leaves = this.collectPaneLeaves(tab.splitRoot);
        return {
          ok: true,
          panes: leaves.map((leaf) => ({
            id: leaf.id,
            cwd: leaf.cwd,
            shell: leaf.shell,
            hasProcess: this.ptyManager.has(leaf.id),
          })),
        };
      }

      case 'new-pane': {
        const parentPaneId = cmd.paneId as string;
        if (!this.ptyManager.has(parentPaneId)) {
          return { ok: false, error: `pane not found: ${parentPaneId}` };
        }

        const newPaneId = randomUUID();
        const cwd = (cmd.cwd as string) ?? '/';
        const direction = (cmd.direction as 'horizontal' | 'vertical') ?? 'horizontal';

        // Insert new split node into the tab's split tree
        const newLeaf: PaneLeaf = { type: 'leaf', id: newPaneId, cwd };
        for (const tab of this.workspace.tabs) {
          if (this.insertSplit(tab, 'splitRoot', tab.splitRoot, parentPaneId, newLeaf, direction)) {
            break;
          }
        }

        this.ptyManager.create({
          paneId: newPaneId,
          cwd,
          cmd: cmd.cmd as string | undefined,
        });

        this.eventBus.emit('pane-created', { type: 'pane-created', paneId: newPaneId });

        return { ok: true, paneId: newPaneId };
      }

      case 'close-pane': {
        const paneId = cmd.paneId as string;
        if (!this.ptyManager.has(paneId)) {
          return { ok: false, error: `pane not found: ${paneId}` };
        }
        this.ptyManager.kill(paneId);
        this.eventBus.emit('pane-closed', { type: 'pane-closed', paneId });
        return { ok: true };
      }

      case 'focus-pane': {
        const paneId = cmd.paneId as string;
        if (!this.ptyManager.has(paneId)) {
          return { ok: false, error: `pane not found: ${paneId}` };
        }
        // Send focus command to renderer
        const win = this.getWindow?.();
        if (win) {
          win.show();
          win.focus();
          win.webContents.send('fleet:focus-pane', { paneId });
        }
        return { ok: true };
      }

      case 'send-input': {
        const paneId = cmd.paneId as string;
        if (!this.ptyManager.has(paneId)) {
          return { ok: false, error: `pane not found: ${paneId}` };
        }
        this.ptyManager.write(paneId, cmd.data as string);
        return { ok: true };
      }

      case 'get-output': {
        // KNOWN DEVIATION: Scrollback retrieval requires an IPC round-trip to
        // the renderer (where xterm.js buffer lives). This requires adding a
        // new invoke channel for the renderer to return buffer contents.
        // TODO: Implement IPC round-trip in a follow-up task after Layer 1 is stable.
        return {
          ok: false,
          error: 'get-output requires renderer IPC round-trip — not yet implemented',
        };
      }

      case 'get-state':
        return {
          ok: true,
          workspace: {
            id: this.workspace.id,
            label: this.workspace.label,
            tabCount: this.workspace.tabs.length,
          },
          panes: this.ptyManager.paneIds(),
          notifications: this.notificationState.getAllStates(),
        };

      default:
        return { ok: false, error: `Unknown command: ${cmd.type}` };
    }
  }

  private collectPaneIds(node: import('../shared/types').PaneNode): string[] {
    if (node.type === 'leaf') return [node.id];
    return [
      ...this.collectPaneIds(node.children[0]),
      ...this.collectPaneIds(node.children[1]),
    ];
  }

  private collectPaneLeaves(node: import('../shared/types').PaneNode): PaneLeaf[] {
    if (node.type === 'leaf') return [node];
    return [
      ...this.collectPaneLeaves(node.children[0]),
      ...this.collectPaneLeaves(node.children[1]),
    ];
  }

  private insertSplit(
    tab: Tab,
    _key: string,
    node: import('../shared/types').PaneNode,
    targetPaneId: string,
    newLeaf: PaneLeaf,
    direction: 'horizontal' | 'vertical',
  ): boolean {
    if (node.type === 'leaf' && node.id === targetPaneId) {
      // Replace this leaf with a split containing the original leaf and the new one
      const split: import('../shared/types').PaneSplit = {
        type: 'split',
        direction,
        ratio: 0.5,
        children: [node, newLeaf],
      };
      // Find and replace in parent — simplified: rebuild splitRoot
      tab.splitRoot = this.replaceNode(tab.splitRoot, targetPaneId, split);
      return true;
    }
    if (node.type === 'split') {
      return (
        this.insertSplit(tab, 'left', node.children[0], targetPaneId, newLeaf, direction) ||
        this.insertSplit(tab, 'right', node.children[1], targetPaneId, newLeaf, direction)
      );
    }
    return false;
  }

  private replaceNode(
    node: import('../shared/types').PaneNode,
    targetId: string,
    replacement: import('../shared/types').PaneNode,
  ): import('../shared/types').PaneNode {
    if (node.type === 'leaf') {
      return node.id === targetId ? replacement : node;
    }
    return {
      ...node,
      children: [
        this.replaceNode(node.children[0], targetId, replacement),
        this.replaceNode(node.children[1], targetId, replacement),
      ],
    };
  }
}
```

- [x] **Step 4: Run test to verify it passes**

Run:
```bash
npm test
```

Expected: PASS — 6 tests pass.

- [x] **Step 5: Commit**

```bash
git add src/main/socket-command-handler.ts src/main/__tests__/socket-command-handler.test.ts
git commit -m "feat: add socket command handler routing to Fleet internals"
```

### Task 3.3: Wire socket API into main process

**Files:**
- Modify: `src/main/index.ts`

- [x] **Step 1: Create and start the socket API**

Add imports to `src/main/index.ts`:
```ts
import { SocketApi } from './socket-api';
import { FleetCommandHandler } from './socket-command-handler';
import { SOCKET_PATH } from '../shared/constants';
```

Add instantiation after the existing module creation:
```ts
const commandHandler = new FleetCommandHandler(ptyManager, layoutStore, eventBus, notificationState);
const socketApi = new SocketApi(SOCKET_PATH, commandHandler);
```

Wire the window getter for `focus-pane`:
```ts
  commandHandler.setWindowGetter(() => mainWindow);
```

Start the socket in `app.whenReady()`:
```ts
  // Start socket API
  socketApi.start().catch((err) => {
    console.error('Failed to start socket API:', err);
  });
```

Wire event bus to broadcast subscription events:
```ts
  // Broadcast events to socket subscribers
  eventBus.on('notification', (event) => {
    socketApi.broadcastEvent('notification', {
      paneId: event.paneId,
      level: event.level,
      timestamp: event.timestamp,
    });
  });

  eventBus.on('pane-created', (event) => {
    socketApi.broadcastEvent('pane-created', { paneId: event.paneId });
  });

  eventBus.on('pane-closed', (event) => {
    socketApi.broadcastEvent('pane-closed', { paneId: event.paneId });
  });

  eventBus.on('workspace-loaded', (event) => {
    socketApi.broadcastEvent('workspace-loaded', { workspaceId: event.workspaceId });
  });

  // Note: agent-state-change broadcast will be wired in Chunk 4 (Layer 4)
  // when agent-state-tracker.ts is implemented.
```

Stop the socket on quit — add to `window-all-closed`:
```ts
app.on('window-all-closed', () => {
  ptyManager.killAll();
  socketApi.stop();
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
```

- [x] **Step 2: Type-check**

Run:
```bash
npx tsc --noEmit
```

Expected: TypeScript compiler exits with code 0.

- [x] **Step 3: Manual smoke test**

Run the app in one terminal:
```bash
npm run dev
```

In another terminal, test the socket:
```bash
echo '{"type":"get-state","id":"1"}' | nc -U ~/.fleet/fleet.sock
```

Expected: JSON response with `"ok": true` and workspace state.

```bash
echo '{"type":"new-tab","label":"test","cwd":"/tmp","id":"2"}' | nc -U ~/.fleet/fleet.sock
```

Expected: JSON response with `"ok": true`, `"tabId"`, and `"paneId"`.

- [x] **Step 4: Commit**

```bash
git add src/main/index.ts
git commit -m "feat: wire socket API into main process with event broadcasting"
```

### Task 3.4: Subscribe integration test

**Files:**
- Create: `src/main/__tests__/socket-subscribe.test.ts`

- [x] **Step 1: Write the subscribe test**

Create `src/main/__tests__/socket-subscribe.test.ts`:
```ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SocketApi, SocketCommandHandler } from '../socket-api';
import { createConnection } from 'net';
import { join } from 'path';
import { tmpdir } from 'os';
import { unlinkSync } from 'fs';

function tmpSocket(): string {
  return join(tmpdir(), `fleet-sub-test-${Date.now()}-${Math.random().toString(36).slice(2)}.sock`);
}

describe('SocketApi subscriptions', () => {
  let socketPath: string;
  let api: SocketApi;

  beforeEach(async () => {
    socketPath = tmpSocket();
    const handler: SocketCommandHandler = {
      handleCommand: vi.fn().mockResolvedValue({ ok: true }),
    };
    api = new SocketApi(socketPath, handler);
    await api.start();
  });

  afterEach(async () => {
    await api.stop();
    try { unlinkSync(socketPath); } catch {}
  });

  it('receives broadcast events after subscribing', async () => {
    const messages = await new Promise<string[]>((resolve, reject) => {
      const collected: string[] = [];
      const client = createConnection(socketPath, () => {
        client.write(JSON.stringify({ type: 'subscribe', events: ['notification'] }) + '\n');
      });

      client.on('data', (chunk) => {
        const lines = chunk.toString().split('\n').filter(Boolean);
        collected.push(...lines);

        // First message is the subscribe ack
        if (collected.length === 1) {
          // Trigger a broadcast
          api.broadcastEvent('notification', { paneId: 'p1', level: 'info', timestamp: 1 });
        }

        // Second message should be the broadcast
        if (collected.length >= 2) {
          client.end();
          resolve(collected);
        }
      });

      setTimeout(() => { client.end(); reject(new Error('timeout')); }, 3000);
    });

    expect(messages).toHaveLength(2);

    const ack = JSON.parse(messages[0]);
    expect(ack.ok).toBe(true);

    const event = JSON.parse(messages[1]);
    expect(event.event).toBe('notification');
    expect(event.paneId).toBe('p1');
  });

  it('does not receive events for unsubscribed types', async () => {
    const messages = await new Promise<string[]>((resolve) => {
      const collected: string[] = [];
      const client = createConnection(socketPath, () => {
        client.write(JSON.stringify({ type: 'subscribe', events: ['pane-created'] }) + '\n');
      });

      client.on('data', (chunk) => {
        const lines = chunk.toString().split('\n').filter(Boolean);
        collected.push(...lines);

        if (collected.length === 1) {
          // Broadcast a notification event (not subscribed)
          api.broadcastEvent('notification', { paneId: 'p1', level: 'info', timestamp: 1 });
          // Give time for potential delivery, then close
          setTimeout(() => { client.end(); resolve(collected); }, 200);
        }
      });

      setTimeout(() => { client.end(); resolve(collected); }, 3000);
    });

    // Should only have the subscribe ack, not the notification
    expect(messages).toHaveLength(1);
  });
});
```

- [x] **Step 2: Run tests**

Run:
```bash
npm test
```

Expected: PASS — all socket tests pass (existing + 2 new).

- [x] **Step 3: Commit**

```bash
git add src/main/__tests__/socket-subscribe.test.ts
git commit -m "test: add subscribe integration tests for socket API"
```

---

## Chunk 4: Agent Visualizer (Layer 4)

The pixel-art office scene. Consists of two parts: the main-process agent state tracker (JSONL watching + state machine) and the renderer-side canvas visualization.

### Task 4.1: JSONL watcher (main process)

**Files:**
- Create: `src/main/jsonl-watcher.ts`
- Create: `src/main/__tests__/jsonl-watcher.test.ts`

- [x] **Step 1: Write the failing test**

Create `src/main/__tests__/jsonl-watcher.test.ts`:
```ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { JsonlWatcher, JsonlRecord } from '../jsonl-watcher';
import { writeFileSync, mkdirSync, rmSync, appendFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

function tmpDir(): string {
  const dir = join(tmpdir(), `fleet-jsonl-test-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe('JsonlWatcher', () => {
  let dir: string;
  let watcher: JsonlWatcher;

  beforeEach(() => {
    dir = tmpDir();
  });

  afterEach(() => {
    watcher?.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  it('parses a JSONL record with tool_use', async () => {
    const callback = vi.fn();
    watcher = new JsonlWatcher(dir);
    watcher.onRecord(callback);
    watcher.start();

    const filePath = join(dir, 'session-1.jsonl');
    const record = {
      type: 'assistant',
      message: {
        content: [{ type: 'tool_use', name: 'Edit', input: {} }],
      },
    };
    writeFileSync(filePath, JSON.stringify(record) + '\n');

    // Wait for fs.watch to fire
    await new Promise((r) => setTimeout(r, 500));

    expect(callback).toHaveBeenCalledWith(
      'session-1',
      expect.objectContaining({ type: 'assistant' }),
    );
  });

  it('handles multiple records appended to the same file', async () => {
    const callback = vi.fn();
    watcher = new JsonlWatcher(dir);
    watcher.onRecord(callback);
    watcher.start();

    const filePath = join(dir, 'session-2.jsonl');
    writeFileSync(filePath, JSON.stringify({ type: 'user' }) + '\n');

    await new Promise((r) => setTimeout(r, 500));

    appendFileSync(filePath, JSON.stringify({ type: 'assistant' }) + '\n');

    await new Promise((r) => setTimeout(r, 500));

    expect(callback).toHaveBeenCalledTimes(2);
  });

  it('ignores non-JSONL files', async () => {
    const callback = vi.fn();
    watcher = new JsonlWatcher(dir);
    watcher.onRecord(callback);
    watcher.start();

    writeFileSync(join(dir, 'readme.txt'), 'hello\n');

    await new Promise((r) => setTimeout(r, 500));

    expect(callback).not.toHaveBeenCalled();
  });
});
```

- [x] **Step 2: Run test to verify it fails**

Run:
```bash
npm test
```

Expected: FAIL — `Cannot find module '../jsonl-watcher'`

- [x] **Step 3: Write the implementation**

Create `src/main/jsonl-watcher.ts`:
```ts
import { watch, FSWatcher, readFileSync, existsSync, readdirSync, statSync } from 'fs';
import { join, extname, basename } from 'path';

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

export class JsonlWatcher {
  private watcher: FSWatcher | null = null;
  private callbacks: RecordCallback[] = [];
  private fileOffsets = new Map<string, number>();

  constructor(private watchDir: string) {}

  onRecord(callback: RecordCallback): void {
    this.callbacks.push(callback);
  }

  start(): void {
    if (!existsSync(this.watchDir)) return;

    // Read existing files
    this.scanExistingFiles();

    // Watch for changes
    this.watcher = watch(this.watchDir, { persistent: false }, (eventType, filename) => {
      if (!filename || extname(filename) !== '.jsonl') return;
      this.processFile(join(this.watchDir, filename));
    });
  }

  stop(): void {
    this.watcher?.close();
    this.watcher = null;
  }

  private scanExistingFiles(): void {
    try {
      const files = readdirSync(this.watchDir);
      for (const file of files) {
        if (extname(file) === '.jsonl') {
          const filePath = join(this.watchDir, file);
          // Set offset to end of file — only process new records
          const stat = statSync(filePath);
          this.fileOffsets.set(filePath, stat.size);
        }
      }
    } catch {}
  }

  private processFile(filePath: string): void {
    try {
      const content = readFileSync(filePath, 'utf-8');
      const offset = this.fileOffsets.get(filePath) ?? 0;
      const newContent = content.slice(offset);
      this.fileOffsets.set(filePath, content.length);

      if (!newContent.trim()) return;

      const sessionId = basename(filePath, '.jsonl');
      const lines = newContent.split('\n').filter(Boolean);

      for (const line of lines) {
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

- [x] **Step 4: Run test to verify it passes**

Run:
```bash
npm test
```

Expected: PASS — 3 tests pass.

- [x] **Step 5: Commit**

```bash
git add src/main/jsonl-watcher.ts src/main/__tests__/jsonl-watcher.test.ts
git commit -m "feat: add JSONL transcript file watcher for agent detection"
```

### Task 4.2: Agent state tracker (main process)

**Files:**
- Create: `src/main/agent-state-tracker.ts`
- Create: `src/main/__tests__/agent-state-tracker.test.ts`

- [x] **Step 1: Write the failing test**

Create `src/main/__tests__/agent-state-tracker.test.ts`:
```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AgentStateTracker } from '../agent-state-tracker';
import { EventBus } from '../event-bus';

describe('AgentStateTracker', () => {
  let eventBus: EventBus;
  let tracker: AgentStateTracker;

  beforeEach(() => {
    eventBus = new EventBus();
    tracker = new AgentStateTracker(eventBus);
  });

  it('creates agent entry when pane-created fires', () => {
    eventBus.emit('pane-created', { type: 'pane-created', paneId: 'pane-1' });

    const state = tracker.getState('pane-1');
    expect(state).toBeDefined();
    expect(state?.state).toBe('not-agent');
  });

  it('transitions to working when tool_use Write is detected', () => {
    eventBus.emit('pane-created', { type: 'pane-created', paneId: 'pane-1' });

    tracker.handleJsonlRecord('pane-1', {
      type: 'assistant',
      message: {
        content: [{ type: 'tool_use', name: 'Write' }],
      },
    });

    expect(tracker.getState('pane-1')?.state).toBe('working');
  });

  it('transitions to reading when tool_use Read is detected', () => {
    eventBus.emit('pane-created', { type: 'pane-created', paneId: 'pane-1' });

    tracker.handleJsonlRecord('pane-1', {
      type: 'assistant',
      message: {
        content: [{ type: 'tool_use', name: 'Read' }],
      },
    });

    expect(tracker.getState('pane-1')?.state).toBe('reading');
  });

  it('transitions to needs-permission on permission event', () => {
    eventBus.emit('pane-created', { type: 'pane-created', paneId: 'pane-1' });

    eventBus.emit('notification', {
      type: 'notification',
      paneId: 'pane-1',
      level: 'permission',
      timestamp: Date.now(),
    });

    expect(tracker.getState('pane-1')?.state).toBe('needs-permission');
  });

  it('removes agent entry when pane-closed fires', () => {
    eventBus.emit('pane-created', { type: 'pane-created', paneId: 'pane-1' });
    eventBus.emit('pane-closed', { type: 'pane-closed', paneId: 'pane-1' });

    expect(tracker.getState('pane-1')).toBeUndefined();
  });

  it('detects sub-agents from progress records', () => {
    eventBus.emit('pane-created', { type: 'pane-created', paneId: 'pane-1' });

    tracker.handleJsonlRecord('pane-1', {
      type: 'assistant',
      message: { content: [{ type: 'tool_use', name: 'Edit' }] },
    });

    tracker.handleJsonlRecord('pane-1', {
      type: 'progress',
      data: {
        type: 'agent_progress',
        parentToolUseID: 'tool-abc',
      },
      message: {
        content: [{ type: 'tool_use', name: 'Read' }],
      },
    });

    const state = tracker.getState('pane-1');
    expect(state?.subAgents).toHaveLength(1);
    expect(state?.subAgents[0].state).toBe('reading');
  });

  it('returns all states', () => {
    eventBus.emit('pane-created', { type: 'pane-created', paneId: 'pane-1' });
    eventBus.emit('pane-created', { type: 'pane-created', paneId: 'pane-2' });

    expect(tracker.getAllStates()).toHaveLength(2);
  });
});
```

- [x] **Step 2: Run test to verify it fails**

Run:
```bash
npm test
```

Expected: FAIL — `Cannot find module '../agent-state-tracker'`

- [x] **Step 3: Write the implementation**

Create `src/main/agent-state-tracker.ts`:
```ts
import { EventBus } from './event-bus';
import type { AgentVisualState } from '../shared/types';
import type { JsonlRecord } from './jsonl-watcher';

const WRITING_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'Bash', 'NotebookEdit']);
const READING_TOOLS = new Set(['Read', 'Grep', 'Glob', 'WebFetch', 'NotebookRead']);

type AgentEntry = {
  paneId: string;
  label: string;
  state: AgentVisualState['state'];
  currentTool?: string;
  subAgents: Map<string, AgentEntry>;
  createdAt: number;
  lastActivity: number;
};

export class AgentStateTracker {
  private agents = new Map<string, AgentEntry>();
  private idleTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private fallbackTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private hasJsonlData = new Set<string>();

  constructor(private eventBus: EventBus) {
    eventBus.on('pane-created', (event) => {
      this.agents.set(event.paneId, {
        paneId: event.paneId,
        label: event.paneId,
        state: 'not-agent',
        subAgents: new Map(),
        createdAt: Date.now(),
        lastActivity: Date.now(),
      });

      // Start 30-second fallback timer: if no JSONL data arrives,
      // switch to PTY output pattern matching as degraded detection.
      this.fallbackTimers.set(event.paneId, setTimeout(() => {
        if (!this.hasJsonlData.has(event.paneId)) {
          // Mark this pane as needing PTY-based detection.
          // The notification detector's patterns will serve as the
          // fallback signal for agent state (permission prompts etc.)
          // This is a degraded mode — state transitions won't be as
          // granular as JSONL-based detection.
        }
        this.fallbackTimers.delete(event.paneId);
      }, 30_000));
    });

    eventBus.on('pane-closed', (event) => {
      this.agents.delete(event.paneId);
      this.hasJsonlData.delete(event.paneId);
      const idleTimer = this.idleTimers.get(event.paneId);
      if (idleTimer) { clearTimeout(idleTimer); this.idleTimers.delete(event.paneId); }
      const fallbackTimer = this.fallbackTimers.get(event.paneId);
      if (fallbackTimer) { clearTimeout(fallbackTimer); this.fallbackTimers.delete(event.paneId); }
    });

    eventBus.on('notification', (event) => {
      if (event.level === 'permission') {
        this.updateState(event.paneId, 'needs-permission');
      }
    });
  }

  handleJsonlRecord(paneId: string, record: JsonlRecord): void {
    const agent = this.agents.get(paneId);
    if (!agent) return;

    // Mark that this pane has JSONL data (cancels fallback timer logic)
    this.hasJsonlData.add(paneId);

    // Any JSONL record proves this is an agent
    if (agent.state === 'not-agent') {
      agent.state = 'idle';
    }

    // Check for sub-agent progress records
    if (record.type === 'progress' && record.data?.type === 'agent_progress' && record.data?.parentToolUseID) {
      const subId = record.data.parentToolUseID;
      const toolName = this.extractToolName(record);
      const subState = this.classifyTool(toolName);

      if (!agent.subAgents.has(subId)) {
        agent.subAgents.set(subId, {
          paneId: `${paneId}:sub:${subId}`,
          label: `sub-agent`,
          state: subState,
          currentTool: toolName,
          subAgents: new Map(),
          createdAt: Date.now(),
          lastActivity: Date.now(),
        });
      } else {
        const sub = agent.subAgents.get(subId)!;
        sub.state = subState;
        sub.currentTool = toolName;
        sub.lastActivity = Date.now();
      }

      this.emitChange(paneId);
      return;
    }

    // Regular tool use
    if (record.type === 'assistant') {
      const toolName = this.extractToolName(record);
      if (toolName) {
        const newState = this.classifyTool(toolName);
        agent.state = newState;
        agent.currentTool = toolName;
        agent.lastActivity = Date.now();
        this.resetIdleTimer(paneId);
        this.emitChange(paneId);
      }
    }
  }

  setLabel(paneId: string, label: string): void {
    const agent = this.agents.get(paneId);
    if (agent) agent.label = label;
  }

  getState(paneId: string): AgentVisualState | undefined {
    const agent = this.agents.get(paneId);
    if (!agent) return undefined;
    return this.toVisualState(agent);
  }

  getAllStates(): AgentVisualState[] {
    return Array.from(this.agents.values()).map((a) => this.toVisualState(a));
  }

  private updateState(paneId: string, state: AgentVisualState['state']): void {
    const agent = this.agents.get(paneId);
    if (agent) {
      agent.state = state;
      agent.lastActivity = Date.now();
      this.emitChange(paneId);
    }
  }

  private extractToolName(record: JsonlRecord): string | undefined {
    const content = record.message?.content;
    if (!Array.isArray(content)) return undefined;
    const toolUse = content.find((c) => c.type === 'tool_use');
    return toolUse?.name;
  }

  private classifyTool(toolName?: string): AgentVisualState['state'] {
    if (!toolName) return 'idle';
    if (WRITING_TOOLS.has(toolName)) return 'working';
    if (READING_TOOLS.has(toolName)) return 'reading';
    return 'working'; // Default to working for unknown tools
  }

  private resetIdleTimer(paneId: string): void {
    const existing = this.idleTimers.get(paneId);
    if (existing) clearTimeout(existing);

    this.idleTimers.set(
      paneId,
      setTimeout(() => {
        this.updateState(paneId, 'idle');
        this.idleTimers.delete(paneId);
      }, 5000), // 5 seconds of no activity → idle
    );
  }

  private emitChange(paneId: string): void {
    const state = this.getState(paneId);
    if (state) {
      this.eventBus.emit('agent-state-change', {
        type: 'agent-state-change',
        paneId,
        state: state.state,
        tool: state.currentTool,
      });
    }
  }

  private toVisualState(agent: AgentEntry): AgentVisualState {
    return {
      paneId: agent.paneId,
      label: agent.label,
      state: agent.state,
      currentTool: agent.currentTool,
      subAgents: Array.from(agent.subAgents.values()).map((s) => this.toVisualState(s)),
      uptime: Date.now() - agent.createdAt,
    };
  }
}
```

- [x] **Step 4: Run test to verify it passes**

Run:
```bash
npm test
```

Expected: PASS — 7 tests pass.

- [x] **Step 5: Commit**

```bash
git add src/main/agent-state-tracker.ts src/main/__tests__/agent-state-tracker.test.ts
git commit -m "feat: add agent state tracker with JSONL-based tool detection and sub-agent support"
```

### Task 4.3: Wire agent tracker into main process

**Files:**
- Modify: `src/main/index.ts`

- [x] **Step 1: Create tracker, wire JSONL watcher, and forward state to renderer**

Add imports to `src/main/index.ts`:
```ts
import { AgentStateTracker } from './agent-state-tracker';
import { JsonlWatcher } from './jsonl-watcher';
import { CLAUDE_PROJECTS_DIR } from '../shared/constants';
```

Add instantiation:
```ts
const agentTracker = new AgentStateTracker(eventBus);
const jsonlWatcher = new JsonlWatcher(CLAUDE_PROJECTS_DIR);
```

Wire JSONL records to the tracker — requires correlating sessions to panes. For initial implementation, use a simple heuristic mapping:
```ts
// Correlate JSONL sessions to panes by cwd-to-project-hash matching.
// When a pane is created, record its cwd. When a JSONL file appears in a
// project hash directory that matches the cwd, bind that session to the pane.
const sessionToPaneMap = new Map<string, string>();
const paneCwdMap = new Map<string, string>();

eventBus.on('pane-created', (event) => {
  // The cwd will be set when the PTY is created — read from pty-manager
  // For now, store a placeholder. The IPC handler already passes cwd.
});

// Watch JSONL files across all project hash subdirectories
// The watcher directory should be the parent (~/.claude/projects/) and
// watch recursively for *.jsonl files in subdirectories.
jsonlWatcher.onRecord((sessionId, record) => {
  // Try to find a mapped pane for this session
  const paneId = sessionToPaneMap.get(sessionId);
  if (paneId) {
    agentTracker.handleJsonlRecord(paneId, record);
    return;
  }

  // If no mapping exists yet, try to correlate by finding a pane whose
  // cwd matches the project hash directory. For now, if only one pane
  // exists, bind directly. For multiple panes, use timestamp proximity.
  const activePanes = ptyManager.paneIds();
  if (activePanes.length === 1) {
    sessionToPaneMap.set(sessionId, activePanes[0]);
    agentTracker.handleJsonlRecord(activePanes[0], record);
  } else if (activePanes.length > 1) {
    // Multiple panes: find the most recently created pane that hasn't
    // been mapped to a session yet. This is imperfect but prevents
    // broadcasting to all panes.
    const mappedPanes = new Set(sessionToPaneMap.values());
    const unmapped = activePanes.find((id) => !mappedPanes.has(id));
    if (unmapped) {
      sessionToPaneMap.set(sessionId, unmapped);
      agentTracker.handleJsonlRecord(unmapped, record);
    }
  }
});

jsonlWatcher.start();
```

Forward state changes to renderer and socket API (single handler):
```ts
eventBus.on('agent-state-change', (event) => {
  // Forward to renderer
  mainWindow?.webContents.send(IPC_CHANNELS.AGENT_STATE, {
    states: agentTracker.getAllStates(),
  });

  // Forward to socket API subscribers (fulfills Chunk 3 TODO)
  socketApi.broadcastEvent('agent-state-change', {
    paneId: event.paneId,
    state: event.state,
    tool: event.tool,
  });
});
```

Stop the watcher on quit:
```ts
app.on('window-all-closed', () => {
  ptyManager.killAll();
  socketApi.stop();
  jsonlWatcher.stop();
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
```

- [x] **Step 2: Type-check**

Run:
```bash
npx tsc --noEmit
```

Expected: TypeScript compiler exits with code 0.

- [x] **Step 3: Commit**

```bash
git add src/main/index.ts
git commit -m "feat: wire agent state tracker and JSONL watcher into main process"
```

### Task 4.4: Visualizer store (renderer)

**Files:**
- Create: `src/renderer/store/visualizer-store.ts`

- [x] **Step 1: Write the visualizer store**

Create `src/renderer/store/visualizer-store.ts`:
```ts
import { create } from 'zustand';
import type { AgentVisualState } from '../../shared/types';

type VisualizerStore = {
  agents: AgentVisualState[];
  isVisible: boolean;
  panelMode: 'drawer' | 'tab';

  setAgents: (agents: AgentVisualState[]) => void;
  toggleVisible: () => void;
  setPanelMode: (mode: 'drawer' | 'tab') => void;
};

export const useVisualizerStore = create<VisualizerStore>((set) => ({
  agents: [],
  isVisible: false,
  panelMode: 'drawer',

  setAgents: (agents) => set({ agents }),
  toggleVisible: () => set((state) => ({ isVisible: !state.isVisible })),
  setPanelMode: (mode) => set({ panelMode: mode }),
}));
```

- [x] **Step 2: Wire IPC to update store**

Add to `src/renderer/App.tsx` — subscribe to agent state updates:

```ts
import { useVisualizerStore } from './store/visualizer-store';
```

Inside the `App` component:
```ts
const { setAgents } = useVisualizerStore();

useEffect(() => {
  const cleanup = window.fleet.agentState.onStateUpdate(({ states }) => {
    setAgents(states);
  });
  return cleanup;
}, [setAgents]);
```

- [x] **Step 3: Type-check**

Run:
```bash
npx tsc --noEmit
```

Expected: TypeScript compiler exits with code 0.

- [x] **Step 4: Commit**

```bash
git add src/renderer/store/visualizer-store.ts src/renderer/App.tsx
git commit -m "feat: add visualizer store with IPC-driven agent state updates"
```

### Task 4.5: Sprite loading and hue-shifting

**Files:**
- Create: `src/renderer/components/visualizer/sprites.ts`

- [x] **Step 1: Write the sprite system**

Create `src/renderer/components/visualizer/sprites.ts`:
```ts
// Sprite sheet configuration
// Characters: 16x24 pixels, 6 base palettes
// Tiles: 16x16 pixels
// Animation frames: walk (4), type (2), read (2)

export type SpriteAnimation = 'walk' | 'type' | 'read' | 'idle';
export type Direction = 'down' | 'up' | 'left' | 'right';

export type CharacterSprite = {
  palette: number;
  hueShift: number;
  frames: Map<string, ImageBitmap>; // key: `${animation}-${direction}-${frame}`
};

const PALETTE_COUNT = 6;
const spriteCache = new Map<string, ImageBitmap>();
const hueShiftedCache = new Map<string, ImageBitmap>();

export async function loadSpriteSheet(src: string): Promise<ImageBitmap> {
  const response = await fetch(src);
  const blob = await response.blob();
  return createImageBitmap(blob);
}

let sourceIdCounter = 0;
const sourceIdMap = new WeakMap<ImageBitmap, number>();

function getSourceId(source: ImageBitmap): number {
  let id = sourceIdMap.get(source);
  if (id === undefined) {
    id = sourceIdCounter++;
    sourceIdMap.set(source, id);
  }
  return id;
}

export function applyHueShift(
  source: ImageBitmap,
  hueShift: number,
): ImageBitmap | OffscreenCanvas {
  const cacheKey = `src-${getSourceId(source)}-hue-${hueShift}`;
  const cached = hueShiftedCache.get(cacheKey);
  if (cached) return cached;

  const canvas = new OffscreenCanvas(source.width, source.height);
  const ctx = canvas.getContext('2d')!;
  ctx.drawImage(source, 0, 0);

  if (hueShift === 0) return source;

  const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const data = imageData.data;

  for (let i = 0; i < data.length; i += 4) {
    const [h, s, l] = rgbToHsl(data[i], data[i + 1], data[i + 2]);
    const [r, g, b] = hslToRgb((h + hueShift) % 360, s, l);
    data[i] = r;
    data[i + 1] = g;
    data[i + 2] = b;
  }

  ctx.putImageData(imageData, 0, 0);
  return canvas;
}

export function getPaletteForAgent(agentIndex: number): { palette: number; hueShift: number } {
  if (agentIndex < PALETTE_COUNT) {
    return { palette: agentIndex, hueShift: 0 };
  }
  // Beyond 6 agents, use palette 0 with progressive hue shifts
  return {
    palette: 0,
    hueShift: ((agentIndex - PALETTE_COUNT) * 60 + 30) % 360,
  };
}

// Color conversion helpers
function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h = 0;
  if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
  else if (max === g) h = ((b - r) / d + 2) / 6;
  else h = ((r - g) / d + 4) / 6;
  return [h * 360, s, l];
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  h /= 360;
  if (s === 0) {
    const v = Math.round(l * 255);
    return [v, v, v];
  }
  const hue2rgb = (p: number, q: number, t: number) => {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1/6) return p + (q - p) * 6 * t;
    if (t < 1/2) return q;
    if (t < 2/3) return p + (q - p) * (2/3 - t) * 6;
    return p;
  };
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  return [
    Math.round(hue2rgb(p, q, h + 1/3) * 255),
    Math.round(hue2rgb(p, q, h) * 255),
    Math.round(hue2rgb(p, q, h - 1/3) * 255),
  ];
}
```

- [x] **Step 2: Type-check**

Run:
```bash
npx tsc --noEmit
```

Expected: TypeScript compiler exits with code 0.

- [x] **Step 3: Commit**

```bash
git add src/renderer/components/visualizer/sprites.ts
git commit -m "feat: add sprite loading system with palette hue-shifting"
```

### Task 4.6: Character state machine and pathfinding

**Files:**
- Create: `src/renderer/components/visualizer/characters.ts`

- [x] **Step 1: Write the character system**

Create `src/renderer/components/visualizer/characters.ts`:
```ts
import type { AgentVisualState } from '../../../shared/types';
import { getPaletteForAgent } from './sprites';

export type Tile = { x: number; y: number };
export type Character = {
  paneId: string;
  label: string;
  agentState: AgentVisualState['state'];
  currentTool?: string;
  position: Tile;
  targetPosition: Tile | null;
  path: Tile[];
  seatPosition: Tile;
  palette: number;
  hueShift: number;
  animationFrame: number;
  animationTimer: number;
  direction: 'down' | 'up' | 'left' | 'right';
  isSubAgent: boolean;
  spawnTime: number;
  despawnTime: number | null;
};

// Office layout: 8 desk positions
const DESK_POSITIONS: Tile[] = [
  { x: 2, y: 2 }, { x: 5, y: 2 }, { x: 8, y: 2 }, { x: 11, y: 2 },
  { x: 2, y: 6 }, { x: 5, y: 6 }, { x: 8, y: 6 }, { x: 11, y: 6 },
];

// Seat position is one tile in front of the desk
const SEAT_OFFSETS: Tile[] = DESK_POSITIONS.map((d) => ({ x: d.x, y: d.y + 1 }));

export class CharacterManager {
  private characters = new Map<string, Character>();
  private assignedDesks = new Map<string, number>();
  private nextDeskIndex = 0;

  update(agents: AgentVisualState[], deltaMs: number): void {
    const activeIds = new Set(agents.filter((a) => a.state !== 'not-agent').map((a) => a.paneId));

    // Spawn new characters
    for (const agent of agents) {
      if (agent.state === 'not-agent') continue;
      if (!this.characters.has(agent.paneId)) {
        this.spawnCharacter(agent);
      }
      this.updateCharacterState(agent);
    }

    // Mark despawning characters
    for (const [paneId, char] of this.characters) {
      if (!activeIds.has(paneId) && !char.despawnTime) {
        char.despawnTime = Date.now();
      }
    }

    // Remove fully despawned characters (after 1 second for matrix rain)
    for (const [paneId, char] of this.characters) {
      if (char.despawnTime && Date.now() - char.despawnTime > 1000) {
        this.characters.delete(paneId);
        this.assignedDesks.delete(paneId);
      }
    }

    // Animate all characters
    for (const char of this.characters.values()) {
      this.animate(char, deltaMs);
    }

    // Handle sub-agents
    for (const agent of agents) {
      if (agent.state === 'not-agent') continue;
      for (const sub of agent.subAgents) {
        if (!this.characters.has(sub.paneId)) {
          this.spawnSubAgent(agent.paneId, sub);
        }
        this.updateCharacterState(sub);
      }
    }
  }

  getCharacters(): Character[] {
    return Array.from(this.characters.values());
  }

  clearAll(): void {
    // Mark all for despawn (workspace switch)
    for (const char of this.characters.values()) {
      if (!char.despawnTime) char.despawnTime = Date.now();
    }
    this.assignedDesks.clear();
    this.nextDeskIndex = 0;
  }

  private spawnCharacter(agent: AgentVisualState): void {
    const deskIndex = this.assignDesk(agent.paneId);
    const seat = SEAT_OFFSETS[deskIndex] ?? { x: 1, y: 1 };
    const { palette, hueShift } = getPaletteForAgent(deskIndex);

    this.characters.set(agent.paneId, {
      paneId: agent.paneId,
      label: agent.label,
      agentState: agent.state,
      currentTool: agent.currentTool,
      position: { x: 0, y: seat.y }, // Spawn at left edge, walk to seat
      targetPosition: seat,
      path: [],
      seatPosition: seat,
      palette,
      hueShift,
      animationFrame: 0,
      animationTimer: 0,
      direction: 'right',
      isSubAgent: false,
      spawnTime: Date.now(),
      despawnTime: null,
    });
  }

  private spawnSubAgent(parentPaneId: string, sub: AgentVisualState): void {
    const parent = this.characters.get(parentPaneId);
    if (!parent) return;

    this.characters.set(sub.paneId, {
      paneId: sub.paneId,
      label: sub.label,
      agentState: sub.state,
      currentTool: sub.currentTool,
      position: { x: parent.seatPosition.x + 1, y: parent.seatPosition.y },
      targetPosition: null,
      path: [],
      seatPosition: { x: parent.seatPosition.x + 1, y: parent.seatPosition.y },
      palette: parent.palette,
      hueShift: (parent.hueShift + 60) % 360,
      animationFrame: 0,
      animationTimer: 0,
      direction: 'down',
      isSubAgent: true,
      spawnTime: Date.now(),
      despawnTime: null,
    });
  }

  private updateCharacterState(agent: AgentVisualState): void {
    const char = this.characters.get(agent.paneId);
    if (!char) return;

    char.agentState = agent.state;
    char.currentTool = agent.currentTool;
    char.label = agent.label;

    // When transitioning to working/reading, walk to seat via BFS path
    if ((agent.state === 'working' || agent.state === 'reading') && !this.isAtSeat(char)) {
      char.path = this.findPath(
        { x: Math.round(char.position.x), y: Math.round(char.position.y) },
        char.seatPosition,
      );
      char.targetPosition = char.path.shift() ?? char.seatPosition;
    }

    // Idle wander: occasionally pick a random walkable tile to wander to
    if (agent.state === 'idle' && !char.targetPosition && Math.random() < 0.002) {
      const wanderTarget = this.randomWalkableTile();
      if (wanderTarget) {
        char.path = this.findPath(
          { x: Math.round(char.position.x), y: Math.round(char.position.y) },
          wanderTarget,
        );
        char.targetPosition = char.path.shift() ?? null;
      }
    }
  }

  private animate(char: Character, deltaMs: number): void {
    char.animationTimer += deltaMs;

    // Walk towards target
    if (char.targetPosition) {
      const speed = 0.003; // tiles per ms
      const dx = char.targetPosition.x - char.position.x;
      const dy = char.targetPosition.y - char.position.y;
      const dist = Math.sqrt(dx * dx + dy * dy);

      if (dist < 0.1) {
        char.position = { ...char.targetPosition };
        // Follow BFS path to next waypoint, or stop
        char.targetPosition = char.path.shift() ?? null;
      } else {
        const step = speed * deltaMs;
        char.position.x += (dx / dist) * Math.min(step, dist);
        char.position.y += (dy / dist) * Math.min(step, dist);

        // Update direction
        if (Math.abs(dx) > Math.abs(dy)) {
          char.direction = dx > 0 ? 'right' : 'left';
        } else {
          char.direction = dy > 0 ? 'down' : 'up';
        }
      }

      // Walk animation: 4 frames at 150ms each
      if (char.animationTimer > 150) {
        char.animationFrame = (char.animationFrame + 1) % 4;
        char.animationTimer = 0;
      }
    } else {
      // Seated or idle animations: 2 frames at 300ms each
      if (char.animationTimer > 300) {
        char.animationFrame = (char.animationFrame + 1) % 2;
        char.animationTimer = 0;
      }
    }
  }

  private isAtSeat(char: Character): boolean {
    return (
      Math.abs(char.position.x - char.seatPosition.x) < 0.1 &&
      Math.abs(char.position.y - char.seatPosition.y) < 0.1
    );
  }

  private findPath(start: Tile, end: Tile): Tile[] {
    // BFS pathfinding against the office tilemap
    const { isWalkable, OFFICE_WIDTH, OFFICE_HEIGHT } = require('./office-state');
    const key = (t: Tile) => `${t.x},${t.y}`;
    const visited = new Set<string>();
    const parent = new Map<string, Tile | null>();
    const queue: Tile[] = [start];
    visited.add(key(start));
    parent.set(key(start), null);

    const dirs = [
      { x: 0, y: -1 }, { x: 0, y: 1 },
      { x: -1, y: 0 }, { x: 1, y: 0 },
    ];

    while (queue.length > 0) {
      const current = queue.shift()!;
      if (current.x === end.x && current.y === end.y) {
        // Reconstruct path
        const path: Tile[] = [];
        let node: Tile | null = current;
        while (node && !(node.x === start.x && node.y === start.y)) {
          path.unshift(node);
          node = parent.get(key(node)) ?? null;
        }
        return path;
      }

      for (const dir of dirs) {
        const next = { x: current.x + dir.x, y: current.y + dir.y };
        if (!visited.has(key(next)) && isWalkable(next.x, next.y)) {
          visited.add(key(next));
          parent.set(key(next), current);
          queue.push(next);
        }
      }
    }

    // No path found — return direct line
    return [end];
  }

  private randomWalkableTile(): Tile | null {
    const { isWalkable, OFFICE_WIDTH, OFFICE_HEIGHT } = require('./office-state');
    // Try up to 20 random positions
    for (let i = 0; i < 20; i++) {
      const x = Math.floor(Math.random() * OFFICE_WIDTH);
      const y = Math.floor(Math.random() * OFFICE_HEIGHT);
      if (isWalkable(x, y)) return { x, y };
    }
    return null;
  }

  private assignDesk(paneId: string): number {
    if (this.assignedDesks.has(paneId)) {
      return this.assignedDesks.get(paneId)!;
    }

    // Find first unassigned desk
    const usedDesks = new Set(this.assignedDesks.values());
    let index = 0;
    while (usedDesks.has(index)) index++;

    this.assignedDesks.set(paneId, index);
    return index;
  }
}
```

- [x] **Step 2: Type-check**

Run:
```bash
npx tsc --noEmit
```

Expected: TypeScript compiler exits with code 0.

- [x] **Step 3: Commit**

```bash
git add src/renderer/components/visualizer/characters.ts
git commit -m "feat: add character manager with state machine, desk assignment, and animation"
```

### Task 4.7: Office canvas renderer

**Files:**
- Create: `src/renderer/components/visualizer/office-renderer.ts`
- Create: `src/renderer/components/visualizer/matrix-effect.ts`
- Create: `src/renderer/components/visualizer/office-state.ts`

- [x] **Step 1: Write the office state manager**

Create `src/renderer/components/visualizer/office-state.ts`:
```ts
// Office tilemap layout — defines walkable tiles, desk positions, furniture
export const TILE_SIZE = 16;
export const OFFICE_WIDTH = 14; // tiles
export const OFFICE_HEIGHT = 10; // tiles

export type TileType = 'floor' | 'wall' | 'desk' | 'chair' | 'bookshelf';

// 0 = floor (walkable), 1 = wall, 2 = desk, 3 = chair, 4 = bookshelf
const OFFICE_MAP: number[][] = [
  [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1],
  [1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1],
  [1, 0, 2, 0, 0, 2, 0, 0, 2, 0, 0, 2, 0, 1],
  [1, 0, 3, 0, 0, 3, 0, 0, 3, 0, 0, 3, 0, 1],
  [1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1],
  [1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1],
  [1, 0, 2, 0, 0, 2, 0, 0, 2, 0, 0, 2, 0, 1],
  [1, 0, 3, 0, 0, 3, 0, 0, 3, 0, 0, 3, 0, 1],
  [1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1],
  [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1],
];

const TILE_TYPES: TileType[] = ['floor', 'wall', 'desk', 'chair', 'bookshelf'];

export function getTileAt(x: number, y: number): TileType {
  if (y < 0 || y >= OFFICE_HEIGHT || x < 0 || x >= OFFICE_WIDTH) return 'wall';
  return TILE_TYPES[OFFICE_MAP[y][x]] ?? 'wall';
}

export function isWalkable(x: number, y: number): boolean {
  const tile = getTileAt(x, y);
  return tile === 'floor' || tile === 'chair';
}
```

- [x] **Step 2: Write the matrix rain effect**

Create `src/renderer/components/visualizer/matrix-effect.ts`:
```ts
type MatrixDrop = {
  x: number;
  y: number;
  speed: number;
  chars: string[];
  alpha: number;
  life: number;
};

export class MatrixEffect {
  private drops: MatrixDrop[] = [];
  private active = false;

  trigger(centerX: number, centerY: number, radius: number = 32): void {
    this.active = true;
    const MATRIX_CHARS = '01アイウエオカキクケコサシスセソ'.split('');

    for (let i = 0; i < 12; i++) {
      const x = centerX + (Math.random() - 0.5) * radius * 2;
      this.drops.push({
        x,
        y: centerY - radius,
        speed: 40 + Math.random() * 60,
        chars: Array.from({ length: 6 }, () =>
          MATRIX_CHARS[Math.floor(Math.random() * MATRIX_CHARS.length)],
        ),
        alpha: 0.8 + Math.random() * 0.2,
        life: 1.0,
      });
    }
  }

  update(deltaMs: number): void {
    if (!this.active) return;

    const dt = deltaMs / 1000;
    for (const drop of this.drops) {
      drop.y += drop.speed * dt;
      drop.life -= dt * 0.8;
    }

    this.drops = this.drops.filter((d) => d.life > 0);
    if (this.drops.length === 0) this.active = false;
  }

  render(ctx: CanvasRenderingContext2D): void {
    if (!this.active) return;

    ctx.save();
    ctx.font = '10px monospace';

    for (const drop of this.drops) {
      ctx.globalAlpha = drop.alpha * Math.max(0, drop.life);
      ctx.fillStyle = '#00ff41';

      for (let i = 0; i < drop.chars.length; i++) {
        const charY = drop.y - i * 10;
        const charAlpha = (1 - i / drop.chars.length) * drop.life;
        ctx.globalAlpha = charAlpha;
        ctx.fillText(drop.chars[i], drop.x, charY);
      }
    }

    ctx.restore();
  }

  isActive(): boolean {
    return this.active;
  }
}
```

- [x] **Step 3: Write the office renderer**

Create `src/renderer/components/visualizer/office-renderer.ts`:
```ts
import type { Character } from './characters';
import { TILE_SIZE, OFFICE_WIDTH, OFFICE_HEIGHT, getTileAt } from './office-state';
import { MatrixEffect } from './matrix-effect';

const TILE_COLORS: Record<string, string> = {
  floor: '#2a2a3e',
  wall: '#1a1a2e',
  desk: '#4a3728',
  chair: '#3a3a4e',
  bookshelf: '#3d2b1f',
};

const STATE_COLORS: Record<string, string> = {
  working: '#4ade80',
  reading: '#60a5fa',
  idle: '#9ca3af',
  walking: '#9ca3af',
  'needs-permission': '#fbbf24',
  waiting: '#34d399',
};

export class OfficeRenderer {
  private matrixEffects = new Map<string, MatrixEffect>();

  get canvasWidth(): number {
    return OFFICE_WIDTH * TILE_SIZE;
  }

  get canvasHeight(): number {
    return OFFICE_HEIGHT * TILE_SIZE;
  }

  render(ctx: CanvasRenderingContext2D, characters: Character[], scale: number): void {
    ctx.save();
    ctx.scale(scale, scale);

    // Nearest-neighbor scaling for crisp pixels
    ctx.imageSmoothingEnabled = false;

    this.renderTilemap(ctx);
    this.renderCharacters(ctx, characters);
    this.renderBubbles(ctx, characters);
    this.renderMatrixEffects(ctx);

    ctx.restore();
  }

  triggerSpawnEffect(paneId: string, x: number, y: number): void {
    const effect = new MatrixEffect();
    effect.trigger(x * TILE_SIZE + TILE_SIZE / 2, y * TILE_SIZE);
    this.matrixEffects.set(paneId, effect);
  }

  updateEffects(deltaMs: number): void {
    for (const [id, effect] of this.matrixEffects) {
      effect.update(deltaMs);
      if (!effect.isActive()) this.matrixEffects.delete(id);
    }
  }

  private renderTilemap(ctx: CanvasRenderingContext2D): void {
    for (let y = 0; y < OFFICE_HEIGHT; y++) {
      for (let x = 0; x < OFFICE_WIDTH; x++) {
        const tile = getTileAt(x, y);
        ctx.fillStyle = TILE_COLORS[tile] ?? '#000';
        ctx.fillRect(x * TILE_SIZE, y * TILE_SIZE, TILE_SIZE, TILE_SIZE);

        // Tile border
        ctx.strokeStyle = 'rgba(255,255,255,0.05)';
        ctx.strokeRect(x * TILE_SIZE, y * TILE_SIZE, TILE_SIZE, TILE_SIZE);
      }
    }
  }

  private renderCharacters(ctx: CanvasRenderingContext2D, characters: Character[]): void {
    // Z-sort: back to front (lower y = further back = rendered first)
    const sorted = [...characters].sort((a, b) => a.position.y - b.position.y);

    for (const char of sorted) {
      const px = Math.round(char.position.x * TILE_SIZE);
      const py = Math.round(char.position.y * TILE_SIZE);

      // Character body (placeholder rectangle — will be replaced with sprite rendering)
      const color = STATE_COLORS[char.agentState] ?? '#9ca3af';
      const size = char.isSubAgent ? 10 : 14;
      const offset = (TILE_SIZE - size) / 2;

      ctx.fillStyle = color;
      ctx.fillRect(px + offset, py + offset - 8, size, size + 8);

      // Head
      ctx.fillStyle = '#e0c8a8';
      ctx.fillRect(px + offset + 2, py + offset - 10, size - 4, 6);

      // Despawn fade
      if (char.despawnTime) {
        const elapsed = Date.now() - char.despawnTime;
        ctx.globalAlpha = Math.max(0, 1 - elapsed / 1000);
      }

      ctx.globalAlpha = 1;
    }
  }

  private renderBubbles(ctx: CanvasRenderingContext2D, characters: Character[]): void {
    for (const char of characters) {
      if (char.agentState === 'needs-permission') {
        this.renderBubble(ctx, char, '⚠', '#fbbf24');
      } else if (char.agentState === 'waiting') {
        this.renderBubble(ctx, char, '✓', '#34d399');
      }
    }
  }

  private renderBubble(ctx: CanvasRenderingContext2D, char: Character, symbol: string, color: string): void {
    const px = Math.round(char.position.x * TILE_SIZE) + TILE_SIZE / 2;
    const py = Math.round(char.position.y * TILE_SIZE) - 14;

    // Bubble background
    ctx.fillStyle = 'rgba(0,0,0,0.7)';
    ctx.beginPath();
    ctx.arc(px, py, 6, 0, Math.PI * 2);
    ctx.fill();

    // Symbol
    ctx.fillStyle = color;
    ctx.font = '8px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(symbol, px, py);
  }

  private renderMatrixEffects(ctx: CanvasRenderingContext2D): void {
    for (const effect of this.matrixEffects.values()) {
      effect.render(ctx);
    }
  }
}
```

- [x] **Step 4: Type-check**

Run:
```bash
npx tsc --noEmit
```

Expected: TypeScript compiler exits with code 0.

- [x] **Step 5: Commit**

```bash
git add src/renderer/components/visualizer/office-renderer.ts src/renderer/components/visualizer/matrix-effect.ts src/renderer/components/visualizer/office-state.ts
git commit -m "feat: add office renderer with tilemap, characters, bubbles, and matrix rain"
```

### Task 4.8: OfficeCanvas React component

**Files:**
- Create: `src/renderer/components/visualizer/OfficeCanvas.tsx`

- [x] **Step 1: Write the OfficeCanvas component**

Create `src/renderer/components/visualizer/OfficeCanvas.tsx`:
```tsx
import { useRef, useEffect, useCallback, useState } from 'react';
import { useVisualizerStore } from '../../store/visualizer-store';
import { CharacterManager, Character } from './characters';
import { OfficeRenderer } from './office-renderer';
import { TILE_SIZE } from './office-state';

type Tooltip = {
  x: number;
  y: number;
  label: string;
  tool: string;
  uptime: string;
};

type OfficeCanvasProps = {
  onCharacterClick: (paneId: string) => void;
};

function formatUptime(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  if (hours > 0) return `${hours}h ${minutes % 60}m`;
  if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
  return `${seconds}s`;
}

export function OfficeCanvas({ onCharacterClick }: OfficeCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rendererRef = useRef(new OfficeRenderer());
  const characterManagerRef = useRef(new CharacterManager());
  const animFrameRef = useRef<number>(0);
  const lastTimeRef = useRef<number>(0);
  const [tooltip, setTooltip] = useState<Tooltip | null>(null);

  const { agents, isVisible } = useVisualizerStore();

  // Game loop
  useEffect(() => {
    if (!isVisible) {
      cancelAnimationFrame(animFrameRef.current);
      return;
    }

    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const renderer = rendererRef.current;
    const charManager = characterManagerRef.current;

    function loop(timestamp: number) {
      const deltaMs = lastTimeRef.current ? timestamp - lastTimeRef.current : 16;
      lastTimeRef.current = timestamp;

      // Recalculate scale each frame to handle resize
      const cw = canvas!.clientWidth || renderer.canvasWidth;
      const ch = canvas!.clientHeight || renderer.canvasHeight;
      const scale = Math.min(cw / renderer.canvasWidth, ch / renderer.canvasHeight);
      canvas!.width = renderer.canvasWidth * scale;
      canvas!.height = renderer.canvasHeight * scale;

      charManager.update(agents, deltaMs);
      renderer.updateEffects(deltaMs);

      ctx!.clearRect(0, 0, canvas!.width, canvas!.height);
      renderer.render(ctx!, charManager.getCharacters(), scale);

      animFrameRef.current = requestAnimationFrame(loop);
    }

    animFrameRef.current = requestAnimationFrame(loop);

    return () => cancelAnimationFrame(animFrameRef.current);
  }, [isVisible, agents]);

  // Click handling
  const handleClick = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => {
      const canvas = canvasRef.current;
      if (!canvas) return;

      const rect = canvas.getBoundingClientRect();
      const renderer = rendererRef.current;
      const scale = canvas.width / renderer.canvasWidth;

      const x = (e.clientX - rect.left) / scale / TILE_SIZE;
      const y = (e.clientY - rect.top) / scale / TILE_SIZE;

      // Find clicked character (within 1 tile radius)
      const characters = characterManagerRef.current.getCharacters();
      for (const char of characters) {
        const dx = char.position.x - x;
        const dy = char.position.y - y;
        if (Math.sqrt(dx * dx + dy * dy) < 1) {
          onCharacterClick(char.paneId);
          return;
        }
      }
    },
    [onCharacterClick],
  );

  // Hover handling for tooltips
  const handleMouseMove = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => {
      const canvas = canvasRef.current;
      if (!canvas) return;

      const rect = canvas.getBoundingClientRect();
      const renderer = rendererRef.current;
      const scale = canvas.width / renderer.canvasWidth;
      const x = (e.clientX - rect.left) / scale / TILE_SIZE;
      const y = (e.clientY - rect.top) / scale / TILE_SIZE;

      const characters = characterManagerRef.current.getCharacters();
      for (const char of characters) {
        const dx = char.position.x - x;
        const dy = char.position.y - y;
        if (Math.sqrt(dx * dx + dy * dy) < 1) {
          setTooltip({
            x: e.clientX - rect.left,
            y: e.clientY - rect.top - 40,
            label: char.label,
            tool: char.currentTool ?? 'none',
            uptime: formatUptime(Date.now() - char.spawnTime),
          });
          return;
        }
      }
      setTooltip(null);
    },
    [],
  );

  return (
    <div className="relative w-full h-full">
      <canvas
        ref={canvasRef}
        onClick={handleClick}
        onMouseMove={handleMouseMove}
        onMouseLeave={() => setTooltip(null)}
        className="w-full h-full cursor-pointer"
        style={{ imageRendering: 'pixelated' }}
      />
      {tooltip && (
        <div
          className="absolute pointer-events-none bg-neutral-800 border border-neutral-700 rounded px-2 py-1 text-xs text-white shadow-lg"
          style={{ left: tooltip.x, top: tooltip.y }}
        >
          <div className="font-medium">{tooltip.label}</div>
          <div className="text-neutral-400">Tool: {tooltip.tool}</div>
          <div className="text-neutral-400">Uptime: {tooltip.uptime}</div>
        </div>
      )}
    </div>
  );
}
```

- [x] **Step 2: Type-check**

Run:
```bash
npx tsc --noEmit
```

Expected: TypeScript compiler exits with code 0.

- [x] **Step 3: Commit**

```bash
git add src/renderer/components/visualizer/OfficeCanvas.tsx
git commit -m "feat: add OfficeCanvas React component with game loop and click-to-focus"
```

### Task 4.9: VisualizerPanel (toggleable drawer/tab)

**Files:**
- Create: `src/renderer/components/visualizer/VisualizerPanel.tsx`
- Modify: `src/renderer/App.tsx`
- Modify: `src/renderer/hooks/use-pane-navigation.ts`

- [x] **Step 1: Write the VisualizerPanel component**

Create `src/renderer/components/visualizer/VisualizerPanel.tsx`:
```tsx
import { useState, useCallback } from 'react';
import { useVisualizerStore } from '../../store/visualizer-store';
import { OfficeCanvas } from './OfficeCanvas';

type VisualizerPanelProps = {
  onCharacterClick: (paneId: string) => void;
};

export function VisualizerPanel({ onCharacterClick }: VisualizerPanelProps) {
  const { isVisible, panelMode } = useVisualizerStore();
  const [drawerHeight, setDrawerHeight] = useState(200);

  const handleResizeStart = useCallback((e: React.PointerEvent) => {
    e.preventDefault();
    const startY = e.clientY;
    const startHeight = drawerHeight;

    function onMove(moveEvent: PointerEvent) {
      const delta = startY - moveEvent.clientY;
      setDrawerHeight(Math.max(100, Math.min(600, startHeight + delta)));
    }

    function onUp() {
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerup', onUp);
    }

    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onUp);
  }, [drawerHeight]);

  if (!isVisible) return null;

  if (panelMode === 'drawer') {
    return (
      <div className="border-t border-neutral-800 bg-neutral-950" style={{ height: `${drawerHeight}px` }}>
        <div
          className="h-1 cursor-row-resize bg-neutral-800 hover:bg-blue-500 transition-colors"
          onPointerDown={handleResizeStart}
        />
        <div className="flex items-center justify-between px-3 py-1 border-b border-neutral-800">
          <span className="text-xs text-neutral-500 uppercase tracking-wider">Agent Visualizer</span>
        </div>
        <div className="h-[calc(100%-32px)]">
          <OfficeCanvas onCharacterClick={onCharacterClick} />
        </div>
      </div>
    );
  }

  // Tab mode — full height
  return (
    <div className="flex-1 bg-neutral-950">
      <OfficeCanvas onCharacterClick={onCharacterClick} />
    </div>
  );
}
```

- [x] **Step 2: Add VisualizerPanel to App.tsx**

Add import:
```ts
import { VisualizerPanel } from './components/visualizer/VisualizerPanel';
```

Add inside the `App` component's return, after the `<main>` section and before the closing `</div>`:
```tsx
<VisualizerPanel
  onCharacterClick={(paneId) => {
    setActivePane(paneId);
    window.fleet.notifications.paneFocused({ paneId });
  }}
/>
```

- [x] **Step 3: Add Cmd+Shift+V toggle shortcut**

In `src/renderer/hooks/use-pane-navigation.ts`, add import:
```ts
import { useVisualizerStore } from '../store/visualizer-store';
```

Add inside `handleKeyDown`:
```ts
      if (mod && e.shiftKey && e.key === 'V') {
        // Cmd+Shift+V is handled separately — don't conflict with paste
        // Check that it's truly Shift+V (uppercase) not just v
        e.preventDefault();
        useVisualizerStore.getState().toggleVisible();
      }
```

- [x] **Step 4: Run the app and test**

Run:
```bash
npm run dev
```

Expected: `Cmd+Shift+V` toggles the visualizer drawer at the bottom. If agents are running (Claude Code in a pane), characters appear in the office scene. Clicking a character focuses the corresponding terminal pane.

- [x] **Step 5: Commit**

```bash
git add src/renderer/components/visualizer/VisualizerPanel.tsx src/renderer/App.tsx src/renderer/hooks/use-pane-navigation.ts
git commit -m "feat: add toggleable visualizer panel with Cmd+Shift+V shortcut"
```

---

## Chunk 5: Cross-Cutting Concerns (Layer 5)

Settings persistence, shortcuts panel, workspace picker, auto-updater, and distribution config.

### Task 5.1: Settings store and persistence

**Files:**
- Create: `src/main/settings-store.ts`
- Create: `src/renderer/store/settings-store.ts`
- Modify: `src/main/ipc-handlers.ts`
- Modify: `src/main/index.ts`

- [x] **Step 1: Create a settings store in the main process**

Create `src/main/settings-store.ts`:
```ts
import Store from 'electron-store';
import type { FleetSettings } from '../shared/types';
import { DEFAULT_SETTINGS } from '../shared/constants';

export class SettingsStore {
  private store: Store<{ settings: FleetSettings }>;

  constructor() {
    this.store = new Store<{ settings: FleetSettings }>({
      name: 'fleet-settings',
      defaults: {
        settings: DEFAULT_SETTINGS,
      },
    });
  }

  get(): FleetSettings {
    return this.store.get('settings');
  }

  set(partial: Partial<FleetSettings>): void {
    const current = this.get();
    const merged = {
      ...current,
      ...partial,
      general: { ...current.general, ...(partial.general ?? {}) },
      notifications: { ...current.notifications, ...(partial.notifications ?? {}) },
      socketApi: { ...current.socketApi, ...(partial.socketApi ?? {}) },
      visualizer: { ...current.visualizer, ...(partial.visualizer ?? {}) },
    };
    this.store.set('settings', merged);
  }
}
```

- [x] **Step 2: Replace stub settings IPC handlers**

In `src/main/ipc-handlers.ts`, add `SettingsStore` as a parameter:

```ts
import { SettingsStore } from './settings-store';
```

Update function signature to include `settingsStore: SettingsStore`.

Replace the stub handlers:
```ts
  ipcMain.handle(IPC_CHANNELS.SETTINGS_GET, () => {
    return settingsStore.get();
  });

  ipcMain.handle(IPC_CHANNELS.SETTINGS_SET, (_event, settings: Partial<FleetSettings>) => {
    settingsStore.set(settings);
  });
```

- [x] **Step 3: Create and pass SettingsStore in main/index.ts**

Add to `src/main/index.ts`:
```ts
import { SettingsStore } from './settings-store';

const settingsStore = new SettingsStore();
```

Pass to `registerIpcHandlers`:
```ts
registerIpcHandlers(ptyManager, layoutStore, eventBus, notificationDetector, notificationState, settingsStore, () => mainWindow);
```

- [x] **Step 4: Create renderer-side settings store**

Create `src/renderer/store/settings-store.ts`:
```ts
import { create } from 'zustand';
import type { FleetSettings } from '../../shared/types';

type SettingsStoreState = {
  settings: FleetSettings | null;
  isLoaded: boolean;
  loadSettings: () => Promise<void>;
  updateSettings: (partial: Partial<FleetSettings>) => Promise<void>;
};

export const useSettingsStore = create<SettingsStoreState>((set) => ({
  settings: null,
  isLoaded: false,

  loadSettings: async () => {
    const settings = await window.fleet.settings.get();
    set({ settings, isLoaded: true });
  },

  updateSettings: async (partial) => {
    await window.fleet.settings.set(partial);
    const settings = await window.fleet.settings.get();
    set({ settings });
  },
}));
```

- [x] **Step 5: Load settings on app startup**

Add to `src/renderer/App.tsx`:
```ts
import { useSettingsStore } from './store/settings-store';
```

Inside `App` component, add:
```ts
const { loadSettings } = useSettingsStore();

useEffect(() => {
  loadSettings();
}, []);
```

- [x] **Step 6: Type-check**

Run:
```bash
npx tsc --noEmit
```

Expected: TypeScript compiler exits with code 0.

- [x] **Step 7: Commit**

```bash
git add src/main/settings-store.ts src/main/ipc-handlers.ts src/main/index.ts src/renderer/store/settings-store.ts src/renderer/App.tsx
git commit -m "feat: add settings persistence with electron-store and IPC"
```

### Task 5.2: Settings modal UI

**Files:**
- Create: `src/renderer/components/SettingsModal.tsx`
- Modify: `src/renderer/hooks/use-pane-navigation.ts`
- Modify: `src/renderer/App.tsx`

- [x] **Step 1: Write the SettingsModal component**

Create `src/renderer/components/SettingsModal.tsx`:
```tsx
import { useState, useEffect } from 'react';
import { useSettingsStore } from '../store/settings-store';
import type { FleetSettings } from '../../shared/types';

type SettingsModalProps = {
  isOpen: boolean;
  onClose: () => void;
};

type NotificationKey = keyof FleetSettings['notifications'];

const NOTIFICATION_LABELS: Record<NotificationKey, string> = {
  taskComplete: 'Task Complete',
  needsPermission: 'Needs Permission',
  processExitError: 'Process Exit (Error)',
  processExitClean: 'Process Exit (Clean)',
};

export function SettingsModal({ isOpen, onClose }: SettingsModalProps) {
  const { settings, updateSettings } = useSettingsStore();
  const [activeTab, setActiveTab] = useState<'general' | 'notifications' | 'socket' | 'visualizer'>('general');

  if (!isOpen || !settings) return null;

  const tabs = ['general', 'notifications', 'socket', 'visualizer'] as const;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={onClose}>
      <div
        className="bg-neutral-900 border border-neutral-700 rounded-lg w-[520px] max-h-[80vh] overflow-hidden shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-neutral-800">
          <h2 className="text-sm font-semibold text-white">Settings</h2>
          <button onClick={onClose} className="text-neutral-500 hover:text-white">×</button>
        </div>

        {/* Tab bar */}
        <div className="flex border-b border-neutral-800">
          {tabs.map((tab) => (
            <button
              key={tab}
              className={`px-4 py-2 text-xs capitalize ${
                activeTab === tab ? 'text-white border-b-2 border-blue-500' : 'text-neutral-500 hover:text-neutral-300'
              }`}
              onClick={() => setActiveTab(tab)}
            >
              {tab}
            </button>
          ))}
        </div>

        {/* Content */}
        <div className="p-4 overflow-y-auto max-h-[60vh] space-y-4">
          {activeTab === 'general' && (
            <>
              <SettingRow label="Default Shell">
                <input
                  type="text"
                  value={settings.general.defaultShell || '(auto-detect)'}
                  onChange={(e) => updateSettings({ general: { ...settings.general, defaultShell: e.target.value } })}
                  placeholder="(auto-detect)"
                  className="bg-neutral-800 text-white text-sm rounded px-2 py-1 w-48 border border-neutral-700"
                />
              </SettingRow>
              <SettingRow label="Font Size">
                <input
                  type="number"
                  value={settings.general.fontSize}
                  onChange={(e) => updateSettings({ general: { ...settings.general, fontSize: parseInt(e.target.value) || 14 } })}
                  className="bg-neutral-800 text-white text-sm rounded px-2 py-1 w-20 border border-neutral-700"
                />
              </SettingRow>
              <SettingRow label="Font Family">
                <input
                  type="text"
                  value={settings.general.fontFamily}
                  onChange={(e) => updateSettings({ general: { ...settings.general, fontFamily: e.target.value } })}
                  className="bg-neutral-800 text-white text-sm rounded px-2 py-1 w-48 border border-neutral-700"
                />
              </SettingRow>
              <SettingRow label="Scrollback Lines">
                <input
                  type="number"
                  value={settings.general.scrollbackSize}
                  onChange={(e) => updateSettings({ general: { ...settings.general, scrollbackSize: parseInt(e.target.value) || 10000 } })}
                  className="bg-neutral-800 text-white text-sm rounded px-2 py-1 w-24 border border-neutral-700"
                />
              </SettingRow>
              <SettingRow label="Theme">
                <select
                  value={settings.general.theme}
                  onChange={(e) => updateSettings({ general: { ...settings.general, theme: e.target.value as 'dark' | 'light' } })}
                  className="bg-neutral-800 text-white text-sm rounded px-2 py-1 border border-neutral-700"
                >
                  <option value="dark">Dark</option>
                  <option value="light">Light</option>
                </select>
              </SettingRow>
            </>
          )}

          {activeTab === 'notifications' && (
            <div className="space-y-3">
              <div className="grid grid-cols-4 gap-2 text-xs text-neutral-500 mb-1">
                <div>Event</div>
                <div className="text-center">Badge</div>
                <div className="text-center">Sound</div>
                <div className="text-center">OS</div>
              </div>
              {(Object.keys(NOTIFICATION_LABELS) as NotificationKey[]).map((key) => (
                <div key={key} className="grid grid-cols-4 gap-2 items-center">
                  <div className="text-sm text-neutral-300">{NOTIFICATION_LABELS[key]}</div>
                  {(['badge', 'sound', 'os'] as const).map((channel) => (
                    <div key={channel} className="flex justify-center">
                      <input
                        type="checkbox"
                        checked={settings.notifications[key][channel]}
                        onChange={(e) => {
                          updateSettings({
                            notifications: {
                              ...settings.notifications,
                              [key]: {
                                ...settings.notifications[key],
                                [channel]: e.target.checked,
                              },
                            },
                          });
                        }}
                        className="accent-blue-500"
                      />
                    </div>
                  ))}
                </div>
              ))}
            </div>
          )}

          {activeTab === 'socket' && (
            <>
              <SettingRow label="Socket API Enabled">
                <input
                  type="checkbox"
                  checked={settings.socketApi.enabled}
                  onChange={(e) => updateSettings({ socketApi: { ...settings.socketApi, enabled: e.target.checked } })}
                  className="accent-blue-500"
                />
              </SettingRow>
              <SettingRow label="Socket Path">
                <input
                  type="text"
                  value={settings.socketApi.socketPath || '~/.fleet/fleet.sock'}
                  onChange={(e) => updateSettings({ socketApi: { ...settings.socketApi, socketPath: e.target.value } })}
                  className="bg-neutral-800 text-white text-sm rounded px-2 py-1 w-64 border border-neutral-700"
                  disabled
                />
              </SettingRow>
            </>
          )}

          {activeTab === 'visualizer' && (
            <SettingRow label="Panel Mode">
              <select
                value={settings.visualizer.panelMode}
                onChange={(e) => updateSettings({ visualizer: { panelMode: e.target.value as 'drawer' | 'tab' } })}
                className="bg-neutral-800 text-white text-sm rounded px-2 py-1 border border-neutral-700"
              >
                <option value="drawer">Bottom Drawer</option>
                <option value="tab">Dedicated Tab</option>
              </select>
            </SettingRow>
          )}
        </div>
      </div>
    </div>
  );
}

function SettingRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-sm text-neutral-300">{label}</span>
      {children}
    </div>
  );
}
```

- [x] **Step 2: Add Cmd+, shortcut and wire into App**

Add to `src/renderer/hooks/use-pane-navigation.ts` `handleKeyDown`:
```ts
      if (mod && e.key === ',') {
        e.preventDefault();
        document.dispatchEvent(new CustomEvent('fleet:toggle-settings'));
      }
```

In `src/renderer/App.tsx`, add state and handler:
```tsx
import { SettingsModal } from './components/SettingsModal';

// Inside App component:
const [settingsOpen, setSettingsOpen] = useState(false);

useEffect(() => {
  const handler = () => setSettingsOpen((prev) => !prev);
  document.addEventListener('fleet:toggle-settings', handler);
  return () => document.removeEventListener('fleet:toggle-settings', handler);
}, []);
```

Add to the JSX:
```tsx
<SettingsModal isOpen={settingsOpen} onClose={() => setSettingsOpen(false)} />
```

- [x] **Step 3: Type-check**

Run:
```bash
npx tsc --noEmit
```

Expected: TypeScript compiler exits with code 0.

- [x] **Step 4: Commit**

```bash
git add src/renderer/components/SettingsModal.tsx src/renderer/hooks/use-pane-navigation.ts src/renderer/App.tsx
git commit -m "feat: add settings modal with per-type notification toggles"
```

### Task 5.3: Workspace picker

**Files:**
- Create: `src/renderer/components/WorkspacePicker.tsx`
- Modify: `src/renderer/components/Sidebar.tsx`

- [x] **Step 1: Write the WorkspacePicker component**

Create `src/renderer/components/WorkspacePicker.tsx`:
```tsx
import { useState, useEffect } from 'react';
import { useWorkspaceStore } from '../store/workspace-store';
import type { Workspace } from '../../shared/types';

export function WorkspacePicker() {
  const { workspace, loadWorkspace } = useWorkspaceStore();
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [isOpen, setIsOpen] = useState(false);

  useEffect(() => {
    window.fleet.layout.list().then(({ workspaces }) => {
      setWorkspaces(workspaces);
    });
  }, [isOpen]);

  const handleSave = async () => {
    await window.fleet.layout.save({ workspace });
    setIsOpen(false);
  };

  const handleLoad = async (ws: Workspace) => {
    // Check if there are running PTY processes — confirm before switching
    const currentPaneIds = useWorkspaceStore.getState().getAllPaneIds();
    if (currentPaneIds.length > 0) {
      const confirmed = window.confirm(
        `Switching workspaces will close ${currentPaneIds.length} active terminal(s). Continue?`
      );
      if (!confirmed) return;

      // Kill all current PTYs
      for (const paneId of currentPaneIds) {
        window.fleet.pty.kill(paneId);
      }
    }

    loadWorkspace(ws);
    setIsOpen(false);
  };

  const handleDelete = async (wsId: string) => {
    await window.fleet.layout.delete(wsId);
    setWorkspaces((prev) => prev.filter((w) => w.id !== wsId));
  };

  return (
    <div className="relative">
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="w-full px-3 py-2 text-left text-xs font-semibold text-neutral-500 uppercase tracking-wider hover:bg-neutral-800 transition-colors"
      >
        {workspace.label} ▾
      </button>

      {isOpen && (
        <div className="absolute left-0 top-full z-20 w-56 bg-neutral-800 border border-neutral-700 rounded-md shadow-lg py-1">
          {workspaces.map((ws) => (
            <div
              key={ws.id}
              className="flex items-center justify-between px-3 py-1.5 hover:bg-neutral-700"
            >
              <button
                className="text-sm text-neutral-300 hover:text-white flex-1 text-left"
                onClick={() => handleLoad(ws)}
              >
                {ws.label}
              </button>
              <button
                className="text-xs text-neutral-600 hover:text-red-400"
                onClick={() => handleDelete(ws.id)}
              >
                ×
              </button>
            </div>
          ))}

          <div className="border-t border-neutral-700 mt-1 pt-1">
            <button
              className="w-full px-3 py-1.5 text-sm text-neutral-400 hover:text-white hover:bg-neutral-700 text-left"
              onClick={handleSave}
            >
              Save Current Workspace
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
```

- [x] **Step 2: Replace the static workspace label in Sidebar with WorkspacePicker**

In `src/renderer/components/Sidebar.tsx`, replace:
```tsx
<div className="px-3 py-3 text-xs font-semibold text-neutral-500 uppercase tracking-wider">
  {workspace.label}
</div>
```

With:
```tsx
<WorkspacePicker />
```

Add the import:
```tsx
import { WorkspacePicker } from './WorkspacePicker';
```

- [x] **Step 3: Type-check**

Run:
```bash
npx tsc --noEmit
```

Expected: TypeScript compiler exits with code 0.

- [x] **Step 4: Commit**

```bash
git add src/renderer/components/WorkspacePicker.tsx src/renderer/components/Sidebar.tsx
git commit -m "feat: add workspace picker with save/load/delete"
```

### Task 5.4: Shortcuts panel

**Files:**
- Create: `src/renderer/components/ShortcutsPanel.tsx`
- Modify: `src/renderer/App.tsx`
- Modify: `src/renderer/hooks/use-pane-navigation.ts`

- [x] **Step 1: Write the ShortcutsPanel component**

Create `src/renderer/components/ShortcutsPanel.tsx`:
```tsx
const isMac = navigator.platform.includes('Mac');

// Platform-specific shortcuts per spec — Windows avoids Ctrl+D (EOF),
// Ctrl+W (word delete), and Ctrl+F (some shells intercept it).
const SHORTCUTS = isMac
  ? [
      { keys: '⌘+T', action: 'New tab' },
      { keys: '⌘+W', action: 'Close pane' },
      { keys: '⌘+D', action: 'Split horizontal' },
      { keys: '⌘+Shift+D', action: 'Split vertical' },
      { keys: '⌘+[/]', action: 'Navigate panes' },
      { keys: '⌘+1-9', action: 'Switch tabs' },
      { keys: '⌘+F', action: 'Search in pane' },
      { keys: '⌘+Shift+V', action: 'Toggle visualizer' },
      { keys: '⌘+,', action: 'Settings' },
      { keys: '⌘+/', action: 'Show shortcuts' },
    ]
  : [
      { keys: 'Ctrl+T', action: 'New tab' },
      { keys: 'Ctrl+Shift+W', action: 'Close pane' },
      { keys: 'Ctrl+Shift+D', action: 'Split horizontal' },
      { keys: 'Ctrl+Shift+Alt+D', action: 'Split vertical' },
      { keys: 'Ctrl+[/]', action: 'Navigate panes' },
      { keys: 'Ctrl+1-9', action: 'Switch tabs' },
      { keys: 'Ctrl+Shift+F', action: 'Search in pane' },
      { keys: 'Ctrl+Shift+V', action: 'Toggle visualizer' },
      { keys: 'Ctrl+,', action: 'Settings' },
      { keys: 'Ctrl+/', action: 'Show shortcuts' },
    ];

type ShortcutsPanelProps = {
  isOpen: boolean;
  onClose: () => void;
};

export function ShortcutsPanel({ isOpen, onClose }: ShortcutsPanelProps) {
  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={onClose}>
      <div
        className="bg-neutral-900 border border-neutral-700 rounded-lg w-[360px] shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-4 py-3 border-b border-neutral-800">
          <h2 className="text-sm font-semibold text-white">Keyboard Shortcuts</h2>
          <button onClick={onClose} className="text-neutral-500 hover:text-white">×</button>
        </div>
        <div className="p-4 space-y-2">
          {SHORTCUTS.map(({ keys, action }) => (
            <div key={keys} className="flex items-center justify-between">
              <span className="text-sm text-neutral-300">{action}</span>
              <kbd className="text-xs bg-neutral-800 text-neutral-400 px-2 py-0.5 rounded border border-neutral-700">
                {keys}
              </kbd>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
```

- [x] **Step 2: Add Cmd+/ shortcut**

In `src/renderer/hooks/use-pane-navigation.ts` `handleKeyDown`, add:
```ts
      if (mod && e.key === '/') {
        e.preventDefault();
        document.dispatchEvent(new CustomEvent('fleet:toggle-shortcuts'));
      }
```

- [x] **Step 3: Wire into App.tsx**

Add import and state:
```tsx
import { ShortcutsPanel } from './components/ShortcutsPanel';

const [shortcutsOpen, setShortcutsOpen] = useState(false);

useEffect(() => {
  const handler = () => setShortcutsOpen((prev) => !prev);
  document.addEventListener('fleet:toggle-shortcuts', handler);
  return () => document.removeEventListener('fleet:toggle-shortcuts', handler);
}, []);
```

Add to JSX:
```tsx
<ShortcutsPanel isOpen={shortcutsOpen} onClose={() => setShortcutsOpen(false)} />
```

- [x] **Step 4: Type-check**

Run:
```bash
npx tsc --noEmit
```

Expected: TypeScript compiler exits with code 0.

- [x] **Step 5: Commit**

```bash
git add src/renderer/components/ShortcutsPanel.tsx src/renderer/hooks/use-pane-navigation.ts src/renderer/App.tsx
git commit -m "feat: add keyboard shortcuts panel with Cmd+/ toggle"
```

### Task 5.5: Auto-updater

**Files:**
- Modify: `src/main/index.ts`

- [x] **Step 1: Add auto-updater to main process**

Add to the top of `src/main/index.ts`:
```ts
import { autoUpdater } from 'electron-updater';
```

Add inside `app.whenReady()`, after `createWindow()`:
```ts
  // Auto-updater — checks GitHub Releases for updates
  autoUpdater.checkForUpdatesAndNotify().catch(() => {
    // Silently fail if no internet or no releases configured
  });

  autoUpdater.on('update-available', () => {
    mainWindow?.webContents.send('fleet:update-available');
  });

  autoUpdater.on('update-downloaded', () => {
    mainWindow?.webContents.send('fleet:update-downloaded');
  });

  // Handle renderer requesting install
  ipcMain.on('fleet:install-update', () => {
    autoUpdater.quitAndInstall();
  });
```

- [x] **Step 2: Add update badge to renderer**

Add to `src/renderer/App.tsx`:
```ts
const [updateReady, setUpdateReady] = useState(false);

useEffect(() => {
  const { ipcRenderer } = window.require?.('electron') ?? {};
  // Listen via preload — add these to the preload if needed, or use
  // a simple window event listener approach:
  const handleAvailable = () => setUpdateReady(false); // show "checking..."
  const handleDownloaded = () => setUpdateReady(true);

  window.addEventListener('fleet:update-downloaded' as any, handleDownloaded);
  return () => window.removeEventListener('fleet:update-downloaded' as any, handleDownloaded);
}, []);
```

Add to the sidebar area of the JSX (inside `<Sidebar>` or after it):
```tsx
{updateReady && (
  <div className="absolute bottom-2 left-2 right-2 z-10">
    <button
      onClick={() => {
        // Trigger install via IPC
        (window as any).fleet?.installUpdate?.();
      }}
      className="w-full px-3 py-1.5 text-xs bg-blue-600 hover:bg-blue-500 text-white rounded-md"
    >
      Update ready — restart to install
    </button>
  </div>
)}
```

Note: For a clean implementation, add `installUpdate` to the preload API and wire `ipcRenderer.send('fleet:install-update')`. The exact wiring follows the same pattern as existing IPC methods.

- [x] **Step 3: Type-check**

Run:
```bash
npx tsc --noEmit
```

Expected: TypeScript compiler exits with code 0.

- [x] **Step 3: Commit**

```bash
git add src/main/index.ts
git commit -m "feat: add auto-updater via electron-updater and GitHub Releases"
```

### Task 5.6: Electron-builder distribution config

**Files:**
- Create: `electron-builder.yml`
- Modify: `package.json`

- [x] **Step 1: Write the electron-builder config**

Create `electron-builder.yml`:
```yaml
appId: com.fleet.app
productName: Fleet
directories:
  buildResources: build
  output: dist
files:
  - "!**/.vscode/*"
  - "!src/*"
  - "!electron.vite.config.*"
  - "!{.eslintignore,.eslintrc.cjs,.prettierignore,.prettierrc.yaml,dev-app-update.yml,CHANGELOG.md,README.md}"
  - "!{tsconfig.json,tsconfig.node.json,tsconfig.web.json}"
  - "!reference/**"
  - "!docs/**"
mac:
  target:
    - target: dmg
      arch:
        - universal
  category: public.app-category.developer-tools
  entitlementsInherit: build/entitlements.mac.plist
win:
  target:
    - target: nsis
      arch:
        - x64
nsis:
  oneClick: false
  perMachine: false
  allowToChangeInstallationDirectory: true
publish:
  provider: github
  owner: OWNER
  repo: fleet
```

- [x] **Step 2: Add build scripts to package.json**

Add to `package.json` scripts:
```json
"build:mac": "electron-vite build && electron-builder --mac",
"build:win": "electron-vite build && electron-builder --win",
"build:all": "electron-vite build && electron-builder --mac --win"
```

- [x] **Step 3: Verify build config is valid**

Run:
```bash
npx electron-builder --help
```

Expected: Help output prints without errors (confirms electron-builder is installed and the config is loadable).

- [x] **Step 4: Commit**

```bash
git add electron-builder.yml package.json
git commit -m "chore: add electron-builder config for macOS and Windows distribution"
```

### Task 5.7: GitHub Actions CI/CD

**Files:**
- Create: `.github/workflows/build.yml`

- [x] **Step 1: Write the CI workflow**

Create `.github/workflows/build.yml`:
```yaml
name: Build & Release

on:
  push:
    branches: [main]
    tags: ['v*']
  pull_request:
    branches: [main]

jobs:
  build:
    strategy:
      matrix:
        os: [macos-latest, windows-latest]
    runs-on: ${{ matrix.os }}

    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: npm

      - run: npm ci

      - name: Type check
        run: npx tsc --noEmit

      - name: Run tests
        run: npm test

      - name: Build Electron app
        run: npx electron-vite build

      - name: Package
        if: startsWith(github.ref, 'refs/tags/')
        run: npx electron-builder --publish always
        env:
          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}

      - name: Upload artifacts
        if: "!startsWith(github.ref, 'refs/tags/')"
        uses: actions/upload-artifact@v4
        with:
          name: fleet-${{ matrix.os }}
          path: dist/*.{dmg,exe}
          if-no-files-found: ignore
```

- [x] **Step 2: Commit**

```bash
git add .github/workflows/build.yml
git commit -m "ci: add GitHub Actions workflow for build, test, and release"
```

### Task 5.8: Auto-save default workspace on quit

**Files:**
- Modify: `src/main/index.ts`
- Modify: `src/renderer/App.tsx`

- [x] **Step 1: Save workspace state before quit**

In `src/renderer/App.tsx`, add a `beforeunload` handler:
```ts
useEffect(() => {
  const handleBeforeUnload = () => {
    const state = useWorkspaceStore.getState();
    window.fleet.layout.save({ workspace: state.workspace });
  };
  window.addEventListener('beforeunload', handleBeforeUnload);
  return () => window.removeEventListener('beforeunload', handleBeforeUnload);
}, []);
```

- [x] **Step 2: Restore default workspace on startup**

Update the initial workspace load in `App.tsx`:
```ts
useEffect(() => {
  window.fleet.layout.list().then(({ workspaces }) => {
    const defaultWs = workspaces.find((w) => w.id === 'default');
    if (defaultWs && defaultWs.tabs.length > 0) {
      loadWorkspace(defaultWs);
    } else {
      addTab('Shell', '/');
    }
  });
}, []);
```

Remove the previous `useEffect` that unconditionally adds a tab when tabs are empty.

- [x] **Step 3: Type-check**

Run:
```bash
npx tsc --noEmit
```

Expected: TypeScript compiler exits with code 0.

- [x] **Step 4: Run the app end-to-end**

Run:
```bash
npm run dev
```

Expected: On first launch, a default Shell tab opens. Open additional tabs, close the app, reopen — the previous layout is restored.

- [x] **Step 5: Commit**

```bash
git add src/renderer/App.tsx
git commit -m "feat: auto-save and restore default workspace on quit/launch"
```

### Task 5.9: Final integration test

- [x] **Step 1: Run all tests**

Run:
```bash
npm test
```

Expected: All tests pass.

- [x] **Step 2: Type-check the entire project**

Run:
```bash
npx tsc --noEmit
```

Expected: TypeScript compiler exits with code 0.

- [x] **Step 3: Run the app and verify all features**

Run:
```bash
npm run dev
```

Manual checklist:
- Terminal pane opens with working shell
- `Cmd+T` creates new tabs, `Cmd+W` closes panes
- `Cmd+D` / `Cmd+Shift+D` splits panes horizontally/vertically
- `Cmd+1-9` switches tabs
- `Cmd+[/]` navigates between panes
- `Cmd+F` opens search bar
- `Cmd+Shift+V` toggles visualizer panel
- `Cmd+,` opens settings
- `Cmd+/` opens shortcuts panel
- Workspace picker saves/loads/deletes workspaces
- Notification badges appear on tabs when agents need permission
- Socket API responds to commands via `nc -U ~/.fleet/fleet.sock`
- Close and reopen app — layout is restored

- [x] **Step 4: Commit any final fixes**

```bash
git add -A
git commit -m "chore: final integration fixes"
```
