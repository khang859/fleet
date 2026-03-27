# Automation Tab — Design Spec

## Overview

A standalone Automation tab for Fleet that lets users create agent-powered automations triggered manually or on a schedule. Each automation is a single agent call — the user writes a prompt describing what they want done, and the agent executes it autonomously using tools (shell, file I/O, Fleet CLI). Output files are stored per-run and browsable in the UI.

Separate from Star Command. No shared state, no crew/mission integration.

## Data Model

Each automation is a JSON file in `~/.fleet/automations/`. Files are named by UUID (e.g., `a1b2c3d4.json`) to avoid name collisions. Output directories use the same UUID as the sibling folder name.

```json
{
  "id": "a1b2c3d4",
  "name": "Deploy staging",
  "description": "Build, test, and deploy to staging server",
  "createdAt": "2026-03-25T10:00:00Z",
  "updatedAt": "2026-03-25T10:00:00Z",
  "trigger": {
    "manual": true,
    "schedule": {
      "cron": "0 9 * * MON-FRI",
      "preset": "weekdays-9am"
    }
  },
  "agent": {
    "provider": "anthropic",
    "model": "claude-sonnet-4-6",
    "systemPrompt": "You are a deployment assistant.",
    "prompt": "Run the test suite in /Users/me/project. If all tests pass, open a new Fleet pane and run deploy.sh. Summarize the results and write a report.csv with test timings.",
    "maxTokens": 8192,
    "maxSteps": 25,
    "tools": ["shell", "read_file", "write_file", "fleet"]
  }
}
```

### Schedule presets

| Preset key             | Display label           | Cron expression   |
| ---------------------- | ----------------------- | ----------------- |
| `every-5m`             | Every 5 minutes         | `*/5 * * * *`     |
| `every-15m`            | Every 15 minutes        | `*/15 * * * *`    |
| `every-hour`           | Every hour              | `0 * * * *`       |
| `every-6h`             | Every 6 hours           | `0 */6 * * *`     |
| `daily-9am`            | Daily at 9am            | `0 9 * * *`       |
| `daily-midnight`       | Daily at midnight       | `0 0 * * *`       |
| `weekdays-9am`         | Weekdays at 9am         | `0 9 * * MON-FRI` |
| `weekly-mon-9am`       | Weekly Monday 9am       | `0 9 * * MON`     |
| `monthly-1st-9am`      | Monthly 1st at 9am      | `0 9 1 * *`       |
| `monthly-1st-midnight` | First of month midnight | `0 0 1 * *`       |

### Output directory

Each automation gets a sibling directory (named by UUID) for run outputs. Timestamps in directory names use hyphens instead of colons for cross-platform compatibility (Windows disallows colons in filenames). A 4-character random suffix is appended to prevent collisions if two runs start in the same second (e.g., `2026-03-25T09-00-00-a3f1`).

```
~/.fleet/automations/
  a1b2c3d4.json                    <- automation config
  a1b2c3d4/                        <- output directory
    2026-03-25T09-00-00-a3f1/      <- per-run folder (timestamp + random suffix)
      run.json                     <- run manifest (see below)
      report.csv
      summary.md
    2026-03-25T10-00-00-b7e2/
      run.json
      report.csv
      error.log
```

### Run manifest

Each run directory contains a `run.json` written at run start, updated on completion:

```json
{
  "automationId": "a1b2c3d4",
  "startedAt": "2026-03-25T09:00:00Z",
  "completedAt": "2026-03-25T09:02:34Z",
  "status": "success",
  "stepCount": 12,
  "error": null
}
```

Status values: `running`, `success`, `error`, `cancelled`. On app launch, any `run.json` with `status: "running"` is marked as `error` (crashed).

The agent receives the run's output directory path in its system prompt context so it can write files there via `write_file`.

### Key decisions

- **No step list.** Each automation is trigger + prompt. The agent handles execution autonomously.
- **No output piping.** The agent decides what to do with intermediate results.
- **No step types.** A single agent call with configurable tools replaces explicit script/fleet/prompt/agent steps.

## SDK

Vercel AI SDK (`ai` package) for multi-provider LLM support. Unified `generateText()` API with `tools` and `maxSteps` for agentic loops. Supports 20+ providers (Anthropic, OpenAI, Google, Mistral, Groq, Ollama, etc.) out of the box.

