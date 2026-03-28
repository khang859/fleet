# Remove Star Command System — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the entire Star Command system (starbase, crews, missions, sectors, comms, cargo, protocols, navigator, first officer, admiral) from Fleet, keeping only the core terminal multiplexer + image generation + file opening features.

**Architecture:** Delete all dedicated star-command/starbase files first, then surgically clean integration points in shared files, then verify with typecheck/lint. The socket server stays (it serves `open` and `images` commands) but loses all starbase service dependencies.

**Tech Stack:** Electron + TypeScript + React + xterm.js

---

### Task 1: Delete all dedicated Star Command source files

**Files to delete:**

Frontend:
- `src/renderer/src/components/star-command/` (entire directory — 18 files)
- `src/renderer/src/components/StarCommandTab.tsx`
- `src/renderer/src/components/StarCommandConfig.tsx`
- `src/renderer/src/store/star-command-store.ts`
- `src/renderer/src/assets/admiral-default.png`
- `src/renderer/src/assets/admiral-speaking.png`
- `src/renderer/src/assets/admiral-thinking.png`
- `src/renderer/src/assets/admiral-alert.png`
- `src/renderer/src/assets/admiral-standby.png`

Backend:
- `src/main/starbase/` (entire directory — 36 files + prompts subdirectory)
- `src/main/starbase-runtime-core.ts`
- `src/main/starbase-runtime-socket-services.ts`
- `src/main/starbase-runtime-client.ts`
- `src/main/starbase-runtime-process.ts`

Tests:
- `src/main/__tests__/conventional-commits.test.ts`
- `src/main/__tests__/workspace-templates.test.ts`
- `src/main/__tests__/runtime-message-shape.test.ts`

Scripts:
- `scripts/assemble-star-command-sprites.ts`

- [ ] **Step 1: Delete frontend star-command directory and components**

```bash
rm -rf src/renderer/src/components/star-command
rm src/renderer/src/components/StarCommandTab.tsx
rm src/renderer/src/components/StarCommandConfig.tsx
rm src/renderer/src/store/star-command-store.ts
rm src/renderer/src/assets/admiral-default.png
rm src/renderer/src/assets/admiral-speaking.png
rm src/renderer/src/assets/admiral-thinking.png
rm src/renderer/src/assets/admiral-alert.png
rm src/renderer/src/assets/admiral-standby.png
```

- [ ] **Step 2: Delete backend starbase directory and runtime files**

```bash
rm -rf src/main/starbase
rm src/main/starbase-runtime-core.ts
rm src/main/starbase-runtime-socket-services.ts
rm src/main/starbase-runtime-client.ts
rm src/main/starbase-runtime-process.ts
```

- [ ] **Step 3: Delete related tests and scripts**

