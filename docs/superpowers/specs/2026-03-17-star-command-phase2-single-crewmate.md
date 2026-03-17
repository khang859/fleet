# Star Command Phase 2: Single Crewmate E2E

## Overview

Deploy one Claude Code agent into a git worktree, track its full lifecycle, and push the branch when done. The minimum path from "deploy" to "branch on remote."

## Prerequisites

- Phase 1 complete: StarbaseDB, schema migrations, SectorService, ConfigService all functional.

## Architecture

### Hull (`src/main/starbase/hull.ts`)

The wrapper that manages a single Crewmate's lifecycle. Each deployed Crewmate gets one Hull instance.

**Constructor:** Takes `{ crewId, sectorId, missionId, prompt, worktreePath, worktreeBranch, baseBranch, db }`.

**Lifecycle sequence:**

1. Insert into `crew` table with status "active", record PID, worktree path, branch. Update `missions` table: set `status = 'active'`, `started_at = NOW()`, `crew_id = crewId`. Log Ship's Log event: `{ eventType: "deployed", crewId }`.
2. Spawn the agent as a PTY via PtyManager: `claude --yes --dangerously-skip-permissions -p "{prompt}"` with cwd set to the worktree path. If spawn fails (e.g. `claude` not in PATH), mark crew as "error", mission as "failed" with reason, clean up worktree, and return.
3. Start Lifesign interval — write `last_lifesign = NOW()` to `crew` table every N seconds (from config `lifesign_interval_sec`)
4. Start Mission timeout timer: read `default_mission_timeout_min` from config, set `deadline` in crew table, start a `setTimeout` for that duration. If deadline fires: SIGTERM the agent. After 5 second grace period, SIGKILL if still alive. Then run exit cleanup with status "timeout".
5. Listen for PTY exit:
   - Exit 0 → status "complete"
   - Exit non-zero → status "error", capture last 200 lines of output buffer
6. On exit (any code):
   - Stop Lifesign interval and timeout timer
   - Auto-commit any uncommitted/untracked files in the worktree (`git add -A && git commit -m "auto-commit uncommitted changes"`)
   - Check for empty diff against base branch (`git diff --stat {baseBranch}...HEAD`). If empty → mark "failed" with reason "no work produced", skip push
   - *Note: verify_command execution is deferred to Phase 5 (Quality Gate 2). Leave a placeholder comment in the code.*
   - Push branch to origin: `git push -u origin {worktreeBranch}` with retry (3 attempts, exponential backoff: 2s, 8s, 30s). Uses the actual `worktreeBranch` value (may include numeric suffix from collision handling).
   - Update `missions` table: status, completed_at, result (commit summary)
   - Send a Transmission to the `comms` table (from: crewId, to: "admiral", type: "mission_complete")
   - Log Ship's Log event: `{ eventType: "exited", crewId, exitCode }`
   - Clean up worktree: `git worktree remove {path}`. Force remove on failure. If push failed, mark mission "push-pending" and preserve worktree.

**Output buffer:** The Hull keeps a ring buffer of the last 200 lines of agent output for debugging and debrief purposes.

**Public API:**
- `start()` — Begin the lifecycle
- `kill()` — Force terminate the agent (for recall)
- `getStatus()` — Current crew status
- `getPid()` — OS process ID

### WorktreeManager (`src/main/starbase/worktree-manager.ts`)

Handles git worktree operations.

**Public API:**
- `create({ starbaseId, crewId, sectorPath, baseBranch })` — Pre-flight checks (verify git repo via `git rev-parse --git-dir` with `cwd: sectorPath`, branch name available locally + remotely via `git branch --list` and `git ls-remote --heads origin`, disk headroom > 500MB), then `git worktree add ~/.fleet/worktrees/{starbaseId}/{crewId} -b crew/{crewId}` (run with `cwd: sectorPath`). If branch name taken, append numeric suffix (`crew/{crewId}-2`). Returns `{ worktreePath, worktreeBranch }`.
- `remove(worktreePath)` — `git worktree remove {path}`. Retry after 2s on failure. Force remove as fallback.
- `installDependencies(worktreePath)` — Detect lockfile type, run the appropriate install command with 120s timeout. On failure, retry once. On persistent failure, try symlink fallback if configured.
- `prune(sectorPath)` — Run `git worktree prune` on the repo.
- `listActive(starbaseId)` — List worktree directories under `~/.fleet/worktrees/{starbaseId}/`.

**Lockfile detection:**
- `package-lock.json` → `npm install`
- `pnpm-lock.yaml` → `pnpm install`
- `yarn.lock` → `yarn install`
- `bun.lockb` → `bun install`
- None → skip install