### New dependencies

| Package             | Purpose            |
| ------------------- | ------------------ |
| `ai`                | Vercel AI SDK core |
| `@ai-sdk/anthropic` | Anthropic provider |
| `@ai-sdk/openai`    | OpenAI provider    |
| `@ai-sdk/google`    | Google provider    |
| `node-cron`         | Cron scheduler     |

Additional provider packages added as needed.

### API key management

API keys are stored in Fleet's settings via `electron-store` (consistent with existing settings persistence). New settings field:

```ts
aiProviders: Record<string, { apiKey: string; baseUrl?: string }>;
// e.g. { anthropic: { apiKey: "sk-ant-..." }, openai: { apiKey: "sk-..." } }
```

Environment variables are supported as fallback (e.g., `ANTHROPIC_API_KEY`). The provider dropdown in the editor is populated by providers that have a configured key or a detected env var.

Keys are not stored in automation JSON files — only the provider name and model ID.

Settings UI: a new "AI Providers" section in the settings dialog with add/remove provider rows, each showing provider name, API key (masked), and optional base URL.

## Sidebar Integration

```
┌─────────────────────┐
│ * Star Command      │  <- existing
├─────────────────────┤
│ ⚡ Automations       │  <- new, collapsible section
│   Deploy staging     │
│   Morning emails     │
│   Backup logs        │
│   + New automation   │
├─────────────────────┤
│ Tab 1               │  <- existing terminal tabs
│ Tab 2               │
│ Tab 3               │
│ +                   │
└─────────────────────┘
```

- Collapsible section under Star Command with header and `+` button
- Each automation is clickable — opens as a tab (type `'automation'`)
- Right-click context menu: Rename, Duplicate, Delete, Show Outputs in Finder, Show in Finder
- Subtle status indicator per item: idle, running, error, cancelled
- Schedule icon shown on items that have a schedule trigger configured
- `Tab.type` extended: `'terminal' | 'star-command' | 'crew' | 'file' | 'image' | 'automation'`
- `PaneLeaf.paneType` extended: `'terminal' | 'file' | 'image' | 'automation'`
- Automation tabs use the existing `Tab` type with a dummy `splitRoot` (single `PaneLeaf` with `paneType: 'automation'`), following the same pattern as `'star-command'` and `'crew'` tabs

## Editor Layout

```
┌──────────────────────────────────────────────────────┐
│  Deploy staging                          ▶ Run  ···  │
│  Build, test, and deploy to staging server           │
├──────────────────────────────────────────────────────┤
│                                                       │
│  TRIGGER                                              │
│  ☑ Manual   ☑ Schedule  [Weekdays 9am ▾] [Custom]   │
│                                                       │
│  AGENT                                                │
│  Provider [Anthropic ▾]    Model [claude-sonnet ▾]   │
│                                                       │
│  System prompt (optional)                             │
│  ┌──────────────────────────────────────────────┐    │
│  │ You are a deployment assistant.              │    │
│  └──────────────────────────────────────────────┘    │
│                                                       │
│  Prompt                                               │
│  ┌──────────────────────────────────────────────┐    │
│  │ Run the test suite in /Users/me/project.     │    │
│  │ If all tests pass, open a new Fleet pane     │    │
│  │ and run deploy.sh. Summarize the results     │    │
│  │ and write a report.csv with test timings.    │    │
│  └──────────────────────────────────────────────┘    │
│                                                       │
│  Tools  ☑ shell  ☑ read_file  ☑ write_file  ☑ fleet │
│  Max steps [25]           Max tokens [8192]          │
│                                                       │
├──────────────────────────────────────────────────────┤
│  ▸ Logs                                              │
├──────────────────────────────────────────────────────┤
│  ▸ Outputs                     🔍 Search  ↕ Expand  │
│                                                       │
│  TODAY                                                │
│  ▾ deploy-prod   3 min ago    12 files    ✓          │
│  ├── 📊 report.csv            2.1 KB      ···       │
│  ├── 📄 summary.json          856 B       ···       │
│  └── 🖼  screenshot.png        145 KB      ···       │
│                                                       │
│  ▸ test-suite    2 hrs ago    4 files     ✓          │
│                                                       │
└──────────────────────────────────────────────────────┘
```

