# Crew Deploy Agent Scoping

**Date:** 2026-03-19
**Mission:** Research how `fleet crew deploy` uses mission type to configure Hull agents

---

## Summary

`fleet crew deploy` is **partially** mission-type-aware: it reads the mission type from the DB and passes it to `Hull`, which uses it to control **post-run cleanup behavior** (cargo vs. PR). However, `Hull` does **not** apply any mission-type-specific model, system prompt, or tool restrictions at spawn time. All agent configuration is inherited uniformly from the Sector, regardless of whether the mission is `code` or `research`.

**Short answer:** No — crew deploy does NOT use custom agents differentiated by mission type. Every crew spawns `claude` with the same Sector-level config.

---

## 1. Current Crew Deploy Flow

### CLI → Socket → Service

```
fleet crew deploy --sector <id> --mission <id>
  ↓ (fleet-cli.ts runCLI)
socket command: crew.deploy { mission: <id>, sector: <id> }
  ↓ (socket-server.ts:432)
mission = missionService.getMission(missionId)    // reads mission.type from DB
crewService.deployCrew({ sectorId, prompt, missionId, type: args.type })
  ↓ (crew-service.ts:71)
missionType = missionRow.type ?? 'code'           // line 93
hull = new Hull({ ..., missionType, model: sector.model, systemPrompt: sector.system_prompt, ... })
hull.start()
```

**Key files:**
- `src/main/fleet-cli.ts:374-393` — client-side validation for `crew.deploy`
- `src/main/socket-server.ts:432-496` — server-side `crew.deploy` handler
- `src/main/starbase/crew-service.ts:71-198` — `deployCrew()` implementation
- `src/main/starbase/hull.ts:93-264` — `Hull.start()` spawns the Claude process

### Mission Type Resolution

In `crew-service.ts:92-93`:
```typescript
const missionRow = missionService.getMission(missionId)!
const missionType = missionRow.type ?? 'code'
```

The mission type is sourced from the `missions` table (set when the mission was created via `fleet missions add --type <code|research>`). It is then passed to `Hull` at `crew-service.ts:183`:
```typescript
missionType,
```

**Note:** `socket-server.ts:493` passes `type: args.type as string | undefined`, but the CLI `crew deploy` command has no `--type` flag — so `args.type` is always `undefined`. The effective type always comes from the mission record.

---

## 2. Hull: Agent Initialization

`hull.ts:155-196` spawns the Claude Code process. The key arguments built:

```typescript
const model = this.opts.model || 'claude-sonnet-4-6'   // line 165
const cmdArgs = [
  '--output-format', 'stream-json',
  '--verbose',
  '--input-format', 'stream-json',
  '--dangerously-skip-permissions',
  '--model', model
]
if (this.opts.systemPrompt) {
  // writes to temp file, adds --append-system-prompt-file (line 173-178)
}
if (this.opts.allowedTools) {
  cmdArgs.push('--allowedTools', this.opts.allowedTools)  // line 180
}
if (this.opts.mcpConfig) {
  cmdArgs.push('--mcp-config', this.opts.mcpConfig)        // line 183
}
```

All of `model`, `systemPrompt`, `allowedTools`, `mcpConfig` come from the **Sector**, not from the mission type. `missionType` is stored in `this.opts` but is **not consulted** during process spawn.

### Where `missionType` IS Used in Hull

| Location | Effect |
|---|---|
| `hull.ts:335-338` | Research missions get 2000-line output buffer; others 200 |
| `hull.ts:434` | Review timeout → escalate instead of entering failure triage |
| `hull.ts:550` | Research + no git changes → produce cargo, mark `completed` |
| `hull.ts:637` | Research with git changes → discard git changes, produce cargo |
| `hull.ts:713` | Review with git changes → discard git changes, parse verdict |

**None of these touch the agent spawn arguments.** The mission type only affects what happens *after* the agent finishes.

---

## 3. Sector Agent Configuration

The `sectors` table stores per-sector agent config (see `sector-service.ts:13-31`):

| Field | Default | Description |
|---|---|---|
| `model` | `null` (falls back to `claude-sonnet-4-6`) | Claude model for all missions in this sector |
| `system_prompt` | `null` | Appended to every agent session via `--append-system-prompt-file` |
| `allowed_tools` | `null` (all tools allowed) | Comma-separated tool allowlist, e.g. `Read,Grep,WebSearch` |
| `mcp_config` | `null` | Path to MCP JSON config for additional tool providers |

`fleet sectors show <id>` returns the full sector row including all these fields.

**These fields apply uniformly to every mission deployed to the sector, regardless of type.** There is no sector-level mechanism to override config per mission type.

