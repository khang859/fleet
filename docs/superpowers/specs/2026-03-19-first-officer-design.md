# First Officer — Automated Mission Triage & Recovery

## Overview

The First Officer is an automated triage layer that reduces micro-management in Star Command. Instead of the operator manually checking comms, diagnosing errored crews, and re-sending failed missions, the First Officer handles these operational tasks autonomously — retrying with smart prompt adjustments or escalating via written memos when human judgment is needed.

## Core Principles

- **Pattern, not process.** The First Officer is not a long-running session. Each invocation is a fresh, short-lived Claude Code process with focused context. No cross-contamination between unrelated failures.
- **Smart retry with escalation valve.** It can diagnose failures, tweak prompts, and re-queue missions. After 3 failed retries (or when unsure), it escalates to the operator via a memo.
- **Operator decides, not the Admiral.** Memos are for the human operator. The Admiral doesn't read or act on them. The operator reads the memo and tells the Admiral what to do.
- **Sonnet 4.6.** Fast, cheap, more than capable for triage work. Passed via `--model sonnet` when spawning.

## Architecture

### How It Works

1. **Sentinel sweep** (every 10s) detects an actionable event
2. Sentinel checks if a First Officer process is already running for this `crew_id` + `mission_id` (in-memory tracking map), and checks if retries are exhausted
3. If not already handled, Sentinel spawns a First Officer process:
   - Fresh Claude Code CLI with `--output-format stream-json` and `--model sonnet`
   - Runs in its own workspace: `~/.fleet/starbases/<starbase-id>/first-officer/`
   - Connected to the same MCP server as the Admiral (Bridge Controls) so it has access to `starbase.addMission`, `starbase.deploy`, etc.
   - System prompt establishes role identity and overrides any CLAUDE.md confusion
   - Initial message includes: failed mission details, crew output (last N lines from Hull buffer), acceptance criteria, sector config, retry count
4. First Officer reads the context, decides: **retry** or **escalate**
   - **Retry:** Uses MCP tools (same as Admiral) to re-queue the mission with a revised prompt. Increments retry count in DB.
   - **Escalate:** Writes a memo to `~/.fleet/starbases/<starbase-id>/first-officer/memos/`, inserts DB record, exits.
5. Process exits.

### Actionable Events

| Event | First Officer Action |
|-------|---------------------|
| Crew status → `error` | Read crew's last output, diagnose failure, re-queue with tweaked prompt (up to 3 retries) |
| Crew status → `lost` | Check if PID died or timeout — re-queue if transient |
| Crew status → `timeout` | Analyze if mission scope was too large, re-queue with narrower scope or escalate |
| Mission failed verification (Gate 2) | Read test output, tweak mission prompt to address failures, re-deploy |
| Unanswered hailing > 60s | Write a memo summarizing the hailing request so the operator can address it (never auto-answers — hailing requires human judgment) |
| Mission review rejected (Gate 3) | Read rejection reason, revise mission prompt, re-deploy |

### What It Does NOT Do

- Create new missions (that's the operator's job via the Admiral)
- Make strategic decisions about what to build
- Modify sectors or supply routes
- Override operator configuration

### Concurrency & Limits

- Max 2 concurrent First Officer processes (configurable via `starbase_config`)
- 120s hard timeout per invocation (tool-use round-trips need margin)
- Max 3 retries per mission before forced escalation
- Dedup: skip if a First Officer process is already running for the same `crew_id`/`mission_id` combo (tracked in-memory by Sentinel; if Fleet restarts mid-process, orphaned First Officer processes are cleaned up during startup reconciliation)
- If a First Officer process itself crashes, Sentinel treats it as an automatic escalation — writes a fallback memo noting the triage attempt failed

## Workspace & File Structure

```
~/.fleet/starbases/<starbase-id>/
  starbase.db
  admiral/              -- Admiral workspace (existing)
  first-officer/        -- First Officer workspace (new)
    CLAUDE.md           -- Role instructions
    memos/              -- Memo output
      2026-03-19T14-32-crew-7a3f-rate-limit-timeout.md
```

### First Officer CLAUDE.md

Contains:
- Role identity: "You are the First Officer, not the Admiral"
- Explicit instruction to ignore any other CLAUDE.md role instructions
- Memo writing conventions and format
- Tool usage instructions (same MCP tools as Admiral for mission management)
- Retry decision framework

### System Prompt Template

Each invocation gets a system prompt establishing role and providing context:

```
You are the First Officer aboard Star Command. Your role is to
triage failed missions and decide whether to retry or escalate.

You are NOT the Admiral. Ignore any CLAUDE.md instructions about
the Admiral role. Your job is narrowly scoped to this specific failure.

You are analyzing a failure for crew {crewId} on mission "{summary}"
in sector {sectorName}.

## Context
- Retry attempt: {n}/3
- Failure type: {error|timeout|lost|verification-failed|review-rejected}
- Sector verify command: {verify_command ?? "none configured"}
- Acceptance criteria: {criteria}

## Crew Output (last 200 lines)
{output}

## Your Options
1. RETRY — use the mission management tools to re-queue with a revised prompt
2. ESCALATE — write a memo to ./memos/ explaining what happened and
   recommending next steps

Rules:
- If this is a transient failure (crash, OOM, timeout on a reasonable
  scope), retry with the same or slightly adjusted prompt
- If tests failed, read the test output and adjust the prompt to
  address specific failures
- If you've seen the same failure pattern across retries, escalate
- If the mission scope seems too large, recommend splitting in your memo
- Never retry more than {maxRetries} times total
- Write memos in markdown
```