```bash
rm src/main/__tests__/conventional-commits.test.ts
rm src/main/__tests__/workspace-templates.test.ts
rm src/main/__tests__/runtime-message-shape.test.ts
rm scripts/assemble-star-command-sprites.ts
```

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "chore: delete all dedicated star command source files"
```

---

### Task 2: Clean up `src/shared/types.ts`

**Files:**
- Modify: `src/shared/types.ts`

Remove star-command-related types while keeping everything else.

- [ ] **Step 1: Remove `'star-command' | 'crew'` from Tab.type union**

In `src/shared/types.ts`, the `Tab` type has:
```ts
type?: 'terminal' | 'star-command' | 'crew' | 'file' | 'image' | 'images' | 'settings';
```

Change to:
```ts
type?: 'terminal' | 'file' | 'image' | 'images' | 'settings';
```

- [ ] **Step 2: Remove `VisualizerEffects` type (lines 81-102)**

Delete the entire `VisualizerEffects` type definition.

- [ ] **Step 3: Remove `visualizer` from `FleetSettings` and starbase notification keys**

In `FleetSettings`, remove:
```ts
visualizer: {
  panelMode: 'drawer' | 'tab';
  effects: VisualizerEffects;
  soundVolume: number;
};
```

Also remove from `notifications`:
```ts
comms: { badge: boolean; sound: boolean; os: boolean };
memos: { badge: boolean; sound: boolean; os: boolean };
```

- [ ] **Step 4: Commit**

```bash
git add src/shared/types.ts
git commit -m "chore: remove star command types from shared types"
```

---

### Task 3: Clean up `src/shared/ipc-api.ts`

**Files:**
- Modify: `src/shared/ipc-api.ts`

Remove all starbase-related type exports.

- [ ] **Step 1: Remove starbase types**

Delete these types (lines 52-318):
- `StarbaseRuntimeStatus`
- `SectorPayload`, `AddSectorRequest`, `UpdateSectorRequest`, `SetConfigRequest`
- `DeployRequest`, `DeployResponse`, `RecallRequest`
- `MissionListFilter`, `AddMissionRequest`
- `AdmiralStateDetailPayload`, `AdmiralStatusPayload`
- `CreateTabPayload`
- `SystemDepResult`
- `StarbaseSectorRow`, `StarbaseCrewRow`, `StarbaseMissionRow`
- `StarbaseCommRow`, `StarbaseMemoRow`
- `StarbaseSupplyRoute`, `StarbaseRetentionStats`, `StarbaseCleanupResult`
- `StarbaseLogEntry`, `SentinelAlert`, `SentinelStatusPayload`
- `StarbaseStatusUpdatePayload`

Keep: `PtyCreateRequest`, `PtyCreateResponse`, `PtyDataPayload`, `PtyInputPayload`, `PtyResizePayload`, `PtyExitPayload`, `LayoutSaveRequest`, `LayoutListResponse`, `NotificationPayload`, `ActivityStatePayload`, `PaneFocusedPayload`, `PtyCwdPayload`, `HostPlatform`, `HostContextPayload`, `GitFileStatus`, `GitStatusPayload`, `GitIsRepoPayload`, `FileOpenInTabPayload`, `DirEntry`, `ReaddirResponse`, `FileSearchRequest`, `FileSearchResult`, `FileSearchResponse`, `RecentImageResult`, `RecentImagesResponse`, `ClipboardEntry`, `ClipboardHistoryResponse`, `LogEntry`, `WorktreeCreateRequest`, `WorktreeCreateResponse`, `WorktreeRemoveRequest`.

- [ ] **Step 2: Commit**

```bash
git add src/shared/ipc-api.ts
git commit -m "chore: remove starbase types from ipc-api"
```

---

### Task 4: Clean up `src/shared/ipc-channels.ts`

**Files:**
- Modify: `src/shared/ipc-channels.ts`

- [ ] **Step 1: Remove all STARBASE_, ADMIRAL_, MEMO_, FOCUS_COMMS, FOCUS_FIRST_OFFICER channels**

Remove lines 21-84 (all the starbase/admiral/memo/comms/focus channels). Keep all other channels (PTY, LAYOUT, NOTIFICATION, ACTIVITY, SETTINGS, GIT, FILE, CLIPBOARD, LOG, IMAGES, UPDATE, APP, SYSTEM, WORKTREE, SHELL).

- [ ] **Step 2: Commit**

```bash
git add src/shared/ipc-channels.ts
git commit -m "chore: remove starbase IPC channels"
```

---

### Task 5: Clean up `src/main/event-bus.ts`

**Files:**
- Modify: `src/main/event-bus.ts`

- [ ] **Step 1: Remove starbase event types**

Remove from the `FleetEvent` union:
```ts
| {
    type: 'admiral-state-change';
    state: 'standby' | 'thinking' | 'speaking' | 'alert';
    statusText: string;
  }
