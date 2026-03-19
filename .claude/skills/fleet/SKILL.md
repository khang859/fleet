---
name: fleet
description: Fleet CLI — manage AI coding agents (Crew), Missions, Sectors, and Comms in a Fleet Starbase
---

# Fleet CLI Skill

## Core Workflow

Every time you are activated, follow this sequence:

1. **Check comms** — `fleet comms inbox --unread` — read and acknowledge any unread transmissions
2. **Review crew** — `fleet crew list` — see who is deployed and what they are working on
3. **Review missions** — `fleet missions list` — check queued and active Missions
4. **Take action** — based on the above, either deploy new Crew, update Missions, or respond to the user

## When to Deploy Crew vs Do It Yourself

**Deploy Crew when:**
- The task requires writing, editing, or running code in a Sector
- The work will take more than a few minutes
- The task is bounded and non-interactive (one Claude Code run)
- The user asks you to implement, fix, or build something
- **Something needs investigating or debugging** — send a Crew to look into it, don't investigate Sectors yourself

**Do it yourself when:**
- The request is purely informational (status check, listing, explaining)
- You need to coordinate across Sectors before dispatching
- The task is administrative (updating Mission status, reading comms)

**Reuse Crew:** Before deploying a new Crewmate, check `fleet crew list` for an existing idle or available Crew in the same Sector. Send them a Mission or comms instead of spinning up a new one. Only deploy fresh Crew when no suitable existing Crewmate is available.

## Custom Agent Configuration

Crewmates inherit their agent configuration from the Sector they are deployed to. There are no per-deployment model overrides — configuration is set at the Sector level and applies to every Mission run in that Sector.

**Configurable fields per Sector:**

| Field | Default | Description |
|-------|---------|-------------|
| `model` | `claude-sonnet-4-6` | Claude model for the agent session |
| `system_prompt` | _(none)_ | Additional context appended to every agent session |
| `allowed_tools` | _(all tools)_ | Comma-separated tools the agent may use (e.g. `Read,Edit,Bash`) |
| `mcp_config` | _(none)_ | Path to an MCP config JSON file for additional tool providers |

**Viewing Sector agent configuration:**

```
fleet sectors show <id>    # Show full Sector details including model and agent config
fleet sectors list          # List all Sectors with basic info
```

**Model selection guidance:**

- `claude-haiku-4-5` — Fast and low-cost; best for simple, well-scoped tasks (docs, formatting, minor fixes)
- `claude-sonnet-4-6` — Default; suitable for most development Missions
- `claude-opus-4-6` — Most capable; use for complex investigations, large refactors, or architecture decisions

**When to set `system_prompt` on a Sector:**

Set a system prompt to give every Crewmate persistent, project-specific context that should apply to all Missions in that Sector:
- Coding conventions (e.g. "Always use TypeScript strict mode")
- Domain constraints (e.g. "Never modify the public API contract without a migration")
- Stack-specific notes the agent should always have in mind

**Note:** Sector agent configuration is managed through the Fleet app's Sector settings panel. There is no `fleet sectors update` CLI command — changes must be made via the UI.

## Full Command Reference

### Crew

```
fleet crew list                        # List all deployed Crewmates
fleet crew list --sector <id>          # Filter by Sector
fleet crew info <crew-id>              # Show details for a specific Crewmate
fleet crew deploy --sector <id> --mission <id>  # Deploy a Crewmate to a Mission
fleet crew recall <crew-id>            # Recall (terminate) a Crewmate
fleet crew observe <crew-id>           # View recent assistant output from a Crewmate
fleet crew message <crew-id> --message "..."  # Send a follow-up message to an active Crewmate
```

### Missions

```
fleet missions list                    # List all Missions
fleet missions list --sector <id>      # Filter by Sector
fleet missions list --status queued    # Filter by status
fleet missions add --sector <id> --summary "..." --prompt "..."  # Add a Mission
fleet missions update <id> --status done    # Update Mission status
fleet missions show <id>               # Show full Mission details
```

### Comms

```
fleet comms inbox --unread             # List only unread transmissions
fleet comms inbox                      # List all transmissions (read and unread)
fleet comms check --quiet              # Check for unread comms (exit code 0 = none, 1 = unread)
fleet comms send --to <crew-id> --message "..."  # Send directive (also injects into live process)
fleet comms send --from <crew-id> --to admiral --message "..."  # Send as a Crewmate
fleet comms resolve <id> --response "..."        # Reply and mark resolved
fleet comms read-all                   # Mark all transmissions as read
fleet comms read-all --crew <crew-id>  # Mark all from a specific crew as read
fleet comms delete --id <id>           # Delete a single transmission
fleet comms clear                      # Delete all transmissions
fleet comms clear --crew <crew-id>     # Delete all transmissions for a crew
```

### Sectors

```
fleet sectors list                     # List registered Sectors
fleet sectors add --path <path>        # Register a Sector
fleet sectors remove <id>              # Unregister a Sector
fleet sectors show <id>                # Show Sector details
```

### Cargo

```
fleet cargo list                       # List all Cargo items
fleet cargo produce --sector <id> --type <type> --path <path>  # Record produced Cargo
fleet cargo pending --sector <id>      # Show undelivered Cargo for a Sector
```

### Log Groups

```
fleet log groups list                  # List all log groups (Ships Log)
fleet log groups show <id>             # Show entries for a log group
```

## Mission Scoping

