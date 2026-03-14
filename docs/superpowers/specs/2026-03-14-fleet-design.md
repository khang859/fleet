# Fleet — Design Spec

A lightweight, cross-platform terminal multiplexer desktop app for developers running multiple AI coding agents simultaneously. Ships as a standalone Electron app for macOS and Windows.

**Target audience:** All developers managing multiple terminal sessions, with special powers for AI agent workflows.

**Architecture approach:** Layered core — build a solid terminal multiplexer foundation, then layer on notifications, socket API, and agent visualizer as loosely coupled modules that hook into the core via an internal event bus.

---

## Data Model

```ts
type Workspace = {
  id: string;
  label: string;
  tabs: Tab[];
};

type Tab = {
  id: string;
  label: string;         // user-editable, defaults to cwd basename + git branch
  cwd: string;           // initial cwd for the tab — used as default for new panes
  splitRoot: PaneNode;   // root of the binary split tree
};

type PaneNode =
  | PaneSplit
  | PaneLeaf;

type PaneSplit = {
  type: 'split';
  direction: 'horizontal' | 'vertical';
  ratio: number;         // 0.0–1.0, position of the divider
  children: [PaneNode, PaneNode];
};

type PaneLeaf = {
  type: 'leaf';
  id: string;            // paneId — used consistently across event bus, socket API, and visualizer
  ptyPid?: number;
  shell?: string;        // shell or command spawned in this pane
  cwd: string;           // initial cwd at pane creation — not live-tracked (shell may cd elsewhere)
};

// level values map to notification table rows:
// 'permission' = Needs permission (amber badge)
// 'error'      = Process exit non-zero (red badge)
// 'info'       = Task complete / OSC 9 (blue badge)
// 'subtle'     = Process exit zero
type NotificationState = {
  paneId: string;
  level: 'permission' | 'error' | 'info' | 'subtle';
  timestamp: number;
};

type AgentVisualState = {
  paneId: string;
  label: string;
  state: 'working' | 'reading' | 'idle' | 'walking' | 'needs-permission' | 'waiting' | 'not-agent';
  currentTool?: string;
  subAgents: AgentVisualState[];
  uptime: number;
};
```

`paneId` (the leaf node ID) is the canonical identifier used across Layer 2 (event bus), Layer 3 (socket API), and Layer 4 (agent state tracker).

---

## Layer 1: Terminal Core

The foundation. Workspaces, tabs, split panes, and PTY management.

### Workspaces

- A workspace is a named, saveable layout: a set of tabs, each containing a tree of split panes.
- Users create, save, load, and delete workspaces from a workspace picker (dropdown or modal at the top of the sidebar).
- One workspace is active at a time. Switching workspaces shows a confirmation dialog if any PTY processes are still running, then tears down current PTYs and restores the new layout.
- Named workspaces save layout structure only — on load, they re-spawn fresh shell processes (not previous PTY state).
- A "default" workspace auto-saves on quit and restores on launch.
- Workspaces are persisted to disk via `electron-store`.

### Sidebar

- Vertical tab list on the left. Each tab shows a label (user-editable, defaults to cwd basename + git branch).
- Tabs are reorderable via drag-and-drop.
- Right-click context menu: rename, close, duplicate, move to workspace.
- Active tab is highlighted. Tabs with notifications show a badge (see Layer 2).

### Pane Splitting

- Each tab contains a recursive binary split tree (horizontal or vertical), as defined in the data model (`PaneNode`).
- Keyboard shortcuts: `Cmd+D` horizontal split, `Cmd+Shift+D` vertical split, `Cmd+[/]` or `Cmd+Arrow` to navigate panes.
- Resize splits via drag handles (updates `ratio` on the parent `PaneSplit`).
- Each `PaneLeaf` owns one xterm.js instance backed by one node-pty process.
- Closing the last pane in a tab closes the tab.

### Terminal