```

And:
```ts
| { type: 'starbase-changed' }
```

- [ ] **Step 2: Commit**

```bash
git add src/main/event-bus.ts
git commit -m "chore: remove starbase events from event bus"
```

---

### Task 6: Clean up `src/main/layout-store.ts`

**Files:**
- Modify: `src/main/layout-store.ts`

- [ ] **Step 1: Remove `ensureStarCommandTab` method**

Delete the `ensureStarCommandTab` method (starting at line 54). Keep `ensureImagesTab`.

- [ ] **Step 2: Update `ensureImagesTab` insertion logic**

The current `ensureImagesTab` inserts after the star-command tab:
```ts
// Insert after star-command tab if it exists, otherwise at the start
const starIdx = workspace.tabs.findIndex((t) => t.type === 'star-command');
```

Change to insert at the start (index 0) since star-command tab no longer exists:
```ts
workspace.tabs.unshift(imagesTab);
```

Or simply insert at position 0 without the star-command logic.

- [ ] **Step 3: Commit**

```bash
git add src/main/layout-store.ts
git commit -m "chore: remove ensureStarCommandTab from layout store"
```

---

### Task 7: Clean up `src/main/index.ts` — the big one

**Files:**
- Modify: `src/main/index.ts`

This is the most complex file. Remove all starbase bootstrap logic while keeping the core app, image service, socket supervisor (for open/images CLI), and auto-updater.

- [ ] **Step 1: Remove starbase imports**

Remove these imports:
```ts
import { AdmiralProcess } from './starbase/admiral-process';
import { AdmiralStateDetector } from './starbase/admiral-state-detector';
import { StarbaseRuntimeClient } from './starbase-runtime-client';
import { createSocketRuntimeServices } from './starbase-runtime-socket-services';
```

Remove `StarbaseRuntimeStatus` from the ipc-api import.

- [ ] **Step 2: Remove starbase module-level variables and initialization**

Remove:
```ts
const starbaseLog = createLogger('starbase');
```
```ts
let lastUnreadCommsCount = 0;
let lastUnreadMemosCount = 0;
```
```ts
let admiralProcess: AdmiralProcess | null = null;
```
```ts
const admiralStateDetector = new AdmiralStateDetector(eventBus);
const runtimeClient = new StarbaseRuntimeClient(
  new URL('./starbase-runtime-process.mjs', import.meta.url)
);
```
```ts
const STARBASE_PARENT_TRACE_FILE = '/tmp/fleet-starbase-parent.log';
```

- [ ] **Step 3: Remove `traceStarbase` function and all calls to it**

Delete the entire `traceStarbase` function (lines 82-93) and the call at line 95-98.

- [ ] **Step 4: Remove `runtimeStatus`, `setRuntimeStatus`, `handleStarbaseSnapshot`**

Delete:
- `let runtimeStatus` variable (line 100)
- `setRuntimeStatus` function (lines 116-123)
- `handleStarbaseSnapshot` function (lines 125-179)

- [ ] **Step 5: Remove starbase push-on-load in `createWindow`**

In `createWindow()`, remove the `did-finish-load` handler that pushes starbase snapshots (lines 268-293):
```ts
mainWindow.webContents.on('did-finish-load', () => {
  if (runtimeStatus.state === 'ready') { ... }
});
```

- [ ] **Step 6: Remove `child-process-gone` handler for starbase**

Remove lines 318-322:
```ts
app.on('child-process-gone', (_event, details) => {
  if (details.type === 'Utility' || details.serviceName === 'Fleet Starbase Runtime') {
    log.error('child-process-gone', { details });
  }
});
```

- [ ] **Step 7: Remove `bootstrapStarbase` function and related logic in `whenReady`**

Inside the `app.whenReady()` callback, remove:
- `let starbaseReadyPromise` and `starbaseBootstrapInFlight` variables
- The entire `bootstrapStarbase` async function
- The `ensureStarCommandTab` call in the bootstrap
- The starbase services passed to `registerIpcHandlers`
- The `STARBASE_SNAPSHOT_REQUEST` handler
- The `commandHandler.setWindowGetter` call
- The `runtimeClient.on('starbase.snapshot', ...)` listener
- The `runtimeClient.on('starbase.log-entry', ...)` listener
- The `runtimeClient.on('runtime.status', ...)` listener
- The `startAdmiralAndWire` function
- The `ADMIRAL_ENSURE_STARTED` handler
- The `void bootstrapStarbase().catch(...)` call
- The `eventBus.on('admiral-state-change', ...)` listener

Simplify `registerIpcHandlers` call — remove the starbase-related factory arguments.

- [ ] **Step 8: Simplify `shutdownAll`**

Remove from `shutdownAll()`:
```ts
socketSupervisor?.stop().catch(...)
admiralProcess?.stop();
admiralStateDetector.dispose();
runtimeClient.stop();
```

Keep `ptyManager.killAll()`, `cwdPoller.stopAll()`, `imageService.shutdown()`.

Also remove the `socketSupervisor` variable and `admiralProcess` references from the `close` handler.

- [ ] **Step 9: Commit**

```bash
git add src/main/index.ts
git commit -m "chore: remove starbase bootstrap and admiral from main process"
```

---

### Task 8: Clean up `src/main/ipc-handlers.ts`

**Files:**
- Modify: `src/main/ipc-handlers.ts`

- [ ] **Step 1: Remove starbase imports and types**

Remove imports for `AdmiralProcess`, `checkDependencies`, `AdmiralStateDetector`, `StarbaseRuntimeClient`, `StarbaseRuntimeStatus`.

Remove the `StarbaseServices` type and the `starbaseReady`/`retryStarbaseBootstrap` from the bootstrap state type.

- [ ] **Step 2: Remove starbase parameter from `registerIpcHandlers`**

Remove the `getStarbaseServices` parameter and simplify the bootstrap state parameter to remove starbase fields.

- [ ] **Step 3: Remove all starbase IPC handlers**

Remove all `ipcMain.handle` calls for:
- `STARBASE_RUNTIME_STATUS_GET`, `STARBASE_RUNTIME_STATUS_RETRY`
- `STARBASE_LIST_SECTORS`, `STARBASE_ADD_SECTOR`, `STARBASE_REMOVE_SECTOR`, `STARBASE_UPDATE_SECTOR`
- `STARBASE_GET_CONFIG`, `STARBASE_SET_CONFIG`
- `STARBASE_DEPLOY`, `STARBASE_RECALL`, `STARBASE_MESSAGE_CREW`
- `STARBASE_CREW`, `STARBASE_MISSIONS`, `STARBASE_ADD_MISSION`
- `STARBASE_COMMS_UNREAD`, `STARBASE_LIST_COMMS`, `STARBASE_MARK_COMMS_READ`
- `STARBASE_RESOLVE_COMMS`, `STARBASE_DELETE_COMMS`, `STARBASE_MARK_ALL_COMMS_READ`, `STARBASE_CLEAR_COMMS`
- `STARBASE_LIST_SUPPLY_ROUTES`, `STARBASE_ADD_SUPPLY_ROUTE`, `STARBASE_REMOVE_SUPPLY_ROUTE`, `STARBASE_SUPPLY_ROUTE_GRAPH`
- `STARBASE_LIST_CARGO`, `STARBASE_RETENTION_STATS`, `STARBASE_RETENTION_CLEANUP`, `STARBASE_RETENTION_VACUUM`
- `STARBASE_SHIPS_LOG`
- `ADMIRAL_CHECK_DEPENDENCIES`, `ADMIRAL_PANE_ID`, `ADMIRAL_RESTART`, `ADMIRAL_RESET`
- `MEMO_LIST`, `MEMO_READ`, `MEMO_DISMISS`, `MEMO_CONTENT`

Remove `ensureStarCommandTab` call from the layout save handler.

- [ ] **Step 4: Commit**

```bash
git add src/main/ipc-handlers.ts
git commit -m "chore: remove starbase IPC handlers"
```

---

### Task 9: Clean up `src/main/socket-command-handler.ts`

**Files:**
- Modify: `src/main/socket-command-handler.ts`

- [ ] **Step 1: Remove all starbase imports, fields, and methods**

Remove imports for `SectorService`, `ConfigService`, `CrewService`, `MissionService`, `StarbaseRuntimeClient`.

Remove fields: `sectorService`, `configService`, `crewService`, `missionService`, `runtimeClient`.

Remove methods: `setStarbaseServices()`, `setPhase2Services()`, `setRuntimeClient()`.

- [ ] **Step 2: Remove all starbase command cases from `handleCommand`**

Remove the entire `// Starbase commands` section and `// Phase 2: Deploy/Recall/Crew/Missions` section (cases: `sectors`, `add-sector`, `config-get`, `config-set`, `deploy`, `recall`, `crew`, `missions`).