### Top — Header

- Name: inline editable, click to rename
- Description: inline editable, click to edit
- Run button: starts the automation (disabled while already running)
- Overflow menu (`···`): Export JSON, Duplicate, Delete, Show in Finder

### Middle — Configuration Form

**Trigger section:**

- Checkboxes: Manual, Schedule (can enable both)
- Schedule presets dropdown (see preset table in Data Model)
- "Custom" option reveals raw cron input with human-readable preview

**Agent section:**

- Provider dropdown (populated by configured API keys in Fleet settings)
- Model dropdown (filters based on selected provider)
- System prompt: optional, collapsible multiline textarea
- Prompt: multiline textarea, monospace, the core of the automation
- Tools: multi-select checklist (shell, read_file, write_file, fleet)
- Max steps: number input, default 25 (caps the tool-use loop iterations)
- Max tokens: number input, default 8192 (per generation step, not total — with maxSteps=25 theoretical max is 25 \* 8192 = 204,800 tokens)

### Bottom — Logs Panel

- Collapsed by default (`▸ Logs`), expands on run or click
- Streams real-time agent output during execution via IPC
- Shows tool calls, responses, and intermediate reasoning
- Scrollable, clearable

**Log event schema:**

```ts
interface LogEvent {
  automationId: string;
  runId: string;
  type: 'text' | 'tool-call' | 'tool-result' | 'error' | 'status';
  timestamp: string;
  content: string;
  toolName?: string; // for tool-call and tool-result
}
```

### Bottom — Outputs Panel

Displays files produced by automation runs.

**Design principles (from Baymard/NNG research):**

- Two-level progressive disclosure: runs > files, no deeper
- Summary in collapsed state: timestamp, file count, status visible without expanding
- Most recent run auto-expanded
- Grouped by day: "Today", "Yesterday", "Mar 23"
- Relative timestamps for today ("3 min ago"), absolute for older ("Yesterday 14:32")
- Hover-reveal actions on file rows: Open, Copy Path, Show in Finder
- Compact density: 32-40px run headers, 28-36px file rows
- Expand All / Collapse All in toolbar when runs > 5
- File type icons: distinct icons for CSV, JSON, log, image, etc.

**Empty state:**

```
         No outputs yet.
  Run your automation to see
       results here.

        [ ▶ Run Now ]
```

**File row hover state:**

```
├── 📊 report.csv    2.1 KB    Open  📋 Copy  📂
```

Actions hidden at rest, revealed on hover. `···` overflow menu for secondary actions.

**Run-level actions** via overflow menu on run header: Open All, Download All as ZIP, Delete Run, Copy All Paths.

## Execution Engine

Lives in Electron's main process. All async operations use promises (never blocking the event loop).

### Flow

1. User clicks Run (or cron fires)
2. If automation is already running, the run is blocked (Run button disabled, cron trigger skipped with a log warning)
3. Main process loads automation JSON from disk
4. Creates a timestamped output directory and writes `run.json` with `status: "running"`
5. Creates an `AbortController` for this run (stored in memory for cancellation)
6. Calls Vercel AI SDK `generateText()` with configured provider, model, prompt, tools, maxSteps, and the abort signal
7. Agent system prompt includes: user's system prompt + output directory path + available tool descriptions
8. Agent loops: generate → tool call → execute → feed result back → until done or maxSteps hit
9. Log events stream to renderer via IPC (`webContents.send()`) in real time
10. On completion: updates `run.json` with final status, scans output directory for files, notifies renderer

### Tool implementations

| Tool         | Implementation                                                                                                                                                                                                                     |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `shell`      | `util.promisify(child_process.exec)`. 60-second default timeout. Returns stdout/stderr.                                                                                                                                            |
| `read_file`  | `fs.promises.readFile()`. Returns file contents as string.                                                                                                                                                                         |
| `write_file` | `fs.promises.writeFile()`. Relative paths resolved against run output directory. Absolute paths written as-is (no sandboxing — agent is trusted at user level). Creates parent dirs with `fs.promises.mkdir({ recursive: true })`. |
| `fleet`      | Calls `FleetCommandHandler.handleCommand()` directly (in-process, no socket overhead). Returns JSON response.                                                                                                                      |

