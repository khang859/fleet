# Star Command Phase 3: Star Command Tab + Admiral

## Overview

A pinned tab in Fleet where you chat with the Admiral in natural language. The Admiral translates directives into Bridge Control calls and shows Crew status. This is the command interface for Star Command.

## Prerequisites

- Phase 1 complete: StarbaseDB, SectorService, ConfigService
- Phase 2 complete: Hull, WorktreeManager, MissionService, CrewService, Ship's Log writes

## Architecture

### Tab Type Extension

Extend `shared/types.ts` to discriminate tab types:

```typescript
export type Tab = {
  id: string;
  label: string;
  labelIsCustom: boolean;
  cwd: string;
  type: 'terminal' | 'star-command';
  splitRoot: PaneNode;
};
```

The Star Command tab:
- Auto-created when a workspace opens (if a Starbase exists for the workspace)
- Always pinned at position 0 in the sidebar
- One per workspace, cannot be closed or duplicated
- Has the Star Command icon (star logo) instead of a terminal icon

Existing tabs default to `type: 'terminal'` — backward compatible.

### Admiral (`src/main/starbase/admiral.ts`)

Maintains a conversational AI session that has access to all Bridge Controls as tools.

**API key configuration:** The Anthropic API key is read from `ANTHROPIC_API_KEY` environment variable (standard SDK behavior). If the key is missing, the Admiral shows an error state in the chat: "Set your ANTHROPIC_API_KEY environment variable to use Star Command." The key can also be stored in `starbase_config` under key `anthropic_api_key` as an override (checked first, then env var fallback).

**Model:** Uses `claude-sonnet-4-20250514` by default (good balance of speed, cost, and tool-use capability). Configurable via `starbase_config` key `admiral_model`.

**Session management:**
- Uses the Anthropic SDK (`@anthropic-ai/sdk`) to maintain a conversation with Claude
- System prompt is defined in `src/main/starbase/admiral-system-prompt.ts` as a template function that takes live state and returns the prompt string. The prompt includes: Starbase context (workspace path, registered Sectors with configs), current Crew status summary, Mission queue state, space terminology glossary, and behavioral instructions (scope Missions tightly, prefer specific over vague, use acceptance criteria, ask for clarification on ambiguous requests).
- On each turn, the system prompt is refreshed with live state from the database
- Conversation history is kept in memory for the session; on restart, the Admiral reads current state from the database (stateless restart)
- **Context management:** When conversation history exceeds 80% of the model's context window (~160k tokens for Sonnet), the Admiral summarizes older messages into a single "session summary" message and truncates the history. This prevents context overflow during long orchestration sessions.

**Tool definitions (Bridge Controls):**
The Admiral's tool list maps to the spec's Bridge Controls:

| Tool Name | Maps To | Description |
|-----------|---------|-------------|
| `deploy` | `crewService.deployCrew()` | Deploy a Crewmate to a Sector |
| `recall` | `crewService.recallCrew()` | Recall a Crewmate |
| `crew` | `crewService.listCrew()` | List Crew, optionally by Sector |
| `observe` | `crewService.observeCrew()` | Read recent output from a Crewmate |
| `hail` | `commsService.send()` | Send a Transmission to a Crewmate |
| `inbox` | `commsService.getUnread('admiral')` | Get unread Transmissions |
| `resolve` | `commsService.resolve()` | Respond to a hailing request (sends reply + marks original as read) |
| `ask` | `crewService.ask()` | Send a directive to a Crewmate and wait for response (deferred — returns "not yet implemented" until Phase 4) |
| `sectors` | `sectorService.listSectors()` | List all Sectors |
| `add_sector` | `sectorService.addSector()` | Register a new Sector |
| `sector_status` | Combined query | Get Crew, Missions, Cargo for a Sector |
| `remove_sector` | `sectorService.removeSector()` | Deregister a Sector |
| `add_mission` | `missionService.addMission()` | Queue a Mission |
| `missions` | `missionService.listMissions()` | List Missions |
| `next_mission` | `missionService.nextMission()` | Get next queued Mission for a Sector |
| `complete_mission` | `missionService.completeMission()` | Mark a Mission done |
| `abort_mission` | `missionService.abortMission()` | Abort a queued Mission |
| `add_supply_route` | Deferred | Deferred to Phase 5 — returns "Supply Routes not yet available" |

**Tool execution:** When Claude calls a tool, the Admiral service executes it against the real services and returns the result. Tool results are JSON-serialized and fed back to the conversation. **Tool errors** (e.g. `deployCrew` throws because sector not found) are caught and returned as tool error results to Claude, allowing it to inform the user naturally rather than crashing the stream.

**Public API:**
- `sendMessage(content: string)` — Send a user message, returns an async iterator of response chunks (for streaming)
- `getHistory()` — Return conversation history for the renderer
- `resetSession()` — Clear conversation history, Admiral re-reads state from DB on next message

### CommsService (`src/main/starbase/comms-service.ts`)

Manages the Transmission channel.

