# Star Command Phase 5: Polish + Advanced

## Overview

The remaining spec features: Supply Routes, Quality Gates, Mission decomposition, the Config panel UI, the pixel art station visualizer, and database maintenance. This phase makes Star Command intelligent and visually distinctive.

## Prerequisites

- Phases 1-4 complete: full database, Hull lifecycle, Admiral chat, multi-Crew, Sentinel, PR flow

## Architecture

### Supply Route Service (`src/main/starbase/supply-route-service.ts`)

Manages Sector dependency graph.

**Public API:**
- `addRoute({ upstreamSectorId, downstreamSectorId, relationship? })` — Insert into `supply_routes`. Before insertion, run cycle detection (DFS from downstream back to upstream through existing routes). If cycle would be created, throw `CyclicDependencyError` with the cycle path.
- `removeRoute(routeId)` — Delete from `supply_routes`.
- `listRoutes({ sectorId? })` — List all routes, optionally filtered to routes involving a Sector.
- `getDownstream(sectorId)` — Get all Sectors that depend on this one.
- `getUpstream(sectorId)` — Get all Sectors this one depends on.
- `getGraph()` — Return the full directed graph as adjacency list for visualization.

**Cycle detection:** Standard DFS with visited/recursion-stack. O(V+E) where V = Sectors, E = routes.

### Cargo Service (`src/main/starbase/cargo-service.ts`)

Manages artifacts produced by Crew.

**Public API:**
- `produceCargo({ crewId, missionId, sectorId, type, manifest })` — Insert into `cargo` with `mission_id`. Checks the Mission's status via `missionId` — if status is "error"/"lost"/"timeout", set `verified = false`.
- `listCargo({ sectorId?, crewId?, type?, verified? })` — Query with filters.
- `getUndelivered(sectorId)` — Get Cargo from upstream Sectors (via Supply Routes) that was produced after the last deployment in this Sector. This is what the Admiral includes in Mission briefings for downstream Sectors.
- `cleanup(olderThanDays)` — Delete Cargo older than the retention period (default 14 days).

**Config additions:** Add `forward_failed_cargo` (BOOLEAN, default false) to `starbase_config`. When false, Cargo from failed Missions is stored but not included in `getUndelivered()` results. When true, it's included with the unverified warning.

**Cargo forwarding flow:**
When Cargo is produced in Sector A, and Sector B has a Supply Route from A:
1. Cargo is stored in the `cargo` table tagged with Sector A
2. Next time a Crewmate deploys in Sector B, the Admiral calls `getUndelivered('B')`
3. Relevant Cargo manifests are included in the Mission prompt: "Note: upstream Sector 'A' recently produced: {cargo summary}"
4. Unverified Cargo gets a warning: "This Cargo came from a failed Mission — verify before using"

### Quality Gate 2 — Hull Verification

**Hull changes after Crewmate exit, before push:**

1. **Empty diff check** (existing — Phase 2): `git diff --stat {baseBranch}...HEAD`. Empty = "failed" with "no work produced."

2. **Auto-commit** (existing — Phase 2): `git add -A && git commit` for any uncommitted files.

3. **Verify command execution** (new — Phase 5): If `sector.verify_command` is set:
   - Run the command in the worktree with a 120-second timeout (configurable)
   - Capture stdout, stderr, exit code
   - Store result in `missions.verify_result` as JSON: `{ stdout, stderr, exitCode, duration }`
   - Exit 0 = pass → continue to push
   - Non-zero = "failed-verification" → still push the branch (preserve work), but do NOT create PR. Hail Admiral with the verification output.

4. **Lint command execution** (new — Phase 5): If `sector.lint_command` is set:
   - Run with 60-second timeout
   - Lint failures are warnings only — do NOT block PR
   - If lint has warnings, PR gets a label: `lint-warnings`
   - Lint output included in PR body under "### Verification" section

### Quality Gate 3 — Admiral Review

**After PR creation, if `sector.review_mode` is "admiral-review":**

1. Hull sends a Transmission to Admiral: type "pr_review_request" with payload `{ prNumber, prUrl, missionId, diffSummary, acceptanceCriteria }`. *Note: "pr_review_request" is a new Comms type not in the parent spec's original list — it's an extension for Quality Gate 3.*

