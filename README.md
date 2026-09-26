# Fleet

A lightweight, cross-platform terminal multiplexer for developers running multiple AI coding agents simultaneously.

Fleet gives you a single window to manage all your terminal sessions with vertical tabs, split panes, real-time agent activity detection, and OS-level notifications when agents need your attention.
It also ships a built-in coding agent, file viewers, git tools, and remote SSH support.

## Download

Download the latest release for your platform:

- [macOS - Apple Silicon (M1/M2/M3/M4)](https://github.com/khang859/fleet/releases/latest) - download `fleet-<version>-arm64.dmg`
- [macOS - Intel](https://github.com/khang859/fleet/releases/latest) - download `fleet-<version>-x64.dmg`
- [Windows](https://github.com/khang859/fleet/releases/latest) - download `fleet-<version>-setup.exe`
- [Linux](https://github.com/khang859/fleet/releases/latest) - `.deb` (Debian/Ubuntu), `.rpm` (Fedora/RHEL), `.AppImage` (universal)

### Linux install

**Debian / Ubuntu / Mint:**

```bash
sudo apt install ./fleet_<version>_amd64.deb
```

Use `apt install` rather than `dpkg -i` so system dependencies (`libxss1`, etc.) are auto-resolved.
The package installs to `/opt/Fleet`, registers a desktop entry, and ships an AppArmor profile so the Chromium sandbox works on Ubuntu 24.04+ without `--no-sandbox`.

**Fedora / RHEL:**

```bash
sudo dnf install ./fleet-<version>.x86_64.rpm
```

**Other distros:** download the `.AppImage`, `chmod +x`, and run.
On distros with `apparmor_restrict_unprivileged_userns=1` (Ubuntu 24.04+), prefer the `.deb`.
AppImages don't ship an AppArmor profile and may need `--no-sandbox` to launch.

## Features

### Tabs & Workspaces

Vertical sidebar with draggable tabs.
Organize sessions into named workspaces that persist across restarts.
Rename tabs with F2 (or Shift+F2 to rename a pane), undo a closed tab within 5 seconds, and switch workspaces without losing state.
Files you open from a session are nested under that session in the sidebar.
Collapse the sidebar to a mini icon-only view for more screen space.

### Dashboard

When no tab is active, Fleet shows a dashboard with an ASCII header, a New Terminal button, recent folders, and recent files.

### Split Panes

Split any tab horizontally or vertically.
Drag dividers to resize.
The recursive split tree supports arbitrary nesting so you can arrange panes however you want.
Navigate between panes with `Cmd+[` / `Cmd+]`.

### Shells

Pick a shell profile per pane.
On Windows, Fleet can also open WSL panes.

### Activity Tracking & Notifications

Fleet tracks the state of every pane: working, idle, done, needs you, or error.
It reads terminal output, and Claude Code hooks can report state directly.

Each pane shows a status glyph:

- **Color** is the state: amber = needs you, red = error, green = done, blue = working
- **Shape** is the process: filled = running, ring = at rest, square = exited

Notifications are forwarded to your OS and batched to prevent alert fatigue.
Each alert level has its own badge, sound, and OS notification toggles.

### Agent Overview & Peek

- **Agent Overview** (`Cmd+Shift+A`) - see every agent across your panes in one place
- **Peek** (`Cmd+Shift+P`) - jump to the next agent that needs your input

### Agent Pane

A built-in coding agent that runs on OpenRouter models or a local model server.
It can run shell commands, edit files, search code, fetch web pages, and generate images.

- MCP servers, subagents, skills, and slash commands
- Memory across sessions and scheduled wake-ups
- Background commands
- Permission modes, from ask-every-time to full access
- Multi-model review panel
- Voice dictation
- Open a session in a new git worktree
- A gallery of every image the agent made, which you can set as your terminal background

**Scratch chat** (`Cmd+Shift+J`) opens a quick agent chat in its own folder.

### Copilot (macOS)

A floating overlay panel that monitors active Claude Code sessions across all your panes.
It surfaces permission requests, tracks session activity, and displays conversation threads, so you can keep an eye on multiple agents without switching tabs.
Comes with selectable animated mascots (Officer, Robot, Cat, Bear, Kraken, Dragon, Owl).

### Command Palette

Open the command palette with `Cmd+K` to quickly access any action: new tabs, splits, settings, git changes, and more.

### Git Integration

Tab labels update in real-time to show each pane's current working directory and git branch.
View file-level diffs with syntax highlighting via the Git Changes panel (`Cmd+Shift+G`).
It shows modified, added, deleted, renamed, and untracked files with line-level insertions and deletions.

### Worktree Management

Create, list, and remove git worktrees directly from Fleet.
Worktree tabs are automatically grouped by parent repository in the sidebar, and branches get auto-generated descriptive names.

### File Editor & Viewers

Open files in a built-in editor with syntax highlighting (JavaScript, TypeScript, HTML, CSS, JSON, Markdown, Python, Go, Rust, Java, PHP, Vue, SQL, YAML, and more).
It is CodeMirror-powered with undo/redo, line numbers, and auto-save.
Editor chrome and the markdown preview sidebar show the full file path so same-named files stay distinguishable.
Images open in an inline viewer and PDFs open in a PDF viewer.

### Markdown Preview

Markdown files open in a dedicated preview pane with preview and raw sub-tabs.
It renders GFM, syntax-highlighted code blocks, and Mermaid diagrams.
Rendering is the same whether you open a file from the sidebar, `Cmd+O`, or `fleet open`.

### Clickable Terminal Output

`Cmd+click` file paths, `ls` output, URLs, and OSC 8 hyperlinks in any terminal to open them.

### Telescope Finder

A multi-mode fuzzy finder (`Cmd+Shift+T`) with files, grep, browse, and panes modes.
Preview images inline, navigate directories, and see gitignored entries dimmed.
Markdown files open in the markdown preview pane; the `fleet open` CLI uses the same routing.

### File Search & Quick Open

- **Quick Open** (`Cmd+P`) - fast fuzzy file finder
- **Search files on disk** (`Cmd+Shift+O`) - deep file search across directories
- **Search in pane** (`Cmd+F`) - search terminal output

### Remote SSH

Browse, view, edit, and transfer files on remote hosts over SSH.
SSH panes support clipboard and file transfer.

### Annotate

Annotate live webpages with an element picker or free-draw canvas, then hand the annotated screenshot to an AI agent.
The move/drag tool (V) repositions drawn elements, and the picker UI is hidden from the saved capture.

### Claude Code Tools

- **Claude Config** - edit Claude Code settings, hooks, and `CLAUDE.md`, and see the effective config
- **Sessions** - browse Claude Code transcripts with cost estimates, and distill them into learnings
- **Learnings** - a local store of lessons with vector search, exposed to agents as an MCP server

### Project Notes

A per-repo markdown scratchpad, stored in `~/.fleet/notes`.

### Env Sync

Sync `.env` files between machines, encrypted, through your own S3 bucket.
Fleet also has an env file editor and a read-only view of your shell environment.

### Clipboard History

Access your clipboard history with `Cmd+Shift+H` and paste previous entries into any pane.

### Fleet CLI

Fleet installs a `fleet` command to `~/.fleet/bin`:

```bash
fleet open src/main.ts   # open files, images, markdown, or PDFs in Fleet tabs
fleet annotate           # annotate a web page for an AI agent
```

It also installs a skill file to `~/.fleet/skills/fleet.md`.
On macOS, Fleet adds this skill to every Claude Code session automatically through a SessionStart hook.

### Socket API

The Fleet CLI talks to Fleet over a Unix socket at `~/.fleet/fleet.sock` (macOS/Linux) or a named pipe `\\.\pipe\fleet` (Windows).
Send one JSON request per line:

```bash
echo '{"id":"1","command":"ping"}' | nc -U ~/.fleet/fleet.sock
echo '{"id":"2","command":"file.open","args":{"files":[{"path":"/tmp/notes.md","paneType":"markdown"}]}}' | nc -U ~/.fleet/fleet.sock
```

Supported commands: `ping`, `file.open`, and `annotate.start`.

### Settings

- **Appearance** - app theme (system, dark, light, and presets), 14 terminal themes, 6 accent colors, and terminal backgrounds with an optional slideshow
- **Terminal** - default shell, font size and family (bundled JetBrains Mono + custom fonts), and scrollback buffer
- **Pages** - Workspaces, Notifications, Copilot, Claude Config, Learnings, Annotate, Env Sync, Remote Hosts, Socket API, Diagnostics, and Updates

### Quit Guard

Fleet warns you before you quit while agents or commands are still running.

### Auto-Updates

Fleet checks GitHub Releases every 4 hours, when the window regains focus, and when your machine wakes.
It prompts you to install new versions, and Settings > Updates shows the full release notes history.

## Keyboard Shortcuts

| Action                    | macOS            | Windows/Linux      |
| ------------------------- | ---------------- | ------------------ |
| New tab                   | `Cmd+T`          | `Ctrl+T`           |
| Close pane                | `Cmd+W`          | `Ctrl+Shift+W`     |
| Split right               | `Cmd+D`          | `Ctrl+Shift+D`     |
| Split down                | `Cmd+Shift+D`    | `Ctrl+Shift+Alt+D` |
| Previous pane             | `Cmd+[`          | `Ctrl+Shift+[`     |
| Next pane                 | `Cmd+]`          | `Ctrl+Shift+]`     |
| Next tab                  | `Ctrl+Tab`       | `Ctrl+Tab`         |
| Previous tab              | `Ctrl+Shift+Tab` | `Ctrl+Shift+Tab`   |
| Command palette           | `Cmd+K`          | `Ctrl+K`           |
| Quick open                | `Cmd+P`          | `Ctrl+P`           |
| Telescope finder          | `Cmd+Shift+T`    | `Ctrl+Shift+T`     |
| Search files on disk      | `Cmd+Shift+O`    | `Ctrl+Shift+O`     |
| Search in pane            | `Cmd+F`          | `Ctrl+Shift+F`     |
| Git changes               | `Cmd+Shift+G`    | `Ctrl+Shift+G`     |
| Clipboard history         | `Cmd+Shift+H`    | `Ctrl+Shift+H`     |
| Open file                 | `Cmd+O`          | `Ctrl+O`           |
| New scratch chat          | `Cmd+Shift+J`    | `Ctrl+Shift+J`     |
| Agent overview            | `Cmd+Shift+A`    | `Ctrl+Shift+A`     |
| Peek at agent needing you | `Cmd+Shift+P`    | `Ctrl+Shift+P`     |
| Rename tab                | `F2`             | `F2`               |
| Rename pane               | `Shift+F2`       | `Shift+F2`         |
| Settings                  | `Cmd+,`          | `Ctrl+,`           |
| Show shortcuts            | `Cmd+/`          | `Ctrl+/`           |
| Switch to tab 1-9         | `Cmd+1`-`Cmd+9`  | `Ctrl+1`-`Ctrl+9`  |

## Development

```bash
npm install
npm run dev
```

### Checks

```bash
npm run typecheck   # TypeScript, main + renderer
npm run lint        # ESLint
npm test            # Vitest
```

### Build

```bash
npm run build:mac     # macOS
npm run build:win     # Windows
npm run build:linux   # Linux
```

## Stack

Electron + electron-vite + React + TypeScript, xterm.js for terminal emulation, node-pty for PTY processes, Radix UI + Tailwind for UI, Zustand for state management, CodeMirror for the editor, and better-sqlite3 for local storage.

## License

MIT
