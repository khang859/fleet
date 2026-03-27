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
| `system_prompt` | _(none)_ | Additional context appended to every agent session |
| `allowed_tools` | _(all tools)_ | Comma-separated tools the agent may use (e.g. `Read,Edit,Bash`) |
| `mcp_config` | _(none)_ | Path to an MCP config JSON file for additional tool providers |

**Viewing Sector agent configuration:**

```
fleet sectors show <id>    # Show full Sector details and agent config
fleet sectors list          # List all Sectors with basic info
```

**Model selection guidance:**

- `claude-haiku-4-5` — Fast and low-cost; best for simple, well-scoped tasks (docs, formatting, minor fixes)
- `claude-opus-4-6` — Most capable; use for complex investigations, large refactors, or architecture decisions

**When to set `system_prompt` on a Sector:**

Set a system prompt to give every Crewmate persistent, project-specific context that should apply to all Missions in that Sector:
- Coding conventions (e.g. "Always use TypeScript strict mode")
- Domain constraints (e.g. "Never modify the public API contract without a migration")
- Stack-specific notes the agent should always have in mind

**Note:** Sector agent configuration is managed through the Fleet app's Sector settings panel. There is no `fleet sectors update` CLI command — changes must be made via the UI.

## Full Command Reference

### File Operations

```
fleet open <path> [path2 ...]    # Open file(s) or image(s) in Fleet tabs
```

### Crew

```
fleet crew list                        # List all deployed Crewmates
fleet crew list --sector <id>          # Filter by Sector
fleet crew info <crew-id>              # Show details for a specific Crewmate
fleet crew deploy --sector <id> --mission <id>  # Deploy a Crewmate to execute a Mission
fleet crew recall <crew-id>            # Recall (terminate) a Crewmate
fleet crew observe <crew-id>           # View recent assistant output from a Crewmate
fleet crew message <crew-id> --message "..."  # Send a follow-up message to an active Crewmate
```

**IMPORTANT:** `crew deploy` requires a numeric mission ID. You MUST create a mission first, then deploy. Passing a prompt string to `--mission` will fail.

### Missions

```
fleet missions list                    # List all Missions
fleet missions list --sector <id>      # Filter by Sector
fleet missions list --status queued    # Filter by status
fleet missions add --sector <id> --type <code|research|review|architect|repair> --summary "..." --prompt "..."  # Create a Mission
fleet missions add --sector <id> --type repair --pr-branch <branch> --summary "..." --prompt "..."  # Create a repair mission for an existing PR
fleet missions add ... --depends-on <research-id>   # Link a research dependency (can repeat for multiple)
fleet missions update <id> --status done    # Update Mission status
fleet missions show <id>               # Show full Mission details
fleet missions cancel <id>             # Cancel a queued Mission
fleet missions verdict <id> --verdict <approved|changes-requested|escalated> --notes "..."  # Set review verdict
```

**Required fields for `missions add`:** `--type` (code, research, review, architect, or repair), `--summary` (short title), and `--prompt` (detailed instructions) are all required. Use `--type code` for work that produces git commits, `--type research` for investigation/analysis that produces documentation artifacts, `--type review` for PR code reviews that produce a VERDICT (approve/request-changes/escalate), `--type architect` for implementation blueprints, and `--type repair` for fixing CI failures or review comments on an existing PR branch (requires `--pr-branch`). Use `--depends-on <research-mission-id>` to attach research dependencies (optional, encouraged for non-trivial changes).

### Comms

