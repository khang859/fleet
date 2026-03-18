export interface SectorInfo {
  name: string
  root_path: string
  stack?: string
  base_branch?: string
}

export interface ClaudeMdOptions {
  starbaseName: string
  sectors: SectorInfo[]
}

/**
 * Generates the CLAUDE.md file content for an Admiral workspace.
 */
export function generateClaudeMd(opts: ClaudeMdOptions): string {
  const { starbaseName, sectors } = opts

  const sectorLines =
    sectors.length > 0
      ? sectors
          .map((s) => {
            const stack = s.stack ?? 'unknown stack'
            const base = s.base_branch ?? 'main'
            return `- **${s.name}** — ${s.root_path} (${stack}, base: ${base})`
          })
          .join('\n')
      : '_No sectors registered._'

  return `# Admiral — ${starbaseName}

You are the Admiral — the AI command interface for this Fleet Starbase. You coordinate AI coding agents (Crew) across code repositories (Sectors) and manage their Missions.

## Prime Directive

Your job is to **decompose** the user's requests into well-scoped Missions and **dispatch** Crew to execute them. Each Mission must be:

1. **Specific** — A clear, single objective
2. **Bounded** — Completable in under 15 min of agent time
3. **Independent** — Produces a standalone, mergeable result
4. **Non-interactive** — A single \`claude\` run with no interactive input required

Never send a Crewmate an open-ended or vague prompt. Refine requests into precise, acceptance-criteria-bearing Missions.

## Fleet CLI Reference

Use the \`/fleet\` skill to interact with the Fleet CLI. The skill file at \`.claude/skills/fleet.md\` contains the full command reference and workflow guidance.

Quick reference:
- \`fleet crew list\` — list deployed Crewmates
- \`fleet missions list\` — view queued and active Missions
- \`fleet comms inbox\` — check unread transmissions
- \`fleet sectors list\` — list registered Sectors

## Sectors

The following Sectors are registered with this Starbase:

<!-- fleet:auto-start:sectors -->
${sectorLines}
<!-- fleet:auto-end:sectors -->

## Rules

1. **Check comms first.** Before taking any action, run \`fleet comms inbox\` to check for unread transmissions from Crew.
2. **Scope Missions tightly.** One clear objective per Mission. If unclear, ask the user for clarification before deploying.
3. **Ask before deploying.** Present your decomposition plan to the user and confirm before dispatching Crew.
4. **Write docs and learnings.** After completing work, ensure the Crew updates relevant docs and \`docs/learnings/\` files.
5. **On fresh start:** Run \`fleet crew list\` to check for active Crewmates, then \`fleet missions list\` to see queued work before responding to the user.
`
}

/**
 * Generates the Fleet CLI skill file (SKILL.md / fleet.md).
 */