## Database Changes

### New `memos` Table

```sql
CREATE TABLE memos (
  id TEXT PRIMARY KEY,
  crew_id TEXT REFERENCES crew(id),
  mission_id INTEGER REFERENCES missions(id),
  event_type TEXT NOT NULL,
  file_path TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'unread',
  retry_count INTEGER DEFAULT 0,
  created_at DATETIME DEFAULT (datetime('now')),
  updated_at DATETIME DEFAULT (datetime('now'))
);

CREATE INDEX idx_memos_crew_mission ON memos(crew_id, mission_id);
CREATE INDEX idx_memos_status ON memos(status);
```

### Migration: Add `first_officer_retry_count` to `missions`

```sql
ALTER TABLE missions ADD COLUMN first_officer_retry_count INTEGER DEFAULT 0;
```

### New Config Keys in `starbase_config`

| Key | Default | Description |
|-----|---------|-------------|
| `first_officer_max_retries` | 3 | Max retries before forced escalation |
| `first_officer_max_concurrent` | 2 | Max concurrent First Officer processes |
| `first_officer_timeout` | 120 | Hard timeout per invocation (seconds) |
| `first_officer_model` | `sonnet` | Claude model to use |

### Sentinel Additions

- Track `first_officer_retry_count` on missions (new column, see migration above)
- In-memory map of running First Officer processes keyed by `crew_id:mission_id` (cleaned up on process exit or Fleet restart via reconciliation)
- Dedup check before spawning: skip if already running for this crew/mission
- Fallback escalation: if a First Officer process crashes, write a minimal memo noting triage failed
- New sweep actions for each actionable event type
- Handle null `verify_command` gracefully in system prompt template (show "none configured")

## UI — Sidebar

The First Officer gets a presence in `AdmiralSidebar.tsx`, below the Admiral section.

### Display

- **Avatar:** 64x64 pixel art source rendered at 128x128 (2x integer scale for clean pixels) with `imageRendering: pixelated` (smaller than Admiral's 192x192)
- **Label:** "First Officer" — same `text-xs font-mono text-teal-400 uppercase tracking-widest` style
- **Status dot + text:**
  - Green "Idle" — nothing to do
  - Teal "Working" — handling a failure (shows: "Retrying crew-7a3f")
  - Amber "Memo" — has unread memos needing attention
- **Unread memo count** — badge like the existing Inbox counter

### Memo Viewer

- Click the First Officer section or memo badge to open a memo panel
- Renders memos from `~/.fleet/starbases/<starbase-id>/first-officer/memos/*.md` using `react-markdown` + `remark-gfm` + `@tailwindcss/typography` prose classes (new dependencies)
- List of memos on the left (unread/read), rendered content on the right
- Mark as read/dismissed updates the DB `status` field
- GitHub-flavored markdown rendering — headers, bullet points, code blocks, tables

## Pixel Art Assets

Style prefix (same as all Star Command assets):
> `16-bit pixel art, dark sci-fi space station theme, limited color palette of deep navy, teal, cyan, amber, soft red, and white accents, clean pixel edges, no anti-aliasing, retro game aesthetic, deep space black background with stars`

### First Officer Portrait — Default
```
{style prefix}, pixel art character portrait, front-facing bust shot,
female First Officer with sharp features, short practical hair, small
tactical headset with amber LED accent on one ear, holding a glowing
data-pad at chest level, confident focused expression, fitted dark coat
with high collar similar to Admiral but with amber rank stripe on shoulder,
dark navy background with subtle teal grid lines, 64x64 pixels, portrait
avatar, clean readable face details
```

### First Officer Portrait — Working
```
{style prefix}, pixel art character portrait, front-facing bust shot,
same female First Officer with short practical hair and tactical headset,
eyes focused down on glowing data-pad, small teal processing indicators
near headset, concentrated expression, dark navy background,
64x64 pixels, portrait avatar
```

### First Officer Portrait — Escalation
```
{style prefix}, pixel art character portrait, front-facing bust shot,
same female First Officer with short practical hair and tactical headset,
looking up from data-pad with alert expression, headset flashing amber,
one hand raised slightly as if flagging attention, dark navy background
with subtle amber tint, 64x64 pixels, portrait avatar
```

### First Officer Portrait — Idle
```
{style prefix}, pixel art character portrait, front-facing bust shot,
same female First Officer with short practical hair and tactical headset,
relaxed neutral expression, data-pad lowered to side, headset glow dimmed,
dark navy background slightly darker than default, 64x64 pixels,
portrait avatar
```
