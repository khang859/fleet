# Star Command Phase 1: Database + Sector Registry

## Overview

Embedded SQLite database per Starbase with the full Star Command schema, plus Sector CRUD operations accessible from the main process. This is the pure data layer that everything else builds on.

## Architecture

### StarbaseDB (`src/main/starbase/db.ts`)

Manages the SQLite database lifecycle for a Starbase.

- Opens/creates `~/.fleet/starbases/starbase-{hash}.db` where `hash` is truncated sha256 of the workspace absolute path (6 chars)
- Maintains `~/.fleet/starbases/index.json` mapping workspace paths to Starbase IDs
- Configures pragmas on open: `journal_mode=WAL`, `synchronous=NORMAL`, `busy_timeout=5000`, `foreign_keys=ON`
- Runs sequential migrations on open (compares `_meta.schema_version` to expected version)
- Runs `PRAGMA integrity_check` on startup; if corrupt, moves to `.db.corrupt` and creates fresh
- Stores workspace path in `_meta` table for index reconstruction

**Constructor:** Takes a workspace path, derives the Starbase ID, opens or creates the database.

**Public API:**
- `open()` — Open DB, run migrations, return ready instance
- `close()` — Close the database connection
- `getDb()` — Return the raw `better-sqlite3` instance for service classes
- `getStarbaseId()` — Return the derived ID

### Schema Migrations (`src/main/starbase/migrations/`)

Each migration is a `.sql` file named `001-initial.sql`, `002-foo.sql`, etc. Migration files are discovered at runtime via a hardcoded ordered array in the migration runner (not glob). Each migration is wrapped in a transaction — if it fails, the transaction rolls back and the database stays at the previous version.

The migration runner reads `schema_version` from `_meta`, runs all migrations with a higher number, then updates `schema_version`. On a fresh database, `_meta` is created by the runner itself before running `001-initial.sql`.

The first migration creates all tables:

**`_meta` table** — Always exactly one row. schema_version (INTEGER), workspace_path (TEXT), created_at (DATETIME)

**`sectors` table** — id (TEXT PK), name (TEXT), root_path (TEXT UNIQUE), stack (TEXT), description (TEXT), base_branch (TEXT DEFAULT 'main'), merge_strategy (TEXT DEFAULT 'pr'), verify_command (TEXT), lint_command (TEXT), review_mode (TEXT DEFAULT 'admiral-review'), worktree_enabled (BOOLEAN DEFAULT 1), created_at (DATETIME), updated_at (DATETIME)

*Note:* `base_branch`, `merge_strategy`, `verify_command`, `lint_command`, `review_mode`, and `worktree_enabled` are forward-compatible columns used by later phases. They are included in the initial migration to avoid schema changes later. `worktree_enabled` is an extension beyond the parent spec to allow per-Sector worktree opt-out (see Phase 4, Single-Crewmate Optimization).

**`supply_routes` table** — id (INTEGER PK AUTOINCREMENT), upstream_sector_id (TEXT FK), downstream_sector_id (TEXT FK), relationship (TEXT), created_at (DATETIME)

**`missions` table** — id (INTEGER PK AUTOINCREMENT), sector_id (TEXT FK), crew_id (TEXT FK nullable), summary (TEXT NOT NULL), prompt (TEXT NOT NULL), acceptance_criteria (TEXT), status (TEXT DEFAULT 'queued'), priority (INTEGER DEFAULT 0), depends_on_mission_id (INTEGER FK nullable), result (TEXT), verify_result (TEXT), review_verdict (TEXT), review_notes (TEXT), created_at (DATETIME), started_at (DATETIME), completed_at (DATETIME)

*Note:* `summary` and `prompt` are NOT NULL — intentional tightening over parent spec to enforce Mission quality. Valid statuses: "queued", "active", "completed", "failed", "failed-verification", "aborted", "push-pending", "pending-review". `acceptance_criteria`, `verify_result`, `review_verdict`, `review_notes` are forward-compatible columns used by Phase 5 Quality Gates.

**`crew` table** — id (TEXT PK), tab_id (TEXT), sector_id (TEXT FK), mission_id (INTEGER FK nullable), sector_path (TEXT), worktree_path (TEXT), worktree_branch (TEXT), status (TEXT DEFAULT 'active'), mission_summary (TEXT), avatar_variant (TEXT), pid (INTEGER), deadline (DATETIME), token_budget (INTEGER DEFAULT 0), tokens_used (INTEGER DEFAULT 0), last_lifesign (DATETIME), created_at (DATETIME), updated_at (DATETIME)

**`comms` table** — id (INTEGER PK AUTOINCREMENT), from_crew (TEXT), to_crew (TEXT), thread_id (TEXT), in_reply_to (INTEGER FK nullable), type (TEXT), payload (TEXT), read (BOOLEAN DEFAULT 0), created_at (DATETIME)

**`cargo` table** — id (INTEGER PK AUTOINCREMENT), crew_id (TEXT FK), mission_id (INTEGER FK nullable), sector_id (TEXT FK), type (TEXT), manifest (TEXT), verified (BOOLEAN DEFAULT 1), created_at (DATETIME)