- [ ] **Step 3: Commit**

```bash
git add src/main/socket-command-handler.ts
git commit -m "chore: remove starbase commands from socket handler"
```

---

### Task 10: Clean up socket server (`src/main/socket-server.ts` and `src/main/socket-supervisor.ts`)

**Files:**
- Modify: `src/main/socket-server.ts`
- Modify: `src/main/socket-supervisor.ts`

- [ ] **Step 1: Rewrite socket-server.ts to remove ServiceRegistry**

The socket server currently imports all starbase services for its `ServiceRegistry`. Since the socket server only needs to handle `images` and `open` commands now, remove the entire `ServiceRegistry`/`AsyncServiceRegistry` types and all starbase service imports.

The `SocketServer` class itself dispatches commands via its handler — the actual command routing happens in `FleetCommandHandler`. So the socket server just needs to pass commands through. Remove starbase service plumbing from the constructor.

- [ ] **Step 2: Update socket-supervisor.ts**

Remove references to `ServiceRegistry`/`AsyncServiceRegistry` from the supervisor. Update constructor to not require starbase services.

- [ ] **Step 3: Commit**

```bash
git add src/main/socket-server.ts src/main/socket-supervisor.ts
git commit -m "chore: remove starbase services from socket server"
```

---

### Task 11: Clean up `src/preload/index.ts`

