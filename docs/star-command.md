# Star Command

A meta-agent orchestration layer for Fleet. Star Command is a pinned tab at the top of every Starbase that acts as mission control — an AI agent you interact with to deploy, monitor, coordinate, and communicate with all Crew running across Sectors in your Starbase.

## Glossary

| Term                    | Meaning                                                                         |
| ----------------------- | ------------------------------------------------------------------------------- |
| **Starbase**            | A workspace — the top-level container for all your projects, crew, and missions |
| **Star Command**        | The pinned orchestrator tab — mission control for the entire Starbase           |
| **Admiral**             | The Star Command AI agent — the commander who manages everything                |
| **Sector**              | A project within the Starbase (e.g. `api/`, `web/`, `mobile/`)                  |
| **Crew** / **Crewmate** | An AI agent working on a mission in a Sector                                    |
| **Mission**             | A task assigned to a Crewmate — a discrete unit of work                         |
| **Comms**               | Messages between Crew and Star Command                                          |
| **Transmission**        | A single message in the Comms channel                                           |
| **Cargo**               | Artifacts produced by Crew — code, specs, schemas, test results                 |
| **Supply Route**        | A dependency link between Sectors (e.g. web consumes api)                       |
| **Hull**                | The wrapper process around each Crewmate — handles lifecycle automatically      |
| **Lifesigns**           | Heartbeat pings from the Hull confirming a Crewmate is alive                    |
| **Sentinel**            | The watchdog system that detects silent failures                                |
| **Ship's Log**          | The append-only event audit trail                                               |
| **Hailing**             | When a Crewmate is blocked and requesting help from Star Command                |
| **Deploy**              | Spawn a new Crewmate                                                            |
| **Recall**              | Kill / shut down a Crewmate                                                     |
| **Dock**                | A Crewmate arriving at the station (spawn animation)                            |
| **Undock**              | A Crewmate departing the station (completion animation)                         |

## Concept

Every Starbase gets a special tab called Star Command. Unlike regular terminal tabs that run a single Crewmate on a single Mission, Star Command has awareness of the entire Starbase. You talk to the Admiral in natural language, and it manages the fleet of Crew on your behalf.

The visual metaphor is a pixel art space station floating in deep space. Each Crewmate is a pod docked to the station. You watch shuttles dock when Crew are deployed, data beams pulse between pods and the hub when Comms flow, and pods glow, flash, or vent gas based on Crew health. The Admiral has their own avatar — a sci-fi commander character shown in the tab sidebar and Comms feed.

## Multi-Sector Starbases

A Starbase is rarely a single Sector. You might have a monorepo with `api/`, `web/`, `mobile/`, or several related repos side by side. Star Command understands Sectors as a first-class concept — it knows which Crew belong to which Sector, what Missions are pending per Sector, and how to coordinate work that spans across Sectors.

### Sector Registry

Star Command maintains a `sectors` table that maps out the Starbase. Sectors are **always added explicitly** through the Config panel — no auto-discovery or magic scanning. You decide what's a Sector.

### Adding a Sector

In the Config sub-tab under the **Sectors** section, click "Add Sector." This opens a form with:

- **Directory** — browse or type the path relative to the Starbase root (e.g. `services/auth`, `packages/web`)
- **Name** — display name for the Sector (e.g. "Auth Service"). Auto-suggested from the directory name
- **Stack** — auto-detected from project markers in the directory (package.json → TypeScript/Node, go.mod → Go, etc.), but editable
- **Description** — optional one-liner about what this Sector does
- **Base branch** — which branch Crew should branch from, defaults to "main"
- **Merge strategy** — PR / Auto-merge / Branch-only, defaults to Starbase-level setting

The form validates that the directory exists, contains at least one file, and isn't already registered as a Sector. On save, the Sector appears in the Config list and on the Starbase visualizer ring.

You can also add Sectors by telling the Admiral in natural language: "add the `services/auth` directory as a Sector called Auth Service." The Admiral calls `starbase.addSector()` under the hood, but it still goes through the same registration — it just fills in the form fields from your description.

### Managing Sectors

Each registered Sector shows up in the Config panel as an expandable card with its settings, current Crew count, and active Missions. From here you can edit any field, configure per-Sector overrides (worktree toggle, custom timeouts, max concurrent Crew), or remove the Sector.

**Sector removal.** Click "Remove Sector" or tell the Admiral "remove the docs Sector." This recalls any active Crew in that Sector first, then deregisters it. No files are deleted — it just removes the Sector from the registry.

Each Sector tracks its own root path, name, tech stack, and a brief description. When you give the Admiral an order, it uses this registry to figure out where to deploy the Crewmate. If you say "fix the auth tests," Star Command looks at which Sector owns the auth module and deploys a Crewmate in the right directory with the right context.

### Sector-Scoped Missions

Missions belong to Sectors. When Star Command deploys a Crewmate, it assigns them to a specific Sector. This means you can ask questions like "what's the status of the API Sector?" and get a filtered view — just the Crew, Comms, and Cargo related to that Sector, not the whole Starbase.

Sectors can also have their own pending Mission queues. You can front-load work by telling the Admiral "for the web Sector, we need to migrate to React 19, update the test suite, and fix the accessibility audit." Star Command records those as pending Missions on the Sector and can work through them sequentially or in parallel as capacity allows.

### Cross-Sector Coordination

The real power comes when Star Command coordinates across Sectors. If an API Crewmate changes an endpoint shape, Star Command knows the web and mobile Sectors consume that API via their Supply Routes. It can proactively notify or deploy Crew in the downstream Sectors to update their client code. This is driven by the `supply_routes` table — you tell Star Command "web depends on api" and it tracks the relationship.

## Core Capabilities

### Crew Lifecycle Management

Star Command can deploy, recall, restart, and reassign Crew. When you say something like "deploy a Crewmate to the auth service and fix the failing tests," Star Command identifies the right Sector, opens a new tab, navigates to the Sector directory, and launches a Claude Code session with the appropriate Mission briefing and Sector context. It registers the Crewmate in the database and tracks them from deployment to mission complete.

### Natural Language Orchestration

You stay in the Star Command tab and issue high-level directives to the Admiral. Star Command translates those into concrete Crew operations. Examples: "which Crewmate is working on the API layer?" or "tell the frontend Crew that the endpoint shape changed" or "deploy three Crewmates to parallelize the migration across the web and mobile Sectors." Star Command routes Comms, provides Sector context, and summarizes results back to you. It understands Sector boundaries — when you say "the API Sector," it knows exactly which directory, Crew, and Missions you mean.

### Status Aggregation

Star Command aggregates all Crew statuses into a single view, grouped by Sector. It knows who's active, who's idle, who's hailing for help, and who just crashed — and which Sector each Crewmate belongs to. It combines data from the Lifesigns system, the Comms channel, and Hull lifecycle events to give you a real-time picture of your entire Starbase or a filtered view of a single Sector.

### Inter-Crew Comms

Crew can send Transmissions to Star Command (hailing requests, status updates, Cargo) and Star Command can relay information between Crew — even across Sector boundaries. If the auth Crewmate in the API Sector produces a new endpoint spec, Star Command can forward that Cargo to Crew in the web and mobile Sectors without you having to copy-paste anything. The Supply Route graph tells Star Command which Sectors care about which Cargo.

### Mission Queue Management

Each Sector maintains its own Mission queue. You can load up Missions ahead of time ("for the API Sector: add rate limiting, update the OpenAPI spec, write integration tests") and Star Command works through them. It can run Missions sequentially within a Sector or in parallel across Sectors. When one Mission completes, Star Command automatically assigns the next one — or hails you if the next Mission needs clarification.

### Mission Scoping — Small, Focused Tasks

Crewmates are designed for short-lived, tightly scoped Missions — not long-running background processes. A Mission should be something a Crewmate can complete in a single focused session: fix a specific bug, add a single feature, write tests for one module, update a config file.

**Why this matters:** Long-running agents drift off-task, burn tokens, accumulate stale context, and are harder to recover when they fail. A Crewmate that's been running for an hour with a vague directive like "refactor the whole auth system" will produce worse results than three Crewmates that each get a focused 10-minute Mission: "extract the OAuth logic into a service class," "update the routes to use the new service," "add tests for the new service."

**The Admiral's responsibility** is to decompose large requests into small Missions. When you say "refactor the auth system," the Admiral should break that into discrete, independently mergeable units of work and queue them as separate Missions — potentially with dependencies between them. Each Mission should be:

- **Specific** — "add rate limiting middleware to the /api/users endpoint," not "improve the API"
- **Bounded** — completable in under 15-20 minutes of agent time
- **Independent** — produces a working, mergeable result on its own (even if subsequent Missions build on it)
- **Testable** — has a clear done condition the Admiral can verify

**Mission timeout as a guardrail.** Every Mission gets a deadline (default 15 minutes, configurable per Sector). If a Crewmate is still running past the deadline, the Sentinel terminates it. This prevents runaway agents and forces the Admiral to scope Missions tightly. If a Mission keeps timing out, that's a signal it needs to be broken down further.

**No daemon Crew.** Crewmates are not background workers or long-running watchers. They deploy, execute their Mission, produce Cargo, and undock. If you need ongoing work (like "keep the tests green as we make changes"), the Admiral queues a new Mission each time rather than keeping a Crewmate alive indefinitely.

### Quality Gates — Don't Ship Garbage

Agents are fast but sloppy. Without guardrails, a Crewmate will happily produce code that doesn't compile, breaks existing tests, or technically "completes" the Mission while missing the point entirely. Quality gates exist at three stages — before the Mission starts, when the Crewmate finishes, and after the PR is created. The first two are cheap and automated. The third uses the Admiral's judgment.

#### Gate 1: Mission Briefing Requirements

Garbage in, garbage out. If the Admiral deploys a Crewmate with "fix the auth," the result will be unpredictable. The `starbase.addMission()` Bridge Control enforces that every Mission includes:

- **`summary`** — one-line description (used as PR title)
- **`prompt`** — full instructions with context
- **`acceptance_criteria`** — a list of concrete conditions that must be true when the Mission is done

The `acceptance_criteria` field is an array of strings, each one a checkable statement. The Admiral writes these when decomposing your request into Missions:

```json
{
  "summary": "Add rate limiting to /api/users",
  "prompt": "Add express-rate-limit middleware to the /api/users POST endpoint. Limit to 10 requests per minute per IP. Return 429 with a JSON error body...",
  "acceptance_criteria": [
    "POST /api/users returns 429 after 10 requests in 60 seconds",
    "Rate limit headers (X-RateLimit-Limit, X-RateLimit-Remaining) present on response",
    "Existing tests still pass",
    "New test covers the 429 case"
  ]
}
```

