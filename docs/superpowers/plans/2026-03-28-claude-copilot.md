# Claude Copilot Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a macOS-only draggable spaceship overlay that monitors Claude Code sessions via hooks, with permission approvals, session status, and chat history.

**Architecture:** A separate frameless transparent `BrowserWindow` (the "copilot window") floats above all apps. The main process runs a Unix socket server that receives events from a Python hook script installed into `~/.claude/`. Session state is tracked in-memory and pushed to the copilot window via IPC. The entire feature is gated behind `process.platform === 'darwin'`.

**Tech Stack:** Electron BrowserWindow, React, Zustand, Node `net` module (Unix socket), CSS sprite sheet animation, Tailwind CSS.

---

## File Structure

```
src/shared/ipc-channels.ts          — Add copilot IPC channels
src/shared/types.ts                 — Add CopilotSettings type + copilot section in FleetSettings
src/shared/constants.ts             — Add copilot default settings

src/main/copilot/index.ts           — OS gate, init/teardown orchestrator
src/main/copilot/copilot-window.ts  — BrowserWindow creation, drag, position persistence
src/main/copilot/socket-server.ts   — Unix socket server on /tmp/fleet-copilot.sock
src/main/copilot/session-store.ts   — In-memory session state + phase state machine
src/main/copilot/hook-installer.ts  — Python script + ~/.claude/settings.json management
src/main/copilot/ipc-handlers.ts    — Copilot-specific IPC handler registration
src/main/index.ts                   — Wire up copilot init in app startup (darwin only)

src/preload/copilot.ts              — Preload bridge for copilot window
src/renderer/copilot/index.html     — HTML entry for copilot renderer
src/renderer/copilot/src/main.tsx   — React root mount
src/renderer/copilot/src/App.tsx    — Copilot React root (spaceship + panel)
src/renderer/copilot/src/store/copilot-store.ts — Zustand store for copilot UI state
src/renderer/copilot/src/components/SpaceshipSprite.tsx — Sprite animation + drag
src/renderer/copilot/src/components/SessionList.tsx     — Session list view
src/renderer/copilot/src/components/SessionDetail.tsx   — Chat/detail/permission view
src/renderer/copilot/src/components/CopilotSettings.tsx — Settings panel
src/renderer/copilot/src/copilot-logger.ts — Logger for copilot renderer

hooks/fleet-copilot.py              — Python hook script (bundled, copied at install time)

electron.vite.config.ts             — Add copilot renderer entry point
```

---

### Task 1: Shared Types and IPC Channels

**Files:**
- Modify: `src/shared/ipc-channels.ts`
- Modify: `src/shared/types.ts`
- Modify: `src/shared/constants.ts`

- [ ] **Step 1: Add copilot IPC channels**

Add to `src/shared/ipc-channels.ts` before the closing `} as const`:

```typescript
  // Copilot
  COPILOT_SESSIONS: 'copilot:sessions',
  COPILOT_RESPOND_PERMISSION: 'copilot:respond-permission',
  COPILOT_GET_SETTINGS: 'copilot:get-settings',
  COPILOT_SET_SETTINGS: 'copilot:set-settings',
  COPILOT_INSTALL_HOOKS: 'copilot:install-hooks',
  COPILOT_UNINSTALL_HOOKS: 'copilot:uninstall-hooks',
  COPILOT_HOOK_STATUS: 'copilot:hook-status',
  COPILOT_POSITION_GET: 'copilot:position:get',
  COPILOT_POSITION_SET: 'copilot:position:set',
```

- [ ] **Step 2: Add copilot types**

Add to `src/shared/types.ts`:

```typescript
// ── Copilot (Claude Code Session Monitor) ──────────────────────────────────

export type CopilotSessionPhase =
  | 'idle'
  | 'processing'
  | 'waitingForInput'
  | 'waitingForApproval'
  | 'compacting'
  | 'ended';

export type CopilotToolInfo = {
  toolName: string;
  toolInput: Record<string, unknown>;
  toolUseId?: string;
};

export type CopilotPendingPermission = {
  sessionId: string;
  toolUseId: string;
  tool: CopilotToolInfo;
  receivedAt: number;
};

export type CopilotSession = {
  sessionId: string;
  cwd: string;
  projectName: string;
  phase: CopilotSessionPhase;
  pid?: number;
  tty?: string;
  pendingPermissions: CopilotPendingPermission[];
  lastActivity: number;
  createdAt: number;
};

export type CopilotSettings = {
  enabled: boolean;
  spriteSheet: string; // filename in assets, e.g. 'spaceship-default.png'
  notificationSound: string; // macOS system sound name, e.g. 'Pop'
  autoStart: boolean; // start copilot when Fleet opens
};

export type CopilotPosition = {
  x: number;
  y: number;
  displayId: number;
};
```

- [ ] **Step 3: Add copilot to FleetSettings and defaults**

In `src/shared/types.ts`, add to the `FleetSettings` type:

```typescript
  copilot: CopilotSettings;
```

In `src/shared/constants.ts`, add to `DEFAULT_SETTINGS`:

```typescript
  copilot: {
    enabled: false,
    spriteSheet: 'spaceship-default.png',
    notificationSound: 'Pop',
    autoStart: false,
  },
```

In `src/main/settings-store.ts`, add to the `get()` merge:

```typescript
  copilot: { ...DEFAULT_SETTINGS.copilot, ...saved.copilot },
```

And in the `set()` merge:

```typescript
  copilot: { ...current.copilot, ...(partial.copilot ?? {}) },
```

- [ ] **Step 4: Run typecheck**

Run: `npm run typecheck`
Expected: PASS (no type errors)

- [ ] **Step 5: Commit**

```bash
git add src/shared/ipc-channels.ts src/shared/types.ts src/shared/constants.ts src/main/settings-store.ts
git commit -m "feat(copilot): add shared types, IPC channels, and settings"
```

---

### Task 2: Python Hook Script

**Files:**
- Create: `hooks/fleet-copilot.py`

- [ ] **Step 1: Create the Python hook script**

Create `hooks/fleet-copilot.py` (this will be copied to `~/.claude/hooks/` at install time):

```python
#!/usr/bin/env python3
"""
Fleet Copilot Hook
- Sends session state to Fleet via Unix socket
- For PermissionRequest: waits for user decision from Fleet
"""
import json
import os
import socket
import sys

SOCKET_PATH = "/tmp/fleet-copilot.sock"
TIMEOUT_SECONDS = 300  # 5 minutes for permission decisions


def get_tty():
    """Get the TTY of the Claude process (parent)"""
    import subprocess

    ppid = os.getppid()
    try:
        result = subprocess.run(
            ["ps", "-p", str(ppid), "-o", "tty="],
            capture_output=True,
            text=True,
            timeout=2
        )
        tty = result.stdout.strip()
        if tty and tty != "??" and tty != "-":
            if not tty.startswith("/dev/"):
                tty = "/dev/" + tty
            return tty
    except Exception:
        pass

    try:
        return os.ttyname(sys.stdin.fileno())
    except (OSError, AttributeError):
        pass
    try:
        return os.ttyname(sys.stdout.fileno())
    except (OSError, AttributeError):
        pass
    return None


def send_event(state):
    """Send event to Fleet, return response if any"""
    try:
        sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        sock.settimeout(TIMEOUT_SECONDS)
        sock.connect(SOCKET_PATH)
        sock.sendall(json.dumps(state).encode())

        if state.get("status") == "waiting_for_approval":
            response = sock.recv(4096)
            sock.close()
            if response:
                return json.loads(response.decode())
        else:
            sock.close()

        return None
    except (socket.error, OSError, json.JSONDecodeError):
        return None


def main():
    try:
        data = json.load(sys.stdin)
    except json.JSONDecodeError:
        sys.exit(1)

    session_id = data.get("session_id", "unknown")
    event = data.get("hook_event_name", "")
    cwd = data.get("cwd", "")
    tool_input = data.get("tool_input", {})

    claude_pid = os.getppid()
    tty = get_tty()

    state = {
        "session_id": session_id,
        "cwd": cwd,
        "event": event,
        "pid": claude_pid,
        "tty": tty,
    }

    if event == "UserPromptSubmit":
        state["status"] = "processing"

    elif event == "PreToolUse":
        state["status"] = "running_tool"
        state["tool"] = data.get("tool_name")
        state["tool_input"] = tool_input
        tool_use_id = data.get("tool_use_id")
        if tool_use_id:
            state["tool_use_id"] = tool_use_id

    elif event == "PostToolUse":
        state["status"] = "processing"
        state["tool"] = data.get("tool_name")
        state["tool_input"] = tool_input
        tool_use_id = data.get("tool_use_id")
        if tool_use_id:
            state["tool_use_id"] = tool_use_id

    elif event == "PermissionRequest":
        state["status"] = "waiting_for_approval"
        state["tool"] = data.get("tool_name")
        state["tool_input"] = tool_input

        response = send_event(state)

        if response:
            decision = response.get("decision", "ask")
            reason = response.get("reason", "")

            if decision == "allow":
                output = {
                    "hookSpecificOutput": {
                        "hookEventName": "PermissionRequest",
                        "decision": {"behavior": "allow"},
                    }
                }
                print(json.dumps(output))
                sys.exit(0)

            elif decision == "deny":
                output = {
                    "hookSpecificOutput": {
                        "hookEventName": "PermissionRequest",
                        "decision": {
                            "behavior": "deny",
                            "message": reason or "Denied by user via Fleet Copilot",
                        },
                    }
                }
                print(json.dumps(output))
                sys.exit(0)

        sys.exit(0)

    elif event == "Notification":
        notification_type = data.get("notification_type")
        if notification_type == "permission_prompt":
            sys.exit(0)
        elif notification_type == "idle_prompt":
            state["status"] = "waiting_for_input"
        else:
            state["status"] = "notification"
        state["notification_type"] = notification_type
        state["message"] = data.get("message")

    elif event == "Stop":
        state["status"] = "waiting_for_input"

    elif event == "SubagentStop":
        state["status"] = "waiting_for_input"

    elif event == "SessionStart":
        state["status"] = "waiting_for_input"

    elif event == "SessionEnd":
        state["status"] = "ended"

    elif event == "PreCompact":
        state["status"] = "compacting"

    else:
        state["status"] = "unknown"

    send_event(state)


if __name__ == "__main__":
    main()
```