**Files:**
- Modify: `src/preload/index.ts`

- [ ] **Step 1: Remove starbase type imports**

Remove from imports: `AdmiralStatusPayload`, `AdmiralStateDetailPayload`, `StarbaseRuntimeStatus`, `SystemDepResult`, `CreateTabPayload`, `StarbaseSectorRow`, `StarbaseCrewRow`, `StarbaseMissionRow`, `StarbaseCommRow`, `StarbaseMemoRow`, `StarbaseSupplyRoute`, `StarbaseRetentionStats`, `StarbaseCleanupResult`, `StarbaseLogEntry`, `StarbaseStatusUpdatePayload`, `DeployResponse`.

- [ ] **Step 2: Remove `admiral` namespace from fleetApi**

Remove the entire `admiral: { ... }` block (lines 171-183).

- [ ] **Step 3: Remove `starbase` namespace from fleetApi**

Remove the entire `starbase: { ... }` block (lines 184-273).

- [ ] **Step 4: Remove `system` namespace from fleetApi**

Remove `system: { check: ... }` (lines 275-277).

- [ ] **Step 5: Remove `onCreateTab` bridge**

Remove the `onCreateTab` method and its comment (lines 286-293).

- [ ] **Step 6: Commit**

```bash
git add src/preload/index.ts
git commit -m "chore: remove starbase/admiral/memo bridge from preload"
```

---

### Task 12: Clean up `src/renderer/src/App.tsx`

**Files:**
- Modify: `src/renderer/src/App.tsx`

- [ ] **Step 1: Remove star command imports and assets**

Remove:
```ts
import admiralDefault from './assets/admiral-default.png';
import { StarCommandTab } from './components/StarCommandTab';
import { Avatar } from './components/star-command/Avatar';
```

- [ ] **Step 2: Remove Star Command mini-sidebar icon section**

Remove the entire block that filters for `star-command` tabs and renders the mini-sidebar icon (around lines 506-530).

- [ ] **Step 3: Remove Star Command from tab content rendering**

Remove the `star-command` case from the tab content area:
```tsx
{tab.type === 'star-command' ? (
  <StarCommandTab />
```

Replace with rendering only terminal/file/image/settings tabs. Remove the `tab.type !== 'star-command'` filter from the file/terminal tab icons section.

- [ ] **Step 4: Commit**

```bash
git add src/renderer/src/App.tsx
git commit -m "chore: remove star command tab rendering from App"
```

---

### Task 13: Clean up `src/renderer/src/components/Sidebar.tsx`

**Files:**
- Modify: `src/renderer/src/components/Sidebar.tsx`

- [ ] **Step 1: Remove star command imports**

Remove:
```ts
import { useStarCommandStore } from '../store/star-command-store';
import admiralDefault from '../assets/admiral-default.png';
import admiralSpeaking from '../assets/admiral-speaking.png';
import admiralThinking from '../assets/admiral-thinking.png';
import admiralAlert from '../assets/admiral-alert.png';
import admiralStandby from '../assets/admiral-standby.png';
import { Avatar } from './star-command/Avatar';
```

Remove the `ADMIRAL_IMAGES` record.

- [ ] **Step 2: Remove `StarCommandTabCard` component**

Delete the entire `StarCommandTabCard` component (starting around line 187).