If you give the Admiral a vague request, it should push back and ask you to clarify before queuing a Mission — the same way a good tech lead would ask "what does 'fix the auth' actually mean?" The acceptance criteria also appear in the PR body later, so reviewers know exactly what the Crewmate was supposed to do.

#### Gate 2: Hull Verification (Automated)

When a Crewmate signals completion (or exits cleanly), the Hull runs a **verification sequence** before pushing the branch. This is fully automated — no Admiral involvement, no agent involvement. The Hull runs commands in the worktree and checks the results.

**The verification sequence:**

```
1. Crewmate exits (or calls completeMission)
2. Hull checks: are there any changes? (git diff --stat)
   → No changes = Mission failed ("no work produced"), skip push
3. Hull runs the Sector's verify command (see below)
   → If it fails, Mission is marked "failed-verification"
   → Branch is still pushed (preserve work), but no PR is created
   → Admiral is hailed with the verification output
4. Hull pushes branch and continues to PR flow
```

**Sector verify commands.** Each Sector can define a `verify_command` in its config — a shell command the Hull runs after the Crewmate finishes. The Hull runs it in the worktree with a timeout (default 120 seconds). Exit code 0 = pass, anything else = fail.

| Sector Stack    | Default Verify Command            | What It Checks        |
| --------------- | --------------------------------- | --------------------- |
| TypeScript/Node | `npm run build && npm test`       | Compiles + tests pass |
| Go              | `go build ./... && go test ./...` | Compiles + tests pass |
| Python          | `python -m pytest`                | Tests pass            |
| Rust            | `cargo build && cargo test`       | Compiles + tests pass |
| Custom          | User-defined in Config            | Whatever you want     |

The verify command is configurable per Sector in the Config panel. You can set it to anything — `make check`, `./scripts/ci.sh`, or even just `true` if you want to skip verification. If no verify command is set and the stack isn't auto-detected, the Hull skips this gate (with a warning in the Ship's Log).

**What the Hull checks automatically (no config needed):**

- **No changes produced.** If the Crewmate exits clean but `git diff` against the base branch is empty, something went wrong. The agent ran, maybe even succeeded from its perspective, but produced no code. Mission fails.
- **Uncommitted files.** If there are unstaged or untracked files in the worktree, the Hull auto-commits them before verification. Agents sometimes forget to `git add` new files.
- **Lint (optional).** If the Sector has a `lint_command` configured, the Hull runs it. Lint failures are warnings, not blockers — the PR gets a "⚠️ lint warnings" label but still gets created. Lint is noisy and blocking on it would cause too many false rejections.

#### Gate 3: Admiral Review (Intelligent)

After the PR is created, the Admiral reviews it against the Mission's acceptance criteria. This is the smart gate — it catches issues that automated checks can't, like "the code compiles and tests pass, but the implementation is completely wrong."

**How it works:**

```
1. Hull creates PR, sends Transmission to Admiral with PR link + diff summary
2. Admiral reads the PR diff (via gh pr diff or GitHub API)
3. Admiral checks each acceptance criterion against the actual changes
4. Admiral produces a review verdict: pass, request-changes, or reject
```

**Pass** — All acceptance criteria are met, the code looks reasonable. The Admiral approves the PR (or leaves it for you to merge, depending on config). Mission status: completed.

**Request-changes** — Most criteria met, but something is off. Maybe a test is missing, or an edge case isn't handled. The Admiral can either:

- Deploy a follow-up "fix" Mission on the same branch to address the gaps
- Add PR review comments and leave it for you

**Reject** — The work fundamentally misses the point. The Crewmate went off-track, or the output is so bad it's not worth salvaging. The Admiral closes the PR, marks the Mission as failed, and re-queues it (optionally with a revised prompt that includes lessons from the failed attempt). Following Let It Crash — don't try to fix a bad Crewmate, just restart with a better Mission brief.

**Admiral review is configurable.** Not every Mission needs the Admiral to review the PR. The Config panel has a `review_mode` per Sector:

- **`admiral-review`** (default) — Admiral reviews every PR before it's marked complete
- **`verify-only`** — Skip Admiral review, rely purely on Gate 2 (automated verification). Good for low-risk Missions or trusted Sectors.
- **`manual`** — Admiral doesn't review, you review. PRs are created and left open for you.

**Review timeout.** The Admiral's review shouldn't block the pipeline forever. If the Admiral is busy (many concurrent Missions completing), reviews are queued. If a review hasn't happened within 10 minutes (configurable), the Mission is marked "pending-review" and the Admiral surfaces it next time you interact with Star Command.

#### Acceptance Criteria in the PR

The PR template includes the acceptance criteria as a checklist, with the Admiral's assessment:

```markdown
## Mission: Add rate limiting to /api/users

### Acceptance Criteria

- [x] POST /api/users returns 429 after 10 requests in 60 seconds
- [x] Rate limit headers present on response
- [x] Existing tests still pass
- [x] New test covers the 429 case

### Verification

- Build: ✅ passed
- Tests: ✅ 47 passed, 0 failed
- Lint: ⚠️ 2 warnings (non-blocking)

### Admiral Review

All acceptance criteria verified against the diff. Rate limiting is implemented
using express-rate-limit with in-memory store as specified. New test at
test/rate-limit.test.ts covers the 429 case with proper assertions.
```

This means every PR is self-documenting — you (or anyone reviewing) can see exactly what was asked for, whether automated checks passed, and what the Admiral thought. No guessing about whether the Crewmate actually did what it was supposed to.

#### Schema Additions

The `missions` table gets new columns for quality gates:

| Column              | Type | Description                                                      |
| ------------------- | ---- | ---------------------------------------------------------------- |
| acceptance_criteria | TEXT | JSON array of criteria strings                                   |
| verify_result       | TEXT | JSON blob with verify command output (stdout, stderr, exit code) |
| review_verdict      | TEXT | "pass", "request-changes", "reject", or NULL if not yet reviewed |
| review_notes        | TEXT | Admiral's review commentary                                      |

The `sectors` table gets verification config:

| Column         | Type | Description                                   |
| -------------- | ---- | --------------------------------------------- |
| verify_command | TEXT | Shell command to run after Mission completion |
| lint_command   | TEXT | Optional lint command (warnings only)         |
| review_mode    | TEXT | "admiral-review", "verify-only", or "manual"  |

The `starbase_config` table gets a new default:

| Key                   | Default          | Description                               |
| --------------------- | ---------------- | ----------------------------------------- |
| `default_review_mode` | "admiral-review" | Default review mode for new Sectors       |
| `review_timeout_min`  | 10               | Minutes before unreviewed PRs get flagged |

## Database

Fleet ships with an embedded SQLite database (via `better-sqlite3`) that acts as the shared brain between Star Command and all Crew. Each Starbase gets its own isolated database file — no cross-contamination between workspaces.

### Database Per Starbase

Each workspace gets a unique database file named `starbase-{id}.db`, where the ID is a 6-character hash derived from the workspace's absolute path (truncated sha256). This means reopening the same workspace automatically reconnects to the same database.

Database files live in Fleet's app data directory, not in the workspace root (avoids polluting the user's project and needing gitignore entries):

```
~/.fleet/starbases/
  starbase-a3f8c2.db    ← /Users/you/projects/main-product
  starbase-7b1e4d.db    ← /Users/you/projects/side-project
  index.json            ← maps workspace paths → db IDs
```

The `index.json` registry maps workspace paths to their Starbase IDs:

```json
{
  "/Users/you/projects/main-product": "starbase-a3f8c2",
  "/Users/you/projects/side-project": "starbase-7b1e4d"
}
```

When Fleet opens a workspace, it hashes the path, checks the index, and opens (or creates) the corresponding database. If a database file is missing but the index entry exists, Fleet creates a fresh database — the Starbase was reset. If the index entry is missing, Fleet generates a new ID and registers it.

SQLite is configured with WAL mode (`PRAGMA journal_mode=WAL`) to allow concurrent reads from multiple Crew while one process writes, avoiding `SQLITE_BUSY` errors under load.

### Schema

#### `sectors` table

Tracks every Sector in the Starbase.

| Column      | Type     | Description                                  |
| ----------- | -------- | -------------------------------------------- |
| id          | TEXT PK  | Short slug like "api", "web", "mobile"       |
| name        | TEXT     | Display name like "API Service"              |
| root_path   | TEXT     | Absolute path to the Sector directory        |
| stack       | TEXT     | Detected tech stack, e.g. "typescript/node"  |
| description | TEXT     | Brief description of what this Sector covers |
| created_at  | DATETIME | When the Sector was registered               |
| updated_at  | DATETIME | Last change                                  |

#### `supply_routes` table

Maps which Sectors depend on which, so Star Command can propagate changes along Supply Routes.

| Column               | Type       | Description                                                          |
| -------------------- | ---------- | -------------------------------------------------------------------- |
| id                   | INTEGER PK | Auto-increment                                                       |
| upstream_sector_id   | TEXT       | The Sector that produces changes                                     |
| downstream_sector_id | TEXT       | The Sector that consumes/depends on upstream                         |
| relationship         | TEXT       | Type of route, e.g. "api_consumer", "shared_lib", "monorepo_sibling" |
| created_at           | DATETIME   | When the Supply Route was established                                |

#### `missions` table

Per-Sector Mission queue that Star Command works through.

| Column                | Type       | Description                                          |
| --------------------- | ---------- | ---------------------------------------------------- |
| id                    | INTEGER PK | Auto-increment                                       |
| sector_id             | TEXT       | FK to sectors table                                  |
| crew_id               | TEXT       | FK to crew table, NULL if not yet assigned           |
| summary               | TEXT       | Short Mission briefing                               |
| prompt                | TEXT       | Full Mission instructions for the Crewmate           |
| status                | TEXT       | "queued", "active", "completed", "failed", "aborted" |
| priority              | INTEGER    | Lower number = higher priority, default 0            |
| depends_on_mission_id | INTEGER    | FK to another Mission that must complete first       |
| result                | TEXT       | JSON blob with Mission debrief when done             |
| created_at            | DATETIME   | When the Mission was queued                          |
| started_at            | DATETIME   | When a Crewmate was assigned                         |
| completed_at          | DATETIME   | When the Mission concluded                           |

#### `crew` table

Tracks every Crewmate in the Starbase.