- [ ] **Step 2: Commit**

```bash
git add hooks/fleet-copilot.py
git commit -m "feat(copilot): add Python hook script for Claude Code integration"
```

---

### Task 3: Session Store (Main Process)

**Files:**
- Create: `src/main/copilot/session-store.ts`

- [ ] **Step 1: Create the session store**

Create `src/main/copilot/session-store.ts`:

```typescript
import { createLogger } from '../logger';
import type {
  CopilotSession,
  CopilotSessionPhase,
  CopilotPendingPermission,
  CopilotToolInfo,
} from '../../shared/types';

const log = createLogger('copilot:session-store');

export type HookEvent = {
  session_id: string;
  cwd: string;
  event: string;
  status: string;
  pid?: number;
  tty?: string;
  tool?: string;
  tool_input?: Record<string, unknown>;
  tool_use_id?: string;
  notification_type?: string;
  message?: string;
};

/** Maps hook status strings to session phases */
function statusToPhase(status: string): CopilotSessionPhase {
  switch (status) {
    case 'processing':
    case 'running_tool':
      return 'processing';
    case 'waiting_for_input':
      return 'waitingForInput';
    case 'waiting_for_approval':
      return 'waitingForApproval';
    case 'compacting':
      return 'compacting';
    case 'ended':
      return 'ended';
    default:
      return 'idle';
  }
}

function projectNameFromCwd(cwd: string): string {
  const parts = cwd.split('/');
  return parts[parts.length - 1] || cwd;
}

export class CopilotSessionStore {
  private sessions = new Map<string, CopilotSession>();
  /** Cache tool_use_id from PreToolUse for later PermissionRequest correlation */
  private toolUseIdCache = new Map<string, string[]>();
  private onChange: (() => void) | null = null;

  setOnChange(cb: () => void): void {
    this.onChange = cb;
  }

  getSessions(): CopilotSession[] {
    return Array.from(this.sessions.values()).filter((s) => s.phase !== 'ended');
  }

  getSession(sessionId: string): CopilotSession | undefined {
    return this.sessions.get(sessionId);
  }

  processHookEvent(event: HookEvent): void {
    const { session_id, cwd, status, pid, tty, tool, tool_input, tool_use_id } = event;
    const phase = statusToPhase(status);
    const now = Date.now();

    let session = this.sessions.get(session_id);

    if (!session) {
      session = {
        sessionId: session_id,
        cwd,
        projectName: projectNameFromCwd(cwd),
        phase: 'idle',
        pid,
        tty,
        pendingPermissions: [],
        lastActivity: now,
        createdAt: now,
      };
      this.sessions.set(session_id, session);
      log.info('session created', { sessionId: session_id, cwd });
    }

    // Update metadata
    if (pid) session.pid = pid;
    if (tty) session.tty = tty;
    session.lastActivity = now;

    // Cache tool_use_id from PreToolUse
    if (event.event === 'PreToolUse' && tool_use_id && tool) {
      const cacheKey = `${session_id}:${tool}:${JSON.stringify(tool_input ?? {})}`;
      const queue = this.toolUseIdCache.get(cacheKey) ?? [];
      queue.push(tool_use_id);
      this.toolUseIdCache.set(cacheKey, queue);
    }

    // Handle permission requests
    if (status === 'waiting_for_approval' && tool) {
      const toolInfo: CopilotToolInfo = {
        toolName: tool,
        toolInput: tool_input ?? {},
        toolUseId: tool_use_id ?? this.popCachedToolUseId(session_id, tool, tool_input),
      };
      const pending: CopilotPendingPermission = {
        sessionId: session_id,
        toolUseId: toolInfo.toolUseId ?? `unknown-${now}`,
        tool: toolInfo,
        receivedAt: now,
      };
      session.pendingPermissions.push(pending);
      log.info('permission requested', { sessionId: session_id, tool });
    }

    // Clear completed permissions on PostToolUse
    if (event.event === 'PostToolUse' && tool_use_id) {
      session.pendingPermissions = session.pendingPermissions.filter(
        (p) => p.toolUseId !== tool_use_id
      );
    }

    // Update phase
    session.phase = phase;

    // Clean up ended sessions after a delay
    if (phase === 'ended') {
      this.cleanupToolUseCache(session_id);
      setTimeout(() => {
        this.sessions.delete(session_id);
        this.onChange?.();
      }, 30_000);
    }

    this.onChange?.();
  }

  removePermission(sessionId: string, toolUseId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    session.pendingPermissions = session.pendingPermissions.filter(
      (p) => p.toolUseId !== toolUseId
    );
    // If no more pending permissions, revert to processing
    if (session.pendingPermissions.length === 0 && session.phase === 'waitingForApproval') {
      session.phase = 'processing';
    }
    this.onChange?.();
  }

  private popCachedToolUseId(
    sessionId: string,
    tool: string,
    toolInput?: Record<string, unknown>
  ): string | undefined {
    const cacheKey = `${sessionId}:${tool}:${JSON.stringify(toolInput ?? {})}`;
    const queue = this.toolUseIdCache.get(cacheKey);
    if (!queue || queue.length === 0) return undefined;
    return queue.shift();
  }

  private cleanupToolUseCache(sessionId: string): void {
    for (const key of this.toolUseIdCache.keys()) {
      if (key.startsWith(`${sessionId}:`)) {
        this.toolUseIdCache.delete(key);
      }
    }
  }
}
```

- [ ] **Step 2: Run typecheck**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/main/copilot/session-store.ts
git commit -m "feat(copilot): add session store with phase state machine"
```

---

### Task 4: Unix Socket Server (Main Process)

**Files:**
- Create: `src/main/copilot/socket-server.ts`

- [ ] **Step 1: Create the copilot socket server**

Create `src/main/copilot/socket-server.ts`:

```typescript
import { createServer, type Server, type Socket } from 'net';
import { unlinkSync, existsSync, chmodSync } from 'fs';
import { createLogger } from '../logger';
import type { CopilotSessionStore, HookEvent } from './session-store';

const log = createLogger('copilot:socket');

const SOCKET_PATH = '/tmp/fleet-copilot.sock';

type PendingSocket = {
  sessionId: string;
  toolUseId: string;
  socket: Socket;
};

export class CopilotSocketServer {
  private server: Server | null = null;
  private pendingSockets = new Map<string, PendingSocket>();
  private sessionStore: CopilotSessionStore;

  constructor(sessionStore: CopilotSessionStore) {
    this.sessionStore = sessionStore;
  }

