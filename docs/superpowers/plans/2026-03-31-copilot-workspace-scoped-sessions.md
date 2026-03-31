# Copilot Workspace-Scoped Sessions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Tag each copilot session with its workspace, add a filter toggle (active workspace vs all), and display workspace names in the session list and detail views.

**Architecture:** The main process resolves workspace ownership by mapping session PIDs to panes to workspaces via the layout store. Active workspace changes are pushed from the main renderer to the copilot window via IPC. The copilot store filters sessions client-side based on a persisted `showAllWorkspaces` setting.

**Tech Stack:** Electron IPC, Zustand (copilot store), React, TypeScript

---

### Task 1: Add workspace fields to CopilotSession and showAllWorkspaces to CopilotSettings

**Files:**
- Modify: `src/shared/types.ts:153-163` (CopilotSession type)
- Modify: `src/shared/types.ts:170-179` (CopilotSettings type)
- Modify: `src/shared/constants.ts:70-79` (DEFAULT_SETTINGS.copilot)

- [ ] **Step 1: Add workspace fields to CopilotSession**

In `src/shared/types.ts`, add `workspaceId` and `workspaceName` to the `CopilotSession` type:

```typescript
export type CopilotSession = {
  sessionId: string;
  cwd: string;
  projectName: string;
  phase: CopilotSessionPhase;
  pid?: number;
  tty?: string;
  workspaceId?: string;
  workspaceName?: string;
  pendingPermissions: CopilotPendingPermission[];
  lastActivity: number;
  createdAt: number;
};
```

- [ ] **Step 2: Add showAllWorkspaces to CopilotSettings**

In `src/shared/types.ts`, add `showAllWorkspaces` to `CopilotSettings`:

```typescript
export type CopilotSettings = {
  enabled: boolean;
  autoEnabled: boolean;
  spriteSheet: string;
  notificationSound: string;
  autoStart: boolean;
  claudeBinaryPath: string;
  claudeConfigDir: string;
  workspaceOverrides: Record<string, CopilotWorkspaceOverride>;
  showAllWorkspaces: boolean;
};
```

- [ ] **Step 3: Add default for showAllWorkspaces**

In `src/shared/constants.ts`, add `showAllWorkspaces: false` to the copilot defaults:

```typescript
  copilot: {
    enabled: false,
    autoEnabled: false,
    spriteSheet: 'officer',
    notificationSound: 'Pop',
    autoStart: false,
    claudeBinaryPath: '',
    claudeConfigDir: '',
    workspaceOverrides: {},
    showAllWorkspaces: false,
  },
```

- [ ] **Step 4: Verify typecheck**

Run: `npm run typecheck`
Expected: Errors in files that create CopilotSession objects without workspace fields — these are optional so should pass cleanly.

- [ ] **Step 5: Commit**

```bash
git add src/shared/types.ts src/shared/constants.ts
git commit -m "feat(copilot): add workspace fields to session type and showAllWorkspaces setting"
```

---

### Task 2: Add workspace lookup to layout store

**Files:**
- Modify: `src/main/layout-store.ts`

- [ ] **Step 1: Add findWorkspaceForPane method**

In `src/main/layout-store.ts`, add a method that searches all workspaces for a pane ID. Add this helper function before the class, and the method inside the class after `list()`:

```typescript
import type { Workspace, Tab, PaneNode } from '../shared/types';

function containsPane(node: PaneNode, paneId: string): boolean {
  if (node.type === 'leaf') return node.id === paneId;
  return containsPane(node.children[0], paneId) || containsPane(node.children[1], paneId);
}
```

Then add the method inside the `LayoutStore` class, after the `list()` method:

```typescript
  findWorkspaceForPane(paneId: string): { workspaceId: string; workspaceName: string } | null {
    const workspaces = this.store.get('workspaces', {});
    for (const ws of Object.values(workspaces)) {
      for (const tab of ws.tabs) {
        if (containsPane(tab.splitRoot, paneId)) {
          return { workspaceId: ws.id, workspaceName: ws.label };
        }
      }
    }
    return null;
  }
```