- [ ] **Step 3: Remove star command tab rendering in sidebar**

Remove the section that filters and renders `star-command` tabs (around line 1104-1115). Remove the `t.type !== 'star-command'` filter from the regular tab list.

- [ ] **Step 4: Commit**

```bash
git add src/renderer/src/components/Sidebar.tsx
git commit -m "chore: remove star command from sidebar"
```

---

### Task 14: Clean up `FileSearchOverlay.tsx` and `ClipboardHistoryOverlay.tsx`

**Files:**
- Modify: `src/renderer/src/components/FileSearchOverlay.tsx`
- Modify: `src/renderer/src/components/ClipboardHistoryOverlay.tsx`

- [ ] **Step 1: Clean FileSearchOverlay.tsx**

Remove the `useStarCommandStore` import and `admiralPaneId` usage. The target pane logic should just use `activePaneId` directly without the star-command special case:
```ts
// Before:
const admiralPaneId = useStarCommandStore((s) => s.admiralPaneId);
const targetPaneId =
  activeTab?.type === 'star-command' ? (admiralPaneId ?? activePaneId) : (activePaneId ?? admiralPaneId);
// After:
const targetPaneId = activePaneId;
```

- [ ] **Step 2: Clean ClipboardHistoryOverlay.tsx**

Same pattern — remove `useStarCommandStore` import and simplify `targetPaneId` to just use `activePaneId`.

- [ ] **Step 3: Commit**

```bash
git add src/renderer/src/components/FileSearchOverlay.tsx src/renderer/src/components/ClipboardHistoryOverlay.tsx
git commit -m "chore: remove star command references from overlays"
```

---

### Task 15: Clean up `src/renderer/src/hooks/use-terminal.ts`

**Files:**
- Modify: `src/renderer/src/hooks/use-terminal.ts`

- [ ] **Step 1: Remove star command comments and attachOnly references**

Remove the comment about "Admiral PTY" on line 22 and lines 131, 202, 234. The `attachOnly` option itself may still be useful for other purposes, so only remove the Star Command-specific comments. If `attachOnly` is exclusively used for the Admiral, remove it too.

- [ ] **Step 2: Commit**

```bash
git add src/renderer/src/hooks/use-terminal.ts
git commit -m "chore: remove star command references from use-terminal hook"
```

---

### Task 16: Clean up `src/main/pty-manager.ts`

**Files:**
- Modify: `src/main/pty-manager.ts`

- [ ] **Step 1: Remove star command comment**

Remove or update the comment on line 40:
```ts
/** PTYs that must not be killed by the renderer-driven GC (e.g. Star Command crews). */
```

Change to a generic comment or remove if the `protectedPanes` set is now unused.

- [ ] **Step 2: Commit**

```bash
git add src/main/pty-manager.ts
git commit -m "chore: remove star command comment from pty-manager"
```

---

### Task 17: Clean up Fleet CLI (`src/main/fleet-cli.ts`)

**Files:**
- Modify: `src/main/fleet-cli.ts`

- [ ] **Step 1: Remove starbase entries from `COMMAND_MAP`**

Remove all entries except `images.*`:
Keep:
```ts
'images.generate': 'image.generate',
'images.edit': 'image.edit',
'images.status': 'image.status',
'images.list': 'image.list',
'images.retry': 'image.retry',
'images.config': 'image.config.get',
'images.action': 'image.action',
'images.actions': 'image.actions.list'
```

Delete: all `sectors.*`, `missions.*`, `crew.*`, `comms.*`, `cargo.*`, `log.*`, `protocols.*` entries.

- [ ] **Step 2: Remove starbase cases from `validateCommand`**

Remove all `case` blocks except image-related ones from `validateCommand()`.

- [ ] **Step 3: Rewrite `HELP_TOP`**

Replace with a simplified version that only references `images` and `open`:
```ts
const HELP_TOP = `# Fleet CLI

Manage images and open files from the terminal.

## Usage

  fleet <command> [--key value ...]
  fleet <command> --help

## Commands

| Command | Intent |
|---------|--------|
| images | Generate, edit, and transform AI images. |
| open | Open files or images in Fleet tabs. |

## Examples