*Note:* `verified` and `mission_id` are forward-compatible columns. `verified` is used in Phase 5 to tag Cargo from failed Missions. `mission_id` allows looking up Mission status when determining verification.

**`ships_log` table** — id (INTEGER PK AUTOINCREMENT), crew_id (TEXT), event_type (TEXT), detail (TEXT), created_at (DATETIME)

**`starbase_config` table** — key (TEXT PK), value (TEXT), updated_at (DATETIME)

Default config values seeded on creation:
- `max_concurrent_worktrees`: 5
- `worktree_pool_size`: 2
- `worktree_disk_budget_gb`: 5
- `default_mission_timeout_min`: 15
- `default_merge_strategy`: "pr"
- `comms_rate_limit_per_min`: 30
- `default_token_budget`: 0
- `lifesign_interval_sec`: 10
- `lifesign_timeout_sec`: 30
- `default_review_mode`: "admiral-review"
- `review_timeout_min`: 10

### SectorService (`src/main/starbase/sector-service.ts`)

CRUD operations for Sectors.

**Public API:**
- `addSector({ path, name?, description?, baseBranch?, mergeStrategy? })` — `path` is relative to the workspace root (e.g. `services/auth`); resolved to an absolute path using the workspace root for storage in `root_path`. Validates directory exists and contains at least one file, isn't already registered (checked via `root_path` UNIQUE constraint). Auto-detects stack from project markers (package.json → typescript/node, go.mod → go, Cargo.toml → rust, requirements.txt/pyproject.toml → python, Gemfile → ruby). Generates slug ID from directory basename, lowercased, non-alphanumeric replaced with hyphens. On collision (e.g. two `api` directories), appends parent directory as prefix: `services-api`. Returns the created Sector. Throws `SectorValidationError` with a descriptive message on failure (directory missing, already registered, etc.).
- `removeSector(sectorId)` — Deregisters the Sector. Does NOT delete files. In later phases, this must be extended to recall active Crew first.
- `updateSector(sectorId, fields)` — Update any editable field.
- `getSector(sectorId)` — Get a single Sector by ID.
- `listSectors()` — List all registered Sectors.

### ConfigService (`src/main/starbase/config-service.ts`)

Key-value config store backed by `starbase_config` table.

**Defaults:** A hardcoded `CONFIG_DEFAULTS` constant object (typed as `Record<string, unknown>`) in the source file defines all default values. Defaults are INSERT-ed as rows during initial migration. This means `getAll()` always returns rows from the table. Future Fleet versions that add new defaults use migrations to INSERT them.

**Public API:**
- `get(key)` — Returns the JSON-parsed value from the table. Falls back to `CONFIG_DEFAULTS[key]` if the row doesn't exist (defensive, since migrations should have seeded it).
- `set(key, value)` — JSON-stringifies and stores the value via `INSERT OR REPLACE`, updates timestamp.
- `getAll()` — Returns all config rows merged with `CONFIG_DEFAULTS` as a typed object.

### IPC + Socket Integration

New IPC handlers registered in `ipc-handlers.ts`:
- `starbase:list-sectors` → `sectorService.listSectors()`
- `starbase:add-sector` → `sectorService.addSector()`
- `starbase:remove-sector` → `sectorService.removeSector()`
- `starbase:update-sector` → `sectorService.updateSector()`
- `starbase:get-config` → `configService.getAll()`
- `starbase:set-config` → `configService.set()`

Socket commands via existing SocketApi:
- `{ type: "sectors" }` → list Sectors
- `{ type: "add-sector", path, name?, description? }` → add Sector
- `{ type: "config-get" }` → get all config (returns full config object)
- `{ type: "config-get", key: "foo" }` → get single key (returns `{ key, value }`)
- `{ type: "config-set", key: "foo", value: 5 }` → set key, returns `{ ok: true }`

### Error Handling

- **`better-sqlite3` load failure:** If the native module fails to load (platform issue, missing binary), `StarbaseDB.open()` throws with a descriptive error. The caller (main process startup) should catch this and disable all Star Command features, showing a warning in the UI: "Star Command unavailable: SQLite failed to load."
- **Concurrent `index.json` access:** Use atomic write (write to temp file, rename) to prevent corruption from concurrent Fleet instances writing different workspace entries. Read-modify-write is protected by the OS-level rename atomicity.
- **Workspace path moved:** On `open()`, if the `index.json` entry points to a database that exists, but the `_meta.workspace_path` doesn't match the current workspace path, update both the `_meta` row and the `index.json` entry. This handles moved project directories gracefully.

### Dependencies

- Add `better-sqlite3` and `@types/better-sqlite3` to the project.

## What Is NOT Built

- Any UI for Sectors or Config
- Hull, worktrees, Crew lifecycle
- Admiral, Star Command tab
- Comms, Cargo operations
- Visualizer changes

## Tests

- **StarbaseDB:** Open, migrate, integrity check, index.json management, corrupt DB recovery
- **SectorService:** Add (valid + invalid paths), remove, update, list, stack auto-detection, duplicate rejection
- **ConfigService:** Get with defaults, set, getAll with merged defaults
- **Migrations:** Verify all tables created with correct columns