```
fleet comms inbox --unread             # List only unread transmissions
fleet comms inbox                      # List all transmissions (read and unread)
fleet comms check --quiet              # Check for unread comms (exit code 0 = none, 1 = unread)
fleet comms send --to <crew-id> --message "..."  # Send directive (also injects into live process)
fleet comms send --from <crew-id> --to admiral --message "..."  # Send as a Crewmate
fleet comms resolve <id> --response "..."        # Reply and mark resolved
fleet comms read <id>                  # Mark a single transmission as read
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

### Images

```
fleet images generate --prompt "..."                    # Generate image(s) from a text prompt
fleet images edit --prompt "..." --images <file1> [file2 ...]  # Edit images with a prompt + reference images
fleet images status <id>                                # Check generation status
fleet images list                                       # List all generations
fleet images retry <id>                                 # Retry a failed generation
fleet images config                                     # Show current image generation configuration
fleet images config --api-key <key>                     # Set fal.ai API key
fleet images config --default-resolution <0.5K|1K|2K|4K>  # Set default resolution
```

**Options for generate/edit:**
- `--provider <id>` — Image provider (default: fal-ai)
- `--model <model>` — Model to use (default: fal-ai/nano-banana-2)
- `--resolution <res>` — 0.5K, 1K, 2K, or 4K (default: 1K)
- `--aspect-ratio <ratio>` — e.g. 1:1, 16:9, 9:16 (default: 1:1)
- `--format <fmt>` — png, jpeg, or webp (default: png)
- `--num-images <n>` — 1-4 (default: 1)

**Non-blocking:** Commands return immediately with a generation ID. Images are downloaded in the background. Use `fleet images status <id>` to check progress.

**Writing effective prompts:**

Nano Banana 2 uses multimodal reasoning — write conversational, descriptive prompts rather than keyword-stuffed ones. Structure your prompt with these elements:

1. **Subject** — Be specific: age, clothing, expression, pose. Not "a hacker" but "24-year-old woman in matte-black techwear jacket, intense focused expression"
2. **Environment** — Setting and context: "rain-soaked Tokyo alleyway at 2 AM, puddles reflecting neon signs"
3. **Composition** — Camera framing: "extreme close-up", "Dutch angle", "rule of thirds", "bird's-eye perspective"
4. **Lighting** — The biggest quality lever: "cinematic rim lighting", "golden hour backlighting", "volumetric god rays", "chiaroscuro shadows"
5. **Style** — Artistic medium: "1980s dark fantasy oil painting", "Studio Ghibli cel-shaded anime", "Unreal Engine 5 render"
6. **Camera specs** (for photorealism) — "85mm lens, f/1.8 aperture, shallow depth of field, bokeh background"

**Common mistakes to avoid:**
- Generic quality tags like "masterpiece, highly detailed, 8k" are junk tokens — describe actual details instead
- Place the primary subject in the first 10-15 words (early tokens carry more weight)
- Iterate in small moves: change one thing per round (color, camera distance, pose, background)

**Example — weak vs strong:**
- Weak: `"A cat in space, highly detailed, 8k"`
- Strong: `"Orange tabby cat floating in zero gravity inside the ISS cupola module, Earth visible through the window behind, soft diffused natural light from the window, wide-angle 14mm lens, NASA documentary photography style"`

### Log Groups

```
fleet log groups list                  # List all log groups (Ships Log)
fleet log groups show <id>             # Show entries for a log group
```

### Protocols

```
fleet protocols list                              # List all available protocols
fleet protocols show <slug>                       # Show protocol details and steps
fleet protocols enable <slug>
fleet protocols disable <slug>
fleet protocols executions list                   # List all active/recent executions
fleet protocols executions list --status running  # Filter by status
fleet protocols executions show <id>              # Show execution detail
```

## Mission Scoping & Deployment Workflow

**Always create a Mission first, then deploy a Crew for it.** This two-step workflow ensures mission prompts are persisted and never lost.

### Step-by-step:

1. **Identify concerns** — Does the request touch multiple files, features, or Sectors?
2. **Break into Missions** — Each Mission gets a precise prompt with acceptance criteria
3. **Confirm with user** — Show the plan before deploying
4. **Create Missions** — `fleet missions add --sector <id> --type <code|research|review|architect|repair> --summary "..." --prompt "..."`
5. **Deploy Crew** — `fleet crew deploy --sector <id> --mission <mission-id>`

### Example:

```bash
# Step 1: Create the mission (returns the mission ID)
fleet missions add --sector my-app --type code --summary "Add POST /api/settings endpoint" --prompt "Add a POST /api/settings endpoint that accepts { theme: string, notifications: boolean }, validates input, persists to SQLite, and returns the updated settings. Tests must pass. No UI changes."

# Step 2: Deploy crew to execute the mission
fleet crew deploy --sector my-app --mission 42
```

### Research-First Workflow (recommended for non-trivial code missions)

For anything beyond a trivial change, create a research mission first to gather context, then create a code mission that depends on it. The code mission will not be scheduled until the research mission reaches a terminal state.

```bash
# 1. Create the research mission
fleet missions add --sector <id> --type research --summary "Investigate X" --prompt "Investigate..."

# 2. Create the code mission that depends on the research
fleet missions add --sector <id> --type code --summary "Implement X" --prompt "..." --depends-on <research-mission-id>

# 3. Deploy the research crew first
fleet crew deploy --sector <id> --mission <research-mission-id>

