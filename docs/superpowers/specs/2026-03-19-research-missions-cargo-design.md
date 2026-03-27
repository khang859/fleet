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

`MissionService.addMission()` accepts an optional `type` parameter (defaults to `'code'`). The type is stored in the `missions` table.

Changes:

- Add `type?: string` to `AddMissionOpts`
- Add `type: string` to `MissionRow`
- Include `type` in the `INSERT` statement (defaulting to `opts.type ?? 'code'`)

### 3. Call Sites

Two call sites create missions and must forward the `type` parameter:

1. **`socket-server.ts`** — `mission.create` command: forward `args.type` to `addMission()`
2. **`crew-service.ts`** — `deployCrew()`: add `type?: string` to the opts parameter, forward to `addMission()` when creating inline missions

For pre-created missions (when `deployCrew` receives `missionId`), the type is read back from the mission row via `missionService.getMission()`.

### 4. Crew Service → Hull Wiring

Pass two new fields to `HullOpts`:

- `missionType: string` — read from the mission row (either just-created or pre-existing)
- `starbaseId: string` — already available in `CrewServiceDeps` (no changes to deps or `index.ts`)

The crew service reads the mission type after mission creation/lookup:

```typescript
const mission = missionService.getMission(missionId)!;
// ... pass mission.type to Hull
```

### 5. Hull Cleanup — Research Branch

In `cleanup()`, after the auto-commit step and the `hasChanges` check (line 470), add a branch for research missions:

**When `missionType === 'research'` and `!hasChanges` and `status !== 'aborted'`:**

1. Set `overrideStatus = 'complete'` (so the `finally` block updates crew status correctly)

2. Write cargo files to `${process.env.HOME}/.fleet/starbases/starbase-<starbaseId>/cargo/<sectorId>/<missionId>/`:
   - `full-output.md` — complete output buffer (`this.outputLines.join('\n')`)
   - `summary.md` — last 20 lines of output buffer (a reasonable tail for quick reading)

3. Insert two `cargo` DB records (raw SQL, consistent with existing Hull pattern):
   - `type: 'documentation_full'`, `manifest` = JSON with absolute file path, `verified = 1`
   - `type: 'documentation_summary'`, `manifest` = JSON with absolute file path, `verified = 1`
   - `verified = 1` is correct because the mission is completed successfully

4. Update mission: `status = 'completed'`, `result = 'Research completed'`
   - If output buffer is empty: `result = 'Research completed (no output captured)'`

5. Send `mission_complete` comms to admiral:

   ```json
   {
     "missionId": 123,
     "status": "completed",
     "reason": "Research completed",
     "cargoProduced": true
   }
   ```

6. Log exit in `ships_log`

7. Return early — the `finally` block handles worktree cleanup and crew status update using `overrideStatus`

**When `missionType === 'research'` and `hasChanges`:** Proceed through normal code flow — a research crew that produces commits still gets push/PR/verification.

**When `missionType === 'code'` and `!hasChanges`:** Existing behavior (mark failed/error).

### 6. Hull — Capture Result Message

Add a `resultText` field to Hull. In `handleStreamMessage()`, when a `result` message arrives, store `(msg as ClaudeResultMessage).result` in `this.resultText`. Use this for `summary.md` when available (falling back to the last 20 lines of output if not).

### 7. Hull — Output Buffer Cap

The existing `MAX_OUTPUT_LINES = 200` cap applies to research missions too. For research missions, raise the cap to `2000` lines to capture more complete output. This is done by checking `this.opts.missionType` in `appendOutput()`.

### 8. Cargo File Storage

Directory structure (using absolute paths via `process.env.HOME`):

```
$HOME/.fleet/starbases/starbase-{id}/cargo/{sectorId}/{missionId}/
  full-output.md
  summary.md
```

The `manifest` column in the cargo DB record stores a JSON blob:

```json
{ "path": "/Users/alice/.fleet/starbases/starbase-abc123/cargo/api/42/full-output.md" }
```

### 9. Error Handling

| Scenario                                  | Behavior                                                                                                        |
| ----------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| Research crew exits non-zero (crash)      | Still marked `error` — crash is a crash regardless of type                                                      |
| Research crew produces commits            | Normal code flow (push/PR/verify)                                                                               |
| Research crew produces no output text     | Mark `completed` with note, create cargo with empty content                                                     |
| Cargo file write fails (disk/permissions) | Non-fatal, log error, mark mission `completed`, store full content directly in DB `manifest` column as fallback |

## Files Changed

| File                                   | Change                                                                                                                         |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `src/main/starbase/migrations.ts`      | New migration adding `type` column to missions                                                                                 |
| `src/main/starbase/mission-service.ts` | Add `type` to `AddMissionOpts`, `MissionRow`, and INSERT                                                                       |
| `src/main/starbase/hull.ts`            | Add `missionType` + `starbaseId` to `HullOpts`, capture result text, raise output cap for research, research branch in cleanup |
| `src/main/starbase/crew-service.ts`    | Add `type` to `deployCrew` opts, read mission type, pass to Hull                                                               |
| `src/main/socket-server.ts`            | Forward `type` arg in `mission.create` command                                                                                 |

## Not Changed

- `cargo-service.ts` — Hull uses raw SQL (existing pattern)
- `index.ts` — `starbaseId` is already in `CrewServiceDeps`
- Sector config — mission type is per-mission, not per-sector
- Supply routes — cargo flows through existing mechanisms once produced
- Comms protocol — uses existing `mission_complete` type with added `cargoProduced` flag