### Cancellation

When `stopAutomation(id)` is called:

1. The `AbortController` for this run is aborted — this cancels the `generateText()` call
2. Any in-progress `shell` child processes are killed via `process.kill()`
3. `run.json` is updated with `status: "cancelled"`
4. Partial output files are kept (not deleted)
5. Renderer is notified of the status change

### Cron scheduling

- `node-cron` in the main process (lightweight, no external deps)
- On app launch: reads all automation files, registers cron jobs for any with schedule triggers
- On automation save: deregisters old cron job (if any), registers new one if schedule is configured
- On automation delete: deregisters cron job
- On schedule checkbox disabled: deregisters cron job
- Cron only runs while Fleet is open (not a system daemon — future feature)
- If automation JSON is malformed, skip it with a console warning (do not crash)

### Error handling

| Scenario                           | Behavior                                                                                                                       |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| API key missing/invalid (401)      | Log error, set run status to `error`, show "API key not configured for [provider]" in logs panel                               |
| Provider unreachable (network)     | Log error, set run status to `error`, show network error message in logs panel                                                 |
| `generateText()` throws mid-loop   | Catch error, log it, set run status to `error`, keep partial outputs                                                           |
| `shell` command hangs              | 60-second timeout (configurable via `agent.shellTimeout` in JSON), kill process, report timeout to agent who can retry or fail |
| `write_file` permission error      | Report error to agent, agent can retry with different path or fail                                                             |
| Automation JSON corrupt/unreadable | Skip on load with console warning, show error indicator on sidebar item                                                        |
| App crash during run               | On next launch, scan for `run.json` with `status: "running"`, mark as `error`                                                  |

## State Management

### New Zustand store — `useAutomationStore`

```ts
interface AutomationMeta {
  id: string;
  name: string;
  description: string;
  status: 'idle' | 'running' | 'error' | 'cancelled';
  hasSchedule: boolean; // for sidebar schedule icon
}

interface RunState {
  runId: string; // timestamp-based, unique per run
  automationId: string;
  startedAt: string;
  logs: LogEvent[];
  status: 'running' | 'success' | 'error' | 'cancelled';
}

interface AutomationStore {
  // List
  automations: AutomationMeta[];
  loadAutomations: () => Promise<void>;

  // Execution
  runningAutomations: Record<string, RunState>; // keyed by automation ID
  runAutomation: (id: string) => void;
  stopAutomation: (id: string) => void;
}
```

Uses `Record<string, RunState>` instead of `Map` for Zustand compatibility (referential equality on mutation).

### New IPC channels

| Channel              | Type                   | Purpose                                                         |
| -------------------- | ---------------------- | --------------------------------------------------------------- |
| `AUTOMATION_LIST`    | handle (invoke/return) | List all automation files                                       |
| `AUTOMATION_READ`    | handle (invoke/return) | Read a single automation by ID                                  |
| `AUTOMATION_WRITE`   | handle (invoke/return) | Create or update an automation                                  |
| `AUTOMATION_DELETE`  | handle (invoke/return) | Delete automation file + output directory                       |
| `AUTOMATION_RUN`     | handle (invoke/return) | Start execution, returns run ID                                 |
| `AUTOMATION_STOP`    | handle (invoke/return) | Cancel running automation, returns acknowledgment               |
| `AUTOMATION_LOG`     | push (main → renderer) | Log events via `webContents.send()`, same pattern as `PTY_DATA` |
| `AUTOMATION_OUTPUTS` | handle (invoke/return) | List output files/runs for an automation                        |

### Preload bridge

Exposed via `contextBridge` as `window.fleet.automation`:

```ts
automation: {
  list: () => Promise<AutomationMeta[]>
  read: (id: string) => Promise<AutomationConfig>
  write: (config: AutomationConfig) => Promise<void>
  delete: (id: string) => Promise<void>
  run: (id: string) => Promise<string>       // returns run ID
  stop: (id: string) => Promise<void>
  outputs: (id: string) => Promise<RunOutput[]>
  onLog: (callback: (event: LogEvent) => void) => () => void  // returns unsubscribe
}
```