- xterm.js with WebGL addon, canvas fallback on unsupported GPUs.
- Cross-platform shell detection: zsh/bash on macOS, WSL/PowerShell on Windows (auto-detect WSL distros via `wsl.exe --list --quiet`).
- tmux passthrough — don't intercept tmux control sequences, let them flow through. Detect tmux presence via `\x1bPtmux;` DCS sequence (not generic `\x1bP` which matches sixel graphics and other DCS uses) and reflect in sidebar label.
- Configurable scrollback buffer (default 10,000 lines).
- Search within terminal output (`Cmd+F` scoped to active pane). Uses xterm.js's `SearchAddon`, limited to the in-memory scrollback buffer (up to the configured line limit).

### Shell Spawning

When creating a pane (via UI or socket API `new-tab`/`new-pane`):

- If `cmd` is provided, spawn the user's default shell with `cmd` as the startup command (e.g., `zsh -c "claude"`). This ensures the pane remains an interactive shell after the command exits.
- If `cmd` is omitted, spawn the user's default shell with no startup command.
- The `shell` field on `PaneLeaf` records what was spawned.

### Data Flow

```
Renderer (React)          Main Process
+---------------+        +----------------+
| TerminalPane  |--IPC-->| pty-manager    |--spawns--> PTY process
| (xterm.js)    |<--IPC--| (Map<id, IPty>)|<--data---|
+---------------+        +----------------+
                           |
                           v
                         layout-store (electron-store)
```

---

## Layer 2: Notification System