### Sector config is set via UI only

Per `workspace-templates.ts:165-166`:
> "Sector agent configuration is managed through the Fleet app's Sector settings panel. There is no `fleet sectors update` CLI command — changes must be made via the UI."

---

## 4. System Prompt Behavior

### What is currently applied

- If `sector.system_prompt` is non-null: written to a temp file at `{tmpdir}/fleet-prompts/{crewId}-system-prompt.md` and passed as `--append-system-prompt-file`
- The fleet SKILL.md is injected into the worktree at `.claude/skills/fleet/SKILL.md` (`hull.ts:147-153`)
- The worktree warning is prepended to the initial user message (`hull.ts:206-209`)

### What is NOT applied

- No built-in research-specific system prompt (e.g., "you are a research agent, do not commit code")
- No built-in code-specific system prompt
- No mission-type-derived system prompt at all

### Research crew safety guard (post-run only)

The only safeguard for research crews making git changes is in `hull.ts:637-639` — but this is a **cleanup-time guard**, not a prevention mechanism at spawn time:
```typescript
if (this.opts.missionType === 'research') {
  try { execSync('git checkout -- .', gitOpts) } catch { /* ignore */ }
  try { execSync('git clean -fd', gitOpts) } catch { /* ignore */ }
```
The research agent is fully capable of making git commits during its run; the changes are only discarded after the fact.

---

## 5. Tool Capabilities by Mission Type

### Current state

Both `code` and `research` crews spawn with **identical tool access** unless the Sector has `allowed_tools` configured. With `--dangerously-skip-permissions` always set (`hull.ts:169`), the agent can use any Claude Code tool including Bash, git operations, file writes, etc.

If `sector.allowed_tools` is set, e.g. `"Read,Grep,WebSearch"`, ALL missions in that sector are restricted to those tools — including code missions.

### Ideal state (not implemented)

| Capability | Research Crew | Code Crew |
|---|---|---|
| Read files | ✓ | ✓ |
| Web search | ✓ | Optional |
| Bash (read-only) | ✓ | ✓ |
| Edit files | ✗ | ✓ |
| Git commit/push | ✗ | ✓ |
| Write new files | Research cargo only | ✓ |
| MCP tools | Research-specific | Code-specific |

---

## 6. Gaps and Recommendations

### Gap 1: No mission-type-aware agent configuration at spawn time

**Current:** `Hull.start()` ignores `missionType` when building `cmdArgs`.
**Impact:** Research crews get full code-execution permissions. A research agent can (and sometimes does) accidentally commit changes.
**Recommendation:** Apply built-in defaults based on mission type before the sector config is overlaid:

```typescript
// In Hull.start(), after reading opts:
let effectiveModel = this.opts.model || 'claude-sonnet-4-6'
let effectiveAllowedTools = this.opts.allowedTools
let effectiveSystemPrompt = this.opts.systemPrompt ?? ''

if (this.opts.missionType === 'research' && !this.opts.allowedTools) {
  // Restrict research crews to read-only tools unless sector overrides
  effectiveAllowedTools = 'Read,Glob,Grep,WebSearch,WebFetch,Bash'
}
```

The post-run git cleanup (`git checkout -- .`) is a safety net but not a substitute for proper tool scoping.

### Gap 2: No built-in system prompts for mission types

**Current:** System prompt is purely optional, set at sector level.
**Impact:** Research crews have no built-in instructions about the cargo workflow, how to structure findings, or that git commits are not expected.
**Recommendation:** Inject a built-in mission-type preamble into the system prompt, appended before any sector-level system prompt:

```typescript
const RESEARCH_SYSTEM_PROMPT = `
You are a research crew member. Your mission produces documentation artifacts, NOT git commits.
- Do NOT commit or push any changes
- Write your findings as markdown in the working directory if needed
- Send a comms summary when complete: fleet comms send --from $FLEET_CREW_ID --to admiral --message "..."
- The mission is complete when you have documented your findings
`

const CODE_SYSTEM_PROMPT = `
You are a code crew member. Your mission produces git commits.
- Make targeted, focused changes matching the mission prompt
- Run tests before finishing if a verify command is available
- Commit changes with a descriptive message
- Send a comms summary: fleet comms send --from $FLEET_CREW_ID --to admiral --message "..."
`
```

These would be prepended to any sector-level system prompt.

### Gap 3: `fleet crew deploy` does not expose `--type` override