2. Admiral processes the review (triggered automatically when the Transmission arrives). **If the review itself fails** (e.g. `gh pr diff` errors, API timeout, diff too large for context), the Mission is marked "pending-review" and surfaced to the user on next interaction. The review is not retried automatically — the user decides whether to review manually or retry.
   a. Fetches the PR diff via `gh pr diff {prNumber}`
   b. Reads the Mission's `acceptance_criteria` array
   c. Checks each criterion against the diff
   d. Produces a verdict:

   - **Pass:** All criteria met. Admiral approves the PR (`gh pr review --approve`). Mission status → "completed". Review notes stored in `missions.review_notes`.
   - **Request-changes:** Most criteria met, minor gaps. Admiral can either:
     - Deploy a follow-up "fix" Mission on the same branch: `deployCrew({ sectorId, prompt: "Fix: {gaps}", branch: existingBranch })`
     - Or add PR review comments: `gh pr review --comment --body "{notes}"`
   - **Reject:** Work fundamentally misses the point. Admiral closes the PR (`gh pr close`). Mission status → "failed". Re-queues with revised prompt including lessons learned.

3. `missions.review_verdict` updated with "pass", "request-changes", or "reject".

4. **Review timeout:** If no review within `review_timeout_min` (read from `starbase_config`, default 10 minutes), Mission marked "pending-review" and surfaced to user next time they interact with Star Command.

**Review modes per Sector:**
- `"admiral-review"` (default) — Full Gate 3
- `"verify-only"` — Skip Gate 3, rely on Gate 2 only
- `"manual"` — PR created, left for human review

### Mission Decomposition

**Admiral system prompt enhancement:**

When the user gives a large/vague request, the Admiral should:
1. Identify that the request spans multiple concerns
2. Break it into discrete Missions following the spec's scoping rules:
   - Specific (not vague)
   - Bounded (< 15 min agent time)
   - Independent (produces mergeable result)
   - Testable (clear done condition)
3. Write acceptance criteria for each Mission
4. Set dependencies between Missions where needed (Mission B depends on Mission A)
5. Queue all Missions via `addMission()` with appropriate priorities
6. Present the decomposition to the user for confirmation before deploying

The Admiral's system prompt (in `src/main/starbase/admiral-system-prompt.ts`, created in Phase 3) is updated with explicit decomposition instructions and examples. This is primarily a prompt engineering improvement — no new services or APIs. The confirmation step uses the existing chat interface: the Admiral presents the decomposition as a numbered list and waits for the user to approve, modify, or reject before calling `addMission()` for each. If the user rejects, the Admiral asks for clarification.

### Config Panel (`src/renderer/src/components/StarCommandConfig.tsx`)

A sub-tab within the Star Command tab, accessed via a "Config" button/tab in the Star Command header.

**Sections:**

1. **Sectors** — List of registered Sectors as expandable cards. Each card shows:
   - Name, path, stack, description
   - Base branch, merge strategy dropdown, review mode dropdown
   - Verify command input, lint command input
   - Worktree enabled toggle
   - Crew count, active Missions count
   - "Remove Sector" button (with confirmation)
   - "Add Sector" button at the bottom: form with directory picker, name, description, auto-detected stack

2. **Supply Routes** — Visual graph display (simple directed graph rendered with divs/SVG, not a full graph library). Add route: pick upstream + downstream Sectors from dropdowns. Remove route button on each edge.

3. **Starbase Settings** — Form fields for all `starbase_config` keys:
   - Max concurrent worktrees (number input)
   - Worktree pool size (number input)
   - Disk budget GB (number input)
   - Default Mission timeout minutes (number input)
   - Default merge strategy (dropdown: pr/auto-merge/branch-only)
   - Comms rate limit per minute (number input)
   - Default token budget (number input, 0 = unlimited)
   - Lifesign interval seconds (number input)
   - Lifesign timeout seconds (number input)
   - Default review mode (dropdown)
   - Review timeout minutes (number input)

4. **Database** — Info panel showing:
   - Database file path and size
   - Row counts for each table
   - "Compact Database" button (runs VACUUM)
   - Retention settings: comms TTL days, cargo TTL days, ships_log TTL days
   - "Clean Now" button to run retention sweep

### Visualizer Integration

**Extend the existing SpaceCanvas/VisualizerPanel to render Star Command elements:**

The existing visualizer renders ships in space. For Star Command, we add a new rendering layer:

1. **Station ring** — A circular structure divided into Sector sections. Each section is labeled with the Sector name. Rendered as a sprite or procedurally (arcs with segment coloring). Sectors with active Crew have lit sections, inactive Sectors are dim.

2. **Crew pods** — Small pod sprites attached to their Sector's ring section. Visual states:
   - Active: teal glow pulse, data stream antenna
   - Hailing: amber glow, flashing beacon
   - Error: red flicker, spark particles
   - Idle: dim teal
   - Complete: green flash, checkmark, calm glow
   - Lost: sparks, gas vent