### MissionService (`src/main/starbase/mission-service.ts`)

CRUD for the Mission queue.

**Public API:**
- `addMission({ sectorId, summary, prompt, acceptanceCriteria?, priority?, dependsOnMissionId? })` — Insert into `missions` table. Summary and prompt are required.
- `completeMission(missionId, result)` — Set status "completed", completed_at, result JSON.
- `failMission(missionId, reason)` — Set status "failed" with reason in result.
- `abortMission(missionId)` — Set status "aborted" for queued Missions only.
- `listMissions({ sectorId?, status? })` — Query with optional filters.
- `nextMission(sectorId)` — Get highest priority queued Mission for a Sector (lowest priority number, respecting depends_on — skip if dependency isn't completed).
- `getMission(missionId)` — Get single Mission by ID.
- `updateMission(missionId, fields)` — Update prompt, priority, etc.

### CrewService (`src/main/starbase/crew-service.ts`)

Orchestrates the full deploy flow.

**Public API:**
- `deployCrew({ sectorId, prompt, missionId? })` — The main entry point:
  1. Look up Sector from the registry (read `base_branch` from Sector record, defaults to "main")
  2. Create a Mission (if missionId not provided) via `missionService.addMission()`
  3. Generate a crew ID: `{sectorSlug}-crew-{4charRandomHex}`
  4. Call `WorktreeManager.create({ starbaseId, crewId, sectorPath: sector.root_path, baseBranch: sector.base_branch })` — if this fails, mark mission as "failed" with reason and throw
  5. Call `WorktreeManager.installDependencies(worktreePath)` — if this fails, call `WorktreeManager.remove(worktreePath)`, mark mission as "failed", and throw
  6. Pick a random avatar variant from: `["hoodie", "headphones", "robot", "cap", "glasses"]`
  7. Create a new Fleet tab (via LayoutStore + IPC) linked to this Crewmate
  8. Instantiate a Hull with `{ crewId, sectorId, missionId, prompt, worktreePath, worktreeBranch, baseBranch, db }`
  9. Start the Hull
  10. Return `{ crewId, tabId, missionId }`
- `recallCrew(crewId)` — Kill the Hull, clean up worktree, update crew status to "aborted"
- `listCrew({ sectorId? })` — Query crew table with optional Sector filter
- `getCrewStatus(crewId)` — Full crew record
- `observeCrew(crewId)` — Return the Hull's output buffer (last 200 lines)

### IPC + Socket Wiring

New IPC handlers:
- `starbase:deploy` → `crewService.deployCrew()`
- `starbase:recall` → `crewService.recallCrew()`
- `starbase:crew` → `crewService.listCrew()`
- `starbase:missions` → `missionService.listMissions()`
- `starbase:add-mission` → `missionService.addMission()`
- `starbase:observe` → `crewService.observeCrew()`

Socket commands:
- `{ type: "deploy", sectorId, prompt }` → deploy
- `{ type: "recall", crewId }` → recall
- `{ type: "crew", sectorId? }` → list Crew
- `{ type: "missions", sectorId?, status? }` → list Missions

### Integration with PtyManager

The Hull creates PTYs through PtyManager (reusing the existing infrastructure). The Crewmate's terminal output flows through the same channels as regular Fleet tabs — visible in the UI, scrollable, searchable. The crew record's `tab_id` links to the Fleet tab so the sidebar can show crew info alongside the tab.

### Tab Integration

When `deployCrew()` runs, it creates a new tab in the layout with:
- `label`: Mission summary (e.g. "Add rate limiting")
- `cwd`: worktree path
- `cmd`: The claude command (spawned via PtyManager with the `cmd` option)

The tab functions like any other Fleet terminal tab — you can watch the agent work in real time.

## What Is NOT Built

- Sentinel / Lifesign sweep (Hull writes Lifesigns, but nothing reads them yet)
- Concurrent Crew coordination (no worktree limits enforced)
- Merge strategy execution (always pushes branch, no PR creation)
- Quality Gates (no verify command, no Admiral review)
- Star Command tab UI
- Comms beyond the auto-generated Mission complete Transmission

## Tests

- **WorktreeManager:** Create (mock git, verify commands), branch name collision handling, remove with retry, dependency detection
- **Hull:** Spawn → clean exit → cleanup sequence (mock PTY), error exit handling, timeout handling, empty diff detection, push retry logic
- **MissionService:** CRUD operations, nextMission priority ordering, dependency respect
- **CrewService:** Full deploy flow (mock WorktreeManager + Hull), recall cleanup
- **Integration:** Deploy a Crewmate with a trivial prompt (`echo "hello" > test.txt && git add -A && git commit -m "test"`) in a test repo, verify branch exists after completion