**Current:** `crew deploy` ignores `args.type` in practice (CLI doesn't surface it).
**Impact:** No way to override mission type at deploy time (minor — type is set correctly at mission creation).
**Assessment:** Low priority. The mission type should be set when the mission is created, not at deploy time.

### Gap 4: Sector config cannot be split by mission type

**Current:** `model`, `system_prompt`, `allowed_tools` are sector-wide.
**Impact:** Cannot use a fast/cheap model for research and a capable model for code within the same sector.
**Recommendation (future):** Add `research_model`, `research_system_prompt`, `research_allowed_tools` fields to the `sectors` table and a `code_` prefix equivalent, or use a mission-type-keyed JSON config field.

### Gap 5: `fleet sectors show` does not label which config applies to which type

**Current:** `fleet sectors show <id>` returns the sector row with `model`, `system_prompt`, etc., but gives no indication that these apply to all mission types uniformly.
**Impact:** Admiral agents may assume per-type config exists when it doesn't.
**Recommendation:** Update the sectors show output or the fleet skill documentation to clarify this.

---

## 7. Recommended Architecture for Proper Agent Scoping

### Short-term (minimal changes)

1. **Add built-in system prompt injection by mission type** in `Hull.start()` (hull.ts, before `cmdArgs` is built). Prepend a type-specific preamble to `this.opts.systemPrompt`.

2. **Add default tool restriction for research missions** in `Hull.start()`. If `missionType === 'research'` and `allowedTools` is not set, default to a read-only + web tool set.

### Medium-term (sector schema changes)

3. **Add per-type sector config fields** to the `sectors` DB table:
   ```sql
   ALTER TABLE sectors ADD COLUMN research_model TEXT;
   ALTER TABLE sectors ADD COLUMN research_system_prompt TEXT;
   ALTER TABLE sectors ADD COLUMN research_allowed_tools TEXT;
   ALTER TABLE sectors ADD COLUMN research_mcp_config TEXT;
   ```

4. **Update `crew-service.ts:deployCrew()`** to select the right sector config fields based on `missionType` before passing to Hull.

5. **Update the Sector settings UI** to expose per-type config panels.

### Example Sector Configuration (intended future state)

```json
{
  "id": "my-app",
  "model": "claude-sonnet-4-6",
  "system_prompt": "This is a TypeScript/React project. Always use strict mode.",
  "allowed_tools": null,
  "research_model": "claude-opus-4-6",
  "research_system_prompt": "You are a research agent. Do not commit code. Write findings to docs/. Use fleet cargo produce to record artifacts.",
  "research_allowed_tools": "Read,Glob,Grep,WebSearch,WebFetch,Bash",
  "code_model": "claude-sonnet-4-6",
  "code_system_prompt": null,
  "code_allowed_tools": null
}
```

---

## 8. Code Location Reference

| Component | File | Lines | Description |
|---|---|---|---|
| CLI `crew deploy` validation | `src/main/fleet-cli.ts` | 374–393 | Client-side arg validation |
| Socket `crew.deploy` handler | `src/main/socket-server.ts` | 432–496 | Reads mission, calls deployCrew |
| `deployCrew()` | `src/main/starbase/crew-service.ts` | 71–198 | Creates worktree, builds Hull opts |
| Mission type read | `src/main/starbase/crew-service.ts` | 92–93 | `missionRow.type ?? 'code'` |
| Hull construction | `src/main/starbase/crew-service.ts` | 161–186 | Passes sector config + missionType to Hull |
| `Hull.start()` — spawn | `src/main/starbase/hull.ts` | 155–196 | Builds cmdArgs, spawns claude |
| Model selection | `src/main/starbase/hull.ts` | 165 | `opts.model \|\| 'claude-sonnet-4-6'` |
| System prompt injection | `src/main/starbase/hull.ts` | 173–178 | `--append-system-prompt-file` |
| Allowed tools injection | `src/main/starbase/hull.ts` | 179–181 | `--allowedTools` |
| MCP config injection | `src/main/starbase/hull.ts` | 182–184 | `--mcp-config` |
| missionType in output buffer | `src/main/starbase/hull.ts` | 335–338 | Research gets 2000 lines |
| Research cargo production | `src/main/starbase/hull.ts` | 550–612 | No-changes path: cargo |
| Research safety guard | `src/main/starbase/hull.ts` | 637–709 | With-changes path: discard + cargo |
| Sector schema | `src/main/starbase/sector-service.ts` | 13–31 | `SectorRow` type with agent fields |
| Sector update | `src/main/starbase/sector-service.ts` | 41–54 | `UpdateSectorFields` (UI only) |
| Fleet skill template | `src/main/starbase/workspace-templates.ts` | 134–166 | Documents sector agent config |