- [ ] **Step 2: Verify typecheck**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/main/layout-store.ts
git commit -m "feat(copilot): add findWorkspaceForPane to layout store"
```

---

### Task 3: Tag sessions with workspace info in the socket server flow

**Files:**
- Modify: `src/main/copilot/session-store.ts:65-86` (processHookEvent)
- Modify: `src/main/copilot/socket-server.ts:134-175` (handleConnection)
- Modify: `src/main/copilot/ipc-handlers.ts:58-67` (registerCopilotIpcHandlers signature)
- Modify: `src/main/copilot/index.ts:42` (where registerCopilotIpcHandlers is called)

The socket server processes hook events and calls `sessionStore.processHookEvent()`. We need to resolve the workspace from the PID and pass it through. The cleanest approach: give the socket server a workspace resolver callback, and have it pass workspace info to `processHookEvent`.

- [ ] **Step 1: Add workspace info to processHookEvent**

In `src/main/copilot/session-store.ts`, add an optional `workspaceInfo` parameter to `processHookEvent` and use it when creating new sessions:

```typescript
  processHookEvent(
    event: HookEvent,
    workspaceInfo?: { workspaceId: string; workspaceName: string }
  ): void {
    const { session_id, cwd, status, pid, tty, tool, tool_input, tool_use_id } = event;
    let phase = statusToPhase(status);
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
        workspaceId: workspaceInfo?.workspaceId,
        workspaceName: workspaceInfo?.workspaceName,
        pendingPermissions: [],
        lastActivity: now,
        createdAt: now,
      };
      this.sessions.set(session_id, session);
      log.info('session created', { sessionId: session_id, cwd, workspaceId: workspaceInfo?.workspaceId });
    } else if (workspaceInfo && !session.workspaceId) {
      // Backfill workspace info if it wasn't available when session was first created
      session.workspaceId = workspaceInfo.workspaceId;
      session.workspaceName = workspaceInfo.workspaceName;
    }
```

The rest of the method remains unchanged.

- [ ] **Step 2: Add workspace resolver to CopilotSocketServer**

In `src/main/copilot/socket-server.ts`, add a resolver callback. Add a new field and setter:

```typescript
export class CopilotSocketServer {
  private server: Server | null = null;
  private pendingSockets = new Map<string, PendingSocket>();
  private sessionStore: CopilotSessionStore;
  private resolveWorkspace: ((pid: number) => { workspaceId: string; workspaceName: string } | null) | null = null;

  constructor(sessionStore: CopilotSessionStore) {
    this.sessionStore = sessionStore;
  }

