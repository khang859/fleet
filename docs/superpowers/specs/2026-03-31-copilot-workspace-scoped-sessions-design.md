# Copilot Workspace-Scoped Sessions

## Problem

The copilot overlay shows all Claude Code sessions from all workspaces with no filtering or workspace identification. When running agents across multiple workspaces, the session list becomes noisy and it's unclear which workspace each session belongs to. Users can't focus on just the workspace they're actively working in.

## Solution

Tag each copilot session with its workspace. Let users filter to the active workspace (default) or show all. Display the workspace name in the session list and detail view.

## Data Model Changes

### CopilotSession

Add two optional fields to `CopilotSession` in `src/shared/types.ts`:

```typescript
export type CopilotSession = {
  sessionId: string;
  cwd: string;
  projectName: string;
  phase: CopilotSessionPhase;
  pid?: number;
  tty?: string;
  workspaceId?: string;    // NEW
  workspaceName?: string;  // NEW
  pendingPermissions: CopilotPendingPermission[];
  lastActivity: number;
  createdAt: number;
};
```

Sessions with no workspace match (e.g. external Claude sessions not spawned from Fleet) leave these fields undefined and display as "Unknown" workspace.

### CopilotSettings

Add a toggle to `CopilotSettings` in `src/shared/types.ts`:

```typescript
export type CopilotSettings = {
  // ... existing fields ...
  showAllWorkspaces: boolean; // NEW — default: false
};
```

Default value set in `src/main/settings-store.ts`.

## Workspace Resolution

When the socket server receives a hook event with a `pid`, resolve the workspace in the main process:

1. Use the existing `findPaneForPid(ptyManager, pid)` to get the `paneId`
2. Look up which workspace owns that pane via the layout store
3. Pass `workspaceId` and `workspaceName` to the session store's upsert

This resolution happens in `src/main/copilot/ipc-handlers.ts` or `src/main/copilot/socket-server.ts`, wherever the hook event is processed and sessions are created/updated.

### Finding workspace from paneId

The main process needs a way to map `paneId` -> `workspaceId`. The layout store (`src/main/layout-store.ts`) holds all workspaces and their tabs/panes. Add a lookup method that iterates workspaces to find which one contains the given paneId, returning `{ workspaceId, workspaceName }` or null.

## Active Workspace Communication

The copilot window (separate BrowserWindow) needs to know which workspace is currently active in the main window.

### Approach

- Add an IPC channel `COPILOT_ACTIVE_WORKSPACE` (push event from main to copilot window)
- When the main window switches workspaces, the main process sends the new `{ workspaceId, workspaceName }` to the copilot window
- The copilot store holds `activeWorkspaceId: string | null`
- On initial copilot window creation, send the current active workspace

### Main process trigger

The workspace switch is driven by the renderer. The simplest trigger: add a new IPC call from the main renderer whenever the active workspace changes (the workspace store already tracks this). The main process forwards it to the copilot window.

## Copilot Overlay UI Changes

### Session List: Workspace Filter Toggle

At the top of the session list (above the sorted session cards), add a compact toggle:

```
[Active workspace]  /  [All workspaces]
```

- Two small text buttons, the active one is highlighted
- Changing the toggle persists to `settings.copilot.showAllWorkspaces` via IPC
- Default: "Active workspace" selected

### Session List: Filtering Logic

In the copilot store or the SessionList component:

- If `showAllWorkspaces` is false: filter sessions to those where `workspaceId === activeWorkspaceId`, plus sessions where `workspaceId` is undefined (external/unknown)
- If `showAllWorkspaces` is true: show all sessions

### Session List: Workspace Label

Below each session's project name, add a subtitle line:

```
fleet
Default              ← workspace name, text-xs text-neutral-500
```

- Use `workspaceName` if set, otherwise "Unknown"
- Style: `text-xs text-neutral-500` (muted, smaller than project name)

### Session Detail: Workspace Label

In the detail header, below the project name, show the workspace name in the same muted subtitle style as the list view. Consistent placement and styling.

## Settings Page

The Copilot settings page (`CopilotSection.tsx`) already has copilot settings. Add a toggle for the default filter preference:

```
Show All Workspaces  [toggle]
Show sessions from all workspaces in the Copilot overlay. When off, only the active workspace's sessions are shown.
```

This controls the same `showAllWorkspaces` setting that the overlay toggle controls — they stay in sync.

## Edge Cases

- **No PID match**: Session tagged with no workspace. Shows as "Unknown". Always visible regardless of filter.
- **Workspace deleted while sessions active**: Sessions keep their tagged workspace name. Visible in "All workspaces" mode.
- **Workspace renamed**: Sessions keep the name from when they were tagged. Acceptable since sessions are short-lived.
- **Copilot window opens before any workspace switch**: Main process sends current active workspace on copilot window creation.

## Files to Modify

| File | Change |
|------|--------|
| `src/shared/types.ts` | Add `workspaceId`, `workspaceName` to `CopilotSession`; add `showAllWorkspaces` to `CopilotSettings` |
| `src/shared/ipc-channels.ts` | Add `COPILOT_ACTIVE_WORKSPACE` channel |
| `src/main/settings-store.ts` | Default `showAllWorkspaces: false` |
| `src/main/layout-store.ts` | Add `findWorkspaceForPane(paneId)` lookup |
| `src/main/copilot/session-store.ts` | Accept and store `workspaceId`/`workspaceName` on upsert |
| `src/main/copilot/socket-server.ts` | Pass workspace info when creating/updating sessions |
| `src/main/copilot/ipc-handlers.ts` | Resolve workspace from PID on hook events; handle active workspace forwarding |
| `src/main/copilot/copilot-window.ts` | Send active workspace to copilot window on creation |
| `src/preload/copilot.ts` | Expose `onActiveWorkspace` listener |
| `src/renderer/copilot/src/store/copilot-store.ts` | Add `activeWorkspaceId`, `showAllWorkspaces` state; filtering logic |
| `src/renderer/copilot/src/components/SessionList.tsx` | Add filter toggle UI; add workspace subtitle per session |
| `src/renderer/copilot/src/components/SessionDetail.tsx` | Add workspace subtitle in header |
| `src/renderer/src/components/settings/CopilotSection.tsx` | Add "Show All Workspaces" toggle |
| `src/renderer/src/store/workspace-store.ts` or equivalent | Notify main process on workspace switch |
