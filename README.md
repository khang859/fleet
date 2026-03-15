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

Vertical sidebar with draggable tabs. Organize sessions into named workspaces that persist across restarts. Rename tabs with a double-click, undo a closed tab within 5 seconds, and switch workspaces without losing state.

### Split Panes

Split any tab horizontally or vertically. Drag dividers to resize. The recursive split tree supports arbitrary nesting so you can arrange panes however you want.

### Notification Badges

Fleet watches terminal output for signals that an agent needs attention:

- **Amber pulse** — agent is asking for permission
- **Red dot** — process exited with an error
- **Blue dot** — task completed
- **Gray dot** — process exited cleanly

Notifications are forwarded to your OS (macOS/Windows) and batched to prevent alert fatigue.

### Agent Visualizer

A space-themed canvas (`Cmd+Shift+V`) that shows each agent as an animated ship. Ships change color based on activity — green when writing code, blue when reading, amber when waiting for permission. Sub-agents appear as smaller ships near their parent. Hover for details, click to focus the pane.

### Live CWD Tracking

Tab labels update in real-time to show each pane's current working directory and git branch. Uses OSC 7 detection with a polling fallback for shells that don't support it.

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

### Settings

Configurable default shell, font size/family, scrollback buffer, theme, notification preferences per alert level, and visualizer mode (drawer or full tab).

### Auto-Updates

Fleet checks GitHub Releases on launch and prompts you to install new versions.

## Keyboard Shortcuts

| Action | macOS | Windows/Linux |
|--------|-------|---------------|
| New tab | `Cmd+T` | `Ctrl+T` |
| Close tab | `Cmd+W` | `Ctrl+W` |
| Split vertical | `Cmd+Shift+E` | `Ctrl+Shift+E` |
| Split horizontal | `Cmd+Shift+O` | `Ctrl+Shift+O` |
| Toggle visualizer | `Cmd+Shift+V` | `Ctrl+Shift+V` |
| Settings | `Cmd+,` | `Ctrl+,` |
| Show shortcuts | `Cmd+?` | `Ctrl+?` |

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