Watches PTY data streams for signals and routes them through a central event bus. All detection runs in the main process via `pty.onData()` (not xterm.js's `term.onData()`).

### Detection Sources

- **OSC 9/777 escape sequences** — Claude Code emits these natively on task completion. Caught by `notification-detector.ts` in the main process scanning PTY output before it's forwarded to the renderer.
- **Permission prompts** — detected by pattern matching on PTY output (Claude Code's permission request format).
- **Process exit** — PTY process exits. Pane shows exit code and optionally auto-closes or holds.

### Notification Types & Defaults

| Event                  | Badge       | Sound | OS Notification |
|------------------------|-------------|-------|-----------------|
| Task complete (OSC 9)  | Yes (blue)  | Off   | Off             |
| Needs permission       | Yes (amber) | On    | On              |
| Process exit (non-zero)| Yes (red)   | Off   | Off             |
| Process exit (zero)    | Subtle      | Off   | Off             |

All configurable per-type in a settings panel. Users toggle each channel (badge/sound/OS) independently for each event type.

### Badge Rendering

- Colored dot on the tab in the sidebar (amber for permission, red for error, blue for general).
- Badge clears when the user focuses that pane. The renderer sends a `pane-focused` IPC message to the main process to clear notification state.
- If multiple panes in one tab have notifications, the tab shows the highest-priority badge. Priority order (highest first): Needs Permission (amber) > Process exit non-zero (red) > Task complete (blue).

### OS Notifications

- Uses Electron's `Notification` API.
- Clicking the notification focuses Fleet and switches to the relevant pane.
- Respects OS-level Do Not Disturb / Focus modes.

### Sound

- Short, subtle chime. Ships with one default sound.
- Toggleable globally and per-event-type.
- No continuous or looping sounds.

### IPC Boundary

- `notification-detector.ts` lives in the **main process**, hooks into `pty.onData()`.
- It emits events to `event-bus.ts` (also main process).
- The event bus forwards relevant events to the renderer via IPC for badge and sound rendering.
- OS notifications are dispatched directly from the main process.
- The renderer sends `pane-focused` IPC messages back to the main process to clear badge state.

### Internal Event Bus

```
PTY data stream (main process)
  |
  v
notification-detector.ts  <-- scans for OSC sequences + patterns (main process)
  |
  v
event-bus.ts  <-- emits typed events: { paneId, type, timestamp } (main process)
  |
  |--IPC--> renderer: sidebar badges, sound player
  |-------> OS notification (main process, direct)
  +-------> agent state tracker (main process, see Layer 4)
```

The event bus is the key extension point. The visualizer and socket API subscribe to the same events.

---

## Layer 3: Socket API

Exposes Fleet's internals for scripts and agents. Sits in the main process, listens on a local socket.

### Transport

- macOS: Unix socket at `~/.fleet/fleet.sock` (directory created on first launch if missing)
- Windows: Named pipe `\\.\pipe\fleet`
- JSON-over-newline protocol (one JSON object per line, newline-delimited)

### Request/Response Model

- Every request has a `type` and optional `id` (for correlating responses).
- Responses include `ok: true/false`, an optional `error` string on failure, and relevant data.
- Error responses use the format: `{"ok": false, "id": "...", "error": "pane not found: abc123"}`
- References to nonexistent `paneId` or `tabId` return an error response, not a crash.

### Commands

| Command            | Description                                              |
|--------------------|----------------------------------------------------------|
| `list-workspaces`  | List saved workspaces                                    |
| `load-workspace`   | Switch to a workspace                                    |
| `list-tabs`        | List tabs in current workspace                           |
| `new-tab`          | Create a new tab, optionally with a command and cwd      |
| `close-tab`        | Close a tab by ID                                        |
| `list-panes`       | List panes in a tab                                      |
| `new-pane`         | Split a pane (direction, command, cwd)                   |
| `close-pane`       | Close a pane by ID                                       |
| `focus-pane`       | Focus a specific pane                                    |
| `send-input`       | Send keystrokes to a pane                                |
| `get-output`       | Snapshot of last N lines from a pane's scrollback (default 100, max capped at scrollback buffer size) |
| `get-state`        | Get full app state (workspace, tabs, panes, notifications)|
| `subscribe`        | Stream events (see Subscription Lifecycle below). Valid event types: `notification`, `pane-created`, `pane-closed`, `agent-state-change`, `workspace-loaded` |

### Subscription Lifecycle

- Client sends `{"type": "subscribe", "events": ["notification", "pane-created", ...]}`.
- Server responds with `{"ok": true, "id": "..."}` as an ack.
- One connection can subscribe to multiple event types in a single request.
- Server sends one JSON line per event for the lifetime of the connection.
- When the client disconnects, the subscription is cleaned up automatically (no explicit unsubscribe needed).
- When Fleet quits, all subscription connections are closed by the server.

### Example Usage

```bash
# Spin up a 3-agent workspace
echo '{"type":"new-tab","label":"api","cmd":"claude","cwd":"/proj/api"}' | nc -U ~/.fleet/fleet.sock
echo '{"type":"new-tab","label":"web","cmd":"claude","cwd":"/proj/web"}' | nc -U ~/.fleet/fleet.sock
echo '{"type":"new-tab","label":"tests","cmd":"npm run test:watch","cwd":"/proj"}' | nc -U ~/.fleet/fleet.sock

# Subscribe to events (persistent connection)
nc -U ~/.fleet/fleet.sock <<< '{"type":"subscribe","events":["notification"]}'
# Server streams: {"event":"notification","paneId":"abc","level":"permission","timestamp":1710000000}
```

### Security

- Socket is local-only, no network exposure.
- File permissions on the socket restrict access to the current user (0600 on Unix).
- No authentication beyond filesystem permissions — same trust model as Docker/tmux sockets.

---

## Layer 4: Agent Visualizer

A pixel-art office scene that visualizes running AI agents as animated characters. First-class feature and key differentiator.

### Architecture

- A React component wrapping a `<canvas>`, rendered in a toggleable panel.
- Panel modes: bottom drawer (slides up, resizable height) or dedicated tab. User's choice in settings.
- Toggle via `Cmd+Shift+V` or sidebar button.
- The visualizer is a pure consumer of agent state — it reads, never writes.

### Agent State Tracking

`agent-state-tracker.ts` lives in the **main process**. It subscribes to the event bus and maintains a `Map<paneId, AgentVisualState>`. The renderer subscribes to state snapshots via IPC (the tracker pushes diffs on every state change, not full snapshots on every frame).

```
event-bus.ts (main process)
  |
  v
agent-state-tracker.ts (main process) <-- maintains Map<paneId, AgentVisualState>
  |
  --IPC--> renderer: visualizer component (reads state, renders canvas)
```

### Agent Detection — Primary: JSONL Transcript Watching

Agent activity is detected primarily via Claude Code's JSONL transcript files, not PTY output scanning. This is more reliable and structured than parsing terminal output.

- Claude Code writes session transcripts to `~/.claude/projects/<hash>/<session-id>.jsonl`.
- `agent-state-tracker.ts` watches the `~/.claude/projects/` directory for new/modified JSONL files.
- When a new pane spawns, the tracker correlates it with JSONL files by matching the pane's `cwd` to the project hash and watching for session files created around the same timestamp. If multiple panes share the same `cwd`, disambiguation uses the JSONL session file's creation timestamp proximity to the pane's spawn time and the PTY's PID (if available in the JSONL metadata).
- Record types used for state detection:
  - `assistant` records with `tool_use` blocks → Working or Reading state (based on tool name)
  - `user` records with permission-related content → Needs Permission state
  - `progress` records → active tool execution
  - Absence of records for >5 seconds → Idle state
- OSC 9/777 sequences remain the **notification** signal (Layer 2) but are not used for visual state detection.

**Fallback:** If no JSONL file is found for a pane within 30 seconds, fall back to PTY output pattern matching as a degraded detection mode. This handles non-Claude-Code agents or future agent tools.

Non-agent panes (dev servers, build watchers) don't get a character. The visualizer only shows panes it detects as running an AI agent.

### Agent States

| State            | Trigger                                         | Animation                        |
|------------------|-------------------------------------------------|----------------------------------|
| Working          | `tool_use` detected (Write, Edit, Bash)         | Seated, typing (2-frame)         |
| Reading          | `tool_use` detected (Read, Grep, Glob)          | Seated, reading (2-frame)        |
| Walking          | Character moving to desk or wander tile         | 4-frame walk cycle               |
| Idle             | No tool activity for >5 seconds                 | Standing, occasional wander      |
| Needs permission | Permission prompt detected                      | Typing + amber speech bubble     |
| Waiting          | Agent waiting for user input                    | Idle + green checkmark bubble    |
| Not an agent     | No agent patterns detected after 30s            | No character shown               |

Walking is a transitional state: triggered when a character needs to move from its current tile to the desk seat (on activation) or to a wander tile (when idle). Uses BFS pathfinding against the office tilemap.

### Sub-Agent Detection

Sub-agents are detected via JSONL `progress` records:

- Records with `data.type === 'agent_progress'` containing nested `assistant`/`user` blocks indicate sub-agent tool activity.
- The `parentToolUseID` field links the sub-agent to its parent.
- Sub-agents appear as smaller characters near the parent's desk.
- Inherit parent palette with a hue shift.
- Despawn when the sub-task completes (no more `progress` records for that `parentToolUseID`) or when the parent despawns.

### Office Scene

- Fixed isometric tilemap: desks, chairs, floor, walls, bookshelves.
- Up to 8 desk positions (matching typical max). Desks dynamically extend if more agents spawn.
- Each agent gets a unique palette (6 base palettes, hue-shifted beyond 6).
- Seat assignment is stable — same pane always gets the same desk for the session.

### Workspace Switching

When a workspace switch occurs:
- All agent characters despawn simultaneously with the matrix rain effect.
- Seat assignments are reset.
- New agents from the loaded workspace spawn fresh with new seat assignments and matrix rain.

### Interactions

- Click a character to focus the corresponding terminal pane.
- Hover for a tooltip showing label, current tool, and uptime.
- Characters spawn/despawn with matrix rain effect.

### Rendering

- `requestAnimationFrame` loop at 60 FPS.
- Z-sorted back-to-front for depth (characters behind desks when further back).
- Canvas rendered at native pixel resolution, scaled up with nearest-neighbor for crisp pixel art.
- When the panel is hidden, the render loop pauses (no wasted cycles).

### Assets

- Tilemap + furniture: 16x16 pixel tiles (hand-drawn or adapted pixel art, shipped as PNGs).
- Characters: 16x24 sprites, 6 base palettes x 4 directions x 3 animation sets (walk 4-frame, type 2-frame, read 2-frame).
- All loaded as `ImageBitmap` at startup. Hue-shifting applied at character creation time via a cached offscreen canvas keyed by palette and hue-shift value.
- The `reference/pixel-agents` repo has a working implementation of most of this — study its sprite pipeline and rendering engine.

---

## Layer 5: Cross-Cutting Concerns

### Settings

Single settings panel (modal or dedicated tab) covering all layers:

- **General:** default shell, scrollback size, font family/size, theme (dark/light)
- **Notifications:** per-event-type toggles for badge/sound/OS notification (this includes the agent "waiting" chime — it's the sound toggle for the "Waiting" event type)
- **Socket API:** socket path, enable/disable
- **Visualizer:** default panel mode (drawer/tab)

Persisted via `electron-store` alongside workspace layouts.

### Keyboard Shortcuts

Configurable, with platform-aware defaults:

**macOS defaults:**

| Shortcut          | Action              |
|-------------------|---------------------|
| `Cmd+T`           | New tab             |
| `Cmd+W`           | Close pane          |
| `Cmd+D`           | Split horizontal    |
| `Cmd+Shift+D`     | Split vertical      |
| `Cmd+[/]`         | Navigate panes      |
| `Cmd+1-9`         | Switch tabs         |
| `Cmd+F`           | Search in pane      |
| `Cmd+Shift+V`     | Toggle visualizer   |
| `Cmd+/`           | Show shortcuts panel|

**Windows defaults** (adjusted to avoid shell conflicts):

| Shortcut            | Action              |
|---------------------|---------------------|
| `Ctrl+T`            | New tab             |
| `Ctrl+Shift+W`      | Close pane          |
| `Ctrl+Shift+D`      | Split horizontal    |
| `Ctrl+Shift+Alt+D`  | Split vertical      |
| `Ctrl+[/]`          | Navigate panes      |
| `Ctrl+1-9`          | Switch tabs         |
| `Ctrl+Shift+F`      | Search in pane      |
| `Ctrl+Shift+V`      | Toggle visualizer   |
| `Ctrl+/`            | Show shortcuts panel|

Note: `Ctrl+D` (EOF), `Ctrl+W` (word delete), and `Ctrl+F` (some shells use it) are avoided on Windows to prevent conflicts with shell interactions.

### Auto-Updater

- `electron-updater` + GitHub Releases.
- Check on launch, show unobtrusive badge when update is available.
- User triggers install + restart.

### Distribution

| Platform | Format                          | Tooling            |
|----------|---------------------------------|--------------------|
| macOS    | `.dmg` (universal arm64 + x64)  | `electron-builder` |
| Windows  | `.exe` NSIS installer           | `electron-builder` |

GitHub Actions CI builds both targets on push to `main`, uploads artifacts to GitHub Release.

---

## What's Cut

- **In-app browser pane** — unnecessary complexity, users can Cmd+Tab to their browser.
- **Session replay / scrollback export** — revisit post-v1.
- **Tab grouping** — workspaces subsume this concept.
- **CLI wrapper (`fleet` command)** — post-v1 consideration, not part of initial build.

---

## Stack

| Layer              | Choice                          |
|--------------------|---------------------------------|
| Shell              | Electron                        |
| Build              | electron-vite + React + TypeScript |
| Terminal emulation | xterm.js (WebGL + canvas fallback) |
| PTY                | node-pty                        |
| UI chrome          | shadcn/ui + Tailwind            |
| Layout persistence | electron-store                  |
| Auto-updater       | electron-updater + GitHub Releases |
