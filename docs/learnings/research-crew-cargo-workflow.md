# Research Crew Cargo Workflow

## Problem

Research crews were creating pull requests and writing files to disk instead of printing findings to stdout. Because Hull runs a git safety guard for research missions (`git checkout -- .` and `git clean -fd`), any files written to disk were silently discarded. The cargo system captures crew output from stdout, not from the filesystem.

## How Research Cargo Works

When a research mission completes, Hull:

1. Discards any git changes (safety guard)
2. Captures all stdout output that was collected during the session
3. Writes two cargo files to the starbase: `full-output.md` and `summary.md`
4. Inserts cargo records into the database

**Key insight:** Cargo comes from `outputLines` (collected stdout), NOT from files the crew writes to disk.

## What Gets Captured

- Text printed via `echo`, `console.log`, or any stdout output
- The full text of assistant responses in the session
- All tool result text that appears in the terminal

## What Does NOT Get Captured

- Files written to disk (discarded by safety guard)
- Files committed via `git commit` (discarded by safety guard)
- Pull requests (should never be created for research missions)

## Ships Log Warning

When the safety guard discards files, a `safety_guard` event is logged to `ships_log` with:
- `filesDiscarded`: count of discarded files
- `paths`: list of discarded file paths (up to 20)
- `recommendation`: guidance to use stdout instead

To check for discarded changes:
```bash
fleet log groups list
fleet log groups show <group-id>
```

## Environment Variables Available to Research Crews

| Variable | Value | Description |
|----------|-------|-------------|
| `FLEET_MISSION_TYPE` | `research` | Identifies this as a research mission |
| `FLEET_CREW_ID` | e.g. `my-sector-crew-a1b2` | Crew identity for comms |
| `FLEET_MISSION_ID` | e.g. `42` | Mission ID for comms |
| `FLEET_SECTOR_ID` | e.g. `my-app` | Sector the crew is deployed to |

Crews can check `$FLEET_MISSION_TYPE` to adapt their behavior.

## Recommended Sector System Prompt for Research-Heavy Sectors

When a sector is used primarily for research missions, add the following to its system prompt in the Fleet app's Sector settings panel:

---

```
## Research Mission Workflow

This sector runs research missions. When FLEET_MISSION_TYPE=research:

- Print all findings to stdout — do NOT write files to disk
- Do NOT create pull requests or commits
- Do NOT use git add/commit/push
- Structure your output with clear headers and sections:

  ## Research Findings: [Topic]

  ### Summary
  [Brief summary]

  ### Details
  [Investigation results]

  ### Conclusions
  [Recommendations]

Your terminal output is automatically captured as cargo by the Fleet hull system.
Files written to disk will be discarded by the safety guard.
```

---

## Copy-Paste Sector System Prompt

For sectors used exclusively for research:

```
This sector is for research missions only. All findings must be printed to stdout — do NOT write files to disk or create git commits. Files will be discarded by the git safety guard. Terminal output is captured as cargo automatically.

Structure output as:
## Research Findings: [Topic]
### Summary / ### Details / ### Conclusions

Check FLEET_MISSION_TYPE to confirm you are in a research session before proceeding.
```

## Fix History

- 2026-03-19: Added `FLEET_MISSION_TYPE` env var to hull process
- 2026-03-19: Added research guidance to initial message sent to crew
- 2026-03-19: Added `safety_guard` ships_log warning when files are discarded
- 2026-03-19: Added Research Mission Output Format section to the Fleet skill (SKILL.md)
- 2026-03-19: Created this reference doc with sector system prompt templates