# 4. When research completes, deploy the code crew
fleet crew deploy --sector <id> --mission <code-mission-id>
```

When the code crew starts, it receives a header listing the research cargo file paths and can use the Read tool to load findings if the task requires them.

### NEVER do this:
```bash
# WRONG — passing prompt text to --mission will fail
fleet crew deploy --sector my-app --mission "Add a settings feature"
```

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
| `memo` | Escalation report from the First Officer | Read the summary in payload. For full details, read the markdown file at `payload.filePath`. Decide whether to create a new mission, adjust scope, or investigate manually. |
| `hailing-memo` | Crew waiting for a response >60s | Review and respond via `fleet crew message` |

**Example response for `lifesign_lost`:**
```
fleet crew info <crew-id>      # Check last known status
fleet crew recall <crew-id>    # Recall if stuck
```

## Protocol Comms

When you receive any of these comms types, take the indicated action:

| Type | Action |
|------|--------|
| `gate-pending` | A Protocol execution needs your decision. Read the payload, present the Feature Brief or question to the operator, collect their response, then spawn a new Navigator invocation with the response in context. |
| `protocol-complete` | A Protocol finished. Present the Feature Brief summary to the operator and offer to create missions from it. |
| `protocol-failed` | A Protocol failed. Present the failure reason. Ask if the operator wants to retry. |
| `clarification-needed` | Same as gate-pending — a clarification question needs human input before the execution can continue. |
| `gate-expired` | A gate timed out with no response. The execution is cancelled. Notify the operator. |

## Handling Comms

When you find unread transmissions:

1. Read each one carefully
2. For **sentinel alerts** (no from_crew, type is `lifesign_lost`, `sector_path_missing`, `disk_warning`, or `memory_warning`): see the Sentinel Alerts section above
3. For **hailing** (question from Crew): reply with `fleet comms resolve <id> --response "..."`
4. For **status** (progress update): acknowledge and mark read with `fleet comms read <id>`
5. For **blocker**: assess if you can unblock via another Mission or need to ask the user
6. Report a summary to the user if anything requires their attention

## PR Review Workflow

When a Crewmate signals their work is ready for review:

1. `fleet crew info <crew-id>` — check their status and mission details
2. `fleet crew observe <crew-id>` — check their terminal output
3. Review the PR/branch in the Sector repository
4. If approved: `fleet missions update <id> --status done`
5. If changes needed: send feedback via `fleet comms send --to <crew-id> --message "..."`

## Repair Workflow

When a PR has CI failures or human review comments that need addressing after the First Officer has approved it, dispatch a **repair crew**:

```bash
# 1. Create a repair mission targeting the existing PR branch
fleet missions add --sector <id> --type repair \
  --pr-branch <branch-name> \
  --original-mission-id <original-code-mission-id> \
  --summary "Fix CI failures on <feature>" \
  --prompt "CI is failing with the following output: <paste ci output>. Fix the issues and push to the existing PR branch."

# 2. Deploy the repair crew
fleet crew deploy --sector <id> --mission <repair-mission-id>
```

**Key rules for repair missions:**
- `--pr-branch` is required — specifies the existing PR branch to check out
- The repair crew works on the existing branch and pushes directly to the open PR
- Do NOT use `--type code` for this — that creates a new branch and new PR
- After the repair crew completes, the First Officer automatically dispatches a fresh review crew
- CI failures on approved missions are also detected and repaired automatically by the First Officer (no manual action needed in most cases)

## Recovery (Fresh Start)

If you are starting a new conversation and don't know the current state:

1. `fleet crew list` — who is deployed?
2. `fleet missions list --status active` — what is in flight?
3. `fleet comms inbox --unread` — any pending messages?
4. `fleet sectors list` — what Sectors are registered?

Then summarize the state for the user before asking what to do next.

## Research Mission Output Format

When `FLEET_MISSION_TYPE=research`, your findings are captured as **cargo** from your terminal output. Follow these rules:

**What gets captured:** All text you print to stdout — your analysis, findings, summaries, and conclusions.

**What does NOT get captured:** Files written to disk. The git safety guard will discard any files you create or modify. Do not write files as your primary output method.

**How to structure your research output:**

1. Print findings directly to your terminal output using `echo`, `console.log`, or by writing text in your assistant responses
2. Structure output clearly with headers, sections, and conclusions
3. End your session with a clear summary of findings
4. Do NOT create pull requests or commits — git changes are discarded automatically

**Example output structure:**
```
## Research Findings: [Topic]

### Summary
[Brief summary of key findings]

### Details
[Detailed investigation results]

### Conclusions
[Actionable conclusions and recommendations]
```

**Checking your mission type:**
```bash
echo $FLEET_MISSION_TYPE   # 'research', 'code', 'review', 'architect', or 'repair'
```

When a research mission completes, its summary cargo path is referenced in the initial message of any code missions that depend on it. The code crew can Read the file on demand if the task requires the findings.

## Crew Identity

When a Crewmate is deployed, the following environment variables are set in its session:

- `FLEET_CREW_ID` — the Crewmate's unique ID (e.g. `my-sector-crew-a1b2`)
- `FLEET_SECTOR_ID` — the Sector it was deployed to
- `FLEET_MISSION_ID` — the Mission ID it is working on
- `FLEET_MISSION_TYPE` — the mission type (`research`, `code`, `review`, `architect`, or `repair`)

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