### Persistence

- Store holds in-memory state only (list metadata, execution state)
- All CRUD via IPC to main process which handles `fs` operations in `~/.fleet/automations/`
- Store reloads from disk on app launch and after any mutation
- File watcher (chokidar, already a dependency) on `~/.fleet/automations/` to detect external edits
- Consistent with how Fleet handles layout/workspace persistence today

### Retention policy

Run output directories are kept indefinitely by default. The "Delete Run" action in the Outputs panel overflow menu lets users clean up manually. A configurable retention policy (e.g., keep last N runs) is a future consideration.

## Agent Tool Reference

Each automation uses a single agent that has access to configurable tools. These are the available tools:

### `shell`

Executes a shell command and returns stdout/stderr.

- The agent decides what commands to run based on the prompt
- Commands run in the user's default shell
- Working directory defaults to the user's home directory
- Supports any CLI tool installed on the system (git, npm, curl, jq, etc.)
- Non-zero exit codes are reported back to the agent as errors
- Default timeout: 60 seconds (configurable via `agent.shellTimeout` in automation JSON)

### `read_file`

Reads a file from the local filesystem and returns its contents.

- Accepts an absolute file path
- Returns file contents as a string
- Binary files return a base64 representation
- Useful for the agent to inspect source code, config files, logs, etc.

### `write_file`

Writes content to a file on the local filesystem.

- Accepts a file path and content string
- Creates parent directories if needed
- Relative paths are resolved against the run's output directory
- Absolute paths are written as-is with no sandboxing (agent is trusted at user level)
- Used for producing output files (reports, CSVs, summaries, etc.)

### `fleet`

Invokes a Fleet CLI command and returns the JSON response.

- Calls `FleetCommandHandler.handleCommand()` directly (in-process, no socket overhead)
- Available commands: `new-tab`, `close-tab`, `list-tabs`, `new-pane`, `close-pane`, `list-panes`, `focus-pane`, `send-input`, `get-state`, `list-workspaces`, `load-workspace`
- Returns the CLI's JSON response (`{ ok: true, ... }` or `{ ok: false, error: "..." }`)
- Enables automations to orchestrate Fleet's terminal environment

## Type/Schema Changes

Existing types that need extending:

- `FleetSettings` (in `src/shared/types.ts`): add `aiProviders: Record<string, { apiKey: string; baseUrl?: string }>` with empty object default for existing users
- `Tab.type`: add `'automation'` to union
- `PaneLeaf.paneType`: add `'automation'` to union

### Validation rules

| Field           | Constraints                          |
| --------------- | ------------------------------------ |
| `name`          | Required, 1-100 characters           |
| `description`   | Optional, max 500 characters         |
| `prompt`        | Required, non-empty                  |
| `tools`         | Required, at least one tool selected |
| `maxSteps`      | 1-100, default 25                    |
| `maxTokens`     | 256-32768, default 8192              |
| `cron` (custom) | Must be valid cron expression        |

### Status lifecycle

```
AutomationMeta.status:
  idle → running (on run start)
  running → idle (on success)
  running → error (on failure)
  running → cancelled (on user stop)
  error → idle (on next successful run)
  cancelled → idle (on next run start)
```

### `updatedAt` management

Updated on every config save (user edits). Not updated on runs.

### Export JSON

"Export JSON" in the overflow menu opens a system save dialog with a copy of the automation's `.json` config file. Does not include run history or API keys.

## Future Considerations

Not in scope for v1, but noted for future:

- **System-level scheduling** (launchd/Task Scheduler) so automations run when Fleet is closed
- **Folder organization** for automations if the flat list outgrows itself
- **More tools** (http_request, database query, etc.) as Fleet's connection ecosystem grows
- **Fleet CLI connections** (Google accounts, Fal AI, etc.) exposed as additional tools
- **Automation sharing** — export/import JSON files between users
- **Configurable retention policy** — auto-delete runs older than N days or keep last N runs
- **Notifications** — OS-level alerts when a scheduled automation completes or fails
- **Total token budget** — cap total token usage per run (not just per-step maxTokens)
- **Per-automation working directory** (`cwd` field) so shell commands default to a project directory instead of home