\`\`\`bash
fleet images generate --prompt "A cat in space"
fleet open src/main.ts
\`\`\`

Run \`fleet <command> --help\` for detailed help.`;
```

- [ ] **Step 4: Remove starbase entries from `HELP_GROUPS`**

Remove: `sectors`, `missions`, `crew`, `comms`, `cargo`, `log`, `protocols`, `config`.

Keep: `images`, `open`.

- [ ] **Step 5: Remove starbase command formatting from `runCLI` output formatter**

Remove all starbase-specific output formatting code (protocol, execution, comms, etc.).

- [ ] **Step 6: Commit**

```bash
git add src/main/fleet-cli.ts
git commit -m "chore: remove starbase CLI commands, keep images and open"
```

---

### Task 18: Clean up `src/main/fleet-cli.ts` test

**Files:**
- Modify: `src/main/__tests__/fleet-cli.test.ts`

- [ ] **Step 1: Remove starbase-related test cases**

Remove any test cases that test starbase CLI commands (sectors, missions, crew, comms, cargo, protocols, config). Keep tests for `images` and `open` commands, and generic tests for `parseArgs`, `formatTable`, etc.

- [ ] **Step 2: Commit**

```bash
git add src/main/__tests__/fleet-cli.test.ts
git commit -m "chore: remove starbase CLI tests"
```

---

### Task 19: Clean up settings store for removed notification keys

**Files:**
- Modify: `src/main/settings-store.ts` (if it has defaults for `comms`/`memos` notifications or `visualizer`)

- [ ] **Step 1: Check and remove starbase defaults**

Search for `comms`, `memos`, `visualizer` in the settings store and remove their defaults.

- [ ] **Step 2: Commit**

```bash
git add src/main/settings-store.ts
git commit -m "chore: remove starbase notification/visualizer settings defaults"
```

---

### Task 20: Delete all Star Command docs, specs, and plans

**Files to delete:**

- `docs/star-command.md`
- `docs/star-command-visual-prompts.md`
- `docs/star-command-chart-prompts.md`
- `docs/star-command-diagrams.mermaid`
- `star-command-asset-prompts.md` (root)
- All files in `docs/superpowers/specs/` and `docs/superpowers/plans/` that reference star command (check each file — some may be for unrelated features)

- [ ] **Step 1: Delete star command docs**

```bash
rm -f docs/star-command.md
rm -f docs/star-command-visual-prompts.md
rm -f docs/star-command-chart-prompts.md
rm -f docs/star-command-diagrams.mermaid
rm -f star-command-asset-prompts.md
```

- [ ] **Step 2: Delete star command specs and plans**

Delete specs and plans that are primarily about star command features. Use grep to identify:
```bash
grep -l "star.command\|starbase\|admiral\|crew.*deploy\|sector.*service\|first.officer\|navigator.*protocol" docs/superpowers/specs/*.md docs/superpowers/plans/*.md
```

Review and delete the identified files.

- [ ] **Step 3: Commit**

```bash
git add -A
git commit -m "chore: delete star command docs, specs, and plans"
```

---

### Task 21: Typecheck and lint verification

- [ ] **Step 1: Run typecheck**

```bash
npm run typecheck
```

Expected: PASS (0 errors). If there are errors, fix the remaining broken imports/references.

- [ ] **Step 2: Run lint**

```bash
npm run lint
```

Expected: PASS. Fix any lint errors (unused imports, etc.).

- [ ] **Step 3: Run build**

```bash
npm run build
```

Expected: PASS.

- [ ] **Step 4: Commit any fixes**

```bash
git add -A
git commit -m "fix: resolve typecheck and lint errors from star command removal"
```

---

### Task 22: Update CHANGELOG.md

- [ ] **Step 1: Add entry to CHANGELOG.md**

Add at the top of the changelog (under the latest version or as a new unreleased section):
```markdown
- Removed Star Command system (starbase, crews, missions, sectors, comms, cargo, protocols, admiral, navigator, first officer)
- Removed fleet CLI commands: sectors, missions, crew, comms, cargo, log, protocols, config
- Kept fleet CLI commands: images, open
```

- [ ] **Step 2: Commit**

```bash
git add CHANGELOG.md
git commit -m "docs: update changelog for star command removal"
```