  async start(): Promise<void> {
    // Clean up stale socket
    if (existsSync(SOCKET_PATH)) {
      try {
        unlinkSync(SOCKET_PATH);
      } catch {
        log.warn('failed to remove stale socket', { path: SOCKET_PATH });
      }
    }

    return new Promise((resolve, reject) => {
      this.server = createServer((client) => this.handleConnection(client));

      this.server.on('error', (err) => {
        log.error('socket server error', { error: String(err) });
        reject(err);
      });

      this.server.listen(SOCKET_PATH, () => {
        // Make socket world-accessible (hooks run as different processes)
        try {
          chmodSync(SOCKET_PATH, 0o777);
        } catch {
          log.warn('failed to chmod socket');
        }
        log.info('socket server listening', { path: SOCKET_PATH });
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    // Close all pending permission sockets
    for (const [, pending] of this.pendingSockets) {
      pending.socket.destroy();
    }
    this.pendingSockets.clear();

    return new Promise((resolve) => {
      if (!this.server) {
        resolve();
        return;
      }
      this.server.close(() => {
        if (existsSync(SOCKET_PATH)) {
          try {
            unlinkSync(SOCKET_PATH);
          } catch {
            // ignore
          }
        }
        log.info('socket server stopped');
        resolve();
      });
    });
  }

  /** Send permission decision back to the waiting hook script */
  respondToPermission(
    toolUseId: string,
    decision: 'allow' | 'deny',
    reason?: string
  ): boolean {
    const pending = this.pendingSockets.get(toolUseId);
    if (!pending) {
      log.warn('no pending socket for toolUseId', { toolUseId });
      return false;
    }

    const response = JSON.stringify({ decision, reason: reason ?? '' });
    try {
      pending.socket.write(response);
      pending.socket.end();
    } catch (err) {
      log.error('failed to write permission response', { toolUseId, error: String(err) });
      return false;
    } finally {
      this.pendingSockets.delete(toolUseId);
    }

    this.sessionStore.removePermission(pending.sessionId, toolUseId);
    log.info('permission responded', { toolUseId, decision });
    return true;
  }

  private handleConnection(client: Socket): void {
    let buffer = '';

    client.on('data', (chunk) => {
      buffer += chunk.toString();
    });

    client.on('end', () => {
      if (!buffer.trim()) return;

      let event: HookEvent;
      try {
        event = JSON.parse(buffer);
      } catch {
        log.warn('invalid JSON from hook', { data: buffer.substring(0, 200) });
        return;
      }

      log.debug('hook event received', {
        sessionId: event.session_id,
        event: event.event,
        status: event.status,
      });

      // Process the event into session state
      this.sessionStore.processHookEvent(event);

      // For permission requests, keep the socket open
      if (event.status === 'waiting_for_approval') {
        const session = this.sessionStore.getSession(event.session_id);
        const lastPermission = session?.pendingPermissions.at(-1);
        if (lastPermission) {
          this.pendingSockets.set(lastPermission.toolUseId, {
            sessionId: event.session_id,
            toolUseId: lastPermission.toolUseId,
            socket: client,
          });
          log.debug('holding socket for permission', {
            toolUseId: lastPermission.toolUseId,
          });
          // Don't destroy the socket — we need it for the response
          return;
        }
      }
    });

    client.on('error', (err) => {
      log.debug('client socket error', { error: String(err) });
    });
  }
}
```

- [ ] **Step 2: Run typecheck**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/main/copilot/socket-server.ts
git commit -m "feat(copilot): add Unix socket server for hook communication"
```

---

### Task 5: Hook Installer (Main Process)

**Files:**
- Create: `src/main/copilot/hook-installer.ts`

- [ ] **Step 1: Create the hook installer**

Create `src/main/copilot/hook-installer.ts`:

```typescript
import { readFileSync, writeFileSync, copyFileSync, existsSync, mkdirSync, chmodSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { execFileSync } from 'child_process';
import { createLogger } from '../logger';

const log = createLogger('copilot:hooks');

const CLAUDE_DIR = join(homedir(), '.claude');
const HOOKS_DIR = join(CLAUDE_DIR, 'hooks');
const SETTINGS_PATH = join(CLAUDE_DIR, 'settings.json');
const HOOK_SCRIPT_NAME = 'fleet-copilot.py';
const HOOK_DEST = join(HOOKS_DIR, HOOK_SCRIPT_NAME);

/** Detect python3 binary path */
function detectPython(): string {
  for (const bin of ['python3', 'python']) {
    try {
      execFileSync('which', [bin], { encoding: 'utf-8' });
      return bin;
    } catch {
      // not found
    }
  }
  return 'python3'; // fallback
}

function makeHookCommand(python: string): string {
  return `${python} ${HOOK_DEST}`;
}

type HookEntry = {
  matcher?: string;
  hooks: { type: string; command: string; timeout?: number }[];
};

type ClaudeSettings = {
  hooks?: Record<string, HookEntry[]>;
  [key: string]: unknown;
};

/** Build the hook entries to merge into settings.json */
function buildHookEntries(command: string): Record<string, HookEntry[]> {
  const simpleHook = (timeout?: number): HookEntry => ({
    hooks: [{ type: 'command', command, ...(timeout != null ? { timeout } : {}) }],
  });

  const matcherHook = (matcher: string, timeout?: number): HookEntry => ({
    matcher,
    hooks: [{ type: 'command', command, ...(timeout != null ? { timeout } : {}) }],
  });

  return {
    UserPromptSubmit: [simpleHook()],
    PreToolUse: [matcherHook('*')],
    PostToolUse: [matcherHook('*')],
    PermissionRequest: [matcherHook('*', 86400)],
    Notification: [matcherHook('*')],
    Stop: [simpleHook()],
    SubagentStop: [simpleHook()],
    SessionStart: [simpleHook()],
    SessionEnd: [simpleHook()],
    PreCompact: [matcherHook('auto'), matcherHook('manual')],
  };
}

/** Check if our hook is already registered for a given event */
function hasFleetHook(entries: HookEntry[]): boolean {
  return entries.some((entry) =>
    entry.hooks.some((h) => h.command.includes(HOOK_SCRIPT_NAME))
  );
}

export function getHookScriptSourcePath(): string {
  // In packaged app, hooks/ is in resources. In dev, it's at project root.
  const devPath = join(process.cwd(), 'hooks', HOOK_SCRIPT_NAME);
  if (existsSync(devPath)) return devPath;

  // Packaged: check resources directory
  const resourcesPath = join(process.resourcesPath ?? '', 'hooks', HOOK_SCRIPT_NAME);
  if (existsSync(resourcesPath)) return resourcesPath;

  // Fallback: try relative to __dirname equivalent
  const fallback = join(import.meta.dirname ?? '', '../../hooks', HOOK_SCRIPT_NAME);
  return fallback;
}

export function isInstalled(): boolean {
  if (!existsSync(HOOK_DEST)) return false;
  if (!existsSync(SETTINGS_PATH)) return false;

  try {
    const settings: ClaudeSettings = JSON.parse(readFileSync(SETTINGS_PATH, 'utf-8'));
    const hooks = settings.hooks ?? {};
    return 'SessionStart' in hooks && hasFleetHook(hooks['SessionStart'] ?? []);
  } catch {
    return false;
  }
}

export function install(): void {
  log.info('installing hooks');

  // Ensure directories
  if (!existsSync(HOOKS_DIR)) mkdirSync(HOOKS_DIR, { recursive: true });

  // Copy Python script
  const source = getHookScriptSourcePath();
  if (!existsSync(source)) {
    log.error('hook script source not found', { source });
    throw new Error(`Hook script not found: ${source}`);
  }
  copyFileSync(source, HOOK_DEST);
  chmodSync(HOOK_DEST, 0o755);
  log.info('hook script installed', { dest: HOOK_DEST });

  // Merge into settings.json
  let settings: ClaudeSettings = {};
  if (existsSync(SETTINGS_PATH)) {
    try {
      settings = JSON.parse(readFileSync(SETTINGS_PATH, 'utf-8'));
    } catch {
      log.warn('failed to parse existing settings.json, starting fresh');
    }
  }

  const python = detectPython();
  const command = makeHookCommand(python);
  const newEntries = buildHookEntries(command);

  const existingHooks = settings.hooks ?? {};

  for (const [eventName, entries] of Object.entries(newEntries)) {
    const existing = existingHooks[eventName] ?? [];
    // Only add if not already present
    if (!hasFleetHook(existing)) {
      existingHooks[eventName] = [...existing, ...entries];
    }
  }

  settings.hooks = existingHooks;
  writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2), 'utf-8');
  log.info('settings.json updated');
}

export function uninstall(): void {
  log.info('uninstalling hooks');

  // Remove Python script
  if (existsSync(HOOK_DEST)) {
    try {
      const { unlinkSync } = require('fs');
      unlinkSync(HOOK_DEST);
    } catch {
      log.warn('failed to remove hook script');
    }
  }

  // Remove our entries from settings.json
  if (!existsSync(SETTINGS_PATH)) return;

  try {
    const settings: ClaudeSettings = JSON.parse(readFileSync(SETTINGS_PATH, 'utf-8'));
    const hooks = settings.hooks ?? {};

    for (const eventName of Object.keys(hooks)) {
      hooks[eventName] = (hooks[eventName] ?? []).filter(
        (entry) => !entry.hooks.some((h) => h.command.includes(HOOK_SCRIPT_NAME))
      );
      if (hooks[eventName].length === 0) {
        delete hooks[eventName];
      }
    }

    settings.hooks = hooks;
    writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2), 'utf-8');
    log.info('settings.json cleaned');
  } catch {
    log.warn('failed to clean settings.json');
  }
}
```

- [ ] **Step 2: Fix the uninstall unlinkSync import**

The `uninstall` function has a `require('fs')` which should use the top-level `import`. Replace the `try` block inside `if (existsSync(HOOK_DEST))` with:

```typescript
  if (existsSync(HOOK_DEST)) {
    try {
      const fs = await import('fs');
      fs.unlinkSync(HOOK_DEST);
    } catch {
      log.warn('failed to remove hook script');
    }
  }
```

Actually, `unlinkSync` is already imported at the top. Just use it directly:

```typescript
import { readFileSync, writeFileSync, copyFileSync, existsSync, mkdirSync, chmodSync, unlinkSync } from 'fs';
```

And in `uninstall()`:

```typescript
  if (existsSync(HOOK_DEST)) {
    try {
      unlinkSync(HOOK_DEST);
    } catch {
      log.warn('failed to remove hook script');
    }
  }
```

- [ ] **Step 3: Run typecheck**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/main/copilot/hook-installer.ts
git commit -m "feat(copilot): add hook installer for ~/.claude/ integration"
```

---

### Task 6: Copilot Window (Main Process)

**Files:**
- Create: `src/main/copilot/copilot-window.ts`

- [ ] **Step 1: Create the copilot window manager**

Create `src/main/copilot/copilot-window.ts`:

```typescript
import { BrowserWindow, screen } from 'electron';
import { existsSync } from 'fs';
import { fileURLToPath } from 'url';
import Store from 'electron-store';
import { createLogger } from '../logger';
import type { CopilotPosition } from '../../shared/types';

const log = createLogger('copilot:window');

const SPRITE_SIZE = 48;
const EXPANDED_WIDTH = 350;
const EXPANDED_HEIGHT = 500;

type CopilotWindowStore = {
  position: CopilotPosition | null;
};

export class CopilotWindow {
  private win: BrowserWindow | null = null;
  private positionStore: Store<CopilotWindowStore>;

  constructor() {
    this.positionStore = new Store<CopilotWindowStore>({
      name: 'fleet-copilot-position',
      defaults: { position: null },
    });
  }

  getWindow(): BrowserWindow | null {
    return this.win;
  }

  create(): void {
    if (this.win && !this.win.isDestroyed()) {
      this.win.focus();
      return;
    }

    const saved = this.positionStore.get('position');
    const { x, y } = this.resolvePosition(saved);

    const preloadPathJs = fileURLToPath(new URL('../preload/copilot.js', import.meta.url));
    const preloadPathMjs = fileURLToPath(new URL('../preload/copilot.mjs', import.meta.url));
    const preloadPath = existsSync(preloadPathJs) ? preloadPathJs : preloadPathMjs;

    this.win = new BrowserWindow({
      width: EXPANDED_WIDTH,
      height: EXPANDED_HEIGHT,
      x,
      y,
      frame: false,
      transparent: true,
      hasShadow: false,
      alwaysOnTop: true,
      focusable: false,
      skipTaskbar: true,
      resizable: false,
      webPreferences: {
        preload: preloadPath,
        contextIsolation: true,
        sandbox: false,
        nodeIntegration: false,
      },
    });

    this.win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    // Start with just the sprite size, renderer will resize when expanding
    this.win.setContentSize(SPRITE_SIZE, SPRITE_SIZE);
    this.win.setIgnoreMouseEvents(false);

    if (process.env.ELECTRON_RENDERER_URL) {
      // Dev: copilot renderer served on a different port or path
      void this.win.loadURL(`${process.env.ELECTRON_RENDERER_URL}/copilot/`);
    } else {
      void this.win.loadFile(
        fileURLToPath(new URL('../renderer/copilot/index.html', import.meta.url))
      );
    }

    this.win.on('closed', () => {
      this.win = null;
    });

    log.info('copilot window created', { x, y });
  }

  destroy(): void {
    if (this.win && !this.win.isDestroyed()) {
      this.win.close();
    }
    this.win = null;
  }

  setPosition(x: number, y: number): void {
    if (this.win && !this.win.isDestroyed()) {
      this.win.setPosition(Math.round(x), Math.round(y));
    }
    const display = screen.getDisplayNearestPoint({ x, y });
    this.positionStore.set('position', { x, y, displayId: display.id });
  }

  getPosition(): CopilotPosition | null {
    return this.positionStore.get('position');
  }

  /** Resize the window for expanded/collapsed state */
  setExpanded(expanded: boolean): void {
    if (!this.win || this.win.isDestroyed()) return;
    if (expanded) {
      this.win.setContentSize(EXPANDED_WIDTH, EXPANDED_HEIGHT);
      this.win.setFocusable(true);
    } else {
      this.win.setContentSize(SPRITE_SIZE, SPRITE_SIZE);
      this.win.setFocusable(false);
    }
  }

  /** Send data to the copilot renderer */
  send(channel: string, ...args: unknown[]): void {
    if (this.win && !this.win.isDestroyed()) {
      this.win.webContents.send(channel, ...args);
    }
  }

  private resolvePosition(saved: CopilotPosition | null): { x: number; y: number } {
    if (saved) {
      // Verify the saved position is still on a valid display
      const displays = screen.getAllDisplays();
      const targetDisplay = displays.find((d) => d.id === saved.displayId);
      if (targetDisplay) {
        const { x: dx, y: dy, width, height } = targetDisplay.bounds;
        if (
          saved.x >= dx &&
          saved.x < dx + width &&
          saved.y >= dy &&
          saved.y < dy + height
        ) {
          return { x: saved.x, y: saved.y };
        }
      }
    }

    // Default: top-right of primary display
    const primary = screen.getPrimaryDisplay();
    return {
      x: primary.bounds.x + primary.bounds.width - SPRITE_SIZE - 20,
      y: primary.bounds.y + 40,
    };
  }
}
```

- [ ] **Step 2: Run typecheck**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/main/copilot/copilot-window.ts
git commit -m "feat(copilot): add copilot window manager with position persistence"
```

---

### Task 7: Copilot IPC Handlers (Main Process)

**Files:**
- Create: `src/main/copilot/ipc-handlers.ts`

- [ ] **Step 1: Create copilot IPC handlers**

Create `src/main/copilot/ipc-handlers.ts`:

```typescript
import { ipcMain } from 'electron';
import { IPC_CHANNELS } from '../../shared/constants';
import { createLogger } from '../logger';
import type { CopilotSessionStore } from './session-store';
import type { CopilotSocketServer } from './socket-server';
import type { CopilotWindow } from './copilot-window';
import type { SettingsStore } from '../settings-store';
import * as hookInstaller from './hook-installer';

const log = createLogger('copilot:ipc');

export function registerCopilotIpcHandlers(
  sessionStore: CopilotSessionStore,
  socketServer: CopilotSocketServer,
  copilotWindow: CopilotWindow,
  settingsStore: SettingsStore
): void {
  ipcMain.handle(IPC_CHANNELS.COPILOT_SESSIONS, () => {
    return sessionStore.getSessions();
  });

  ipcMain.handle(
    IPC_CHANNELS.COPILOT_RESPOND_PERMISSION,
    (_event, args: { toolUseId: string; decision: 'allow' | 'deny'; reason?: string }) => {
      log.info('permission response', { toolUseId: args.toolUseId, decision: args.decision });
      return socketServer.respondToPermission(args.toolUseId, args.decision, args.reason);
    }
  );

  ipcMain.handle(IPC_CHANNELS.COPILOT_GET_SETTINGS, () => {
    return settingsStore.get().copilot;
  });

  ipcMain.handle(
    IPC_CHANNELS.COPILOT_SET_SETTINGS,
    (_event, partial: Record<string, unknown>) => {
      settingsStore.set({ copilot: { ...settingsStore.get().copilot, ...partial } });
    }
  );

  ipcMain.handle(IPC_CHANNELS.COPILOT_INSTALL_HOOKS, () => {
    hookInstaller.install();
    return true;
  });

  ipcMain.handle(IPC_CHANNELS.COPILOT_UNINSTALL_HOOKS, () => {
    hookInstaller.uninstall();
    return true;
  });

  ipcMain.handle(IPC_CHANNELS.COPILOT_HOOK_STATUS, () => {
    return hookInstaller.isInstalled();
  });

  ipcMain.handle(IPC_CHANNELS.COPILOT_POSITION_GET, () => {
    return copilotWindow.getPosition();
  });

  ipcMain.handle(
    IPC_CHANNELS.COPILOT_POSITION_SET,
    (_event, pos: { x: number; y: number }) => {
      copilotWindow.setPosition(pos.x, pos.y);
    }
  );

  ipcMain.on('copilot:set-expanded', (_event, expanded: boolean) => {
    copilotWindow.setExpanded(expanded);
  });

  log.info('IPC handlers registered');
}
```

- [ ] **Step 2: Run typecheck**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/main/copilot/ipc-handlers.ts
git commit -m "feat(copilot): add IPC handlers for renderer communication"
```

---

### Task 8: Copilot Orchestrator (Main Process)

**Files:**
- Create: `src/main/copilot/index.ts`
- Modify: `src/main/index.ts`

- [ ] **Step 1: Create the copilot orchestrator**

Create `src/main/copilot/index.ts`:

```typescript
import { createLogger } from '../logger';
import { CopilotSessionStore } from './session-store';
import { CopilotSocketServer } from './socket-server';
import { CopilotWindow } from './copilot-window';
import { registerCopilotIpcHandlers } from './ipc-handlers';
import * as hookInstaller from './hook-installer';
import type { SettingsStore } from '../settings-store';
import { IPC_CHANNELS } from '../../shared/constants';

const log = createLogger('copilot');

let sessionStore: CopilotSessionStore | null = null;
let socketServer: CopilotSocketServer | null = null;
let copilotWindow: CopilotWindow | null = null;

export async function initCopilot(settingsStore: SettingsStore): Promise<void> {
  if (process.platform !== 'darwin') {
    log.info('copilot disabled: not macOS');
    return;
  }

  const settings = settingsStore.get();
  if (!settings.copilot.enabled) {
    log.info('copilot disabled by settings');
    // Still register IPC so the settings UI can enable it
    sessionStore = new CopilotSessionStore();
    socketServer = new CopilotSocketServer(sessionStore);
    copilotWindow = new CopilotWindow();
    registerCopilotIpcHandlers(sessionStore, socketServer, copilotWindow, settingsStore);
    return;
  }

  await startCopilot(settingsStore);
}

export async function startCopilot(settingsStore: SettingsStore): Promise<void> {
  if (sessionStore && socketServer && copilotWindow) {
    // Already have instances, just start services
  } else {
    sessionStore = new CopilotSessionStore();
    socketServer = new CopilotSocketServer(sessionStore);
    copilotWindow = new CopilotWindow();
    registerCopilotIpcHandlers(sessionStore, socketServer, copilotWindow, settingsStore);
  }

  // Push session updates to the copilot window
  sessionStore.setOnChange(() => {
    copilotWindow?.send(IPC_CHANNELS.COPILOT_SESSIONS, sessionStore!.getSessions());
  });

  // Install hooks if not already present
  if (!hookInstaller.isInstalled()) {
    try {
      hookInstaller.install();
    } catch (err) {
      log.error('failed to install hooks', { error: String(err) });
    }
  }

  // Start socket server
  try {
    await socketServer.start();
  } catch (err) {
    log.error('failed to start socket server', { error: String(err) });
    return;
  }

  // Create the spaceship window
  copilotWindow.create();

  log.info('copilot started');
}

export async function stopCopilot(): Promise<void> {
  if (socketServer) {
    await socketServer.stop();
  }
  if (copilotWindow) {
    copilotWindow.destroy();
  }
  log.info('copilot stopped');
}
```

- [ ] **Step 2: Wire copilot into Fleet's main startup**

In `src/main/index.ts`, add the import at the top with other imports:

```typescript
import { initCopilot, stopCopilot } from './copilot/index';
```

In the `app.whenReady()` block, after the socket supervisor start and other service init, add:

```typescript
    // Start copilot (macOS only, gated internally)
    await initCopilot(settingsStore);
```

In the `shutdownAll()` function, add before the existing cleanup:

```typescript
  await stopCopilot();
```

- [ ] **Step 3: Run typecheck**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/main/copilot/index.ts src/main/index.ts
git commit -m "feat(copilot): add orchestrator and wire into Fleet startup"
```

---

### Task 9: Copilot Preload Bridge

**Files:**
- Create: `src/preload/copilot.ts`

- [ ] **Step 1: Create copilot preload script**

Create `src/preload/copilot.ts`:

```typescript
import { contextBridge, ipcRenderer } from 'electron';
import { IPC_CHANNELS } from '../shared/ipc-channels';
import type {
  CopilotSession,
  CopilotSettings,
  CopilotPosition,
} from '../shared/types';

const copilotApi = {
  getSessions: (): Promise<CopilotSession[]> =>
    ipcRenderer.invoke(IPC_CHANNELS.COPILOT_SESSIONS),

  onSessions: (cb: (sessions: CopilotSession[]) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, sessions: CopilotSession[]): void => {
      cb(sessions);
    };
    ipcRenderer.on(IPC_CHANNELS.COPILOT_SESSIONS, handler);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.COPILOT_SESSIONS, handler);
  },

  respondPermission: (
    toolUseId: string,
    decision: 'allow' | 'deny',
    reason?: string
  ): Promise<boolean> =>
    ipcRenderer.invoke(IPC_CHANNELS.COPILOT_RESPOND_PERMISSION, {
      toolUseId,
      decision,
      reason,
    }),

  getSettings: (): Promise<CopilotSettings> =>
    ipcRenderer.invoke(IPC_CHANNELS.COPILOT_GET_SETTINGS),

  setSettings: (partial: Partial<CopilotSettings>): Promise<void> =>
    ipcRenderer.invoke(IPC_CHANNELS.COPILOT_SET_SETTINGS, partial),

  installHooks: (): Promise<boolean> =>
    ipcRenderer.invoke(IPC_CHANNELS.COPILOT_INSTALL_HOOKS),

  uninstallHooks: (): Promise<boolean> =>
    ipcRenderer.invoke(IPC_CHANNELS.COPILOT_UNINSTALL_HOOKS),

  hookStatus: (): Promise<boolean> =>
    ipcRenderer.invoke(IPC_CHANNELS.COPILOT_HOOK_STATUS),

  getPosition: (): Promise<CopilotPosition | null> =>
    ipcRenderer.invoke(IPC_CHANNELS.COPILOT_POSITION_GET),

  setPosition: (x: number, y: number): Promise<void> =>
    ipcRenderer.invoke(IPC_CHANNELS.COPILOT_POSITION_SET, { x, y }),

  setExpanded: (expanded: boolean): void =>
    ipcRenderer.send('copilot:set-expanded', expanded),
};

contextBridge.exposeInMainWorld('copilot', copilotApi);

export type CopilotApi = typeof copilotApi;
```

- [ ] **Step 2: Add preload to build config**

In `electron.vite.config.ts`, update the preload section to include both preloads:

```typescript
  preload: {
    build: {
      rollupOptions: {
        input: {
          index: 'src/preload/index.ts',
          copilot: 'src/preload/copilot.ts',
        },
        output: { format: 'cjs' }
      }
    }
  },
```

- [ ] **Step 3: Run typecheck**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/preload/copilot.ts electron.vite.config.ts
git commit -m "feat(copilot): add preload bridge and build config"
```

---

### Task 10: Copilot Renderer Entry Point

**Files:**
- Create: `src/renderer/copilot/index.html`
- Create: `src/renderer/copilot/src/main.tsx`
- Create: `src/renderer/copilot/src/copilot-logger.ts`
- Modify: `electron.vite.config.ts`

- [ ] **Step 1: Create the copilot HTML entry**

Create `src/renderer/copilot/index.html`:

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Fleet Copilot</title>
    <style>
      /* Transparent background for the spaceship overlay */
      html, body, #root {
        margin: 0;
        padding: 0;
        background: transparent;
        overflow: hidden;
      }
    </style>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="./src/main.tsx"></script>
  </body>
</html>
```

- [ ] **Step 2: Create the copilot logger**

Create `src/renderer/copilot/src/copilot-logger.ts`:

```typescript
const PREFIX = '%c[copilot]';
const STYLE = 'color: #a78bfa; font-weight: bold';

export function createLogger(tag: string) {
  const fullPrefix = `${PREFIX}%c[${tag}]`;
  const tagStyle = 'color: #60a5fa';
  return {
    debug: (msg: string, meta?: Record<string, unknown>) =>
      console.debug(fullPrefix, STYLE, tagStyle, msg, meta ?? ''),
    info: (msg: string, meta?: Record<string, unknown>) =>
      console.info(fullPrefix, STYLE, tagStyle, msg, meta ?? ''),
    warn: (msg: string, meta?: Record<string, unknown>) =>
      console.warn(fullPrefix, STYLE, tagStyle, msg, meta ?? ''),
    error: (msg: string, meta?: Record<string, unknown>) =>
      console.error(fullPrefix, STYLE, tagStyle, msg, meta ?? ''),
  };
}
```

- [ ] **Step 3: Create the copilot React mount**

Create `src/renderer/copilot/src/main.tsx`:

```tsx
import { createRoot } from 'react-dom/client';
import { App } from './App';

const root = document.getElementById('root')!;
createRoot(root).render(<App />);
```

- [ ] **Step 4: Add copilot renderer to build config**

In `electron.vite.config.ts`, update the renderer section to support multiple pages. The full config should look like:

```typescript
import { resolve } from 'path';
import { defineConfig } from 'electron-vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  main: {
    build: {
      rollupOptions: {
        input: {
          index: 'src/main/index.ts',
          'fleet-cli': 'src/main/fleet-cli.ts'
        },
        output: { format: 'es' }
      }
    }
  },
  preload: {
    build: {
      rollupOptions: {
        input: {
          index: 'src/preload/index.ts',
          copilot: 'src/preload/copilot.ts',
        },
        output: { format: 'cjs' }
      }
    }
  },
  renderer: {
    resolve: {
      alias: {
        '@renderer': resolve('src/renderer/src'),
        '@copilot': resolve('src/renderer/copilot/src'),
      }
    },
    build: {
      rollupOptions: {
        input: {
          index: 'src/renderer/index.html',
          copilot: 'src/renderer/copilot/index.html',
        }
      }
    },
    plugins: [react(), tailwindcss()]
  }
});
```

- [ ] **Step 5: Run typecheck**

Run: `npm run typecheck`
Expected: PASS (App.tsx doesn't exist yet, but main.tsx should be fine or we may get an error — that's expected, we'll create App.tsx next)

- [ ] **Step 6: Commit**

```bash
git add src/renderer/copilot/ electron.vite.config.ts
git commit -m "feat(copilot): add renderer entry point, logger, and build config"
```

---

### Task 11: Copilot Zustand Store

**Files:**
- Create: `src/renderer/copilot/src/store/copilot-store.ts`

- [ ] **Step 1: Create the copilot store**

Create `src/renderer/copilot/src/store/copilot-store.ts`:

```typescript
import { create } from 'zustand';
import { createLogger } from '../copilot-logger';
import type {
  CopilotSession,
  CopilotSettings,
  CopilotPosition,
} from '../../../../shared/types';

const log = createLogger('store');

declare global {
  interface Window {
    copilot: import('../../../../preload/copilot').CopilotApi;
  }
}

type CopilotView = 'sessions' | 'detail' | 'settings';

type CopilotStoreState = {
  // UI state
  expanded: boolean;
  view: CopilotView;
  selectedSessionId: string | null;

  // Data
  sessions: CopilotSession[];
  settings: CopilotSettings | null;
  hookInstalled: boolean;

  // Actions
  setExpanded: (expanded: boolean) => void;
  toggleExpanded: () => void;
  setView: (view: CopilotView) => void;
  selectSession: (sessionId: string) => void;
  backToList: () => void;

  // Data actions
  setSessions: (sessions: CopilotSession[]) => void;
  loadSettings: () => Promise<void>;
  updateSettings: (partial: Partial<CopilotSettings>) => Promise<void>;
  respondPermission: (toolUseId: string, decision: 'allow' | 'deny', reason?: string) => Promise<void>;
  checkHookStatus: () => Promise<void>;
  installHooks: () => Promise<void>;
  uninstallHooks: () => Promise<void>;
};

export const useCopilotStore = create<CopilotStoreState>((set, get) => ({
  expanded: false,
  view: 'sessions',
  selectedSessionId: null,

  sessions: [],
  settings: null,
  hookInstalled: false,

  setExpanded: (expanded) => {
    log.debug('setExpanded', { expanded });
    set({ expanded });
    window.copilot.setExpanded(expanded);
  },

  toggleExpanded: () => {
    const next = !get().expanded;
    log.debug('toggleExpanded', { next });
    set({ expanded: next, view: next ? get().view : 'sessions' });
    window.copilot.setExpanded(next);
  },

  setView: (view) => set({ view }),

  selectSession: (sessionId) => {
    log.debug('selectSession', { sessionId });
    set({ selectedSessionId: sessionId, view: 'detail' });
  },

  backToList: () => set({ view: 'sessions', selectedSessionId: null }),

  setSessions: (sessions) => set({ sessions }),

  loadSettings: async () => {
    const settings = await window.copilot.getSettings();
    const hookInstalled = await window.copilot.hookStatus();
    log.debug('loadSettings', { settings, hookInstalled });
    set({ settings, hookInstalled });
  },

  updateSettings: async (partial) => {
    log.debug('updateSettings', { keys: Object.keys(partial) });
    await window.copilot.setSettings(partial);
    const settings = await window.copilot.getSettings();
    set({ settings });
  },

  respondPermission: async (toolUseId, decision, reason) => {
    log.info('respondPermission', { toolUseId, decision });
    await window.copilot.respondPermission(toolUseId, decision, reason);
  },

  checkHookStatus: async () => {
    const hookInstalled = await window.copilot.hookStatus();
    set({ hookInstalled });
  },

  installHooks: async () => {
    await window.copilot.installHooks();
    set({ hookInstalled: true });
  },

  uninstallHooks: async () => {
    await window.copilot.uninstallHooks();
    set({ hookInstalled: false });
  },
}));
```

- [ ] **Step 2: Run typecheck**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/renderer/copilot/src/store/copilot-store.ts
git commit -m "feat(copilot): add Zustand store for copilot UI state"
```

---

### Task 12: Spaceship Sprite Component

**Files:**
- Create: `src/renderer/copilot/src/components/SpaceshipSprite.tsx`

- [ ] **Step 1: Create the spaceship sprite component**

Create `src/renderer/copilot/src/components/SpaceshipSprite.tsx`:

```tsx
import { useRef, useCallback, useEffect, useState } from 'react';
import { useCopilotStore } from '../store/copilot-store';

const SPRITE_SIZE = 48;
const DRAG_THRESHOLD = 4; // px before considering it a drag vs click

type SpriteState = 'idle' | 'processing' | 'permission' | 'complete';

function useSpriteState(): SpriteState {
  const sessions = useCopilotStore((s) => s.sessions);

  if (sessions.length === 0) return 'idle';

  // Priority: permission > processing > idle
  const hasPermission = sessions.some((s) => s.pendingPermissions.length > 0);
  if (hasPermission) return 'permission';

  const hasProcessing = sessions.some((s) => s.phase === 'processing' || s.phase === 'compacting');
  if (hasProcessing) return 'processing';

  return 'idle';
}

export function SpaceshipSprite(): React.JSX.Element {
  const spriteState = useSpriteState();
  const toggleExpanded = useCopilotStore((s) => s.toggleExpanded);
  const expanded = useCopilotStore((s) => s.expanded);

  const isDragging = useRef(false);
  const dragStartPos = useRef({ x: 0, y: 0 });
  const windowStartPos = useRef({ x: 0, y: 0 });
  const hasMoved = useRef(false);

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    isDragging.current = true;
    hasMoved.current = false;
    dragStartPos.current = { x: e.screenX, y: e.screenY };

    // Get current window position
    window.copilot.getPosition().then((pos) => {
      if (pos) {
        windowStartPos.current = { x: pos.x, y: pos.y };
      }
    });

    const handleMouseMove = (ev: MouseEvent): void => {
      if (!isDragging.current) return;
      const dx = ev.screenX - dragStartPos.current.x;
      const dy = ev.screenY - dragStartPos.current.y;

      if (Math.abs(dx) > DRAG_THRESHOLD || Math.abs(dy) > DRAG_THRESHOLD) {
        hasMoved.current = true;
        window.copilot.setPosition(
          windowStartPos.current.x + dx,
          windowStartPos.current.y + dy
        );
      }
    };

    const handleMouseUp = (): void => {
      isDragging.current = false;
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);

      if (!hasMoved.current) {
        toggleExpanded();
      }
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
  }, [toggleExpanded]);

  // Sprite animation class based on state
  const animationClass = {
    idle: 'animate-bob',
    processing: 'animate-thrust',
    permission: 'animate-pulse-amber',
    complete: 'animate-flash-green',
  }[spriteState];

  return (
    <div
      className={`w-[${SPRITE_SIZE}px] h-[${SPRITE_SIZE}px] cursor-pointer select-none ${animationClass}`}
      onMouseDown={handleMouseDown}
      style={{
        width: SPRITE_SIZE,
        height: SPRITE_SIZE,
        // Placeholder: solid square until real sprite sheet is ready
        // Replace with background-image sprite sheet when available
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      {/* Placeholder emoji until sprite sheet is ready */}
      <span style={{ fontSize: 32, lineHeight: 1 }}>🚀</span>
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add src/renderer/copilot/src/components/SpaceshipSprite.tsx
git commit -m "feat(copilot): add spaceship sprite component with drag and animation states"
```

---

### Task 13: Session List Component

**Files:**
- Create: `src/renderer/copilot/src/components/SessionList.tsx`

- [ ] **Step 1: Create the session list component**

Create `src/renderer/copilot/src/components/SessionList.tsx`:

```tsx
import { useCopilotStore } from '../store/copilot-store';
import type { CopilotSession } from '../../../../shared/types';

function phaseIcon(session: CopilotSession): string {
  if (session.pendingPermissions.length > 0) return '⚠';
  switch (session.phase) {
    case 'processing':
    case 'compacting':
      return '⟳';
    case 'waitingForInput':
      return '●';
    case 'waitingForApproval':
      return '⚠';
    case 'ended':
      return '✓';
    default:
      return '○';
  }
}

function phaseColor(session: CopilotSession): string {
  if (session.pendingPermissions.length > 0) return 'text-amber-400';
  switch (session.phase) {
    case 'processing':
    case 'compacting':
      return 'text-blue-400';
    case 'waitingForInput':
      return 'text-green-400';
    case 'ended':
      return 'text-neutral-500';
    default:
      return 'text-neutral-400';
  }
}

function elapsed(timestamp: number): string {
  const seconds = Math.floor((Date.now() - timestamp) / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

/** Sort: permission needed > processing > everything else */
function sortSessions(a: CopilotSession, b: CopilotSession): number {
  const priority = (s: CopilotSession): number => {
    if (s.pendingPermissions.length > 0) return 0;
    if (s.phase === 'processing' || s.phase === 'compacting') return 1;
    if (s.phase === 'waitingForInput') return 2;
    return 3;
  };
  return priority(a) - priority(b);
}

export function SessionList(): React.JSX.Element {
  const sessions = useCopilotStore((s) => s.sessions);
  const selectSession = useCopilotStore((s) => s.selectSession);
  const respondPermission = useCopilotStore((s) => s.respondPermission);
  const setView = useCopilotStore((s) => s.setView);

  const sorted = [...sessions].sort(sortSessions);

  return (
    <div className="flex flex-col h-full bg-neutral-900/95 rounded-lg border border-neutral-700 overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-neutral-700">
        <span className="text-xs font-medium text-neutral-300">
          Claude Sessions ({sessions.length})
        </span>
        <button
          onClick={() => setView('settings')}
          className="text-neutral-500 hover:text-neutral-300 text-xs"
        >
          ⚙
        </button>
      </div>

      {/* Session list */}
      <div className="flex-1 overflow-y-auto">
        {sorted.length === 0 ? (
          <div className="flex items-center justify-center h-full text-neutral-500 text-xs px-4 text-center">
            No active Claude Code sessions.
            <br />
            Start a session to see it here.
          </div>
        ) : (
          sorted.map((session) => (
            <div
              key={session.sessionId}
              className="px-3 py-2 border-b border-neutral-800 hover:bg-neutral-800/50 cursor-pointer"
              onClick={() => selectSession(session.sessionId)}
            >
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2 min-w-0">
                  <span className={`text-sm ${phaseColor(session)}`}>
                    {phaseIcon(session)}
                  </span>
                  <span className="text-xs text-neutral-200 truncate">
                    {session.projectName}
                  </span>
                </div>
                <span className="text-[10px] text-neutral-500 ml-2 shrink-0">
                  {elapsed(session.createdAt)}
                </span>
              </div>

              {/* Inline permission actions */}
              {session.pendingPermissions.map((perm) => (
                <div
                  key={perm.toolUseId}
                  className="mt-1 flex items-center gap-1"
                  onClick={(e) => e.stopPropagation()}
                >
                  <span className="text-[10px] text-amber-400 truncate flex-1">
                    {perm.tool.toolName}
                  </span>
                  <button
                    onClick={() => respondPermission(perm.toolUseId, 'allow')}
                    className="px-1.5 py-0.5 text-[10px] bg-green-600/30 text-green-400 rounded hover:bg-green-600/50"
                  >
                    Allow
                  </button>
                  <button
                    onClick={() => respondPermission(perm.toolUseId, 'deny')}
                    className="px-1.5 py-0.5 text-[10px] bg-red-600/30 text-red-400 rounded hover:bg-red-600/50"
                  >
                    Deny
                  </button>
                </div>
              ))}
            </div>
          ))
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add src/renderer/copilot/src/components/SessionList.tsx
git commit -m "feat(copilot): add session list component with permission controls"
```

---

### Task 14: Session Detail Component

**Files:**
- Create: `src/renderer/copilot/src/components/SessionDetail.tsx`

- [ ] **Step 1: Create the session detail component**

Create `src/renderer/copilot/src/components/SessionDetail.tsx`:

```tsx
import { useCopilotStore } from '../store/copilot-store';

export function SessionDetail(): React.JSX.Element | null {
  const selectedSessionId = useCopilotStore((s) => s.selectedSessionId);
  const sessions = useCopilotStore((s) => s.sessions);
  const backToList = useCopilotStore((s) => s.backToList);
  const respondPermission = useCopilotStore((s) => s.respondPermission);

  const session = sessions.find((s) => s.sessionId === selectedSessionId);

  if (!session) {
    return (
      <div className="flex flex-col h-full bg-neutral-900/95 rounded-lg border border-neutral-700">
        <div className="flex items-center px-3 py-2 border-b border-neutral-700">
          <button
            onClick={backToList}
            className="text-xs text-neutral-400 hover:text-neutral-200"
          >
            ← Back
          </button>
        </div>
        <div className="flex-1 flex items-center justify-center text-neutral-500 text-xs">
          Session not found
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full bg-neutral-900/95 rounded-lg border border-neutral-700 overflow-hidden">
      {/* Header */}
      <div className="flex items-center gap-2 px-3 py-2 border-b border-neutral-700">
        <button
          onClick={backToList}
          className="text-xs text-neutral-400 hover:text-neutral-200"
        >
          ←
        </button>
        <span className="text-xs font-medium text-neutral-200 truncate">
          {session.projectName}
        </span>
      </div>

      {/* Session info */}
      <div className="px-3 py-2 border-b border-neutral-800 text-[10px] text-neutral-500">
        <div>CWD: {session.cwd}</div>
        {session.pid && <div>PID: {session.pid}</div>}
        <div>Phase: {session.phase}</div>
      </div>

      {/* Pending permissions */}
      {session.pendingPermissions.length > 0 && (
        <div className="px-3 py-2 border-b border-neutral-800">
          <div className="text-[10px] font-medium text-amber-400 mb-1">
            Pending Permissions
          </div>
          {session.pendingPermissions.map((perm) => (
            <div
              key={perm.toolUseId}
              className="mb-2 p-2 bg-neutral-800/50 rounded border border-amber-500/20"
            >
              <div className="text-xs text-neutral-200 font-medium">
                {perm.tool.toolName}
              </div>
              {Object.keys(perm.tool.toolInput).length > 0 && (
                <pre className="mt-1 text-[10px] text-neutral-400 overflow-x-auto max-h-24 overflow-y-auto">
                  {JSON.stringify(perm.tool.toolInput, null, 2)}
                </pre>
              )}
              <div className="flex gap-1 mt-2">
                <button
                  onClick={() => respondPermission(perm.toolUseId, 'allow')}
                  className="px-2 py-1 text-[10px] bg-green-600/30 text-green-400 rounded hover:bg-green-600/50"
                >
                  Allow
                </button>
                <button
                  onClick={() => respondPermission(perm.toolUseId, 'deny')}
                  className="px-2 py-1 text-[10px] bg-red-600/30 text-red-400 rounded hover:bg-red-600/50"
                >
                  Deny
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Placeholder for chat history — will be wired when JSONL parsing is added */}
      <div className="flex-1 overflow-y-auto px-3 py-2">
        <div className="text-[10px] text-neutral-500 text-center mt-4">
          Chat history will appear here
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add src/renderer/copilot/src/components/SessionDetail.tsx
git commit -m "feat(copilot): add session detail component with permission approval UI"
```

---

### Task 15: Copilot Settings Component

**Files:**
- Create: `src/renderer/copilot/src/components/CopilotSettings.tsx`

- [ ] **Step 1: Create the copilot settings component**

Create `src/renderer/copilot/src/components/CopilotSettings.tsx`:

```tsx
import { useEffect } from 'react';
import { useCopilotStore } from '../store/copilot-store';

const SYSTEM_SOUNDS = [
  'Pop', 'Ping', 'Tink', 'Glass', 'Blow', 'Bottle', 'Frog',
  'Funk', 'Hero', 'Morse', 'Purr', 'Sosumi', 'Submarine', 'Basso',
];

export function CopilotSettings(): React.JSX.Element {
  const settings = useCopilotStore((s) => s.settings);
  const hookInstalled = useCopilotStore((s) => s.hookInstalled);
  const setView = useCopilotStore((s) => s.setView);
  const loadSettings = useCopilotStore((s) => s.loadSettings);
  const updateSettings = useCopilotStore((s) => s.updateSettings);
  const installHooks = useCopilotStore((s) => s.installHooks);
  const uninstallHooks = useCopilotStore((s) => s.uninstallHooks);

  useEffect(() => {
    loadSettings();
  }, [loadSettings]);

  return (
    <div className="flex flex-col h-full bg-neutral-900/95 rounded-lg border border-neutral-700 overflow-hidden">
      {/* Header */}
      <div className="flex items-center gap-2 px-3 py-2 border-b border-neutral-700">
        <button
          onClick={() => setView('sessions')}
          className="text-xs text-neutral-400 hover:text-neutral-200"
        >
          ←
        </button>
        <span className="text-xs font-medium text-neutral-200">Settings</span>
      </div>

      <div className="flex-1 overflow-y-auto px-3 py-2 space-y-3">
        {/* Notification Sound */}
        <div>
          <label className="text-[10px] text-neutral-400 block mb-1">
            Notification Sound
          </label>
          <select
            value={settings?.notificationSound ?? 'Pop'}
            onChange={(e) => updateSettings({ notificationSound: e.target.value })}
            className="w-full text-xs bg-neutral-800 border border-neutral-700 rounded px-2 py-1 text-neutral-200"
          >
            <option value="">None</option>
            {SYSTEM_SOUNDS.map((sound) => (
              <option key={sound} value={sound}>{sound}</option>
            ))}
          </select>
        </div>

        {/* Sprite selector */}
        <div>
          <label className="text-[10px] text-neutral-400 block mb-1">
            Sprite
          </label>
          <div className="text-[10px] text-neutral-500">
            Default spaceship (more sprites coming soon)
          </div>
        </div>

        {/* Hook status */}
        <div>
          <label className="text-[10px] text-neutral-400 block mb-1">
            Claude Code Hooks
          </label>
          <div className="flex items-center gap-2">
            <span className={`text-xs ${hookInstalled ? 'text-green-400' : 'text-red-400'}`}>
              {hookInstalled ? '● Installed' : '● Not installed'}
            </span>
            <button
              onClick={hookInstalled ? uninstallHooks : installHooks}
              className="px-2 py-0.5 text-[10px] bg-neutral-800 border border-neutral-700 rounded hover:bg-neutral-700 text-neutral-300"
            >
              {hookInstalled ? 'Uninstall' : 'Install'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add src/renderer/copilot/src/components/CopilotSettings.tsx
git commit -m "feat(copilot): add copilot settings component"
```

---

### Task 16: Copilot App Root Component

**Files:**
- Create: `src/renderer/copilot/src/App.tsx`
- Create: `src/renderer/copilot/src/index.css`

- [ ] **Step 1: Create the copilot CSS**

Create `src/renderer/copilot/src/index.css`:

```css
@import 'tailwindcss';

/* Sprite animations */
@keyframes bob {
  0%, 100% { transform: translateY(0); }
  50% { transform: translateY(-3px); }
}

@keyframes thrust {
  0%, 100% { transform: translateY(0) scale(1); }
  50% { transform: translateY(-2px) scale(1.05); }
}

@keyframes pulse-amber {
  0%, 100% { filter: drop-shadow(0 0 4px #f59e0b00); }
  50% { filter: drop-shadow(0 0 8px #f59e0b99); }
}

@keyframes flash-green {
  0% { filter: drop-shadow(0 0 0px #22c55e00); }
  50% { filter: drop-shadow(0 0 12px #22c55eff); }
  100% { filter: drop-shadow(0 0 0px #22c55e00); }
}

.animate-bob { animation: bob 2s ease-in-out infinite; }
.animate-thrust { animation: thrust 0.6s ease-in-out infinite; }
.animate-pulse-amber { animation: pulse-amber 1.5s ease-in-out infinite; }
.animate-flash-green { animation: flash-green 1s ease-in-out; }
```

- [ ] **Step 2: Create the copilot App root**

Create `src/renderer/copilot/src/App.tsx`:

```tsx
import { useEffect } from 'react';
import './index.css';
import { useCopilotStore } from './store/copilot-store';
import { SpaceshipSprite } from './components/SpaceshipSprite';
import { SessionList } from './components/SessionList';
import { SessionDetail } from './components/SessionDetail';
import { CopilotSettings } from './components/CopilotSettings';

export function App(): React.JSX.Element {
  const expanded = useCopilotStore((s) => s.expanded);
  const view = useCopilotStore((s) => s.view);
  const setSessions = useCopilotStore((s) => s.setSessions);
  const loadSettings = useCopilotStore((s) => s.loadSettings);
  const setExpanded = useCopilotStore((s) => s.setExpanded);

  // Subscribe to session updates from main process
  useEffect(() => {
    // Initial load
    window.copilot.getSessions().then(setSessions);
    loadSettings();

    // Live updates
    const cleanup = window.copilot.onSessions(setSessions);
    return cleanup;
  }, [setSessions, loadSettings]);

  // Close on Escape
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && expanded) {
        setExpanded(false);
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [expanded, setExpanded]);

  return (
    <div className="relative">
      {/* Spaceship sprite (always visible) */}
      <SpaceshipSprite />

      {/* Expanded panel */}
      {expanded && (
        <div
          className="absolute top-[52px] right-0 w-[350px] h-[450px]"
          style={{ zIndex: 10 }}
        >
          {view === 'sessions' && <SessionList />}
          {view === 'detail' && <SessionDetail />}
          {view === 'settings' && <CopilotSettings />}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 3: Update main.tsx to import CSS**

Update `src/renderer/copilot/src/main.tsx`:

```tsx
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './index.css';

const root = document.getElementById('root')!;
createRoot(root).render(<App />);
```

- [ ] **Step 4: Run typecheck**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 5: Run build**

Run: `npm run build`
Expected: PASS (full build including copilot renderer)

- [ ] **Step 6: Commit**

```bash
git add src/renderer/copilot/src/App.tsx src/renderer/copilot/src/index.css src/renderer/copilot/src/main.tsx
git commit -m "feat(copilot): add copilot App root with view routing and animations"
```

---

### Task 17: Bundle Python Hook in Build

**Files:**
- Modify: `electron-builder.yml` or `package.json` (builder config)

- [ ] **Step 1: Find the electron-builder config**

Check if there's an `electron-builder.yml` or builder config in `package.json`:

Run: `ls electron-builder.yml 2>/dev/null; cat package.json | grep -A5 '"build"'`

- [ ] **Step 2: Add hooks directory to extraResources**

In the electron-builder config (whichever file holds it), add the `hooks/` directory to `extraResources` so it's bundled in the packaged app:

```yaml
extraResources:
  - from: hooks/
    to: hooks/
```

Or if in `package.json`:
```json
"build": {
  "extraResources": [
    { "from": "hooks/", "to": "hooks/" }
  ]
}
```

- [ ] **Step 3: Commit**

```bash
git add electron-builder.yml  # or package.json
git commit -m "build: bundle Python hook script in app resources"
```

---

### Task 18: Add Copilot Toggle to Fleet Settings UI

**Files:**
- Modify: Fleet's existing settings page/component (wherever settings UI lives)

- [ ] **Step 1: Find the settings UI component**

Run: `grep -r "Settings" src/renderer/src/components/ --include="*.tsx" -l` to find the settings page.

- [ ] **Step 2: Add copilot section (macOS only)**

In the settings component, add a section gated by platform check. The preload already exposes `window.fleet.platform`:

```tsx
{window.fleet.platform === 'darwin' && (
  <div className="space-y-2">
    <h3 className="text-sm font-medium text-neutral-200">Copilot</h3>
    <div className="flex items-center justify-between">
      <span className="text-xs text-neutral-400">Enable Claude Code Copilot</span>
      <Switch
        checked={settings.copilot.enabled}
        onCheckedChange={(checked) => updateSettings({ copilot: { ...settings.copilot, enabled: checked } })}
      />
    </div>
    <p className="text-[10px] text-neutral-500">
      Floating spaceship overlay that monitors Claude Code sessions
    </p>
  </div>
)}
```

- [ ] **Step 3: Run typecheck and build**

Run: `npm run typecheck && npm run build`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/renderer/src/components/SettingsPage.tsx  # actual filename may differ
git commit -m "feat(copilot): add copilot toggle to Fleet settings UI (macOS only)"
```

---

### Task 19: Integration Test — Manual Verification

- [ ] **Step 1: Start Fleet in dev mode**

Run: `npm run dev`

- [ ] **Step 2: Verify copilot window appears (if enabled in settings)**

1. Open Fleet settings, enable Copilot
2. Restart Fleet (or implement hot-toggle later)
3. Verify: small spaceship sprite appears at top-right of screen
4. Verify: spaceship is draggable
5. Verify: clicking opens the session panel
6. Verify: Escape closes the panel

- [ ] **Step 3: Test hook installation**

1. In the copilot settings panel, verify hook status
2. Click "Install" if not installed
3. Check `~/.claude/hooks/fleet-copilot.py` exists
4. Check `~/.claude/settings.json` contains fleet-copilot entries

- [ ] **Step 4: Test with a real Claude Code session**

1. Open a terminal (inside Fleet or externally)
2. Run `claude` to start a Claude Code session
3. Verify: session appears in the copilot session list
4. Verify: spaceship animates when Claude is processing
5. If a permission prompt appears: verify amber pulse animation
6. Test approve/deny from the copilot panel

- [ ] **Step 5: Verify non-macOS gate**

If on macOS, verify in code review that all copilot code paths are behind `process.platform === 'darwin'` checks.

- [ ] **Step 6: Final commit with any fixes**

```bash
git add -A
git commit -m "feat(copilot): integration fixes from manual testing"
```

---

## Summary

| Task | Description | Key Files |
|------|-------------|-----------|
| 1 | Shared types, IPC channels, settings | `shared/` |
| 2 | Python hook script | `hooks/fleet-copilot.py` |
| 3 | Session store | `main/copilot/session-store.ts` |
| 4 | Unix socket server | `main/copilot/socket-server.ts` |
| 5 | Hook installer | `main/copilot/hook-installer.ts` |
| 6 | Copilot window | `main/copilot/copilot-window.ts` |
| 7 | IPC handlers | `main/copilot/ipc-handlers.ts` |
| 8 | Orchestrator + wiring | `main/copilot/index.ts` + `main/index.ts` |
| 9 | Preload bridge | `preload/copilot.ts` |
| 10 | Renderer entry point | `renderer/copilot/` |
| 11 | Zustand store | `renderer/copilot/src/store/` |
| 12 | Spaceship sprite | `SpaceshipSprite.tsx` |
| 13 | Session list | `SessionList.tsx` |
| 14 | Session detail | `SessionDetail.tsx` |
| 15 | Copilot settings | `CopilotSettings.tsx` |
| 16 | App root + CSS | `App.tsx` + `index.css` |
| 17 | Build bundling | `electron-builder.yml` |
| 18 | Fleet settings toggle | Settings page |
| 19 | Manual integration test | — |
