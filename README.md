# Fleet

A lightweight, cross-platform terminal multiplexer for developers running multiple AI coding agents simultaneously.

Fleet gives you a single window to manage all your terminal sessions with vertical tabs, split panes, real-time agent activity detection, and OS-level notifications when agents need your attention.

## Download

Download the latest release for your platform:

- [macOS (Apple Silicon)](https://github.com/khang859/fleet/releases/latest) — `.dmg`
- [macOS (Intel)](https://github.com/khang859/fleet/releases/latest) — `.dmg`
- [Windows](https://github.com/khang859/fleet/releases/latest) — `.exe`
- [Linux](https://github.com/khang859/fleet/releases/latest) — `.AppImage` / `.deb`

## Features

### Tabs & Workspaces

Vertical sidebar with draggable tabs. Organize sessions into named workspaces that persist across restarts. Rename tabs with F2, undo a closed tab within 5 seconds, and switch workspaces without losing state. Collapse the sidebar to a mini icon-only view for more screen space.

### Split Panes

Split any tab horizontally or vertically. Drag dividers to resize. The recursive split tree supports arbitrary nesting so you can arrange panes however you want. Navigate between panes with `Cmd+[` / `Cmd+]`.

### Notification Badges & Activity Tracking

Fleet watches terminal output for signals that an agent needs attention:

- **Amber pulse** — agent is asking for permission
- **Red dot** — process exited with an error
- **Blue dot** — task completed
- **Gray dot** — process exited cleanly

Notifications are forwarded to your OS (macOS/Windows) and batched to prevent alert fatigue. Fleet also tracks granular activity states (working, reading, idle, waiting, needs-permission) for each pane.

### Copilot (macOS)

A floating overlay panel that monitors active Claude Code sessions across all your panes. Surfaces permission requests, tracks session activity, and displays conversation threads — so you can keep an eye on multiple agents without switching tabs. Comes with selectable animated mascots (Officer, Robot, Cat, Bear, Kraken).

### Agent Visualizer

A space-themed canvas (`Cmd+Shift+V`) that shows each agent as an animated ship. Ships change color based on activity — green when writing code, blue when reading, amber when waiting for permission. Sub-agents appear as smaller ships near their parent. Hover for details, click to focus the pane.

18 toggleable visual effects across five categories: ambient (nebula clouds, aurora bands, shooting stars, constellations, day/night cycle), ships (engine trails, idle animations, uptime badges, V-formation), environment (distant planets, space station, asteroids, space weather), interactive (click-to-follow camera, scroll zoom), and audio (ambient soundscape with volume control).

### Command Palette

Open the command palette with `Cmd+Shift+P` to quickly access any action — new tabs, splits, settings, git changes, and more.

### Git Integration

Tab labels update in real-time to show each pane's current working directory and git branch. View file-level diffs with syntax highlighting via the Git Changes panel (`Cmd+Shift+G`), showing modified, added, deleted, renamed, and untracked files with line-level insertions and deletions.

### Worktree Management

Create, list, and remove git worktrees directly from Fleet. Worktree tabs are automatically grouped by parent repository in the sidebar, and branches get auto-generated descriptive names.

### File Editor & Viewer

Open files in a built-in editor with syntax highlighting (JavaScript, TypeScript, HTML, CSS, JSON, Markdown, Python, and more). CodeMirror-powered with undo/redo, line numbers, and auto-save. Image files open in an inline viewer.

### File Search & Quick Open

- **Quick Open** (`Cmd+P`) — fast fuzzy file finder
- **Search files on disk** (`Cmd+Shift+O`) — deep file search across directories
- **Search in pane** (`Cmd+F`) — search terminal output

### Clipboard History

Access your clipboard history with `Cmd+Shift+H` and paste previous entries into any pane.

### Image Generation

Generate and edit images using FAL AI directly from Fleet. A dedicated image gallery tab tracks all generations with metadata, status, and history. Configure models, resolutions, and formats from settings.

### Socket API

Control Fleet programmatically over a Unix socket (macOS/Linux) or named pipe (Windows):

```bash
# List all panes
echo '{"command":"list-panes"}' | nc -U /tmp/fleet.sock

# Send input to a pane
echo '{"command":"send-input","paneId":"abc123","input":"ls\n"}' | nc -U /tmp/fleet.sock

# Subscribe to events
echo '{"command":"subscribe"}' | nc -U /tmp/fleet.sock
```

### Fleet CLI

Fleet installs a `fleet` command to `~/.fleet/bin` for opening files, images, and managing panes from the terminal. It also auto-installs skill files for Claude Code integration (`Cmd+Shift+.` to inject skills into a session).

### Settings

Configurable default shell, font size/family (bundled JetBrains Mono + custom font support), scrollback buffer, theme (dark/light), notification preferences per alert level (badge, sound, and OS notification toggles), visualizer effects, and copilot options.

### Auto-Updates

Fleet checks GitHub Releases on launch and prompts you to install new versions.

## Keyboard Shortcuts

| Action              | macOS           | Windows/Linux      |
| ------------------- | --------------- | ------------------ |
| New tab             | `Cmd+T`         | `Ctrl+T`           |
| Close pane          | `Cmd+W`         | `Ctrl+Shift+W`     |
| Split right         | `Cmd+D`         | `Ctrl+Shift+D`     |
| Split down          | `Cmd+Shift+D`   | `Ctrl+Shift+Alt+D` |
| Previous pane       | `Cmd+[`         | `Ctrl+Shift+[`     |
| Next pane           | `Cmd+]`         | `Ctrl+Shift+]`     |
| Next tab            | `Ctrl+Tab`      | `Ctrl+Tab`         |
| Previous tab        | `Ctrl+Shift+Tab` | `Ctrl+Shift+Tab`  |
| Command palette     | `Cmd+Shift+P`   | `Ctrl+Shift+P`     |
| Quick open          | `Cmd+P`         | `Ctrl+P`           |
| Search files on disk | `Cmd+Shift+O`  | `Ctrl+Shift+O`     |
| Search in pane      | `Cmd+F`         | `Ctrl+Shift+F`     |
| Git changes         | `Cmd+Shift+G`   | `Ctrl+Shift+G`     |
| Clipboard history   | `Cmd+Shift+H`   | `Ctrl+Shift+H`     |
| Toggle visualizer   | `Cmd+Shift+V`   | `Ctrl+Shift+V`     |
| Open file           | `Cmd+O`         | `Ctrl+O`           |
| Rename tab          | `F2`            | `F2`               |
| Settings            | `Cmd+,`         | `Ctrl+,`           |
| Show shortcuts      | `Cmd+/`         | `Ctrl+/`           |
| Switch to tab 1–9   | `Cmd+1`–`Cmd+9` | `Ctrl+1`–`Ctrl+9` |
| Inject Fleet skills | `Cmd+Shift+.`   | `Ctrl+Shift+.`     |

## Development

```bash
npm install
npm run dev
```

### Build

```bash
npm run build:mac     # macOS
npm run build:win     # Windows
npm run build:linux   # Linux
```

## Stack

Electron + electron-vite + React + TypeScript, xterm.js for terminal emulation, node-pty for PTY processes, shadcn/ui + Tailwind for UI, Zustand for state management.

## License

MIT