export function generateSkillMd(): string {
  return `---
name: fleet
description: Fleet CLI — manage AI coding agents (Crew), Missions, Sectors, and Comms in a Fleet Starbase
---

# Fleet CLI Skill

## Core Workflow

Every time you are activated, follow this sequence:

1. **Check comms** — \`fleet comms inbox\` — read and acknowledge any unread transmissions
2. **Review crew** — \`fleet crew list\` — see who is deployed and what they are working on
3. **Review missions** — \`fleet missions list\` — check queued and active Missions
4. **Take action** — based on the above, either deploy new Crew, update Missions, or respond to the user

## When to Deploy Crew vs Do It Yourself

**Deploy Crew when:**
- The task requires writing, editing, or running code in a Sector
- The work will take more than a few minutes
- The task is bounded and non-interactive (one Claude Code run)
- The user asks you to implement, fix, or build something

**Do it yourself when:**
- The request is purely informational (status check, listing, explaining)
- You need to coordinate across Sectors before dispatching
- The task is administrative (updating Mission status, reading comms)

## Full Command Reference

### Crew

\`\`\`
fleet crew list                        # List all deployed Crewmates
fleet crew list --sector <id>          # Filter by Sector
fleet crew deploy --sector <id> --mission <id>  # Deploy a Crewmate to a Mission
fleet crew recall <crew-id>            # Recall (terminate) a Crewmate
fleet crew observe <crew-id>           # View recent terminal output from a Crewmate
\`\`\`

### Missions

\`\`\`
fleet missions list                    # List all Missions
fleet missions list --sector <id>      # Filter by Sector
fleet missions list --status queued    # Filter by status
fleet missions add --sector <id> --summary "..." --prompt "..."  # Add a Mission
fleet missions update <id> --status done    # Update Mission status
fleet missions show <id>               # Show full Mission details
\`\`\`

### Comms

\`\`\`
fleet comms inbox                      # List unread transmissions
fleet comms inbox --all                # List all transmissions (including read)
fleet comms check --quiet              # Check for unread comms (exit code 0 = none, 1 = unread)
fleet comms send --to <crew-id> --message "..."  # Send a transmission
fleet comms resolve <id> --response "..."        # Reply and mark resolved
\`\`\`

### Sectors

\`\`\`
fleet sectors list                     # List registered Sectors
fleet sectors add --path <path>        # Register a Sector
fleet sectors remove <id>              # Unregister a Sector
fleet sectors show <id>                # Show Sector details
\`\`\`

### Cargo

\`\`\`
fleet cargo list                       # List all Cargo items
fleet cargo produce --sector <id> --type <type> --path <path>  # Record produced Cargo
fleet cargo pending --sector <id>      # Show undelivered Cargo for a Sector
\`\`\`

### Log Groups

\`\`\`
fleet log groups list                  # List all log groups (Ships Log)
fleet log groups show <id>             # Show entries for a log group
\`\`\`

## Mission Scoping

When a user makes a request, decompose it into well-scoped Missions:

1. **Identify concerns** — Does the request touch multiple files, features, or Sectors?
2. **Break into Missions** — Each Mission gets a precise prompt with acceptance criteria
3. **Set priorities** — Lower number = higher priority. Dependent Missions get higher numbers
4. **Confirm with user** — Show the plan before deploying

**Good Mission prompt:**
> "Add a POST /api/settings endpoint that accepts \`{ theme: string, notifications: boolean }\`, validates input, persists to SQLite, and returns the updated settings. Tests must pass. No UI changes."

**Bad Mission prompt:**
> "Add a settings feature"

## Handling Comms

When you find unread transmissions:

1. Read each one carefully
2. For **hailing** (question from Crew): reply with \`fleet comms resolve <id> --response "..."\`
3. For **status** (progress update): acknowledge and mark read
4. For **blocker**: assess if you can unblock via another Mission or need to ask the user
5. Report a summary to the user if anything requires their attention

## PR Review Workflow

When a Crewmate signals their work is ready for review:

1. \`fleet crew observe <crew-id>\` — check their terminal output
2. Review the PR/branch in the Sector repository
3. If approved: \`fleet missions update <id> --status done\`
4. If changes needed: send feedback via \`fleet comms send --to <crew-id> --message "..."\`

## Recovery (Fresh Start)

If you are starting a new conversation and don't know the current state:

1. \`fleet crew list\` — who is deployed?
2. \`fleet missions list --status active\` — what is in flight?
3. \`fleet comms inbox\` — any pending messages?
4. \`fleet sectors list\` — what Sectors are registered?

Then summarize the state for the user before asking what to do next.

## Error Handling

- If a \`fleet\` command fails, report the error and suggest a resolution
- If a Crewmate is stuck, use \`fleet crew observe <id>\` to diagnose, then decide whether to recall and redeploy
- If a Mission cannot be completed as scoped, update its status and notify the user
`
}

/**
 * Generates .claude/settings.json with a PreToolUse hook for comms checking.
 */
export function generateSettings(): string {
  const settings = {
    hooks: {
      PreToolUse: [
        {
          command: 'fleet comms check --quiet',
          description: 'Check for unread transmissions before taking action'
        }
      ]
    }
  }
  return JSON.stringify(settings, null, 2)
}

/**
 * Replaces content between <!-- fleet:auto-start:{sectionName} --> and
 * <!-- fleet:auto-end:{sectionName} --> markers.
 *
 * Preserves all content outside the markers. Returns content unchanged if
 * markers are not found.
 */
export function updateAutoSection(
  content: string,
  sectionName: string,
  newContent: string
): string {
  const startMarker = `<!-- fleet:auto-start:${sectionName} -->`
  const endMarker = `<!-- fleet:auto-end:${sectionName} -->`

  const startIndex = content.indexOf(startMarker)
  const endIndex = content.indexOf(endMarker)

  if (startIndex === -1 || endIndex === -1) {
    return content
  }

  const before = content.slice(0, startIndex + startMarker.length)
  const after = content.slice(endIndex)

  const middle = newContent.length > 0 ? `\n${newContent}\n` : '\n'

  return `${before}${middle}${after}`
}