| Column          | Type     | Description                                                         |
| --------------- | -------- | ------------------------------------------------------------------- |
| id              | TEXT PK  | Short slug like "auth-crew-1"                                       |
| tab_id          | TEXT     | FK to Fleet's tab system                                            |
| sector_id       | TEXT     | FK to sectors table                                                 |
| mission_id      | INTEGER  | FK to missions table, the current Mission                           |
| sector_path     | TEXT     | Working directory for this Crewmate                                 |
| status          | TEXT     | "active", "idle", "hailing", "complete", "error", "lost", "timeout" |
| mission_summary | TEXT     | What this Crewmate is working on                                    |
| avatar_variant  | TEXT     | Which pixel art variant to display                                  |
| pid             | INTEGER  | OS process ID for the Hull                                          |
| deadline        | DATETIME | Optional Mission timeout                                            |
| token_budget    | INTEGER  | Max tokens this Crewmate can consume                                |
| tokens_used     | INTEGER  | Tokens consumed so far                                              |
| last_lifesign   | DATETIME | Last Lifesign timestamp from the Hull                               |
| created_at      | DATETIME | When the Crewmate was deployed                                      |
| updated_at      | DATETIME | Last status change                                                  |

#### `comms` table

The Transmission channel between Crew and Star Command.

| Column      | Type       | Description                                                                               |
| ----------- | ---------- | ----------------------------------------------------------------------------------------- |
| id          | INTEGER PK | Auto-increment                                                                            |
| from_crew   | TEXT       | Crewmate id or "admiral"                                                                  |
| to_crew     | TEXT       | Crewmate id, "admiral", or "all-hands"                                                    |
| thread_id   | TEXT       | Groups back-and-forth exchanges                                                           |
| in_reply_to | INTEGER    | FK to parent Transmission id                                                              |
| type        | TEXT       | "status_update", "hailing", "mission_complete", "directive", "question", "cargo_manifest" |
| payload     | TEXT       | JSON blob — flexible schema                                                               |
| read        | BOOLEAN    | Default false                                                                             |
| created_at  | DATETIME   | When the Transmission was sent                                                            |

#### `cargo` table

Things Crew produce that other Crew or Star Command might need.

| Column     | Type       | Description                                              |
| ---------- | ---------- | -------------------------------------------------------- |
| id         | INTEGER PK | Auto-increment                                           |
| crew_id    | TEXT       | Who produced this Cargo                                  |
| sector_id  | TEXT       | FK to sectors table — which Sector this Cargo belongs to |
| type       | TEXT       | "file_changed", "endpoint_spec", "schema", "test_result" |
| manifest   | TEXT       | JSON blob describing the Cargo contents                  |
| created_at | DATETIME   | When the Cargo was produced                              |

#### `ships_log` table

Append-only audit trail for debugging and post-mission review.

| Column     | Type       | Description                                                                 |
| ---------- | ---------- | --------------------------------------------------------------------------- |
| id         | INTEGER PK | Auto-increment                                                              |
| crew_id    | TEXT       | Which Crewmate                                                              |
| event_type | TEXT       | "deployed", "lifesign_lost", "exited", "lost", "redeployed", "comms_failed" |
| detail     | TEXT       | JSON blob with context                                                      |
| created_at | DATETIME   | When it happened                                                            |

#### `starbase_config` table

Key-value configuration store for the entire Starbase. Managed via the Star Command Config panel.

| Column     | Type     | Description     |
| ---------- | -------- | --------------- |
| key        | TEXT PK  | Config key name |
| value      | TEXT     | JSON value      |
| updated_at | DATETIME | Last change     |

**Default config values:**

| Key                           | Default | Description                                                   |
| ----------------------------- | ------- | ------------------------------------------------------------- |
| `max_concurrent_worktrees`    | 5       | Hard limit on active worktrees across the Starbase            |
| `worktree_pool_size`          | 2       | How many idle worktrees to keep warm per Sector               |
| `worktree_disk_budget_gb`     | 5       | Max total disk for worktrees before Admiral warns             |
| `default_mission_timeout_min` | 15      | Default Mission deadline in minutes                           |
| `default_merge_strategy`      | "pr"    | Default for new Sectors: "pr", "auto-merge", or "branch-only" |
| `comms_rate_limit_per_min`    | 30      | Max Transmissions a Crewmate can send per minute              |
| `default_token_budget`        | 0       | Default token budget per Crewmate (0 = unlimited)             |
| `lifesign_interval_sec`       | 10      | How often the Hull sends Lifesign pings                       |
| `lifesign_timeout_sec`        | 30      | How long before a missing Lifesign triggers Sentinel          |

### Payload Flexibility

The `payload` column on Comms and `manifest` on Cargo are intentionally JSON text columns rather than normalized. The Transmission types will evolve fast and schema migrations would slow things down. Indexes on extracted JSON fields can be added later if queries get slow. All payloads are validated with zod at the Bridge Controls / Subspace CLI layer before insertion — bad JSON is rejected immediately rather than written as corrupt data.

## Crew Interface

### Bridge Controls (Primary)

Star Command exposes Starbase operations as MCP tools — the Bridge Controls — that get injected into Crewmate sessions. The model sees them in its tool list and uses them naturally. This is the primary interface because Crew are far more likely to use visible MCP tools than remember a CLI command.

**Crew Operations**

| Tool                                                | Description                                                 |
| --------------------------------------------------- | ----------------------------------------------------------- |
| `starbase.deploy({ sectorId, prompt, missionId? })` | Deploy a Crewmate to a Sector, optionally tied to a Mission |
| `starbase.hail(crewId, message)`                    | Send a Transmission to a Crewmate                           |
| `starbase.recall(crewId)`                           | Recall a Crewmate (shut down)                               |
| `starbase.observe(crewId)`                          | Read recent output from a Crewmate                          |
| `starbase.crew({ sectorId? })`                      | List Crew, optionally filtered by Sector                    |
| `starbase.inbox()`                                  | Get unread Transmissions addressed to the caller            |
| `starbase.ask(crewId, question)`                    | Send a directive and wait for response                      |
| `starbase.resolve(transmissionId, response)`        | Respond to a hailing request                                |

**Sector Operations**

| Tool                                                               | Description                                     |
| ------------------------------------------------------------------ | ----------------------------------------------- |
| `starbase.sectors()`                                               | List all registered Sectors                     |
| `starbase.addSector({ path, name?, description? })`                | Register a new Sector in the Starbase           |
| `starbase.sectorStatus(sectorId)`                                  | Get Crew, Missions, and Cargo for a Sector      |
| `starbase.removeSector(sectorId)`                                  | Deregister a Sector (recalls active Crew first) |
| `starbase.addSupplyRoute({ upstream, downstream, relationship? })` | Establish a Supply Route between Sectors        |

**Mission Operations**

| Tool                                                                        | Description                                          |
| --------------------------------------------------------------------------- | ---------------------------------------------------- |
| `starbase.addMission({ sectorId, summary, prompt, priority?, dependsOn? })` | Queue a Mission for a Sector                         |
| `starbase.missions({ sectorId?, status? })`                                 | List Missions, optionally filtered                   |
| `starbase.nextMission(sectorId)`                                            | Get the highest priority queued Mission for a Sector |
| `starbase.completeMission(missionId, result)`                               | Mark a Mission done with a debrief                   |
| `starbase.abortMission(missionId)`                                          | Abort a queued Mission                               |

### Subspace CLI (Fallback)

A lightweight CLI that Crew can shell out to when Bridge Controls aren't available. Each command does a simple INSERT or SELECT on the SQLite database.

```
starbase hail admiral --type hailing --payload '{"issue":"need API key for stripe test env"}'
starbase status hailing "waiting on stripe credentials"
starbase cargo endpoint_spec --sector api '{"path":"/api/users","method":"POST"}'
starbase missions --sector web --status queued
starbase complete-mission 42 '{"summary":"migrated to React 19"}'
```

The Subspace CLI has built-in retry with backoff — if a write fails due to a SQLite lock, it waits 100ms and tries again up to 3 times. Silent retry, no Crew involvement needed.

## Worktrees — Crew Isolation

When multiple Crewmates are deployed to the same Sector, they need to work in isolation so they don't step on each other's files. Fleet solves this with git worktrees — each Crewmate gets their own checkout of the repo on their own branch.

### How It Works