When a user makes a request, decompose it into well-scoped Missions:

1. **Identify concerns** — Does the request touch multiple files, features, or Sectors?
2. **Break into Missions** — Each Mission gets a precise prompt with acceptance criteria
3. **Set priorities** — Lower number = higher priority. Dependent Missions get higher numbers
4. **Confirm with user** — Show the plan before deploying

**Good Mission prompt:**
> "Add a POST /api/settings endpoint that accepts `{ theme: string, notifications: boolean }`, validates input, persists to SQLite, and returns the updated settings. Tests must pass. No UI changes."

**Bad Mission prompt:**
> "Add a settings feature"

## Follow-Up Workflow (Mid-Flight Messaging)

Active Crewmates can receive follow-up messages while they are running. This enables
the Admiral to provide clarification, corrections, or additional context without
recalling and redeploying.

**When to use:**
- Crewmate has sent an `awaiting_feedback` comms and is waiting for a response
- You need to correct the Crewmate's approach before they commit
- Clarification is needed mid-mission without losing the working context

**How it works:**
1. Crewmate writes to comms: `fleet comms send --from $FLEET_CREW_ID --to admiral --type awaiting_feedback --message "..."`
2. Admiral reads comms: `fleet comms inbox --unread`
3. Admiral responds: `fleet comms send --to <crew-id> --message "..."` (this also injects into the live process)
   OR: `fleet crew message <crew-id> --message "..."` (direct injection only, no comms record)
4. Crewmate receives the message as a new turn in its session
5. Crewmate continues work and eventually completes the mission

### `awaiting_feedback` comms type

Use `awaiting_feedback` when you need the Admiral to provide input before you can continue:

```
fleet comms send --from $FLEET_CREW_ID --to admiral --type awaiting_feedback --message "Need clarification on X before proceeding"
```

The Admiral will respond by injecting a follow-up instruction into your session.

## Sentinel Alerts

The Starbase Sentinel is an automated watchdog that monitors system and crew health. It sends comms directly to the Admiral when it detects problems. These arrive in your inbox alongside normal Crew transmissions. Sentinel comms have no `from_crew` — they come from the system, not a Crewmate.

**Sentinel comms types and what to do:**

| Type | Meaning | Action |
|------|---------|--------|
| `lifesign_lost` | A Crew stopped sending lifesigns (stalled or crashed) | Check `fleet crew info <crew-id>`, then recall and redeploy or investigate |
| `sector_path_missing` | A registered Sector path no longer exists on disk | Alert the user — the Sector may need to be re-added or the path restored |
| `disk_warning` | Worktree disk usage has exceeded 90% of the configured budget | Alert the user to free disk space or increase the budget in app settings |
| `memory_warning` | System available memory is critically low (<0.5 GB) or low (<1 GB) | Alert the user — consider recalling Crew to free memory |

**Example response for `lifesign_lost`:**
```
fleet crew info <crew-id>      # Check last known status
fleet crew recall <crew-id>    # Recall if stuck
```

## Handling Comms

When you find unread transmissions:

1. Read each one carefully
2. For **sentinel alerts** (no from_crew, type is `lifesign_lost`, `sector_path_missing`, `disk_warning`, or `memory_warning`): see the Sentinel Alerts section above
3. For **hailing** (question from Crew): reply with `fleet comms resolve <id> --response "..."`
4. For **status** (progress update): acknowledge and mark read
5. For **blocker**: assess if you can unblock via another Mission or need to ask the user
6. Report a summary to the user if anything requires their attention

## PR Review Workflow

When a Crewmate signals their work is ready for review:

1. `fleet crew info <crew-id>` — check their status and mission details
2. `fleet crew observe <crew-id>` — check their terminal output
3. Review the PR/branch in the Sector repository
4. If approved: `fleet missions update <id> --status done`
5. If changes needed: send feedback via `fleet comms send --to <crew-id> --message "..."`

## Recovery (Fresh Start)

If you are starting a new conversation and don't know the current state:

1. `fleet crew list` — who is deployed?
2. `fleet missions list --status active` — what is in flight?
3. `fleet comms inbox --unread` — any pending messages?
4. `fleet sectors list` — what Sectors are registered?

Then summarize the state for the user before asking what to do next.

## Crew Identity

When a Crewmate is deployed, the following environment variables are set in its session:

- `FLEET_CREW_ID` — the Crewmate's unique ID (e.g. `my-sector-crew-a1b2`)
- `FLEET_SECTOR_ID` — the Sector it was deployed to
- `FLEET_MISSION_ID` — the Mission ID it is working on

Crew can use these to identify themselves in comms:

```
fleet comms send --from $FLEET_CREW_ID --to admiral --message "Found a blocker..."
fleet crew info $FLEET_CREW_ID    # Check own status
```

## Mission Completion

**You MUST send a comms report to the Admiral before completing your mission.** This is required for every mission, regardless of outcome.

```
fleet comms send --from $FLEET_CREW_ID --to admiral --message "<summary of what you did, findings, files changed, or blockers>"
```

Include in your report:
- What you found or accomplished
- Files created or changed
- Any blockers or issues encountered
- PR link if one was created

Do not exit without sending a comms report.

## Error Handling

- If a `fleet` command fails, report the error and suggest a resolution
- If a Crewmate is stuck, use `fleet crew observe <id>` to diagnose, then decide whether to recall and redeploy
- If a Mission cannot be completed as scoped, update its status and notify the user
