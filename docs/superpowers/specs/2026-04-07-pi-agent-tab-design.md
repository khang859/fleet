# Pi Agent Tab Design

A dedicated Fleet tab type that runs the [pi-mono](https://github.com/badlogic/pi-mono) coding agent (`@mariozechner/pi-coding-agent`) with Fleet-specific extensions for bidirectional integration.

## Overview

Users run `fleet pi` from any terminal tab to open a Pi agent tab in that working directory. Pi runs its interactive TUI inside xterm.js. Fleet-bundled extensions connect back to Fleet over WebSocket, giving the agent tools to open files, create terminals, and interact with the Fleet workspace.

## Tab Type & Data Model

New `'pi'` value added to the `Tab['type']` union in `src/shared/types.ts`. Pi tabs use the existing `splitRoot` structure with a single leaf (no split pane support).

The pane leaf gets a new `paneType: 'pi'` that behaves like a terminal pane (xterm.js + node-pty) but auto-launches `pi` instead of a shell.

Environment variables set on the PTY:
- `FLEET_BRIDGE_PORT` - WebSocket bridge port
- `FLEET_BRIDGE_TOKEN` - one-time auth token for the bridge connection

No new persistent state beyond standard tab fields (`id`, `label`, `cwd`, `type`).

## Agent Manager

New `PiAgentManager` service in `src/main/pi-agent-manager.ts`.

### Installation

- Installs `@mariozechner/pi-coding-agent` to `~/.fleet/agents/pi/` using `npm install --prefix`
- Binary name is `pi`
- Stores installed version for update checks
- On first `fleet pi`, auto-installs; terminal shows "Installing Pi agent..." message
- If install fails (no Node 20+, network error), displays error with instructions

### Launching

- Resolves the `pi` binary path from the local install directory
- Returns command + args for PTY to spawn
- Passes Fleet extensions explicitly via `-e` flags:
  ```
  pi -e <fleet-bridge.ts> -e <fleet-files.ts> -e <fleet-terminal.ts>
  ```
- Sets environment variables: `FLEET_BRIDGE_PORT`, `FLEET_BRIDGE_TOKEN`
- Does **not** override `PI_CODING_AGENT_DIR` - users keep their existing pi config, API keys, and sessions

### Version Management

- Checks against latest periodically (not every launch)
- If outdated, logs "Fleet: updating Pi agent..." and runs `npm update`
- Never blocks launch on update check - uses what's installed, updates in background for next time

## WebSocket Bridge

New `FleetBridgeServer` in `src/main/fleet-bridge.ts`.

### Server

- WebSocket server on a random available port on `127.0.0.1` (localhost only)
- Port passed to pi via `FLEET_BRIDGE_PORT` env var
- One-time auth token passed via `FLEET_BRIDGE_TOKEN` env var; extensions must present it on connect
- Each pi tab gets a unique connection identified by pane ID sent on connect handshake
- Lifecycle: starts when Fleet launches, stops on quit

### Protocol

JSON messages with `{ type, payload }` structure. Request/response uses `{ id, type, payload }` with `{ id, result }` replies.

**Pi extension -> Fleet (requests):**
- `file.open` - open a file in Fleet's editor
- `tab.create` - create a new terminal tab
- `terminal.run` - run a command in a new terminal

**Fleet -> Pi extension (events):**
- `file.opened` - user opened a file
- `tab.changed` - active tab changed
- `git.status` - git status update

### Fleet-Side Handler

- Lives in main process alongside the socket server
- Has access to existing services (file opening, tab management via IPC to renderer)
- Reuses existing codepaths (e.g., opening a file is the same path as `fleet open <file>`)

## Fleet Pi Extensions

Bundled in `resources/pi-extensions/`, loaded via `-e` flags on launch. Each extension is a single TypeScript file (loaded by pi's `jiti` runtime, no compilation needed).

### `fleet-bridge.ts` (core)

- Connects to Fleet's WebSocket using `FLEET_BRIDGE_PORT` and `FLEET_BRIDGE_TOKEN` env vars
- Maintains connection lifecycle (reconnect on drop)
- Stores the bridge client on the `ExtensionAPI` metadata so other extensions can access it (e.g., `pi.metadata.fleetBridge`)
- Registers tools and events that depend on the bridge connection
- **Must be loaded first** (listed first in `-e` flags)

### `fleet-files.ts`

- Reads the bridge client from `pi.metadata.fleetBridge`
- Registers a `fleet_open` tool the agent can call
- Sends `file.open` request over the bridge
- Agent can say "let me open that for you" and it appears as a Fleet tab

### `fleet-terminal.ts`

- Reads the bridge client from `pi.metadata.fleetBridge`
- Registers a `fleet_run` tool to run a command in a new Fleet terminal tab
- Useful for background tasks while the agent keeps working

### Adding New Extensions

Add a `.ts` file to `resources/pi-extensions/` and add its `-e` flag to the launch args in `PiAgentManager`. No magic discovery.

## CLI Command (`fleet pi`)

### CLI (`fleet-cli.ts`)

- New command map entry: `'pi.open': 'pi.open'`
- `fleet pi` maps to group `pi`, action `open`
- Passes current working directory as `cwd` arg (from `process.cwd()`)

### Socket Server (`socket-server.ts`)

- New case `'pi.open'` in `dispatch()`
- Extracts `cwd` from args
- Emits `state-change` event with type `pi:open` and the cwd

### Renderer

- Listens for `pi:open` state-change event
- Calls new `addPiTab(cwd)` action on workspace store
- Creates tab with `type: 'pi'`, label `'Pi Agent'`, provided cwd
- Switches to the new tab

### Full Flow

```
fleet pi (in terminal)
  → CLI: { command: 'pi.open', args: { cwd: '/path/to/project' } }
  → Socket server dispatches, emits state-change
  → Renderer creates pi tab with cwd
  → PiAgentManager resolves pi binary, extensions, env vars
  → PTY spawns: pi -e fleet-bridge.ts -e fleet-files.ts -e fleet-terminal.ts
  → xterm.js renders pi's TUI
  → fleet-bridge.ts connects to Fleet's WebSocket
```

## Rendering

### App.tsx

New branch in tab rendering conditional:
```
tab.type === 'pi' ? <PiTab tab={tab} /> : ...
```

### PiTab Component (`src/renderer/src/components/PiTab.tsx`)

- Renders a single xterm.js terminal (similar to TerminalPane but simplified)
- On mount, requests PTY creation via IPC with pi command from PiAgentManager
- Handles PTY data/exit same as terminal panes
- On pi exit, shows "Pi agent exited. Press any key to close."
- No split pane controls - terminal fills the tab

### Sidebar

- Pi tabs appear in the tab list with label "Pi Agent" and a distinct icon
- No special sidebar card (unlike images/annotate) - regular closeable tab
- Closing kills the pi PTY process

## Error Handling

| Scenario | Behavior |
|----------|----------|
| Pi not installed | Auto-install on first `fleet pi`. Show progress in terminal. |
| Install fails | Display error in terminal pane with instructions |
| Pi crashes/exits | Show exit message, tab stays open for reading output |
| WebSocket fails | Extensions retry with backoff. Pi still works standalone - Fleet tools unavailable but agent functional |
| Version outdated | Log note at launch, update in background for next time |

## Files to Create/Modify

**New files:**
- `src/main/pi-agent-manager.ts` - installation, version management, launch config
- `src/main/fleet-bridge.ts` - WebSocket bridge server
- `src/renderer/src/components/PiTab.tsx` - tab component
- `resources/pi-extensions/fleet-bridge.ts` - core bridge extension
- `resources/pi-extensions/fleet-files.ts` - file opening tool
- `resources/pi-extensions/fleet-terminal.ts` - terminal creation tool

**Modified files:**
- `src/shared/types.ts` - add `'pi'` to Tab type union and PaneLeaf paneType union
- `src/renderer/src/App.tsx` - add pi tab rendering branch
- `src/renderer/src/store/workspace-store.ts` - add `addPiTab()` action
- `src/renderer/src/components/Sidebar.tsx` - pi tab icon/label
- `src/main/socket-server.ts` - add `pi.open` dispatch case
- `src/main/fleet-cli.ts` - add command map entry and validation
- `src/main/index.ts` - instantiate PiAgentManager and FleetBridgeServer
- `src/main/socket-supervisor.ts` - pass new services, handle pi:open event