**Public API:**
- `send({ from, to, type, payload, threadId?, inReplyTo? })` — Insert into `comms` table
- `resolve(transmissionId, response)` — Send a reply Transmission (auto-sets `inReplyTo`, same `threadId`) and marks the original as read
- `getUnread(crewId)` — Query unread Transmissions addressed to a Crewmate (or "admiral")
- `markRead(transmissionId)` — Set read = true
- `getThread(threadId)` — Get all Transmissions in a thread
- `getRecent({ crewId?, limit? })` — Recent Transmissions with optional filter

*Note:* Phase 2 writes to the `comms` table directly (INSERT for mission_complete Transmission). This service formalizes that into a proper API. Phase 2's ad-hoc writes should be migrated to use CommsService.

### Star Command Tab Renderer (`src/renderer/src/components/StarCommandTab.tsx`)

A split layout with chat and status:

**Chat panel (left/main area):**
- Message list showing conversation history: user messages (right-aligned), Admiral responses (left-aligned with Admiral avatar), tool call results (collapsed by default, expandable)
- Streaming response display with typing indicator
- Input bar at the bottom with send button, supports multi-line (Shift+Enter)
- Messages persist across tab switches (stored in component state / zustand store)

**Status panel (right sidebar, collapsible):**
- **Active Crew** section: cards showing each Crewmate's name, Sector, status badge (color-coded), Mission summary, duration. Click a card to jump to that Crewmate's terminal tab.
- **Mission Queue** section: grouped by Sector, showing queued/active/completed counts. Expandable to see individual Missions.
- **Sectors** section: list of registered Sectors with Crew count and status summary.
- Uses event-driven updates via IPC push: main process sends `starbase:status-update` events when Crew/Mission state changes (triggered by EventBus). The renderer listens and updates the store. Fallback: poll every 5 seconds as a safety net for missed events.

**Layout:** The chat panel takes ~70% width, status panel ~30%. Status panel can be collapsed to give full width to chat. On narrow windows, status panel collapses automatically.

### Sidebar Updates

- Star Command tab renders at position 0 with a star icon
- Badge on the Star Command tab icon shows count of unread hailing Transmissions
- Tab label is always "Star Command" (not editable)
- Distinct visual treatment: slightly different background or border to distinguish from terminal tabs

### StarCommandStore (`src/renderer/src/store/star-command-store.ts`)

Zustand store for Star Command UI state:
- `messages: AdmiralMessage[]` — Chat history
- `isStreaming: boolean` — Whether the Admiral is currently responding
- `crewList: CrewStatus[]` — Current Crew states
- `missionQueue: Mission[]` — Current Mission queue
- `sectors: Sector[]` — Registered Sectors
- `unreadCount: number` — Unread hailing Transmissions
- Actions: `sendMessage()`, `refreshStatus()`, `jumpToCrewTab(crewId)` — if the Crew's tab no longer exists (completed/recalled), shows a toast: "Crewmate {id} has undocked"

### IPC Plumbing

New IPC channels:
- `admiral:send-message` → Admiral.sendMessage(), returns stream
- `admiral:get-history` → Admiral.getHistory()
- `admiral:reset` → Admiral.resetSession()
- `starbase:comms-unread` → CommsService.getUnread('admiral')
- `starbase:crew-status` → CrewService.listCrew() with full status
- `starbase:mission-queue` → MissionService.listMissions()

For streaming, use `ipcMain.handle` that returns chunks via `webContents.send` on a dedicated channel (`admiral:stream-chunk`), with an `admiral:stream-end` signal and an `admiral:stream-error` signal for API failures.

**Concurrent message handling:** The input bar is disabled while the Admiral is streaming (`isStreaming: true`). If the user manages to send a second message (race condition), it is queued and sent after the current stream completes.

**Tab auto-creation:** In `src/main/index.ts`, after `StarbaseDB.open()` succeeds during workspace load, the main process checks if the current layout has a Star Command tab. If not, it inserts one at position 0 via LayoutStore. This runs in the main process during the `workspace-loaded` event handler.

### Error Handling

- **API key missing:** Admiral shows inline error in chat UI, all tools remain disabled
- **API rate limit (429):** Retry with backoff (read `Retry-After` header), show "Admiral is rate-limited, retrying..." in chat
- **Network failure:** Show error message in chat: "Lost connection to Admiral. Check your network and try again."
- **Stream failure mid-response:** Send `admiral:stream-error` with error details. Renderer sets `isStreaming = false`, appends error message to chat, re-enables input
- **Tool execution failure:** Caught and returned as tool error to Claude (not surfaced as stream error)

### Dependencies

- Add `@anthropic-ai/sdk` to the project for the Admiral's AI session.

## What Is NOT Built

- Mission decomposition intelligence (Admiral deploys exactly what you ask, doesn't break down large requests)
- Supply Routes
- Quality Gates
- Pixel art visualizer in the Star Command tab (status panel only, no canvas)
- Config panel UI (Sectors managed via Admiral natural language or IPC only)

## Tests

- **Admiral:** Tool dispatch (mock services, send a "deploy a Crewmate to the api Sector" message, verify deployCrew was called with correct args). Session reset and state reload.
- **CommsService:** Send, getUnread, markRead, thread queries
- **StarCommandTab:** Render tests: message display, status panel cards, streaming indicator
- **StarCommandStore:** State transitions: sending message, receiving stream, crew list updates
