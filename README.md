# Fleet

A lightweight, cross-platform terminal multiplexer for developers running multiple AI coding agents simultaneously.

Fleet gives you a single window to manage all your terminal sessions with vertical tabs, split panes, real-time agent activity detection, and OS-level notifications when agents need your attention.

## Download

Download the latest release for your platform:

- [macOS (Apple Silicon)](https://github.com/khang859/fleet/releases/latest) — `.dmg`
- [macOS (Intel)](https://github.com/khang859/fleet/releases/latest) — `.dmg`
- [Windows](https://github.com/khang859/fleet/releases/latest) — `.exe`
- [Linux](https://github.com/khang859/fleet/releases/latest) — `.deb` (Debian/Ubuntu), `.rpm` (Fedora/RHEL), `.AppImage` (universal)

### Linux install

**Debian / Ubuntu / Mint:**

```bash
sudo apt install ./fleet_<version>_amd64.deb
```

Use `apt install` rather than `dpkg -i` so system dependencies (`libxss1`, etc.) are auto-resolved. The package installs to `/opt/Fleet`, registers a desktop entry, and ships an AppArmor profile so the Chromium sandbox works on Ubuntu 24.04+ without `--no-sandbox`.

**Fedora / RHEL:**

```bash
sudo dnf install ./fleet-<version>.x86_64.rpm
```

**Other distros:** download the `.AppImage`, `chmod +x`, and run. On distros with `apparmor_restrict_unprivileged_userns=1` (Ubuntu 24.04+), prefer the `.deb` — AppImages don't ship an AppArmor profile and may need `--no-sandbox` to launch.

## Features

### Tabs & Workspaces

Vertical sidebar with draggable tabs. Organize sessions into named workspaces that persist across restarts. Rename tabs with F2 (or Shift+F2 to rename a pane), undo a closed tab within 5 seconds, and switch workspaces without losing state. Collapse the sidebar to a mini icon-only view for more screen space.

### Dashboard

When no tab is active, Fleet shows a dashboard with an ASCII header, recent files, and recent folders — a quick way to jump back into recent work or switch workspaces.

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

A floating overlay panel that monitors active Claude Code sessions across all your panes. Surfaces permission requests, tracks session activity, and displays conversation threads — so you can keep an eye on multiple agents without switching tabs. Comes with selectable animated mascots (Officer, Robot, Cat, Bear, Kraken, Dragon, Owl).

### Agent Visualizer

A space-themed canvas (`Cmd+Shift+V`) that shows each agent as an animated ship. Ships change color based on activity — green when writing code, blue when reading, amber when waiting for permission. Sub-agents appear as smaller ships near their parent. Hover for details, click to focus the pane.

20 toggleable visual effects across five categories: ambient (nebula clouds, aurora bands, shooting stars, twinkling/colored stars, constellations, day/night cycle, bloom glow, depth of field), ships (engine trails, idle animations, uptime badges, V-formation), environment (distant planets, space station, asteroids, space weather), interactive (click-to-follow camera, scroll zoom), and audio (ambient soundscape with volume control).

### Command Palette

Open the command palette with `Cmd+Shift+P` to quickly access any action — new tabs, splits, settings, git changes, and more.

### Git Integration

Tab labels update in real-time to show each pane's current working directory and git branch. View file-level diffs with syntax highlighting via the Git Changes panel (`Cmd+Shift+G`), showing modified, added, deleted, renamed, and untracked files with line-level insertions and deletions.

### Worktree Management

Create, list, and remove git worktrees directly from Fleet. Worktree tabs are automatically grouped by parent repository in the sidebar, and branches get auto-generated descriptive names.

### File Editor & Viewer

Open files in a built-in editor with syntax highlighting (JavaScript, TypeScript, HTML, CSS, JSON, Markdown, Python, Go, Rust, Java, PHP, Vue, SQL, YAML, and more). CodeMirror-powered with undo/redo, line numbers, and auto-save. Editor chrome and the markdown preview sidebar show the full file path so same-named files stay distinguishable. Image files open in an inline viewer.

### Markdown Preview

Markdown files open in a dedicated preview pane with preview and raw sub-tabs — GFM, syntax-highlighted code blocks, and the same rendering whether you open them from the sidebar, `Cmd+O`, or `fleet open`.

### Telescope Finder

A multi-mode fuzzy finder (`Cmd+Shift+T`) with file, grep, symbol, browse, and panes modes. Preview images inline, navigate directories, and see gitignored entries dimmed. Markdown files open in the markdown preview pane; the `fleet open` CLI uses the same routing.

### File Search & Quick Open

- **Quick Open** (`Cmd+P`) — fast fuzzy file finder
- **Search files on disk** (`Cmd+Shift+O`) — deep file search across directories
- **Search in pane** (`Cmd+F`) — search terminal output

### Annotate

Annotate live webpages with an element picker or free-draw canvas, then hand the annotated screenshot to an AI agent. Move/drag tool (V) repositions drawn elements; picker UI is hidden from the saved capture.

### Clipboard History

Access your clipboard history with `Cmd+Shift+H` and paste previous entries into any pane.

### Image Generation

Generate and edit images using FAL AI directly from Fleet. A dedicated image gallery tab tracks all generations with metadata, status, and history. Configure models, resolutions, and formats from settings.

### Socket API

Control Fleet programmatically over a Unix socket at `~/.fleet/fleet.sock` (macOS/Linux) or a named pipe `\\.\pipe\fleet` (Windows):

```bash
# List all panes
echo '{"command":"list-panes"}' | nc -U ~/.fleet/fleet.sock

# Send input to a pane
echo '{"command":"send-input","paneId":"abc123","input":"ls\n"}' | nc -U ~/.fleet/fleet.sock

# Subscribe to events
echo '{"command":"subscribe"}' | nc -U ~/.fleet/fleet.sock
```

### Fleet CLI

Fleet installs a `fleet` command to `~/.fleet/bin` for opening files, images, and managing panes from the terminal. It also auto-installs skill files for Claude Code integration (`Cmd+Shift+.` to inject skills into a session).

### Settings

Configurable default shell, font size/family (bundled JetBrains Mono + custom font support), scrollback buffer, theme (dark/light), notification preferences per alert level (badge, sound, and OS notification toggles), visualizer effects, and copilot options.

### Auto-Updates

Fleet checks GitHub Releases on launch and prompts you to install new versions.

## Keyboard Shortcuts

| Action               | macOS            | Windows/Linux      |
| -------------------- | ---------------- | ------------------ |
| New tab              | `Cmd+T`          | `Ctrl+T`           |
| Close pane           | `Cmd+W`          | `Ctrl+Shift+W`     |
| Split right          | `Cmd+D`          | `Ctrl+Shift+D`     |
| Split down           | `Cmd+Shift+D`    | `Ctrl+Shift+Alt+D` |
| Previous pane        | `Cmd+[`          | `Ctrl+Shift+[`     |
| Next pane            | `Cmd+]`          | `Ctrl+Shift+]`     |
| Next tab             | `Ctrl+Tab`       | `Ctrl+Tab`         |
| Previous tab         | `Ctrl+Shift+Tab` | `Ctrl+Shift+Tab`   |
| Command palette      | `Cmd+Shift+P`    | `Ctrl+Shift+P`     |
| Quick open           | `Cmd+P`          | `Ctrl+P`           |
| Telescope finder     | `Cmd+Shift+T`    | `Ctrl+Shift+T`     |
| Search files on disk | `Cmd+Shift+O`    | `Ctrl+Shift+O`     |
| Search in pane       | `Cmd+F`          | `Ctrl+Shift+F`     |
| Git changes          | `Cmd+Shift+G`    | `Ctrl+Shift+G`     |
| Clipboard history    | `Cmd+Shift+H`    | `Ctrl+Shift+H`     |
| Toggle visualizer    | `Cmd+Shift+V`    | `Ctrl+Shift+V`     |
| Open file            | `Cmd+O`          | `Ctrl+O`           |
| Rename tab           | `F2`             | `F2`               |
| Rename pane          | `Shift+F2`       | `Shift+F2`         |
| Settings             | `Cmd+,`          | `Ctrl+,`           |
| Show shortcuts       | `Cmd+/`          | `Ctrl+/`           |
| Switch to tab 1–9    | `Cmd+1`–`Cmd+9`  | `Ctrl+1`–`Ctrl+9`  |
| Inject Fleet skills  | `Cmd+Shift+.`    | `Ctrl+Shift+.`     |

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
