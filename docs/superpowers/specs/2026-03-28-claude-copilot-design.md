# Claude Copilot — Design Spec

A macOS-only feature that adds a draggable, always-on-top pixel art spaceship to the desktop. It monitors Claude Code sessions via hooks and provides quick access to session status, permission approvals, and chat history.

## Architecture Overview

Four components:

1. **Spaceship Window** — a separate frameless, transparent `BrowserWindow` with its own React root. Renders the animated sprite + expanded panel. Communicates with Fleet's main process via IPC.

2. **Hook System** (main process) — installs a Python hook script to `~/.claude/hooks/` and registers it in `~/.claude/settings.json`. Runs a Unix socket server on `/tmp/fleet-copilot.sock` to receive session events from Claude Code.

3. **Session Store** (main process) — an in-memory store tracking all active Claude Code sessions, their phases, chat items, and pending permission requests. Pushes updates to the spaceship window via IPC.

4. **OS Gate** — the entire feature is behind a `process.platform === 'darwin'` check. On Windows/Linux, none of the above is created, registered, or loaded.

## Spaceship Window Behavior

### Window Properties

- Frameless, transparent, no shadow, always-on-top (`level: 'pop-up-menu'`)
- Visible on all Spaces/desktops via `setVisibleOnAllWorkspaces(true)`
- Non-activating (`focusable: false`) — doesn't steal focus from terminal
- No separate dock icon (part of Fleet's process)
- Starts at default position (top-right corner), remembers last position across restarts

### States

**Collapsed** — just the spaceship sprite (~48x48px). Draggable. Sprite animates based on aggregate session state.

**Expanded** — clicking the spaceship opens a panel anchored to the sprite. Panel contains session list, permission controls, chat history, settings. Clicking outside or pressing Escape collapses back.

### Drag Behavior

- Click-and-drag moves the spaceship anywhere on screen
- Short click (no movement) toggles expanded/collapsed
- Position persisted to Fleet's settings store

### Sprite Animation (CSS Sprite Sheet)

Single PNG sprite sheet with all frames, animated via `background-position` stepping. Default sprite is Fleet's pixel art spaceship (placeholder until AI-generated sprites are ready). Sprite sheet is swappable via settings.

Animation states mapped to session status:
- **No sessions** — gentle idle bob
- **Processing** — thruster flame animation
- **Permission needed** — amber pulse (highest priority, overrides processing)
- **Complete** — green flash, then back to idle

## Hook System & Session Monitoring

### Hook Installation (on feature enable)

Writes `fleet-copilot.py` to `~/.claude/hooks/` and merges hook entries into `~/.claude/settings.json` for these Claude Code events:

- `SessionStart`, `SessionEnd`
- `UserPromptSubmit`
- `PreToolUse`, `PostToolUse`
- `PermissionRequest` (with long timeout for synchronous response)
- `Notification`, `Stop`

### Socket Server

- Listens on `/tmp/fleet-copilot.sock` (Unix domain socket via Node `net.createServer()`)
- Receives newline-delimited JSON events from the Python hook
- For `PermissionRequest`: holds the connection open until user approves/denies from the panel, then writes the response back

### Session Store

- Tracks sessions by ID with: phase, working directory, chat history, pending permissions, PID
- Phase state machine: `idle -> processing -> waitingForInput -> ended`
- Pushes state updates to spaceship window via IPC

### Uninstall/Disable

- Removes hook entries from `settings.json` and deletes the Python script
- Clean socket server shutdown

## Expanded Panel UI

### Session List View (default)

- Lists all active Claude Code sessions, sorted by priority: permission needed > processing > idle
- Each row: working directory basename, phase icon, time elapsed
- Click a session to open detail view
- Inline approve/deny buttons for pending permissions

### Chat/Detail View

- Back button to return to session list
- Scrollable chat history with markdown rendering
- Tool execution results with stdout/stderr
- Permission request card with approve (once/always) and deny buttons
- Working directory and process info

### Settings View (gear icon)

- Enable/disable copilot
- Notification sound picker (macOS system sounds via `afplay`)
- Sprite selector (swap sprite sheet image)
- Launch behavior (auto-start copilot when Fleet opens)
- Hook status with reinstall button

### Panel Sizing

- ~350px wide, ~500px tall max
- Anchored to spaceship position, flips direction if near screen edge
- Smooth expand/collapse CSS animation

## OS Gate & Fleet Integration

### OS Detection

- Single guard: `process.platform === 'darwin'`
- Guards all copilot code: window creation, socket server, hook installation, IPC handlers
- No copilot UI or settings visible on Windows/Linux

### Fleet Integration

- Opt-in toggle in Fleet's settings panel (macOS only)
- Fleet main window and copilot window are independent
- Fleet quit tears down copilot window and socket server
- Monitors all Claude Code instances system-wide (Fleet's own terminals + external)

### Settings Persistence

- Copilot settings (enabled, sprite, sound, position) in Fleet's existing settings store
- Hook installation state tracked to avoid redundant installs

## File Structure

```
src/main/copilot/
  index.ts            — OS gate, init/teardown orchestrator
  copilot-window.ts   — BrowserWindow creation & management
  hook-installer.ts   — Python script + settings.json management
  socket-server.ts    — Unix socket server
  session-store.ts    — In-memory session state
  ipc-handlers.ts     — Copilot-specific IPC registration

src/renderer/copilot/
  App.tsx             — Copilot React root
  SpaceshipSprite.tsx — Sprite sheet animation + drag logic
  SessionList.tsx     — Session list view
  SessionDetail.tsx   — Chat/detail view
  CopilotSettings.tsx — Settings panel
  store/
    copilot-store.ts  — Zustand store for copilot UI state

src/renderer/copilot/assets/
  spaceship-default.png  — Default sprite sheet (placeholder)

hooks/
  fleet-copilot.py    — Python hook script bundled with app
```

## Technical Feasibility

All Claude Island capabilities translate to Electron:

| Capability | Approach |
|---|---|
| Always-on-top transparent window | `BrowserWindow` with `transparent`, `frame: false`, `alwaysOnTop` |
| Non-activating, all Spaces | `focusable: false`, `setVisibleOnAllWorkspaces(true)` |
| Click-through when collapsed | `setIgnoreMouseEvents(true, { forward: true })` |
| Unix socket server | Node `net.createServer()` |
| Hook installation | Node `fs` module |
| Permission sync response | Hold socket connection open |
| Tmux integration | `child_process.execFile('tmux', ...)` |
| Window focus (yabai) | `child_process.execFile('yabai', ...)` |
| System sounds | `child_process.spawn('afplay', ...)` |
| Launch at login | `app.setLoginItemSettings()` |
| Multi-monitor | `screen.getAllDisplays()` |
| Process discovery | `ps` / `lsof` via `child_process` |

No native addons required. The draggable spaceship approach avoids the two hardest Claude Island problems (notch geometry detection and global mouse monitoring).