3. **Dock/undock animations** — When a Crewmate deploys, a shuttle sprite approaches and docks at the Sector's ring section. On completion, the shuttle undocks and departs.

4. **Comms beams** — When Transmissions flow, glowing orbs travel along beam lines:
   - Crew → Admiral: teal orb from pod to central hub
   - Admiral → Crew: amber orb from hub to pod
   - Cross-Sector: larger orbs following Supply Route arcs between ring sections

5. **Admiral avatar** — 64x64 pixel portrait in the chat interface (next to Admiral messages) and in the sidebar. State variants: default, speaking (when streaming), thinking (when processing tools), alert (unread hails).

**Implementation approach:** Add new sprite types and animation functions to the existing visualizer modules. The station ring, pods, and beams are new canvas layers rendered on top of the existing starfield/nebula background. State is driven by the `star-command-store` — when Crew status changes, the visualizer updates pod states.

**Rendering strategy** (from parent spec): Use CSS sprite animation for pod status states (pre-rendered sprite sheets, CSS `animation` with `steps()`). Use one-shot canvas particles for transient effects (sparks, gas vents, beam pulses) — paint to an offscreen canvas, composite onto the main canvas each frame, let particles decay. Implement visibility-aware throttling: when the Star Command tab is not visible, reduce animation to 1fps or pause entirely. Low-power mode: detect battery status, disable particles and reduce to static sprites. Performance budget: < 5% CPU when idle, < 15% during active animations, < 20MB memory for all visualizer assets.

### Retention + Database Maintenance

**RetentionService (`src/main/starbase/retention-service.ts`):**

- `cleanup()` — Delete records older than configured TTLs:
  - comms: 30 days default
  - cargo: 14 days default
  - ships_log: 30 days default
- Runs on Sentinel sweep but on a slower interval (hourly)
- `vacuum()` — Run SQLite VACUUM to reclaim disk space. Callable from Config panel.
- `getStats()` — Return table row counts and database file size.

TTL values stored in `starbase_config`:
- `comms_retention_days`: 30
- `cargo_retention_days`: 14
- `ships_log_retention_days`: 30

### PR Template Enhancement

PRs now include the full spec template:

```markdown
## Mission: {summary}

**Sector:** {sector name}
**Crewmate:** {crewId} ({avatar variant})
**Duration:** {started → completed}

### Acceptance Criteria
- [x] Criterion 1 (checked/unchecked based on Admiral review)
- [x] Criterion 2
- [ ] Criterion 3 (if not met)

### Changes
{git diff --stat}

### Verification
- Build/Test: {verify_command result — pass/fail with output}
- Lint: {lint_command result or "skipped"}

### Mission Debrief
{Crewmate's final output summary}

### Admiral Review
{review_notes or "Skipped (verify-only mode)" or "Pending"}

---
Deployed by Star Command | Starbase: {starbaseId}
```

Labels: `fleet`, `sector/{sectorId}`, `mission/{missionId}`, optionally `lint-warnings`, `needs-rebase`.

Dependency linking: if Mission depends on another Mission's PR, body includes "Depends on #{prNumber}".

### Schema Additions

Add new columns to support Phase 5 features. Delivered as the next sequential migration (number depends on whether Phases 2-4 added any migrations — check `src/main/starbase/migrations/` for the highest existing number and increment):

- `cargo.verified` column (already in Phase 1 schema — just start using it)
- `starbase_config` new default keys for retention TTLs
- Indexes: `CREATE INDEX idx_cargo_sector ON cargo(sector_id)`, `CREATE INDEX idx_comms_to ON comms(to_crew, read)`, `CREATE INDEX idx_missions_status ON missions(status, sector_id)`

## Tests

- **SupplyRouteService:** Add route, cycle detection (reject cyclic), list, getDownstream/getUpstream, graph generation
- **CargoService:** Produce, list, getUndelivered with Supply Route traversal, verified/unverified tagging, retention cleanup
- **Gate 2:** Mock verify command (pass, fail, timeout), lint command (warnings), empty diff detection. Verify correct Mission status and PR behavior for each case.
- **Gate 3:** Mock Admiral review session with PR diff and acceptance criteria. Verify pass/request-changes/reject flows. Review timeout behavior.
- **Config panel:** Render tests for each section, form validation, save/load
- **Visualizer:** Pod state animations triggered by crew status changes, dock/undock sequence, Comms beam rendering
- **RetentionService:** Cleanup deletes old records, preserves recent ones. VACUUM runs without error. Stats return correct counts.
