# Fleet

A lightweight, cross-platform terminal multiplexer desktop app targeted at developers running multiple AI coding agents simultaneously. Think CMUX, but cross-platform — ships as a standalone installer for both Windows and macOS.

---

## Problem

Running multiple Claude Code sessions, background watchers, dev servers, and build processes across scattered terminal windows is noisy and hard to manage. CMUX solves this on macOS but is Mac-only. Nothing comparable exists as a polished, cross-platform standalone app.

---

## Core Idea

A native-feeling desktop app that wraps real PTY processes in a clean UI — vertical tabs per project/task, split panes per tab, and notification rings when an agent needs attention. Scriptable via a local socket API.

---

## Stack

| Layer              | Choice                             | Why                                                  |
| ------------------ | ---------------------------------- | ---------------------------------------------------- |
| Shell              | Electron                           | Renderer is a real browser, easy IPC, cross-platform |
| Build              | electron-vite + React + TypeScript | Fast HMR, familiar stack                             |
| Terminal emulation | xterm.js                           | Industry standard, WebGL renderer                    |
| PTY                | node-pty                           | Spawns real shell processes                          |
| UI chrome          | shadcn/ui + Tailwind               | Covers sidebar, tabs, badges, dialogs                |

---

## Features

- **Vertical tab sidebar** — one tab per project or task, shows cwd + git branch
- **Split panes** — horizontal/vertical splits within a tab, each its own PTY
- **Notification rings** — panes badge when a process emits OSC 9/777 escape (Claude Code does this natively)
- **Persist layout** — remember tabs/panes between sessions
- **Socket API** — open a new pane, send input, query state from scripts or Claude Code hooks
- **In-app browser pane** — Electron WebView alongside terminal splits
- **Tab grouping / workspaces**
- **Search across terminal output**
- **Session replay / scrollback export**
- **Windows-native WSL shell auto-detection**
- **Agent Visualizer** — pixel-art office scene showing agent activity (see section below)

---

## Agent Visualizer

A pixel-art office scene that visualizes running AI agents as animated characters — inspired by `reference/pixel-agents`. Lives in a toggleable panel (drawer or separate tab) and gives an ambient, at-a-glance view of what every agent is doing.

### Why

Terminal output scrolls fast and looks identical across panes. The visualizer gives spatial, intuitive feedback: "the one at the left desk is typing, the one in the middle is idle, the one on the right needs permission." Useful when running 3+ agents and you don't want to scan every pane.

### Visual Elements

| Element              | Detail                                                                                                             |
| -------------------- | ------------------------------------------------------------------------------------------------------------------ |
| **Office tilemap**   | Isometric-ish pixel-art floor, walls, desks, chairs, bookshelves — rendered on a `<canvas>`                        |
| **Agent characters** | 16×24 pixel sprites, one per running agent. Each gets a unique palette (6 base palettes, hue-shifted beyond 6)     |
| **Speech bubbles**   | Small pixel-art bubbles above characters — amber dots for "needs permission," green checkmark for "waiting on you" |
| **Spawn/despawn FX** | Matrix-style green digital rain when an agent starts or stops                                                      |

### Agent States → Animations

| Agent State          | Character Animation                                                | Trigger                                                            |
| -------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------ |
| **Working**          | Seated at desk, typing animation (2 frames, 0.3s/frame)            | Tool execution starts (Write, Edit, Bash, etc.)                    |
| **Reading**          | Seated at desk, reading animation (2 frames, 0.3s/frame)           | Read/Grep/Glob/WebFetch tool detected                              |
| **Walking**          | 4-frame walk cycle moving between tiles                            | Transitioning to seat or wandering                                 |
| **Idle**             | Standing still, occasional wander to random tile then back to seat | No active tool, agent waiting for next task                        |
| **Needs permission** | Typing + amber bubble                                              | Agent emits a permission request (detected via PTY output parsing) |
| **Waiting**          | Idle + green checkmark bubble (auto-fades after 2s)                | Agent signals it's waiting for user input                          |

### State Detection

Agent activity is detected from the PTY data stream — no special agent protocol required:

```ts
// Parse Claude Code's stderr/stdout for tool activity
// Option A: Watch for known patterns in terminal output
// Option B: If Socket API is in use, agents can report state directly
// Option C: JSONL transcript file watching (like pixel-agents does with .claude/ files)

type AgentVisualState = {
  id: string; // maps to paneId
  label: string; // pane label / cwd basename
  isActive: boolean; // currently executing a tool
  currentTool?: string; // 'Read' | 'Edit' | 'Bash' | etc.
  needsPermission: boolean;
  isWaiting: boolean;
};
```

### Seat Assignment & Sub-Agents

- Each agent is assigned a desk/seat in the office when its pane is created
- If an agent spawns sub-agents (Claude Code `Task` tool), sub-agents appear as smaller characters near the parent's desk
- Sub-agents inherit the parent's palette with a hue shift
- When a pane is closed, the character despawns with a matrix rain effect and the seat is freed

### Integration with Fleet

- **Toggle**: Button in the sidebar or a keyboard shortcut (e.g., `Cmd+Shift+V`) opens/closes the visualizer panel
- **Click-to-focus**: Clicking a character in the office focuses the corresponding terminal pane
- **Hover tooltip**: Shows agent label, current tool, and uptime
- **Panel modes**: Drawer overlay (slides up from bottom) or dedicated tab
- **Sound**: Optional subtle chime when an agent transitions to "waiting" state (toggleable in settings)

### Rendering

```
Renderer (React component wrapping <canvas>)
├── OfficeState        → tracks all characters, furniture, bubbles
├── TilemapRenderer    → floor/wall tiles, furniture sprites
├── CharacterRenderer  → sprite selection, walk/type/idle animation, z-sorting
├── BubbleRenderer     → permission/waiting bubbles positioned above characters
└── MatrixEffect       → spawn/despawn green rain overlay
```

- 60 FPS via `requestAnimationFrame`
- Z-sorted back-to-front rendering (characters behind desks when further back)
- Canvas scales to panel size, pixel-art rendered at native resolution then scaled up (nearest-neighbor for crisp pixels)

### Assets

- Tilemap + furniture sprites: hand-drawn or adapted pixel art (16×16 tiles)
- Character sprites: 6 base palettes × 4 directions × 3 animation sets (walk 4-frame, type 2-frame, read 2-frame)
- All sprites shipped as PNGs, loaded into `ImageBitmap` at startup
- Hue-shift applied at load time for agents beyond the 6th

---

## Architecture Sketch

```
Electron Main Process
├── pty-manager.ts     → Map<PaneId, IPty>, spawns/kills PTY processes
├── ipc-handlers.ts    → bridges renderer ↔ pty-manager
├── socket-api.ts      → local Unix socket for CLI/script automation
└── layout-store.ts    → persists tab/pane layout to disk (JSON)

Electron Renderer Process (React)
├── App.tsx            → root layout (sidebar + pane grid)
├── Sidebar.tsx        → shadcn Sidebar, tab list, badges
├── PaneGrid.tsx       → CSS grid, splits, resize handles
└── TerminalPane.tsx   → mounts xterm.js instance, wires IPC
```

---

## Data Model

```ts
type Workspace = {
  id: string;
  label: string;
  cwd: string;
  branch?: string;
  panes: Pane[];
};

type Pane = {
  id: string;
  split: 'horizontal' | 'vertical' | 'none';
  children?: [Pane, Pane];
  ptyPid?: number;
  hasNotification: boolean;
};
```

---

## Notification Detection

Watch for OSC escape sequences in the PTY data stream:

```ts
term.onData((data) => {
  if (data.includes('\x1b]9;') || data.includes('\x1b]777;')) {
    markPaneNotified(paneId);
  }
});
```

Claude Code emits these automatically on task completion. No agent config needed.

---

## Socket API (Automation)

```bash
# Open a new pane in tab "my-project" running a command
echo '{"type":"new-pane","tabId":"my-project","cmd":"claude"}' | nc -U /tmp/terminal.sock

# Send input to a specific pane
echo '{"type":"input","paneId":"abc123","data":"npm run dev\n"}' | nc -U /tmp/terminal.sock
```

Enables Claude Code hooks to control the terminal layout programmatically.

---

## Distribution

Standalone installers — no Node.js or npm required on the user's machine.

| Platform | Format                          | Tooling            |
| -------- | ------------------------------- | ------------------ |
| macOS    | `.dmg` (universal, arm64 + x64) | `electron-builder` |
| Windows  | `.exe` NSIS installer           | `electron-builder` |

