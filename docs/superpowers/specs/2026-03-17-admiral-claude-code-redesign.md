# Admiral Claude Code Redesign

**Date:** 2026-03-17
**Status:** Draft
**Replaces:** Star Command Phase 3 (Admiral Tab) custom Anthropic SDK integration

## Overview

Replace the custom Admiral AI implementation (Anthropic SDK, tool dispatch, streaming, context compaction) with a Claude Code instance running in a managed workspace. The Admiral becomes a Claude Code PTY process — configured via CLAUDE.md, a Fleet CLI skill, and hooks — instead of a bespoke API integration.

This aligns the Admiral with how crew already works (Claude Code in a PTY) and gives the Admiral full access to Claude Code's capabilities: tools, skills, context management, and slash commands.

## Prime Directive

The Admiral's most important job is **mission decomposition**. When given a task, the Admiral breaks it into the smallest possible missions, each completable in a single Claude Code run (`claude -p "prompt"`, no interaction, exits when done).

Constraints:
- Each mission has ONE clear objective
- Each mission should complete in under 15 minutes
- If a mission needs human input or clarification, it's too big — split further
- Never create a mission requiring interactive input
- The full `-p` prompt should fit in a paragraph

**Bad:** "Build the authentication system"
**Good:**
- "Add bcrypt password hashing to User model with tests"
- "Add POST /login endpoint that returns JWT token"
- "Add auth middleware that validates JWT on protected routes"

## Architecture

### Current State (to be replaced)

```
Renderer (custom chat UI)
  ↕ IPC (admiral:send-message, admiral:stream-chunk, ...)
Main Process
  └── Admiral (Anthropic SDK)
      ├── admiral.ts — SDK streaming, tool dispatch loop, context compaction
      ├── admiral-tools.ts — 25+ tool definitions
      └── admiral-system-prompt.ts — dynamic prompt builder
```

### New State

```
Renderer (xterm.js terminal + chrome)
  ↕ PTY data (same as any terminal tab)
Main Process
  ├── AdmiralProcess — spawns/manages Claude Code PTY
  ├── SocketServer — Unix socket, routes commands to services
  └── Existing services (CrewService, MissionService, CommsService, etc.)

Admiral Workspace (~/.fleet/starbase/{id}/admiral/)
  ├── CLAUDE.md — persona, rules, sector list
  ├── .claude/settings.json — hooks
  ├── .claude/skills/fleet/SKILL.md — Fleet CLI skill
  ├── docs/ — specs, plans the Admiral creates
  ├── learnings/ — post-mortems, patterns
  └── .git/

Fleet CLI (~/.fleet/bin/fleet)
  └── Thin client → Unix socket → SocketServer → Services
```

## Components

### 1. Admiral Workspace

**Location:** `~/.fleet/starbase/{starbaseId}/admiral/`

**Structure:**
```
admiral/
├── CLAUDE.md
├── .claude/
│   ├── settings.json
│   └── skills/
│       └── fleet/
│           └── SKILL.md
├── docs/
├── learnings/
└── .git/
```

**Initialization:** When a starbase loads, `AdmiralProcess.ensureWorkspace()`:
1. Creates directory structure if missing
2. Runs `git init` if no `.git/`
3. Writes/updates `CLAUDE.md` — regenerates auto-generated sections, preserves Admiral-authored content
4. Writes/updates `.claude/settings.json`
5. Writes/updates `.claude/skills/fleet/SKILL.md`

**CLAUDE.md structure:**
```markdown
# Admiral — {starbaseName}

You are the Admiral of this starbase. You coordinate crew, manage missions,
and oversee all sectors.

## Prime Directive

Your most important job is decomposition. When given a task:
1. Break it into the smallest possible missions
2. Each mission must be completable in a single Claude Code run
3. A mission should have ONE clear objective and take <15 minutes
4. If a mission needs human input or clarification, it's too big — split it
5. Never create a mission that requires interactive input

## Fleet CLI

Use the `fleet` command to manage your starbase. See the /fleet skill for
full reference and workflows.

## Sectors
<!-- fleet:auto-start:sectors -->
(auto-generated sector list)
<!-- fleet:auto-end:sectors -->

## Rules
- Always check comms before starting new work
- Scope missions tightly — one clear objective per crewmate
- Ask for clarification rather than guessing
- Write docs and learnings in this workspace — they persist across sessions
```

**Auto-generated sections** use `<!-- fleet:auto-start:X -->` / `<!-- fleet:auto-end:X -->` delimiters. Content between these markers is regenerated on starbase load. Everything outside is preserved.

### 2. Fleet CLI

A thin Node.js CLI client that communicates with the running Fleet Electron app over a Unix socket.

**Socket:** `~/.fleet/fleet.sock` (Unix) / `\\.\pipe\fleet` (Windows)

**Protocol:** Newline-delimited JSON request/response.

```json
{"command": "crew.deploy", "args": {"sectorId": "abc", "missionId": "xyz"}}
{"ok": true, "data": {"crewId": "...", "tabId": "..."}}
```

**Command groups:**

| Group | Commands | Service |
|-------|----------|---------|
| `fleet crew` | `deploy`, `recall`, `list`, `observe` | CrewService |
| `fleet mission` | `create`, `list`, `status`, `cancel` | MissionService |
| `fleet comms` | `list`, `read`, `send`, `check` | CommsService |
| `fleet sector` | `list`, `info`, `add`, `remove` | SectorService |
| `fleet cargo` | `list`, `inspect` | CargoService |
| `fleet supply-route` | `list`, `add`, `remove` | SupplyRouteService |
| `fleet config` | `get`, `set` | ConfigService |
| `fleet log` | `show`, `tail` | ShipsLog |

