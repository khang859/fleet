# Research Missions & Cargo Documentation Output

## Problem

Crews deployed for non-code tasks (documentation, code review, investigation, research) produce no git commits. The current Hull cleanup logic treats "no changes" as a failure, marking these missions as `failed` with "No work produced" and setting crew status to `error` — even though the work completed successfully.

## Solution

Add an explicit mission `type` column and a research-specific exit path in the Hull that produces cargo artifacts instead of expecting git changes.

## Design

### 1. Database Migration

Add `type TEXT DEFAULT 'code'` to the `missions` table.

```sql
ALTER TABLE missions ADD COLUMN type TEXT DEFAULT 'code';
```

Existing rows default to `'code'`. No backfill needed. The column is a free-form string to support future mission types without additional migrations.

### 2. Mission Service

`MissionService.createMission()` accepts an optional `type` parameter (defaults to `'code'`). The type is stored in the `missions` table and later read by the Hull.

### 3. Crew Service

Pass two new fields through to `HullOpts`:
- `starbaseId: string` — already available in `CrewServiceDeps`, needed for cargo file paths
- `missionType: string` — read from the mission row after creation

`CrewServiceDeps` gains a `starbaseId` field, set from `starbaseDb.getStarbaseId()` in `index.ts`.

### 4. Hull Cleanup — Research Branch

In `cleanup()`, after the auto-commit step and the `hasChanges` check, add a branch for research missions:

**When `missionType === 'research'` and `!hasChanges` and `status !== 'aborted'`:**

1. Write cargo files to `~/.fleet/starbases/starbase-<starbaseId>/cargo/<sectorId>/<missionId>/`:
   - `full-output.md` — complete output buffer (`this.outputLines.join('\n')`)
   - `summary.md` — tail of output buffer or result message (concise version)

2. Insert two `cargo` DB records:
   - `type: 'documentation_full'`, `manifest` = JSON with file path
   - `type: 'documentation_summary'`, `manifest` = JSON with file path

3. Update mission: `status = 'completed'`, `result = 'Research completed'`
   - If output buffer is empty: `result = 'Research completed (no output captured)'`

4. Send `mission_complete` comms to admiral:
   ```json
   {
     "missionId": 123,
     "status": "completed",
     "reason": "Research completed",
     "cargoProduced": true
   }
   ```

5. Log exit in `ships_log`

6. Skip push, PR, verification, and lint entirely

7. Clean up worktree normally

8. Return early (same pattern as existing `!hasChanges` early return)

**When `missionType === 'research'` and `hasChanges`:** Proceed through normal code flow — a research crew that produces commits still gets push/PR/verification.

**When `missionType === 'code'` and `!hasChanges`:** Existing behavior (mark failed/error).

### 5. Cargo File Storage

Cargo files are written using raw SQL inserts (consistent with how Hull handles comms, ships_log, and mission updates). No `CargoService` dependency added to Hull.

Directory structure:
```
~/.fleet/starbases/starbase-{id}/cargo/{sectorId}/{missionId}/
  full-output.md
  summary.md
```

The `manifest` column in the cargo DB record stores a JSON blob with the file path:
```json
{ "path": "~/.fleet/starbases/starbase-abc123/cargo/api/42/full-output.md" }
```

### 6. Error Handling

| Scenario | Behavior |
|----------|----------|
| Research crew exits non-zero (crash) | Still marked `error` — crash is a crash regardless of type |
| Research crew produces commits | Normal code flow (push/PR/verify) |
| Research crew produces no output text | Mark `completed` with note, create cargo with empty content |
| Cargo file write fails (disk/permissions) | Non-fatal, log error, mark mission `completed`, store content in DB manifest as fallback |

## Files Changed

| File | Change |
|------|--------|
| `src/main/starbase/migrations.ts` | New migration adding `type` column to missions |
| `src/main/starbase/mission-service.ts` | Accept `type` param on creation |
| `src/main/starbase/hull.ts` | Add `missionType` + `starbaseId` to `HullOpts`, research branch in cleanup |
| `src/main/starbase/crew-service.ts` | Pass `starbaseId` and mission type to Hull |
| `src/main/index.ts` | Pass `starbaseId` to `CrewServiceDeps` |

## Not Changed

- `cargo-service.ts` — Hull uses raw SQL (existing pattern)
- Sector config — mission type is per-mission, not per-sector
- Supply routes — cargo flows through existing mechanisms once produced
- Comms protocol — uses existing `mission_complete` type with added `cargoProduced` flag