```jsonc
// electron-builder config
{
  "appId": "com.yourname.fleet",
  "productName": "Fleet",
  "mac": {
    "target": [{ "target": "dmg", "arch": ["universal"] }],
    "category": "public.app-category.developer-tools"
  },
  "win": {
    "target": [{ "target": "nsis", "arch": ["x64"] }]
  }
}
```

CI/CD: GitHub Actions builds both targets on push to `main`, uploads artifacts to a GitHub Release automatically.

---

## Cross-Platform Shell Detection

```ts
function getDefaultShell(): string {
  if (process.platform === 'win32') {
    // Prefer WSL if available, fall back to PowerShell
    return hasWSL() ? 'wsl.exe' : 'powershell.exe';
  }
  return process.env.SHELL ?? '/bin/zsh';
}

function hasWSL(): boolean {
  try {
    execSync('wsl.exe --status', { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}
```

On Windows, also auto-detect installed WSL distros via `wsl.exe --list --quiet` and let the user pick one in settings.

---

## Platform-Specific Notes

**macOS**

- Request `NSAppleEventsUsageDescription` for AppleScript automation hooks
- Use `electron-builder`'s notarize step for Gatekeeper compliance
- Socket API uses a Unix socket at `~/.fleet/fleet.sock`

**Windows**

- Socket API uses a named pipe: `\\.\pipe\fleet`
- node-pty on Windows spawns via ConPTY (Windows 10 1903+)
- WSL path translation: strip `/mnt/c/` → `C:\` for cwd display in sidebar
- Code-sign the `.exe` installer to avoid SmartScreen warnings

---

## Decided

| Decision            | Choice                                                       |
| ------------------- | ------------------------------------------------------------ |
| Layout persistence  | `electron-store` — typed, schema-validated, zero-config      |
| Terminal renderer   | xterm.js WebGL addon, fallback to canvas on unsupported GPUs |
| tmux/screen support | Yes — passthrough mode, don't fight it                       |
| Auto-updater        | `electron-updater` + GitHub Releases                         |

### Layout Persistence (`electron-store`)

```ts
import Store from 'electron-store';

type Layout = { workspaces: Workspace[] };

const store = new Store<Layout>({
  schema: {
    workspaces: { type: 'array', default: [] }
  }
});

// Save
store.set('workspaces', getWorkspaces());

// Load
const workspaces = store.get('workspaces');
```

### WebGL with Canvas Fallback

```ts
import { WebglAddon } from '@xterm/addon-webgl';
import { CanvasAddon } from '@xterm/addon-canvas';

const term = new Terminal();
term.open(container);

try {
  const webgl = new WebglAddon();
  webgl.onContextLoss(() => webgl.dispose()); // graceful fallback trigger
  term.loadAddon(webgl);
} catch {
  term.loadAddon(new CanvasAddon());
}
```

### tmux Passthrough

Don't try to parse or intercept tmux control sequences — let them flow through the PTY as-is. Just detect if the user is running tmux inside a pane and reflect that in the sidebar label:

```ts
term.onData((data) => {
  // detect tmux status line via OSC or by watching for tmux DCS sequences
  if (data.includes('\x1bP')) {
    markPaneAsTmux(paneId);
  }
});
```

This means tmux users get their existing tmux layout inside a pane, and the app's own tab/pane system layers on top — both coexist.

### Auto-Updater

```ts
// main process
import { autoUpdater } from 'electron-updater';

autoUpdater.checkForUpdatesAndNotify();

autoUpdater.on('update-available', () => {
  // notify renderer to show update badge
});

autoUpdater.on('update-downloaded', () => {
  // prompt user to restart and install
});
```

Requires GitHub Releases as the update feed. Tag a release → `electron-updater` picks it up on next launch.

---

## Name

**Fleet** — like a starfleet. Commands a fleet of terminals. ✓

---

## References

- [cmux.dev](https://www.cmux.dev) — primary inspiration
- [xterm.js](https://xtermjs.org) — terminal emulator
- [node-pty](https://github.com/microsoft/node-pty) — PTY bindings (Microsoft)
- [electron-vite](https://electron-vite.org) — build tooling
- [shadcn/ui](https://ui.shadcn.com) — component library