**Output format:** Human-readable tables/text by default. Claude Code reads terminal output, so plain text is optimal.

**Installation:** Fleet ensures `~/.fleet/bin/fleet` exists and is executable on launch. The Admiral's PTY environment includes `~/.fleet/bin` in PATH.

### 3. Socket Server

New class in the Electron main process. Starts when Fleet launches.

**Responsibilities:**
- Listen on `~/.fleet/fleet.sock`
- Parse incoming JSON commands
- Route to existing service methods
- Return JSON results
- Clean up socket file on shutdown

**Implementation:** Thin dispatch layer. No business logic — just routing to services that already exist (CrewService, MissionService, CommsService, etc.).

### 4. Admiral Lifecycle (AdmiralProcess)

Replaces the current `Admiral` class.

**Properties:**
- `workspace: string` — path to Admiral workspace
- `paneId: string | null` — PTY reference
- `status: 'running' | 'stopped' | 'starting'`

**Methods:**
- `ensureWorkspace()` — create/update workspace directory, CLAUDE.md, skill, hooks
- `start()` — spawn `claude --dangerously-skip-permissions` with cwd=workspace, return paneId
- `stop()` — kill PTY
- `restart()` — stop + start

**Spawn:** Uses existing `PtyManager.create()` with:
- `cmd`: `claude`
- `args`: `['--dangerously-skip-permissions']`
- `cwd`: Admiral workspace path
- `env`: PATH includes `~/.fleet/bin`

PTY is marked as protected (not garbage collected).

**Auto-start:** When starbase loads → `ensureWorkspace()` → `start()` → send paneId to renderer.

### 5. Star Command Tab UI

Transforms from custom chat UI to terminal + chrome.

**Layout:**
```
┌─────────────────────────────────────────────────────┐
│ CRT Frame                                           │
│ ┌─────────────────────────────────┬───────────────┐ │
│ │                                 │               │ │
│ │   xterm.js terminal             │  Galaxy Map   │ │
│ │   (Admiral Claude Code PTY)     │  Scene        │ │
│ │                                 │               │ │
│ │                                 │               │ │
│ ├─────────────────────────────────┤               │ │
│ │ Status Bar: crew(3) missions(2) │               │ │
│ └─────────────────────────────────┴───────────────┘ │
└─────────────────────────────────────────────────────┘
```

**Changes:**
- Replace custom message list with xterm.js terminal attached to Admiral paneId
- Delete: message types, stream buffer, tool call cards, Admiral IPC channels
- Simplify store to: `admiralPaneId`, `admiralStatus`, crew list, mission queue, sectors, unread count
- Keep: CRT frame, status bar, crew chips, galaxy map scene, avatar states

**Admiral status in UI:**
- Running → terminal is live, status bar shows crew/mission counts
- Stopped → terminal shows exit message, restart button available

### 6. Fleet Skill (SKILL.md)

**Location:** `.claude/skills/fleet/SKILL.md`

Teaches the Admiral how and when to use the Fleet CLI. Contains:
- Core workflow (check comms → review status → take action)
- Decision framework (when to deploy crew vs do it yourself)
- Full command reference with examples
- Mission scoping guidance (one prompt, one outcome, verify command)
- Comms handling patterns
- Error handling guidance

### 7. Hooks Configuration

**`.claude/settings.json`:**
```json
{
  "hooks": {
    "PreToolUse": [
      {
        "command": "fleet comms check --quiet",
        "description": "Check for unread transmissions before taking action"
      }
    ]
  }
}
```

**`fleet comms check --quiet` behavior:**
- 0 unread → silent exit (code 0, no output)
- N unread → prints notification, exits 0

Gentle reminder, not a gate. Fires before every tool use — frequent enough to stay current, only when actively working.

## Deleted Code

| File | Reason |
|------|--------|
| `src/main/starbase/admiral.ts` | Replaced by AdmiralProcess + Claude Code |
| `src/main/starbase/admiral-tools.ts` | Replaced by Fleet CLI + skill |
| `src/main/starbase/admiral-system-prompt.ts` | Replaced by CLAUDE.md |
| Admiral IPC channels in `constants.ts` | No longer needed — PTY data flows via xterm |
| Admiral IPC handlers in `ipc-handlers.ts` | Same |
| Chat UI components (message list, stream) | Replaced by xterm.js terminal |
| Store: message/stream state | Simplified to paneId + status |

## Kept / Unchanged

| Component | Reason |
|-----------|--------|
| CrewService, Hull, WorktreeManager | Crew deployment unchanged |
| MissionService | Missions unchanged, now created via Fleet CLI |
| CommsService | Comms unchanged, now accessed via Fleet CLI |
| SectorService, CargoService | Unchanged |
| StarbaseDB, migrations | Unchanged |
| PtyManager | Unchanged — Admiral uses it like any other PTY |
| Galaxy map, CRT frame, sprites | Visual chrome stays |
| Status bar, crew chips | Stay, data source changes to polling services |

## Future Evolution

- **MCP server:** Expose starbase capabilities as MCP tools for richer integration (typed inputs, native tool discovery). Layer on top of the CLI.
- **Auto-restart:** If Admiral exits unexpectedly, Fleet respawns it automatically.
- **Hybrid UI:** Parse terminal output to render richer UI elements alongside the terminal (optional, not planned).
- **Multi-starbase:** Multiple Admiral instances, each in their own workspace.
