# Mission Type Scoping

## Investigation Findings (Mission 28)

**Gap identified:** `crew deploy` reads `mission.type` from DB but Hull did NOT apply different model/system_prompt/allowedTools per mission type at spawn time. Research crews received identical tool access as code crews.

### Code Locations
- `hull.ts:155-196` — Claude process spawn, env building, system prompt injection
- `crew-service.ts:92-93` — mission type read from DB
- `crew-service.ts:179` — `allowedTools` passed to Hull
- `socket-server.ts:432-496` — deploy command handler

### Root Cause
`CrewService.deployCrew()` passes `sector.allowed_tools` directly to Hull with no fallback for mission type. Hull builds a single system prompt from `sector.system_prompt` only — no mission-type-aware preamble was injected.

---

## Implementation

### 1. Research Preamble in Hull.start() (`hull.ts`)

When `missionType === 'research'`, Hull now injects a preamble before the sector-level `system_prompt`:

```typescript
const researchPreamble = this.opts.missionType === 'research'
  ? `# Research Mission Instructions

You are a research crew deployed on a research mission (FLEET_MISSION_TYPE=research).

## Cargo Workflow
- Output your findings as printed text — do NOT write findings to files in the worktree.
- The Fleet system captures your full output as cargo automatically.

## Constraints
- Do NOT push code or create pull requests.
- Do NOT commit changes. Git changes will be discarded at mission end.
- Focus on investigation, analysis, and producing written findings.
`
  : null

const combinedSystemPrompt = [researchPreamble, this.opts.systemPrompt]
  .filter(Boolean)
  .join('\n\n')
```

The preamble comes **before** the sector `system_prompt`, so sector config can override with additional instructions appended after.

### 2. Default Tool Restrictions for Research Crews (`crew-service.ts`)

If `missionType === 'research'` AND `sector.allowed_tools` is not explicitly set, Hull receives:

```
Read,Glob,Grep,WebSearch,WebFetch
```

This excludes `Edit`, `Write`, and `Bash` by default, preventing research crews from modifying files or running shell commands. `Bash` is excluded because it is a superset of `Edit`/`Write` and allows file writes, commits, and pushes via shell — undermining the read-only intent. Code crews remain unrestricted (all tools).

```typescript
allowedTools: sector.allowed_tools ?? (missionType === 'research' ? 'Read,Glob,Grep,WebSearch,WebFetch' : undefined),
```

**To override per sector:** Set `allowed_tools` in Sector settings. The default only applies when `allowed_tools` is null/empty.

### 3. FLEET_MISSION_TYPE Environment Variable (`hull.ts`)

All crews now receive `FLEET_MISSION_TYPE` in their environment:

```typescript
const mergedEnv = {
  ...baseEnv,
  FLEET_CREW_ID: crewId,
  FLEET_SECTOR_ID: this.opts.sectorId,
  FLEET_MISSION_ID: String(this.opts.missionId),
  FLEET_MISSION_TYPE: this.opts.missionType ?? 'code',  // NEW
}
```

Crews can branch on mission type in their prompts or skill logic:

```bash
if [ "$FLEET_MISSION_TYPE" = "research" ]; then
  echo "Research mode — output findings as text"
fi
```

---

## Sector Configuration Examples

### Research-Heavy Sector (default behavior, no overrides needed)

```
Sector: research-sector
allowed_tools: (leave empty — defaults to Read,Glob,Grep,WebSearch,WebFetch for research)
system_prompt: Focus on security vulnerabilities. Always check CVE databases.
```

Research missions automatically get:
- Read-only tool defaults (no Bash — use Read/Glob/Grep for file access)
- Research preamble injected before the sector system_prompt
- `FLEET_MISSION_TYPE=research` in env

### Research Sector with Extended Tools

```
Sector: research-with-write
allowed_tools: Read,Glob,Grep,WebSearch,WebFetch,Write
system_prompt: You may write summary files to /tmp for intermediate work.
```

Explicitly setting `allowed_tools` overrides the research default — Write is allowed.

### Code Sector (no changes)

```
Sector: app-sector
allowed_tools: (leave empty — all tools for code missions)
system_prompt: Always run npm test before committing.
```

Code missions are unrestricted as before.

---

## Behavior Summary

| Mission Type | `sector.allowed_tools` set? | Effective `allowedTools` |
|---|---|---|
| `research` | No | `Read,Glob,Grep,WebSearch,WebFetch` |
| `research` | Yes | Sector value (overrides default) |
| `code` | No | All tools (no restriction) |
| `code` | Yes | Sector value |
| `review` | No | All tools (no restriction) |
| `review` | Yes | Sector value |