The Hull handles worktree creation transparently. The Crewmate (whether it's Claude Code, OpenCode, Aider, or anything else) doesn't need to know it's in a worktree — it just sees a normal git repo.

```
1. Admiral calls starbase.deploy({ sectorId: "api", prompt: "add rate limiting" })
2. Hull runs: git worktree add ~/.fleet/worktrees/{starbaseId}/{crewId} -b crew/{crewId}
3. Hull runs package install in the worktree (npm install, etc.)
4. Hull spawns the agent with cwd set to the worktree path
5. Crewmate works in complete isolation — own branch, own files, commits as they go
6. On Mission complete, Hull pushes branch to origin and executes merge strategy (PR, auto-merge, or branch-only)
7. Hull cleans up: git worktree remove ~/.fleet/worktrees/{starbaseId}/{crewId}
```

Fleet owns worktree management exclusively via `git worktree` — no agent-specific worktree features are used. The Hull creates the worktree _before_ any agent launches, so the agent never needs built-in worktree support. This means Fleet works identically with Claude Code, OpenCode, Aider, Cursor, Cline, or any CLI-based coding agent. If it can run in a directory, it can run in a Fleet worktree.

### Worktree Directory Layout

```
~/.fleet/worktrees/
  {starbaseId}/
    {crewId}/          ← full working tree, branched from main
    {crewId}/          ← another Crewmate, own branch
```

### Schema Additions

The `crew` table tracks worktree state:

| Column          | Type | Description                             |
| --------------- | ---- | --------------------------------------- |
| worktree_path   | TEXT | Absolute path to the worktree directory |
| worktree_branch | TEXT | Branch name, e.g. "crew/auth-crew-1"    |

### Agent Compatibility

Every agent gets the same treatment — Hull creates the worktree, sets the agent's working directory to it, done:

| Agent         | Spawn Command                   |
| ------------- | ------------------------------- |
| Claude Code   | `claude` in worktree cwd        |
| OpenCode      | `opencode` in worktree cwd      |
| Aider         | `aider` in worktree cwd         |
| Cursor (CLI)  | `cursor` in worktree cwd        |
| Cline         | `cline` in worktree cwd         |
| Custom script | Any executable, in worktree cwd |

The key insight: git worktrees are invisible to the tools running inside them. `git status`, `git commit`, `git diff` — everything works exactly as if it's a normal clone. No agent needs worktree awareness. Fleet handles it at the infrastructure layer so you can mix and match agents freely.

### Mission Completion — Push & PR Flow

When a Crewmate finishes their Mission, the Hull handles the full git lifecycle — the Crewmate just writes code and commits, and the infrastructure takes care of everything else.

**The completion sequence:**

```
1. Crewmate signals Mission complete (or exits cleanly)
2. Hull ensures all changes are committed on the worktree branch
3. Hull runs Gate 2 verification (verify_command, lint, diff check)
   → If verification fails: push branch, mark "failed-verification", hail Admiral, stop here
4. Hull pushes the branch to origin: git push -u origin crew/{crewId}
5. Hull executes the Sector's merge strategy (see below)
6. If review_mode is "admiral-review": Admiral runs Gate 3 against acceptance criteria
   → If rejected: close PR, re-queue Mission with revised prompt
7. Hull updates the missions table with the result/debrief
8. Hull sends a Transmission to the Admiral with the outcome
9. Hull cleans up the worktree (or recycles it to the pool)
```

If the Crewmate exits uncleanly (error, crash, timeout), the Hull still pushes whatever commits exist on the branch — partial work is better than lost work. The Mission gets marked as failed but the branch is preserved for review or reassignment. Gate 2 verification is skipped for failed Missions — no point verifying broken work.

### Merge Strategy

Three strategies, configurable per Sector:

**"pr" (default)** — The Hull pushes the branch and creates a pull request via `gh pr create` (or equivalent GitLab/Bitbucket CLI). The PR title comes from the Mission summary, and the body is auto-generated from the Mission debrief — what changed, what was tested, any caveats. The Admiral can review and approve PRs, or you review them yourself. This is the safest option and fits naturally into existing GitHub flow.

The PR template follows a consistent format:

```
## Mission: {mission summary}

**Sector:** {sector name}
**Crewmate:** {crew id} ({avatar variant})
**Duration:** {started_at → completed_at}

### Acceptance Criteria
{checklist from mission.acceptance_criteria, checked/unchecked by Admiral review}

### Changes
{auto-generated from git diff --stat}

### Verification
- Build/Test: {verify_command result}
- Lint: {lint_command result or "skipped"}

### Mission Debrief
{summary from the Crewmate's final output / Cargo}

### Admiral Review
{review_notes from Gate 3, or "Skipped (verify-only mode)"}

---
Deployed by Star Command | Starbase: {starbase id}
```

**"auto-merge"** — The Hull pushes, creates a PR, and immediately merges it (if CI passes and there are no conflicts). Fast but risky with concurrent Crew in the same Sector. If merge conflicts occur, the Hull leaves the PR open and hails the Admiral to resolve. Best for single-Crewmate Sectors or when Crew are working on isolated files.

**"branch-only"** — The Hull pushes the branch but doesn't create a PR. You or the Admiral handle it later. The branch persists on the remote, the worktree is cleaned up locally. Good for exploratory Missions where you want to evaluate the work before deciding what to do with it.

Configured in the `sectors` table:

| Column         | Type | Description                                        |
| -------------- | ---- | -------------------------------------------------- |
| merge_strategy | TEXT | "pr", "auto-merge", or "branch-only". Default "pr" |
| base_branch    | TEXT | Branch to merge into, default "main"               |

### PR Labels and Linking

PRs created by Fleet are automatically labeled with `fleet`, `sector/{sectorId}`, and `mission/{missionId}` for easy filtering. If the Mission depends on another Mission's PR, the Hull adds a "depends on #N" reference in the PR body so you can see the dependency chain in GitHub.

The Admiral can also batch-merge PRs from a completed Mission chain — if Missions A → B → C all completed successfully and their PRs have no conflicts, the Admiral can merge them in order with a single command.

### Concurrent Crew and Merge Conflicts

When multiple Crewmates work in the same Sector simultaneously, merge conflicts are inevitable. Fleet handles this with a rebase-first approach:

1. Crewmate A completes first, Hull pushes and creates PR, PR gets merged
2. Crewmate B completes, Hull attempts to rebase B's branch onto the updated base branch
3. If rebase succeeds cleanly — push and create PR as normal
4. If rebase has conflicts — Hull pushes the un-rebased branch, creates a draft PR, marks the Mission as "needs-rebase", and hails the Admiral

The Admiral can then either resolve the conflicts itself (by deploying a short "rebase Mission") or flag it for you to handle manually. The key is that no work is ever lost — the branch is always pushed to the remote regardless of conflict state.

### Package Installation

Each worktree needs its own `node_modules` (or equivalent). The Hull detects the package manager from lockfiles and runs the install after creating the worktree:

```
package-lock.json  → npm install
pnpm-lock.yaml     → pnpm install (uses content-addressable store, fast)
yarn.lock          → yarn install
bun.lockb          → bun install
```

For pnpm and bun, this is near-instant because they use shared stores. For npm/yarn, the Hull can optionally symlink `node_modules` from the Sector's original directory to skip the install entirely (with a config flag `worktree_symlink_modules: true`), at the risk of edge cases with native modules.

### Worktree Limits

Worktrees eat disk space — each one is a full copy of the working tree (minus `.git`). Fleet enforces a hard limit of **5 concurrent worktrees per Starbase** by default. When the limit is hit, the Admiral queues new Missions instead of deploying them immediately — they'll execute as existing Crew complete and worktrees free up.

The limit is configurable via the Star Command Config panel (see below) and stored in the `starbase_config` table. If you're working on a small repo and have disk to spare, bump it up. For large monorepos, you might want to lower it.

**Worktree pool.** Instead of always creating fresh worktrees, Fleet can recycle worktrees from completed Crew. When a Mission completes and the branch is merged, the Hull resets the worktree to main instead of deleting it. Next deploy reuses it. Configurable via `worktree_pool_size` in the Config panel.

**Disk budget.** Fleet tracks total worktree disk usage in `~/.fleet/worktrees/`. If it exceeds a configurable threshold (default 5GB), the Admiral warns you and refuses to deploy new Crew until old worktrees are cleaned up.

**Stale cleanup.** The startup reconciliation pass sweeps `~/.fleet/worktrees/` and removes any worktree directories that don't correspond to active Crew in the database. Also runs `git worktree prune` on each Sector repo to clean up stale worktree references.

### Single-Crewmate Optimization

If a Sector only ever has one Crewmate at a time, worktrees are overhead. The Hull can detect this and skip worktree creation — just run the agent directly in the Sector directory. Configurable per Sector via the Config panel (`worktree_enabled`).

The Admiral can also auto-detect: if a Sector has never had concurrent Crew, suggest disabling worktrees for it.

## Reliability

### Design Philosophy — Let It Crash

Star Command borrows its reliability model from Erlang/OTP and Elixir: **let it crash, then restart clean.** Instead of writing elaborate error-handling code inside every agent, Hull, or subsystem, we embrace failure as a normal part of operation and invest in fast, clean recovery.

The core insight is that Crewmates are already perfectly suited for this:

- **Isolated.** Each Crewmate runs in its own worktree, on its own branch, in its own process. A crash can't corrupt another Crewmate's state.
- **Short-lived.** Missions are scoped to 15 minutes. There's minimal state to lose — at most a few commits on a branch.
- **Stateless.** All durable state lives in the SQLite database, not in the agent's memory. A restarted Crewmate can pick up where the last one left off by reading the database.
- **Replaceable.** A Crewmate is not precious. If one dies, deploy another with the same Mission briefing. The worktree branch preserves any partial work.
- **Supervised.** The Hull supervises the Crewmate, the Sentinel supervises the Hull, Fleet's main process supervises everything. It's a supervision tree — just like OTP.

**What this means in practice:** When something goes wrong, the default response is not "try to fix it in place" but "kill it, clean up, restart." A Crewmate stuck in a loop? Kill and redeploy with a tighter Mission scope. Package install failed? Kill, clean the worktree, retry from scratch. Agent ignoring MCP tools? Fine, let it finish or timeout — the Hull tracks lifecycle regardless. Database locked? Retry with a timeout, and if it persists, restart the writer.

**The supervision tree:**

```
Fleet (Electron main process)
  └── Sentinel (watchdog sweep, runs every 10s)
        └── Hull (one per Crewmate)
              └── Crewmate (the actual agent process)
```

Each layer watches the layer below it. If a Crewmate dies, the Hull detects it and cleans up. If the Hull somehow dies, the main process detects the PTY exit and cleans up. If Fleet itself crashes, the startup reconciliation pass cleans up everything on relaunch. At every level: detect failure → clean up state → restart if appropriate.

**Two principles from Erlang that apply directly:**

1. **Don't program defensively inside the worker.** The Crewmate doesn't need elaborate error handling. It just does its job. If it hits something unexpected, it crashes. The Hull handles the rest.
2. **Distinguish between expected and unexpected errors.** Expected errors (git push fails due to network) get retries with backoff. Unexpected errors (agent exits with code 137, OOM-killed) get an immediate restart with the same Mission. The distinction is: can we meaningfully retry the same operation? If yes, retry. If no, restart the whole thing.

**What we explicitly don't do:** We don't try to keep a sick Crewmate alive. No complex state recovery inside a running agent, no "pause and resume" semantics, no partial rollbacks. If a Crewmate is in a bad state, the cheapest and most reliable fix is always: kill it, push whatever commits exist on the branch (preserve partial work), and deploy a fresh Crewmate.

### Never Trust the Worker

The second principle: never trust a Crewmate to self-report reliably. Every critical state transition (active, lost, hailing, complete) is tracked by infrastructure the Crewmate can't forget to call. The Crewmate's own Transmissions via Bridge Controls / Subspace CLI are a nice-to-have context layer on top — but the system works even if the Crewmate never sends a single Transmission.

### Hull (Wrapper Process)

Crewmates are never deployed as bare `claude` processes. Each Crewmate runs inside a Hull — a thin wrapper process that handles lifecycle reporting automatically.

```
Crewmate starts   → Hull INSERTs into crew table (status: "active")
Crewmate exits 0  → Hull UPDATEs status to "complete"
Crewmate exits !0 → Hull UPDATEs status to "error", captures last N lines of output
Mission timeout   → Hull terminates Crewmate, marks "timeout"
SIGTERM/crash     → Hull's signal handler marks "lost"
```

The Hull is the source of truth for "is this Crewmate alive," not the Crewmate itself. This means reliable lifecycle tracking even if the Crewmate never once sends a Transmission.

### Lifesigns

The Hull (not the Crewmate) writes a Lifesign timestamp to the database every N seconds. Star Command or the Electron main process runs the Sentinel query:

```sql
SELECT * FROM crew
WHERE status = 'active'
AND last_lifesign < datetime('now', '-30 seconds')
```

Anything that shows up is presumed lost. Mark it, notify the Admiral, let it decide whether to redeploy or reassign.

### Electron Main Process Hooks

The Electron main process listens for PTY `exit` events and immediately updates the database regardless of what the Hull does. Belt and suspenders — if the Hull is destroyed too (which it will if the PTY is its child process), the main process still cleans up.

### Comms Rate Limiting

If a Crewmate sends more than N Transmissions per minute, the Bridge Controls / Subspace CLI layer starts dropping them and flags it to the Admiral. Simple counter in the crew table prevents runaway Comms spam.

### Token/Cost Budget

Each Crewmate has an optional `token_budget` in the crew table. The Hull monitors Claude Code's output for token usage and terminates the Crewmate if it exceeds the budget.

### Mission Timeout

When Star Command deploys a Crewmate, it can set a `deadline` in the crew table. The Sentinel terminates anything that runs past its deadline.

### Startup Reconciliation

When the app restarts or Star Command recovers from a crash, the Admiral runs a reconciliation pass:

1. Query all Crew with status "active"
2. Check if their PIDs are actually alive (`kill -0` or equivalent)
3. Mark lost ones as "lost" in the crew table, log to Ship's Log
4. Check for unread Transmissions that arrived while the Admiral was down
5. Redeploy or reassign incomplete Missions

### Reliability Stack Summary

| Layer              | What it does                                     |
| ------------------ | ------------------------------------------------ |
| Hull               | Guaranteed lifecycle tracking for each Crewmate  |
| Lifesigns          | Detects silent Crew failures                     |
| Sentinel           | Watchdog query that sweeps for missing Lifesigns |
| Main process hooks | Catches PTY death at the Electron level          |
| WAL + retries      | Handles database write contention                |
| Comms rate limits  | Prevents runaway Transmission spam               |
| Token budget       | Prevents runaway cost from a single Crewmate     |
| Startup reconcile  | Recovers Starbase state after app crashes        |
| Ship's Log         | Explains what went wrong in post-mission review  |

## Failure Modes & Mitigations

Following the Let It Crash philosophy, the default response to most failures is: **kill, clean up, restart.** This section catalogues how specific failures map to that pattern — and the few cases where we retry in place instead of restarting. Organized by subsystem.

The guiding question for each failure: **is it cheaper to fix in place or restart from scratch?** For Crewmates, the answer is almost always restart. For infrastructure (database, worktrees, git), we retry a bounded number of times, then escalate.

### Worktree Failures

**Worktree creation fails.** `git worktree add` can fail for several reasons: disk full, branch name collision (a `crew/auth-crew-1` branch already exists from a previous run), git index corruption, or the Sector directory isn't actually a git repo. The Hull must catch the error before spawning the agent.

_Mitigation:_ Before creating a worktree, the Hull runs a pre-flight check: verify the Sector is a git repo (`git rev-parse --git-dir`), verify the branch name is available (`git branch --list crew/{crewId}`), verify disk headroom (at least 500MB free). If the branch already exists, append a numeric suffix (`crew/auth-crew-1-2`). If the Sector isn't a git repo, skip worktree creation entirely and run the agent directly in the directory (with a warning to the Admiral). On any unrecoverable error, the Mission goes back to queued status and the Admiral is hailed with the specific error.

**Package install fails or hangs.** `npm install` can hang on network issues, fail on native module compilation, or error on lockfile conflicts in the worktree. The agent can't start working until dependencies are ready.

_Mitigation:_ The Hull runs the package install with a hard timeout (default 120 seconds, configurable). If it fails, the Hull retries once. If it hangs, the Hull kills it after timeout. On persistent failure, the Hull tries the `worktree_symlink_modules` approach as a fallback (symlink `node_modules` from the original Sector directory). If that also fails, Mission goes back to queued and the Admiral gets the install error output so it can diagnose (missing native deps, wrong Node version, etc.).

**Worktree cleanup fails.** After a Mission completes, the Hull runs `git worktree remove`. This can fail if files are still locked (a running process still has handles open), or if the worktree directory was manually modified/moved. Stale worktree refs pile up in `.git/worktrees/`.

_Mitigation:_ The Hull terminates all child processes before cleanup. If `git worktree remove` fails, the Hull retries after 2 seconds (handles slow file handle release). If it still fails, the Hull force-removes with `git worktree remove --force` and logs a warning. The startup reconciliation pass runs `git worktree prune` on every Sector repo to clean orphaned references. A background sweep of `~/.fleet/worktrees/` removes any directories not tracked in the crew table.

**Worktree pool staleness.** Recycled worktrees in the pool might have stale dependencies (e.g., `package.json` changed on main since the worktree was created), uncommitted files from a previous Crewmate, or diverged significantly from the base branch.

_Mitigation:_ When recycling a worktree, the Hull runs a refresh sequence: `git checkout {base_branch}`, `git pull`, `git clean -fd`, and a fresh package install. If the refresh fails or takes too long, the Hull discards the pooled worktree and creates a fresh one. Pool worktrees older than 1 hour are automatically evicted.

### Git & Push Failures

**Branch push fails.** `git push` can fail because: the remote is unreachable (network down), git credentials have expired (GitHub token revoked), the branch was already pushed by a previous attempt, or the remote rejected the push (pre-receive hook, branch protection).

_Mitigation:_ The Hull retries pushes up to 3 times with exponential backoff (2s, 8s, 30s). On auth failure, the Hull hails the Admiral with a specific "git credentials expired" message — the Admiral escalates to you. On network failure, the Hull persists the branch locally, marks the Mission as "push-pending," and registers a retry job. The startup reconciliation pass checks for any "push-pending" Missions and retries them. The branch is never deleted until the push succeeds — partial work is always preserved locally.

**PR creation fails.** The `gh` CLI might not be installed, not authenticated, rate-limited by GitHub's API, or the repo might not have a remote origin configured.

_Mitigation:_ On first deploy, the Hull checks for `gh` availability and auth status (`gh auth status`). If `gh` isn't available, the merge strategy automatically falls back to "branch-only" and the Admiral is warned: "PR creation unavailable — branches will be pushed but PRs must be created manually." On GitHub API rate limiting (HTTP 429), the Hull reads the `Retry-After` header and queues the PR creation for later. On any other PR creation failure, the branch is still pushed — worst case you have the code on the remote, just no PR wrapping it.

**Branch naming collision.** Two Crewmates could theoretically get the same crew ID, or a branch from a previous session could still exist on the remote.

_Mitigation:_ Crew IDs include a short random suffix (e.g., `auth-crew-a3f8`). Before creating a branch, the Hull checks both local (`git branch --list`) and remote (`git ls-remote --heads origin crew/{crewId}`) for conflicts. If the name is taken, append an incrementing suffix.

**Agent force-pushes or rewrites history.** An agent running inside a worktree could run `git push --force` or `git rebase` in unexpected ways, potentially overwriting other Crewmates' branches on the remote.

_Mitigation:_ The Hull sets `receive.denyNonFastForwards` in the worktree's git config. Additionally, the Hull configures the worktree git config to restrict push to only the Crewmate's own branch: `git config push.default current`. The main repo's branch protection rules (set up on GitHub/GitLab) are the ultimate guardrail here — Fleet recommends enabling branch protection on the base branch.

**Rebase conflicts during concurrent Crew merge.** Crewmate B finishes after Crewmate A's PR was merged, and the rebase fails with conflicts.

_Mitigation:_ Already covered in the spec (draft PR + hail Admiral), but additionally: the Hull captures the conflicting file list from the rebase output and includes it in the hailing Transmission. The Admiral can then deploy a short-lived "rebase Crewmate" with specific instructions: "resolve conflicts in these files: {list}, keeping both sets of changes." If the rebase Crewmate also fails, the Admiral escalates to you.

### Database Failures

**SQLite corruption.** Power loss or force-kill during a write can corrupt the database even with WAL mode. Rare but possible, especially if the machine crashes.

_Mitigation:_ Fleet enables `PRAGMA synchronous=NORMAL` (balances safety and performance with WAL). On startup, Fleet runs `PRAGMA integrity_check` on the database. If corruption is detected, Fleet attempts `PRAGMA recovery` (SQLite 3.42+). If recovery fails, Fleet moves the corrupt file to `starbase-{id}.db.corrupt`, creates a fresh database, and warns you that Starbase history was lost. For critical deployments, Fleet can be configured to take periodic database snapshots (copy the `.db` and `.db-wal` files) every N minutes.

**Database grows unbounded.** The comms, cargo, and ships_log tables grow forever. A busy Starbase with many Missions over weeks/months could accumulate hundreds of thousands of rows, slowing queries.

_Mitigation:_ Fleet implements retention policies with configurable TTLs. Default: comms older than 30 days are archived to a `comms_archive` table (or deleted), cargo older than 14 days is pruned, ships_log older than 30 days is pruned. The Admiral warns when the database exceeds 100MB. A "compact database" button in the Config panel runs `VACUUM` and cleans expired records. Retention settings are stored in `starbase_config`.

**Database locked by zombie process.** A crashed Hull process might leave the database file locked (more of a problem on Windows than macOS/Linux). New Crew can't write.

_Mitigation:_ WAL mode largely prevents this since readers don't block writers. For the rare case where a writer dies mid-transaction, SQLite's built-in lock recovery timeout handles it (Fleet sets `PRAGMA busy_timeout=5000` — wait up to 5 seconds for the lock to clear). If it's still locked, the Hull logs the error and the startup reconciliation kills any zombie processes holding the file.

**Schema migrations on Fleet updates.** When Fleet ships a new version that adds columns or tables, existing databases need to be migrated without data loss.

_Mitigation:_ The database has a `schema_version` pragma (or a `_meta` table). On open, Fleet compares the on-disk version to the expected version and runs sequential migration scripts. Migrations are always additive (add columns, add tables, add indexes) — never destructive. Each migration is wrapped in a transaction so a failed migration rolls back cleanly. Fleet keeps the migration scripts as simple SQL files versioned alongside the code.

### Agent Behavior Failures

**Agent spawns but never starts working.** The agent process is alive (Hull sees Lifesigns), but the agent is stuck in initialization — loading context, waiting for user input, or encountering an interactive prompt.

_Mitigation:_ The Hull monitors the agent's stdout/stderr for activity. If no output is produced for 60 seconds after spawn (configurable `agent_startup_timeout`), the Hull terminates and redeploys with adjusted flags. For Claude Code specifically, the Hull ensures `--yes` or equivalent non-interactive flags are set. The Ship's Log records the timeout so the Admiral can adjust the spawn command for that agent type.

**Agent ignores Bridge Controls entirely.** The MCP tools are injected, but the agent never calls them — it just writes code and exits without ever reporting status, producing Cargo, or calling `completeMission`.

_Mitigation:_ This is fine. The Hull tracks lifecycle independently. When the agent exits cleanly (exit code 0), the Hull marks the Mission as complete. The Hull captures the agent's final git diff as an automatic Cargo entry. The Hull auto-generates a Mission debrief from the commit messages. The system is explicitly designed to work even if the agent never touches Bridge Controls — they're a nice-to-have enhancement, not a requirement.

**Agent goes into an infinite loop.** The agent keeps committing, modifying, reverting — burning tokens and time but never converging on a solution.

_Mitigation:_ The Mission timeout (default 15 min) is the primary guardrail. The token budget is the secondary guardrail. Additionally, the Hull can detect "churn" by monitoring git activity — if the agent has made more than N commits (default 20) without calling `completeMission`, the Sentinel flags it as "churning" and hails the Admiral. The Admiral can recall the Crewmate and re-scope the Mission.

**Agent modifies files outside its Sector.** A Crewmate deployed to the `api/` Sector starts editing files in `web/`. In a worktree this is somewhat constrained (the worktree only has its own checkout), but the Crewmate could still create files outside the expected paths.

_Mitigation:_ Since worktrees are full copies of the repo, the agent technically can touch any file. The Hull runs a post-Mission validation: `git diff --name-only` against the base branch, and checks that all modified files are within the Sector's `root_path`. If out-of-scope files are modified, the Hull flags it in the PR description ("⚠️ Changes outside Sector boundary") and the Admiral warns you. This is a soft guardrail — sometimes cross-Sector changes are intentional (shared config files, root-level configs).

**Agent runs destructive commands.** `rm -rf`, `git reset --hard`, `DROP TABLE`, etc. — an agent could damage the worktree or external resources.

_Mitigation:_ Worktree isolation is the primary defense — the agent can't damage the main checkout or other Crewmates' worktrees. For truly destructive commands (deleting the database, hitting production APIs), Fleet doesn't try to sandbox at the OS level — that's not practical for coding agents that need full shell access. Instead, the Admiral should scope Missions to minimize blast radius, and the worktree + PR flow means no destructive changes reach the base branch without review.

### Network & External Service Failures

**Network goes down mid-Mission.** The agent might need to install packages, access APIs, or push to the remote. Network failure can strand a Crewmate.

_Mitigation:_ Package installs happen at worktree setup time (before the agent starts), so network issues there are caught by the Hull's install timeout. During the Mission itself, network failures are the agent's problem — most coding agents handle this gracefully (they retry or work offline). For the push at Mission completion, the Hull's retry logic with "push-pending" status handles it. The Admiral can batch-retry all pending pushes when network returns.

**GitHub API rate limiting.** Creating many PRs in quick succession (e.g., 5 Crewmates all completing around the same time) can hit GitHub's API rate limit.

_Mitigation:_ The Hull reads rate limit headers from `gh` CLI output. When approaching the limit, it spaces out PR creation with increasing delays. A simple token bucket at the Starbase level ensures no more than N PR operations per minute (default 10). PRs that couldn't be created are queued and retried when the rate limit window resets. The Admiral reports: "3 PRs created, 2 queued due to rate limiting — will retry in {N} minutes."

**Remote repo becomes unavailable.** GitHub/GitLab is down, or the repo was deleted/moved.

_Mitigation:_ Same as push failure — branch is preserved locally, Mission marked as "push-pending." The Hull periodically retries (every 5 minutes for the first hour, then hourly). If the remote is consistently unreachable for more than 24 hours, the Mission is marked as "push-failed" and the Admiral alerts you. The code is safe in the local worktree and can be manually recovered.

### System Resource Failures

**Disk fills up completely.** Worktrees, node_modules, agent outputs, and the database itself all consume disk. A full disk can cause cascading failures — git can't commit, SQLite can't write, agents crash.

_Mitigation:_ The disk budget system (`worktree_disk_budget_gb`) is the first line of defense. Additionally, the Sentinel runs a periodic disk check (every 60 seconds) on `~/.fleet/worktrees/` and the database directory. Warning at 90% disk usage, hard stop at 95% — no new Crew deployments, Admiral is hailed with "disk critical." The Admiral can recall idle Crew and clean up completed worktrees to free space. The startup reconciliation aggressively cleans stale worktrees on launch.

**Memory exhaustion.** Too many concurrent agents (each with their own node process, potentially running language servers, etc.) can exhaust system memory. The OOM killer starts terminating processes randomly.

_Mitigation:_ The worktree limit (default 5) implicitly caps concurrent agents. The Admiral should also factor in system resources when deciding how many Crew to deploy in parallel. Fleet can read system memory stats (`os.freemem()` in Node) and the Admiral can gate deployments: "Only 2GB free memory — deploying 1 Crewmate instead of 3, queuing the rest." The Config panel can add a `max_concurrent_crew` global setting as an additional hard cap independent of worktree limits.

**Fleet app crashes while agents are running.** Electron crashes, gets force-quit, or the machine reboots. Hull processes (which are child processes of Fleet) die with it. Agents running in PTYs may or may not survive depending on how the PTY was set up.

_Mitigation:_ The startup reconciliation pass is specifically designed for this. On relaunch, Fleet checks all "active" Crew in the database against running PIDs. Dead ones get marked "lost." Worktrees with uncommitted work are preserved (not cleaned up) so you can recover the code. The Admiral offers to redeploy lost Missions: "Found 2 lost Crew from last session. Crewmate auth-crew-a3f8 had 3 commits on branch crew/auth-crew-a3f8. Redeploy or recover manually?" Branches are never deleted during crash recovery — only during explicit cleanup.

### Supply Route & Cross-Sector Failures

**Circular dependencies in Supply Routes.** User accidentally tells the Admiral "api depends on web" and "web depends on api." This creates a cycle that could cause infinite Cargo forwarding or Mission deadlocks.

_Mitigation:_ When adding a Supply Route, the `addSupplyRoute` Bridge Control runs a cycle detection check (simple DFS on the supply_routes graph). If a cycle would be created, the route is rejected with an explanation: "Can't add this Supply Route — it would create a circular dependency: api → web → api." The Config panel shows the dependency graph visually so you can spot issues.

**Cargo forwarded to a Sector with no active Crew.** An API Crewmate produces Cargo that should go to the web Sector via a Supply Route, but no web Crewmate is currently deployed.

_Mitigation:_ The Cargo is stored in the cargo table regardless. When a web Crewmate is eventually deployed, the Admiral checks for undelivered Cargo on that Sector's Supply Routes and includes it in the Mission briefing. Cargo doesn't expire quickly (14-day default retention), so even if the downstream Sector isn't worked on for a while, the context is preserved.

**Stale Cargo from a failed Mission gets forwarded.** A Crewmate crashes mid-Mission, producing partial or incorrect Cargo. The Supply Route system forwards this stale Cargo to downstream Sectors, which then build on a broken foundation.

_Mitigation:_ Cargo produced by Crewmates whose Mission status is "error," "lost," or "timeout" is tagged as `unverified` in the cargo table. When the Admiral forwards Cargo along Supply Routes, it includes the source Mission status: "⚠️ This Cargo came from a failed Mission — verify before using." The Admiral can also choose not to forward Cargo from failed Missions at all (configurable: `forward_failed_cargo: false`).

**Sector directory moved or deleted while Crew is active.** The user renames or deletes a directory that's registered as a Sector while Crewmates are deployed there.

_Mitigation:_ The Sentinel periodically validates Sector paths (check that `root_path` exists and is a directory). If a Sector path goes missing, the Sentinel marks all Crew in that Sector as "lost," hails the Admiral, and disables the Sector in the registry. The Admiral reports: "Sector 'api' path no longer exists at /projects/api. 2 Crew recalled. Update the Sector path in Config or remove it." Worktrees are unaffected (they're in `~/.fleet/worktrees/`, not in the Sector directory) but they can't be merged back since the base repo is gone.

### Config & State Failures

**Config changes while agents are running.** User changes the Mission timeout from 15 minutes to 5 minutes while a Crewmate has been running for 10 minutes. Should the Crewmate be killed?

_Mitigation:_ Config changes apply to **new** deployments only — they don't retroactively affect running Crew. The Sentinel uses the `deadline` value stored in the crew table row (set at deploy time), not the live config value. The Config panel shows a note: "Changes apply to new Missions. Running Crew keep their original settings." Exception: Lifesign interval/timeout changes apply immediately since those are checked by the Sentinel sweep, not per-Crewmate.

**User manually edits the SQLite database.** Someone opens the `.db` file in a SQLite browser and modifies rows directly, putting the state out of sync with reality (e.g., marking a running Crewmate as "complete").

_Mitigation:_ Fleet can't prevent this, but the Sentinel reconciliation provides self-healing. If a Crewmate is marked "complete" in the database but its PID is still alive, the Sentinel detects the mismatch and restores the status to "active." The Ship's Log records: "Crewmate status was externally modified — reconciled back to active." For truly corrupted states, the startup reconciliation is the catch-all reset.

**Index.json gets corrupted or deleted.** The workspace-to-Starbase mapping is lost, so Fleet can't find the database for an existing workspace.

_Mitigation:_ Fleet can reconstruct the index by scanning the `~/.fleet/starbases/` directory. Each database file name contains the Starbase ID, and the database itself stores the workspace path in a `_meta` table (added during creation). Fleet rebuilds the index from the database contents. If the database doesn't store the path (older schema), Fleet creates a new Starbase — you lose the history but can re-register Sectors.

**Multiple Fleet instances open the same Starbase.** A user opens two Fleet windows pointing at the same workspace. Both try to manage the same database and deploy Crew.

_Mitigation:_ SQLite with WAL handles concurrent reads fine, and the busy timeout handles write contention. But two Admirals managing the same Starbase would create confusion (duplicate deployments, conflicting directives). Fleet detects this via a lockfile (`starbase-{id}.lock`) in the starbases directory. If the lock is held, the second instance opens the Starbase in read-only mode — you can view status but can't deploy Crew or issue directives. The UI shows: "This Starbase is managed by another Fleet instance."

### Edge Cases

**Mission dependency deadlock.** Mission B depends on Mission A, but Mission A is assigned to a Crewmate that's stuck in "hailing" status waiting for input. Mission B can never start.

_Mitigation:_ The Sentinel monitors the Mission dependency graph. If a Mission has been in "active" status with a "hailing" Crewmate for longer than 2x the Mission timeout, the Sentinel escalates to the Admiral: "Mission A is blocking Mission B and has been hailing for {N} minutes. Resolve the hail or abort Mission A?" The Missions sub-tab visually highlights blocked dependency chains.

**Admiral itself fails or gets stuck.** The Admiral is an AI agent too — it can hallucinate, get confused, or go off-track just like any Crewmate. But there's no higher-level agent to catch it.

_Mitigation:_ The Admiral is not autonomous — it only acts in response to your directives or Crew hailing requests. It doesn't self-deploy Crew or make decisions without your initiation (except for pre-authorized automation like "auto-deploy the next Mission when one completes"). All Admiral actions are logged to the Ship's Log for review. If the Admiral seems confused, you can restart it (new Claude session) without affecting running Crew — the database is the source of truth, not the Admiral's conversation context. On restart, the Admiral reads the current Starbase state from the database and resumes.

**Token budget tracking is inaccurate.** Different agents report token usage differently (or not at all). The Hull's token monitoring depends on parsing agent output, which is fragile.

_Mitigation:_ Token budgets are a soft guardrail, not a hard limit. The Hull uses best-effort parsing — for Claude Code it reads the token usage lines from stdout; for other agents it may not be able to track tokens at all. The Mission timeout is the reliable hard limit. Token tracking is marked as "estimated" in the UI, and agents that don't report tokens show "N/A" instead of 0.

### Failure Mode Summary

| Category     | Failure                   | Severity | Primary Mitigation                                            |
| ------------ | ------------------------- | -------- | ------------------------------------------------------------- |
| Worktree     | Creation fails            | Medium   | Pre-flight checks, branch suffix, fallback to direct dir      |
| Worktree     | Package install hangs     | Medium   | Hard timeout, retry, symlink fallback                         |
| Worktree     | Cleanup fails             | Low      | Force remove, startup prune sweep                             |
| Worktree     | Pool staleness            | Low      | Refresh sequence, age-based eviction                          |
| Git          | Push fails                | High     | Retry with backoff, "push-pending" status, local preservation |
| Git          | PR creation fails         | Medium   | Fallback to branch-only, rate limit awareness                 |
| Git          | Branch collision          | Low      | Random suffix, local+remote check                             |
| Git          | Agent force-push          | Medium   | Git config restrictions, branch protection                    |
| Git          | Rebase conflicts          | Medium   | Draft PR, hail Admiral, rebase Crewmate                       |
| Database     | Corruption                | High     | Integrity check, recovery, backup snapshots                   |
| Database     | Unbounded growth          | Medium   | Retention policies, VACUUM, size monitoring                   |
| Database     | Locked by zombie          | Low      | WAL mode, busy timeout, zombie cleanup                        |
| Database     | Schema migration          | Medium   | Versioned additive migrations, transactions                   |
| Agent        | Never starts              | Medium   | Startup timeout, non-interactive flags                        |
| Agent        | Ignores MCP tools         | Low      | Hull tracks lifecycle independently                           |
| Agent        | Infinite loop             | Medium   | Mission timeout, token budget, churn detection                |
| Agent        | Out-of-scope edits        | Low      | Post-Mission diff validation, PR warning                      |
| Agent        | Destructive commands      | Medium   | Worktree isolation, PR review gate                            |
| Network      | Network down              | Medium   | Retry with backoff, push-pending queue                        |
| Network      | GitHub rate limit         | Low      | Token bucket, queued PR creation                              |
| Network      | Remote unavailable        | Medium   | Local preservation, periodic retry                            |
| System       | Disk full                 | High     | Disk budget, Sentinel checks, hard stop at 95%                |
| System       | Memory exhaustion         | High     | Worktree/crew limits, memory-gated deployments                |
| System       | Fleet crash               | High     | Startup reconciliation, branch preservation                   |
| Supply Route | Circular deps             | Low      | Cycle detection on route creation                             |
| Supply Route | No downstream Crew        | Low      | Cargo stored, delivered when Crew deploys                     |
| Supply Route | Stale Cargo forwarded     | Medium   | Tag unverified, include source Mission status                 |
| Supply Route | Sector path missing       | Medium   | Sentinel path validation, auto-disable                        |
| Config       | Mid-flight changes        | Low      | New deployments only, exception for Sentinel settings         |
| Config       | Manual DB edits           | Low      | Sentinel reconciliation, Ship's Log audit                     |
| Config       | Index corruption          | Low      | Reconstruct from database \_meta table                        |
| Config       | Duplicate instances       | Medium   | Lockfile, read-only mode for second instance                  |
| Edge         | Dependency deadlock       | Medium   | Sentinel monitors dependency graph, escalation timer          |
| Edge         | Admiral failure           | Low      | Stateless restart from database, Ship's Log audit             |
| Edge         | Token tracking inaccurate | Low      | Soft guardrail, Mission timeout as hard limit                 |

## Visual Design

The Star Command tab renders a split view: the top portion is a live pixel art visualizer, the bottom is the terminal where you talk to the Admiral.

### Art Style

16-bit pixel art, retro game aesthetic. Color palette: deep navy, teal, cyan, amber, soft red, and white accents. All assets generated via fal.ai with a consistent style prefix. Post-processing in Aseprite/Piskel for pixel-perfect cleanup.

Full asset prompt list is in `star-command-asset-prompts.md`.

### Space Station Scene

The centerpiece is a pixel art space station (the Starbase) floating in deep space with a twinkling starfield background. The station has a circular rotating ring, central hub module (the Bridge), docking arms, solar panel wings, and teal-glowing windows. It slowly rotates via an 8-frame sprite animation.

The station ring is divided into Sectors — one per Sector in the Starbase. Each Sector section is subtly labeled with the Sector name and has its own cluster of pod slots. This means you can visually see at a glance which Sector has the most activity, which has idle pods, and which has errors. Sectors with no Crew have empty dark sections. As you register more Sectors, new sections appear on the ring.

Each Crewmate is represented as a pod module attached to their Sector's section of the ring. Pods have three visual states: occupied (teal glow), empty (dark/grey), and error (red flicker with sparks). When a new Crewmate is deployed, a shuttle docking animation plays — a small ship approaches and docks at a port in the appropriate Sector section. When a Crewmate completes their Mission, the shuttle undocks and departs.

Cross-Sector Comms are visualized as data beams that arc across the station ring from one Sector section to another, following the Supply Routes.

### Pod Status Animations

| Crew Status | Pod Visual                                         |
| ----------- | -------------------------------------------------- |
| Active      | Teal window glow pulsing, data stream from antenna |
| Hailing     | Amber window glow, flashing warning beacon         |
| Error       | Red flicker, sparks and venting gas                |
| Idle        | Dim teal, no antenna activity                      |
| Complete    | Green flash, checkmark hologram, calm green glow   |
| Lost        | Hull sparks, gas vent, optional small explosion    |

### Comms Visuals

When a Crewmate hails Star Command, a glowing teal data orb travels along a beam line from the pod to the Bridge (central hub). When the Admiral sends a directive back, an amber orb travels the other way. Active Comms links show as thin laser-like beams with pulses traveling along them. Cross-Sector Cargo transfers show as larger orbs traveling the Supply Route arcs.

### Avatars

The Admiral and each Crew variant have 64x64 pixel art portrait avatars shown in the tab sidebar and Comms feed. The Admiral is a sci-fi commander character with a long dark coat, high collar, and teal glowing headset. The Admiral portrait has state variants: default, speaking, thinking, alert, and standby.

Crew avatars come in five visual variants: hoodie dev, headphones dev, robot Crewmate, cap dev, and glasses dev. Each Crewmate gets randomly assigned a variant when deployed, providing visual distinction in the sidebar and Comms feed.

A Star Command logo (five-pointed star with circuit traces) serves as the tab icon at 32x32 and 16x16 sizes.

### Particle Effects

Supporting effects for the scene: thruster flames for shuttle docking/undocking, docking sparkles on connection, hull sparks on errors, gas venting on Crew loss, and small contained explosions for critical pod failures. These are **one-shot canvas effects** — they play for 1-2 seconds when triggered by a state change and then the canvas loop stops entirely. They are not persistent. See "Rendering Philosophy" in Implementation Notes for the performance model.

Data stream visuals on active Comms lines and Supply Route arcs are CSS-animated (pulsing `background-position` on a repeating dot pattern), not canvas particles — they can run indefinitely without JS cost.

### UI Chrome

The terminal portion has a pixel art CRT border frame with scanline styling. A status bar with dark metal texture and rivets sits between the visualizer and terminal. Crew status chips (rounded badges with colored dot indicators) provide at-a-glance status grouped by Sector across the top.

### Star Command Sub-Tabs

The Star Command tab has sub-tabs along its top edge for switching between different views. The sub-tabs keep everything scoped to Star Command without cluttering the main tab sidebar.

**Bridge (default)** — The main view: pixel art visualizer on top, Admiral terminal on the bottom. This is where you talk to the Admiral and watch the Starbase.

**Comms Log** — Scrollable feed of all Transmissions across the Starbase, filterable by Sector, Crewmate, or Transmission type. Shows the full conversation history between Crew and the Admiral. Each Transmission has the sender's avatar, timestamp, and a badge for its type (hailing, directive, cargo_manifest, etc.).

**Missions** — Table view of all Missions across the Starbase. Columns: Sector, summary, status, assigned Crewmate, priority, PR link (if created), duration. Filterable by Sector and status. You can drag to reorder priority, click to expand the full Mission briefing, and right-click to abort or reassign.

**Ship's Log** — The audit trail. Chronological list of all events across the Starbase — deployments, completions, errors, Lifesign losses, Comms failures. Useful for debugging when something went wrong. Filterable by Crewmate and event type.

**Config** — Starbase configuration panel. All settings from the `starbase_config` table, organized into sections with sensible defaults. Changes take effect immediately and are persisted to the database.

Config panel sections:

**Worktrees**

- Max concurrent worktrees (default: 5, range: 1-20)
- Worktree pool size per Sector (default: 2, range: 0-10)
- Disk budget in GB (default: 5)
- Symlink node_modules toggle (default: off)

**Missions**

- Default Mission timeout in minutes (default: 15, range: 5-60)
- Default merge strategy dropdown: PR / Auto-merge / Branch-only

**Crew**

- Default token budget per Crewmate (default: 0 = unlimited)
- Comms rate limit per minute (default: 30)

**Sentinel**

- Lifesign interval in seconds (default: 10, range: 5-60)
- Lifesign timeout in seconds (default: 30, range: 10-120)

**Sectors** — Per-Sector overrides. A list of all registered Sectors, each expandable to configure:

- Merge strategy override
- Base branch override
- Worktree enabled toggle
- Custom Mission timeout
- Max concurrent Crew for this Sector

The Config panel uses the same pixel art styling as the rest of Star Command — dark navy backgrounds, teal input borders, amber for validation warnings. Toggle switches use the pod glow style (teal = on, grey = off). Dropdowns have a CRT-style frame. Keeps the whole tab cohesive.

## Example Workflow

### Setting Up

1. You open Fleet and point it at your workspace. Star Command tab is pinned at the top, showing the station floating in a starfield with no Sectors yet.

2. You open the Config sub-tab and add three Sectors: `api/` (Node/Express backend), `web/` (React frontend), and `docs/` (documentation site). For each one you pick the directory, give it a name, and confirm. Stack is auto-detected from the project markers in each directory.

3. While you're in Config, you tell the Admiral "web depends on api" and it establishes a Supply Route. The station visualizer now shows three labeled Sector sections on the ring, connected by a faint Supply Route arc.

### Mission Loading

4. You front-load Missions: "For the API Sector, I need to add rate limiting and update the OpenAPI spec. For the web Sector, migrate the auth flow to the new API endpoints. For docs, regenerate the API reference."

5. The Admiral queues five Missions across three Sectors. It understands the dependency chain — the web migration depends on the API rate limiting Mission completing first, and the docs regeneration depends on the OpenAPI spec Mission.

### Execution

6. The Admiral deploys two Crewmates in parallel to the API Sector (rate limiting + OpenAPI spec). Two shuttle docking animations play. Two pods light up on the API Sector section of the ring.

7. The rate limiting Crewmate starts hailing — its pod shifts to amber. A teal data orb flies to the Bridge. The Admiral relays: "Redis or in-memory for the rate limit store?" You answer "in-memory for now." An amber orb flies back.

8. The OpenAPI spec Crewmate completes their Mission first. The Hull pushes branch `crew/openapi-spec-1` to origin and creates PR #14 with the Mission debrief. Pod flashes green. The Admiral sees the docs Sector has a Mission waiting on this — it auto-deploys a Crewmate to docs. A new shuttle docks on the docs Sector section.

9. The rate limiting Crewmate completes. Hull pushes `crew/rate-limit-1`, creates PR #15. The Admiral checks the Supply Routes — the web Sector's auth migration was waiting on this. It deploys a web Crewmate, forwarding the new rate limit headers as Cargo from the API Crewmate. A shuttle docks on the web Sector section.

10. The web Crewmate produces Cargo: the updated API client types. Hull pushes `crew/auth-migration-1`, creates PR #16 with a "depends on #15" reference. The Admiral notices this Cargo is relevant to the docs Sector too via the Supply Route, but the docs Crewmate is already active — it forwards the Cargo as a Transmission.

11. All Crew complete their Missions. Five PRs are open, labeled by Sector and Mission. The Admiral summarizes: "API Sector: PR #14 (OpenAPI spec) and PR #15 (rate limiting). Web Sector: PR #16 (auth migration, depends on #15). Docs Sector: PR #17 (API reference). All 5 Missions completed across 3 Sectors. Ready for review or I can batch-merge the chain."

## Implementation Notes

### Stack Integration

Star Command runs within Fleet's existing Electron + React + xterm.js stack. The visualizer is a React component that renders the pixel art scene. The terminal is a standard xterm.js instance below it. Data flows from the SQLite database through Electron IPC to the React renderer.

### Rendering Philosophy — Zero Idle Cost

The visualizer must run all day without eating CPU or battery. The core principle: **nothing animates unless something changed.** Star Command is not a game — it's a status display with occasional transitions. Most of the time, the station is just sitting there and nothing is happening.

**No `requestAnimationFrame` loop.** A constant 60fps RAF loop burns CPU even when every pixel is identical to the last frame. Instead, the visualizer is event-driven — it only repaints when state changes.

### CSS Sprite Animations (Primary)

Most animations are **CSS-driven**, not canvas-driven. CSS animations run on the compositor thread, get GPU-accelerated for free, and cost essentially zero CPU when idle.

**Station rotation.** The 8-frame rotation is a CSS `steps(8)` animation on a sprite sheet background. One DOM element, one `background-position` animation, runs entirely on the GPU. No JS involved.

```css
.station {
  background: url('station-spritesheet.png');
  animation: rotate 4s steps(8) infinite;
  image-rendering: pixelated;
}
@keyframes rotate {
  to {
    background-position: -2560px 0;
  } /* 8 frames × 320px */
}
```

**Pod glow pulsing.** CSS `opacity` animation with `steps()` for pixel-art feel. Each pod is an absolutely positioned `<div>` with a sprite background. Status change swaps the CSS class — the browser handles the rest.

**Starfield twinkling.** A handful of `<div>` elements with a CSS `opacity` animation at different `animation-delay` values. No per-frame JS calculation.

**Data orb travel.** CSS `translate` animation along a path using `offset-path` (CSS Motion Path). The orb element is created on Comms events, animates to its destination, then is removed from the DOM. JS only fires to create/destroy the element — the actual animation is CSS.

**Beacon flashing (hailing).** CSS `background-color` alternation with `steps(2)`. Toggle on when status is "hailing," toggle off when resolved.

### Canvas for Complex One-Shot Effects Only

Canvas is reserved for effects that CSS can't handle — specifically, particle effects (sparks, gas vents, explosions) that involve many short-lived random elements. Even these use a **one-shot pattern**, not a persistent loop:

```typescript
function playSparkEffect(x: number, y: number) {
  const canvas = effectCanvasRef.current;
  const ctx = canvas.getContext('2d');
  const particles: Particle[] = createSparkParticles(x, y);

  let frameId: number;
  const animate = () => {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    let alive = false;
    for (const p of particles) {
      p.update();
      if (p.life > 0) {
        p.draw(ctx);
        alive = true;
      }
    }
    if (alive) {
      frameId = requestAnimationFrame(animate);
    } else {
      // Effect done — stop the loop entirely
      cancelAnimationFrame(frameId);
      ctx.clearRect(0, 0, canvas.width, canvas.height);
    }
  };
  frameId = requestAnimationFrame(animate);
}
```

The RAF loop starts when a particle effect triggers (error, explosion, docking sparkle) and **stops itself** when all particles are dead. Between effects, the canvas is completely idle — zero CPU. Most of the time, no particle effects are playing and the canvas loop isn't running at all.

### Visibility-Aware Throttling

When the Star Command tab isn't visible, animations should cost exactly zero.

**Tab not focused.** When the user switches to another Fleet tab, the visualizer pauses all CSS animations (`animation-play-state: paused`) and skips any canvas effects. The `IntersectionObserver` API detects when the visualizer element leaves the viewport. On return, animations resume from where they left off — no jarring resets.

**Window minimized or hidden.** Electron's `BrowserWindow` emits `hide`/`minimize` events. The renderer listens for these and sets a global `isVisible` flag. All animation triggers check this flag before starting. Additionally, `document.visibilitychange` catches the browser-level hidden state. When hidden, the data polling interval from the database also slows down (from every 2 seconds to every 30 seconds) since there's no UI to update.

**Window unfocused but visible.** If Fleet is in the background but the window is still partially visible (e.g., tiled next to another app), animations continue but at reduced fidelity. The station rotation slows from 4s to 8s per cycle, and particle effects are skipped entirely. Comms orbs still animate since they carry meaningful status information.

### Low-Power Mode

Fleet detects battery status via `navigator.getBattery()` (where available). On battery with less than 20% charge, the visualizer enters low-power mode:

- Station rotation stops (static frame)
- Pod glow animations switch to static colors (no pulse)
- Particle effects are disabled entirely
- Data orbs are replaced with instant state changes (no travel animation)
- Database polling interval increases to 60 seconds

The Config panel has a toggle to force low-power mode regardless of battery state, useful for users who always want minimal resource usage.

### Sprite Assets

Assets are loaded as sprite sheets in PNG format. Sprite sizes: 320x180 for the full station scene, 64x64 for portraits/docking details, 32x32 for pods, 8x8 for icons/particles. All rendered with `image-rendering: pixelated` for crisp pixel art scaling. Sprite sheets are loaded once on tab mount and cached — no re-fetching.

### State Machine Per Element

Each visual element (pod, shuttle, data orb) has a simple state machine that maps database state → CSS class. When the database reports a Crew status change, the renderer updates the relevant element's class. The CSS handles the visual transition. No per-frame logic, no animation scheduling in JS — just `element.className = newState`.

```typescript
// Pod state machine — maps DB status to CSS class
const POD_CLASS: Record<CrewStatus, string> = {
  active: 'pod pod--active', // teal pulse animation
  hailing: 'pod pod--hailing', // amber flash animation
  error: 'pod pod--error', // red flicker + trigger spark effect
  idle: 'pod pod--idle', // static dim teal
  complete: 'pod pod--complete', // green glow + trigger undock
  lost: 'pod pod--lost' // trigger gas vent effect
};
```

### Memory Budget

The visualizer targets under **20MB** of memory for all sprite assets combined. At pixel art resolutions (320px wide scenes, 32px pods), sprite sheets are tiny — a full 8-frame station rotation at 320x180 is ~150KB as PNG. All 5 Crew avatar variants at 64x64 fit in ~30KB. The entire asset bundle should be under 2MB even with generous padding. No WebGL context is allocated — just 2D canvas for occasional particle effects and CSS for everything else.

### Performance Budget Summary

| Metric                         | Target        | How                                       |
| ------------------------------ | ------------- | ----------------------------------------- |
| CPU at idle (nothing changing) | ~0%           | No RAF loop, CSS animations on compositor |
| CPU during status change       | < 1% spike    | Class swap triggers CSS transition        |
| CPU during particle effect     | < 5% for < 2s | One-shot RAF, self-terminating            |
| Memory (all sprites)           | < 20MB        | Pixel art is tiny, PNG sprite sheets      |
| GPU                            | Minimal       | CSS compositor, no WebGL                  |
| Battery drain                  | Negligible    | Visibility throttling, low-power mode     |
| Hidden tab cost                | 0%            | All animations paused, polling slowed     |

### Database Location

Each Starbase's database (`starbase-{id}.db`) lives in `~/.fleet/starbases/`, not in the workspace root. SQLite is accessed via `better-sqlite3` from the Electron main process. The Subspace CLI resolves the current workspace path → Starbase ID via the index file, then opens the same database directly. No network, no sockets — just file-based SQLite. The Subspace CLI can also accept a `--starbase` flag to target a specific Starbase ID directly.

### Asset Generation

All pixel art assets are generated via fal.ai with a consistent style prefix to maintain visual coherence. See `star-command-asset-prompts.md` for the full prompt list. Assets are post-processed in Aseprite or Piskel for pixel-perfect alignment and exported as sprite sheets in PNG format.