  setWorkspaceResolver(
    resolver: (pid: number) => { workspaceId: string; workspaceName: string } | null
  ): void {
    this.resolveWorkspace = resolver;
  }
```

Then in `handleConnection`, after parsing the event JSON, resolve workspace and pass it through. Replace the line `this.sessionStore.processHookEvent(event);` (line 158) with:

```typescript
      const workspaceInfo = event.pid && this.resolveWorkspace
        ? this.resolveWorkspace(event.pid)
        : null;
      this.sessionStore.processHookEvent(event, workspaceInfo ?? undefined);
```

- [ ] **Step 3: Wire up the workspace resolver in registerCopilotIpcHandlers**

In `src/main/copilot/ipc-handlers.ts`, add `layoutStore` to the function parameters. Update the import and signature:

```typescript
import type { LayoutStore } from '../layout-store';
```

Update the `registerCopilotIpcHandlers` function signature to add `layoutStore: LayoutStore`:

```typescript
export function registerCopilotIpcHandlers(
  sessionStore: CopilotSessionStore,
  socketServer: CopilotSocketServer,
  copilotWindow: CopilotWindow,
  settingsStore: SettingsStore,
  conversationReader: ConversationReader,
  ptyManager: PtyManager,
  layoutStore: LayoutStore,
  getMainWindow: () => BrowserWindow | null,
  onSettingsChanged?: () => Promise<void>
): void {
```

Then at the start of the function body, after the existing `log.info('IPC handlers registered')` line... Actually, set up the resolver right at the start of the function, before the IPC handler registrations:

```typescript
  // Wire up workspace resolution: PID → paneId → workspaceId
  socketServer.setWorkspaceResolver((pid: number) => {
    const paneId = findPaneForPid(ptyManager, pid);
    if (!paneId) return null;
    return layoutStore.findWorkspaceForPane(paneId);
  });
```

- [ ] **Step 4: Pass layoutStore in copilot/index.ts**

In `src/main/copilot/index.ts`, update the `initCopilot` function to accept and pass `layoutStore`. Update the import:

```typescript
import type { LayoutStore } from '../layout-store';
```

Update the function signature:

```typescript
export async function initCopilot(
  settingsStore: SettingsStore,
  ptyManager: PtyManager,
  layoutStore: LayoutStore,
  getMainWindow: () => BrowserWindow | null
): Promise<void> {
```

Update the `registerCopilotIpcHandlers` call to pass `layoutStore`:

```typescript
  registerCopilotIpcHandlers(sessionStore, socketServer, copilotWindow, settingsStore, conversationReader, ptyManager, layoutStore, getMainWindow, onCopilotSettingsChanged);
```

- [ ] **Step 5: Update the initCopilot call site in the main app**

Find where `initCopilot` is called (likely in `src/main/index.ts` or similar) and pass `layoutStore`. Search for `initCopilot(` to find the call site.

The call likely looks like:
```typescript
await initCopilot(settingsStore, ptyManager, getMainWindow);
```

Update it to:
```typescript
await initCopilot(settingsStore, ptyManager, layoutStore, getMainWindow);
```

- [ ] **Step 6: Verify typecheck**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add src/main/copilot/session-store.ts src/main/copilot/socket-server.ts src/main/copilot/ipc-handlers.ts src/main/copilot/index.ts src/main/index.ts
git commit -m "feat(copilot): resolve workspace from PID and tag sessions"
```

---

### Task 4: Add active workspace IPC channel and push from main renderer

**Files:**
- Modify: `src/shared/ipc-channels.ts`
- Modify: `src/main/copilot/ipc-handlers.ts`
- Modify: `src/main/copilot/copilot-window.ts`
- Modify: `src/preload/index.ts` (main window preload)
- Modify: `src/preload/copilot.ts` (copilot window preload)
- Modify: `src/renderer/src/store/workspace-store.ts`

We need two IPC channels: one push channel (main renderer → main process → copilot window) for real-time workspace switch notifications, and one pull channel (copilot window → main process) for fetching the current active workspace on init. Electron doesn't allow both `ipcMain.on` and `ipcMain.handle` on the same channel.

- [ ] **Step 1: Add IPC channels**

In `src/shared/ipc-channels.ts`, add two channels after the `COPILOT_SERVICE_STATUS` line:

```typescript
  COPILOT_ACTIVE_WORKSPACE: 'copilot:active-workspace',
  COPILOT_GET_ACTIVE_WORKSPACE: 'copilot:get-active-workspace',
```

- [ ] **Step 2: Add IPC handlers in main process**

In `src/main/copilot/ipc-handlers.ts`, add a variable at the top of `registerCopilotIpcHandlers` to cache the last-known active workspace, then add both handlers inside the function:

```typescript
  let lastActiveWorkspace: { workspaceId: string; workspaceName: string } | null = null;

  // Push: main renderer notifies active workspace change → forward to copilot window
  ipcMain.on(IPC_CHANNELS.COPILOT_ACTIVE_WORKSPACE, (
    _event,
    payload: { workspaceId: string; workspaceName: string }
  ) => {
    lastActiveWorkspace = payload;
    copilotWindow.send(IPC_CHANNELS.COPILOT_ACTIVE_WORKSPACE, payload);
  });

  // Pull: copilot window fetches current active workspace on init
  ipcMain.handle(IPC_CHANNELS.COPILOT_GET_ACTIVE_WORKSPACE, () => {
    return lastActiveWorkspace;
  });
```

- [ ] **Step 3: Expose notifyActiveWorkspace in main preload**

In `src/preload/index.ts`, add to the `fleetApi.copilot` section:

```typescript
    notifyActiveWorkspace: (workspaceId: string, workspaceName: string): void =>
      ipcRenderer.send(IPC_CHANNELS.COPILOT_ACTIVE_WORKSPACE, { workspaceId, workspaceName }),
```

- [ ] **Step 4: Expose onActiveWorkspace and getActiveWorkspace in copilot preload**

In `src/preload/copilot.ts`, add to the `copilotApi` object:

```typescript
  onActiveWorkspace: (
    cb: (payload: { workspaceId: string; workspaceName: string }) => void
  ): (() => void) => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      payload: { workspaceId: string; workspaceName: string }
    ): void => {
      cb(payload);
    };
    ipcRenderer.on(IPC_CHANNELS.COPILOT_ACTIVE_WORKSPACE, handler);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.COPILOT_ACTIVE_WORKSPACE, handler);
  },

  getActiveWorkspace: (): Promise<{ workspaceId: string; workspaceName: string } | null> =>
    ipcRenderer.invoke(IPC_CHANNELS.COPILOT_GET_ACTIVE_WORKSPACE),
```

- [ ] **Step 5: Notify active workspace on switch from main renderer**

In `src/renderer/src/store/workspace-store.ts`, add a Zustand subscription at the bottom of the file (after the store creation) to push workspace changes to the main process:

```typescript
// Notify copilot of workspace changes
let lastWorkspaceId: string | null = null;
useWorkspaceStore.subscribe((state) => {
  const wsId = state.workspace.id;
  if (wsId !== lastWorkspaceId) {
    lastWorkspaceId = wsId;
    window.fleet.copilot?.notifyActiveWorkspace(wsId, state.workspace.label);
  }
});
```

Note: We use `?.` because the copilot API might not be available in all contexts.

- [ ] **Step 6: Verify typecheck**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 8: Commit**

```bash
git add src/shared/ipc-channels.ts src/main/copilot/ipc-handlers.ts src/preload/index.ts src/preload/copilot.ts src/renderer/src/store/workspace-store.ts
git commit -m "feat(copilot): add active workspace IPC communication"
```

---

### Task 5: Add workspace state and filtering to copilot store

**Files:**
- Modify: `src/renderer/copilot/src/store/copilot-store.ts`
- Modify: `src/renderer/copilot/src/App.tsx`

- [ ] **Step 1: Add workspace state to copilot store**

In `src/renderer/copilot/src/store/copilot-store.ts`, add new state fields and actions to `CopilotStoreState`:

```typescript
type CopilotStoreState = {
  expanded: boolean;
  view: CopilotView;
  selectedSessionId: string | null;

  sessions: CopilotSession[];
  settings: CopilotSettings | null;
  hookInstalled: boolean;
  claudeDetected: boolean;

  activeWorkspaceId: string | null;
  activeWorkspaceName: string | null;
  showAllWorkspaces: boolean;

  chatMessages: CopilotChatMessage[];
  chatLoading: boolean;

  setExpanded: (expanded: boolean) => void;
  toggleExpanded: () => void;
  setView: (view: CopilotView) => void;
  selectSession: (sessionId: string) => void;
  backToList: () => void;

  setSessions: (sessions: CopilotSession[]) => void;
  setActiveWorkspace: (workspaceId: string, workspaceName: string) => void;
  setShowAllWorkspaces: (show: boolean) => Promise<void>;
  filteredSessions: () => CopilotSession[];
  loadSettings: () => Promise<void>;
  updateSettings: (partial: Partial<CopilotSettings>) => Promise<void>;
  respondPermission: (toolUseId: string, decision: 'allow' | 'deny', reason?: string) => Promise<void>;
  checkHookStatus: () => Promise<void>;
  installHooks: () => Promise<void>;
  uninstallHooks: () => Promise<void>;

  loadChatHistory: (sessionId: string, cwd: string) => Promise<void>;
  setChatMessages: (sessionId: string, messages: CopilotChatMessage[]) => void;
  sendMessage: (sessionId: string, message: string) => Promise<boolean>;
};
```

- [ ] **Step 2: Implement the new state and actions**

In the store creation, add the initial values and action implementations:

After `claudeDetected: true,`:

```typescript
  activeWorkspaceId: null,
  activeWorkspaceName: null,
  showAllWorkspaces: false,
```

Add these actions after `setSessions`:

```typescript
  setActiveWorkspace: (workspaceId, workspaceName) => {
    set({ activeWorkspaceId: workspaceId, activeWorkspaceName: workspaceName });
  },

  setShowAllWorkspaces: async (show) => {
    set({ showAllWorkspaces: show });
    await window.copilot.setSettings({ showAllWorkspaces: show });
  },

  filteredSessions: () => {
    const { sessions, showAllWorkspaces, activeWorkspaceId } = get();
    if (showAllWorkspaces) return sessions;
    return sessions.filter(
      (s) => !s.workspaceId || s.workspaceId === activeWorkspaceId
    );
  },
```

- [ ] **Step 3: Initialize showAllWorkspaces from settings in loadSettings**

Update the `loadSettings` action to also read `showAllWorkspaces`:

```typescript
  loadSettings: async () => {
    const settings = await window.copilot.getSettings();
    const hookInstalled = await window.copilot.hookStatus();
    let claudeDetected = true;
    try {
      const status = await window.copilot.serviceStatus();
      claudeDetected = status.claudeDetected;
    } catch {
      // serviceStatus not available (older preload), assume true
    }
    log.debug('loadSettings', { settings, hookInstalled, claudeDetected });
    set({
      settings,
      hookInstalled,
      claudeDetected,
      showAllWorkspaces: settings.showAllWorkspaces ?? false,
    });
  },
```

- [ ] **Step 4: Subscribe to active workspace changes in App.tsx**

In `src/renderer/copilot/src/App.tsx`, add the active workspace subscription in the main `useEffect`. Add to the imports:

After the existing subscriptions inside the `useEffect` (after `const cleanupExpanded = ...`), add:

```typescript
    const setActiveWorkspace = useCopilotStore.getState().setActiveWorkspace;

    // Load initial active workspace
    window.copilot.getActiveWorkspace().then((ws) => {
      if (ws) setActiveWorkspace(ws.workspaceId, ws.workspaceName);
    }).catch(() => {});

    // Subscribe to active workspace changes
    const cleanupWorkspace = window.copilot.onActiveWorkspace((payload) => {
      setActiveWorkspace(payload.workspaceId, payload.workspaceName);
    });
```

Update the cleanup return:

```typescript
    return () => {
      cleanupSessions();
      cleanupExpanded();
      cleanupWorkspace();
    };
```

- [ ] **Step 5: Verify typecheck**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/renderer/copilot/src/store/copilot-store.ts src/renderer/copilot/src/App.tsx
git commit -m "feat(copilot): add workspace state, filtering, and active workspace subscription"
```

---

### Task 6: Add workspace filter toggle and labels to SessionList

**Files:**
- Modify: `src/renderer/copilot/src/components/SessionList.tsx`

- [ ] **Step 1: Add filter toggle and workspace labels**

In `src/renderer/copilot/src/components/SessionList.tsx`, update the component to use filtered sessions, add a toggle, and show workspace names.

First, update the store selectors at the top of the component:

```typescript
export function SessionList(): React.JSX.Element {
  const filteredSessions = useCopilotStore((s) => s.filteredSessions);
  const showAllWorkspaces = useCopilotStore((s) => s.showAllWorkspaces);
  const setShowAllWorkspaces = useCopilotStore((s) => s.setShowAllWorkspaces);
  const selectSession = useCopilotStore((s) => s.selectSession);
  const respondPermission = useCopilotStore((s) => s.respondPermission);
  const setView = useCopilotStore((s) => s.setView);
  const hookInstalled = useCopilotStore((s) => s.hookInstalled);
  const claudeDetected = useCopilotStore((s) => s.claudeDetected);

  const sessions = filteredSessions();
  const sorted = [...sessions].sort(sortSessions);
```

- [ ] **Step 2: Add the toggle UI**

Replace the header section (the `{/* Header */}` div, lines 72-86) with:

```tsx
        {/* Header */}
        <div className="flex items-center justify-between px-3 py-2 border-b border-neutral-700">
          <span className="text-sm font-medium text-neutral-300">
            Sessions ({sessions.length})
          </span>
          <div className="flex items-center gap-1">
            <div className="flex items-center bg-neutral-800 rounded text-xs">
              <button
                onClick={() => void setShowAllWorkspaces(false)}
                className={`px-2 py-0.5 rounded transition-colors ${
                  !showAllWorkspaces
                    ? 'bg-neutral-600 text-neutral-200'
                    : 'text-neutral-500 hover:text-neutral-400'
                }`}
              >
                Active
              </button>
              <button
                onClick={() => void setShowAllWorkspaces(true)}
                className={`px-2 py-0.5 rounded transition-colors ${
                  showAllWorkspaces
                    ? 'bg-neutral-600 text-neutral-200'
                    : 'text-neutral-500 hover:text-neutral-400'
                }`}
              >
                All
              </button>
            </div>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button variant="ghost" size="icon" onClick={() => setView('mascots')}>
                  <PawPrint size={14} />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Mascots</TooltipContent>
            </Tooltip>
          </div>
        </div>
```

- [ ] **Step 3: Add workspace name subtitle to each session**

In the session item rendering (inside the `sorted.map()` callback), after the project name tooltip and before the elapsed time span, add a workspace name subtitle. Replace the inner content of the session item (the part with project name and elapsed time) with:

Find the existing block:

```tsx
                  <div className="flex items-center justify-between py-2">
                    <div className="flex items-center gap-2 min-w-0">
                      {/* Multi-signal badge (Baymard: shape+size+color+animation) */}
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Badge status={status} />
                        </TooltipTrigger>
                        <TooltipContent>{statusLabel(status)}</TooltipContent>
                      </Tooltip>

                      {/* Project name with truncation + tooltip (Baymard) */}
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <span className="text-sm text-neutral-200 truncate">
                            {session.projectName}
                          </span>
                        </TooltipTrigger>
                        <TooltipContent>{session.projectName}</TooltipContent>
                      </Tooltip>
                    </div>
                    <span className="text-xs text-neutral-500 ml-2 shrink-0">
                      {elapsed(session.createdAt)}
                    </span>
                  </div>
```

Replace with:

```tsx
                  <div className="flex items-center justify-between py-2">
                    <div className="flex items-center gap-2 min-w-0">
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Badge status={status} />
                        </TooltipTrigger>
                        <TooltipContent>{statusLabel(status)}</TooltipContent>
                      </Tooltip>

                      <div className="min-w-0">
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <span className="text-sm text-neutral-200 truncate block">
                              {session.projectName}
                            </span>
                          </TooltipTrigger>
                          <TooltipContent>{session.projectName}</TooltipContent>
                        </Tooltip>
                        <span className="text-xs text-neutral-500 truncate block">
                          {session.workspaceName ?? 'Unknown'}
                        </span>
                      </div>
                    </div>
                    <span className="text-xs text-neutral-500 ml-2 shrink-0">
                      {elapsed(session.createdAt)}
                    </span>
                  </div>
```

- [ ] **Step 4: Verify typecheck**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/renderer/copilot/src/components/SessionList.tsx
git commit -m "feat(copilot): add workspace filter toggle and labels to session list"
```

---

### Task 7: Add workspace label to SessionDetail header

**Files:**
- Modify: `src/renderer/copilot/src/components/SessionDetail.tsx:81-100`

- [ ] **Step 1: Add workspace subtitle to detail header**

In `src/renderer/copilot/src/components/SessionDetail.tsx`, update the header section. Find the existing header (lines 81-100):

```tsx
        <div className="flex items-center gap-2 px-3 py-2 border-b border-neutral-700">
          <Button variant="ghost" size="sm" onClick={backToList}>
            <ChevronLeft size={14} />
          </Button>
          <Badge status={status} />
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="text-sm font-medium text-neutral-200 truncate">
                {session.projectName}
              </span>
            </TooltipTrigger>
            <TooltipContent>{session.projectName}</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="text-xs text-neutral-500 ml-auto">{session.phase}</span>
            </TooltipTrigger>
            <TooltipContent>Current phase: {session.phase}</TooltipContent>
          </Tooltip>
        </div>
```

Replace with:

```tsx
        <div className="flex items-center gap-2 px-3 py-2 border-b border-neutral-700">
          <Button variant="ghost" size="sm" onClick={backToList}>
            <ChevronLeft size={14} />
          </Button>
          <Badge status={status} />
          <div className="min-w-0 flex-1">
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="text-sm font-medium text-neutral-200 truncate block">
                  {session.projectName}
                </span>
              </TooltipTrigger>
              <TooltipContent>{session.projectName}</TooltipContent>
            </Tooltip>
            <span className="text-xs text-neutral-500 truncate block">
              {session.workspaceName ?? 'Unknown'}
            </span>
          </div>
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="text-xs text-neutral-500 ml-auto shrink-0">{session.phase}</span>
            </TooltipTrigger>
            <TooltipContent>Current phase: {session.phase}</TooltipContent>
          </Tooltip>
        </div>
```

- [ ] **Step 2: Verify typecheck**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/renderer/copilot/src/components/SessionDetail.tsx
git commit -m "feat(copilot): add workspace label to session detail header"
```

---

### Task 8: Add showAllWorkspaces toggle to settings page

**Files:**
- Modify: `src/renderer/src/components/settings/CopilotSection.tsx`

- [ ] **Step 1: Add toggle in settings UI**

In `src/renderer/src/components/settings/CopilotSection.tsx`, add a "Show All Workspaces" toggle after the "Claude Code Hooks" section and before the "Workspace Overrides" section. Find the `{/* Workspace Overrides */}` comment and add this block before it:

```tsx
      {/* Show All Workspaces */}
      <div>
        <SettingRow label="Show All Workspaces">
          <input
            type="checkbox"
            checked={copilot.showAllWorkspaces}
            onChange={(e) => updateCopilot({ showAllWorkspaces: e.target.checked })}
            className="accent-blue-500"
          />
        </SettingRow>
        <p className="text-xs text-neutral-500 mt-1">
          Show sessions from all workspaces in the Copilot overlay. When off, only the active
          workspace&apos;s sessions are shown.
        </p>
      </div>
```

- [ ] **Step 2: Verify typecheck**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/renderer/src/components/settings/CopilotSection.tsx
git commit -m "feat(copilot): add showAllWorkspaces toggle to settings page"
```

---

### Task 9: Final verification

- [ ] **Step 1: Full typecheck**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 2: Lint check**

Run: `npm run lint`
Expected: No new errors (pre-existing warnings are ok)

- [ ] **Step 3: Build check**

Run: `npm run build`
Expected: PASS

- [ ] **Step 4: Manual testing checklist**

Run `npm run dev` and verify:
1. Global hooks section shows correct installed/not-installed status
2. Start a Claude session in a workspace — the copilot session list should show the workspace name under the project name
3. The "Active / All" toggle at the top of the session list switches filtering
4. Clicking into a session detail shows the workspace name under the project name in the header
5. In Settings > Copilot, the "Show All Workspaces" toggle matches the overlay toggle state
6. Switching workspaces in Fleet updates the copilot filter (if set to "Active")

---

## Build Order Summary

| Task | What it does | Dependencies |
|------|-------------|-------------|
| 1 | Types + setting default | None |
| 2 | Layout store lookup | None |
| 3 | Tag sessions with workspace | Tasks 1, 2 |
| 4 | Active workspace IPC | Task 1 |
| 5 | Copilot store filtering | Tasks 1, 4 |
| 6 | Session list UI | Tasks 1, 5 |
| 7 | Session detail UI | Task 1 |
| 8 | Settings toggle | Task 1 |
| 9 | Final verification | All |
