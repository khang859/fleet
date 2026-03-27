# Explicit Cargo Send API — Design Spec

## Problem

The current cargo capture system is lossy and fragile:

1. **Output truncation** — Research missions cap output at 2000 lines, losing early detailed content
2. **Automatic capture complexity** — System parses NDJSON streams and captures stdout, introducing multiple failure points
3. **Summary override** — Brief result messages override intended "last 20 lines" summaries
4. **Fallback truncation** — If files can't be written, content is severely limited (50K chars full, 10K summary)
5. **No control** — Crews have no explicit way to declare what they want to persist; the system guesses

Result: Research findings are unpredictably incomplete (Mission 71, 73 investigations).

## Solution

Three-part change:

1. **`fleet cargo send` command** — Crews explicitly declare and send cargo
2. **FO cargo evaluation** — First Officer evaluates completed missions and recovers cargo from raw output if crew didn't send explicitly
3. **Raw output streaming** — Hull streams full untruncated output to disk as a recovery fallback

## 1. `fleet cargo send` Command

### Usage

```bash
# Send from file (preferred)
fleet cargo send --type findings --file findings.md

# Send inline content
fleet cargo send --type documentation_full --content "$(cat findings.md)"

# Multiple cargo items
fleet cargo send --type findings --file findings.json
fleet cargo send --type screenshots --file screenshots.tar.gz
```

### Context Auto-Detection

The command auto-detects mission context from environment variables already set by the hull:

- `FLEET_CREW_ID` — crew ID
- `FLEET_SECTOR_ID` — sector ID
- `FLEET_MISSION_ID` — mission ID
- `FLEET_MISSION_TYPE` — mission type

No `--crew`, `--mission`, or `--sector` flags needed.

### File Path Resolution

Paths are resolved relative to the crew's working directory. Absolute paths also supported.

### Storage

All cargo is written to disk at:
```
~/.fleet/starbases/starbase-{id}/cargo/{sector}/{mission_id}/{timestamp}-{type}.{ext}
```

Manifest JSON stored in the cargo DB record:
```json
{
  "title": "<type>",
  "path": "/absolute/path/to/file",
  "size": 12345,
  "originalName": "findings.md",
  "sourceType": "explicit"
}
```

All explicit cargo is `verified=1` (trusted).

### Mission Status Transition

When `fleet cargo send` is called while mission is in `'awaiting-cargo-check'` status:
- Create cargo record
- Transition mission status: `'awaiting-cargo-check'` → `'completed'`
- These two operations are wrapped in a database transaction (atomic)

When called while mission is still `'active'`:
- Create cargo record only (no status transition — crew is still working)

### Code Path

```
CLI (fleet-cli.ts) → Unix socket → SocketServer.dispatch('cargo.send') → CargoService.sendCargo() → SQLite + disk
```

## 2. Mission Status: `'awaiting-cargo-check'`

### New Status in Mission State Machine

When a mission reaches its completion point, the hull sets:
```sql
UPDATE missions SET status = 'awaiting-cargo-check', cargo_checked = 0
```

Instead of the current direct transition to `'completed'`.

### Schema Change

```sql
ALTER TABLE missions ADD COLUMN cargo_checked INTEGER DEFAULT 0;
```

**Meaning:**
- `cargo_checked = 0` — FO hasn't evaluated yet
- `cargo_checked = 1` — FO has evaluated (either recovered cargo or determined none needed)

### Which Completion Points Change

| Location | Current Status | New Status |
|----------|---------------|------------|
| hull.ts:981 (research/architect after cargo) | `'completed'` | `'awaiting-cargo-check'` |
| hull.ts:1149 (safety guard research/architect) | `'completed'` | `'awaiting-cargo-check'` |
| hull.ts:827 (repair no changes) | `'completed'` | `'awaiting-cargo-check'` |
| hull.ts:1564 (repair complete) | `'completed'` | `'awaiting-cargo-check'` |
| mission-service.ts:86 `completeMission()` | `'completed'` | `'awaiting-cargo-check'` |
| socket-server.ts:560 (review approved) | `'completed'` | `'awaiting-cargo-check'` |
| sentinel.ts:1126 (auto-approved) | `'completed'` | `'awaiting-cargo-check'` — FO evaluates even auto-approved missions |
| reconciliation.ts:177 | `'completed'` | NO CHANGE — stale cleanup, not real completion |

### Invariants

1. **Hull invariant:** When mission reaches completion, ALWAYS set `status='awaiting-cargo-check'` and `cargo_checked=0`. Never transition directly to `'completed'`.
2. **FO invariant:** After `evaluateMissionForCargo()` runs, ALWAYS set `cargo_checked=1`. Prevents double-evaluation.
3. **Socket invariant:** `fleet cargo send` called during `'awaiting-cargo-check'` transitions to `'completed'` atomically.
4. **Timeout invariant:** Crew's 15-minute deadline still applies. If mission is in `'awaiting-cargo-check'` when deadline expires, sentinel marks crew as lost/timeout per existing rules.

## 3. Raw Output Streaming

### Problem with Current Capture

The hull currently caps `this.outputLines` at:
- 2000 lines for research/review/architect
- 200 lines for code/repair

This loses early content — the exact problem the feature request describes.

### Solution: Stream to Disk

When a crew starts, the hull opens a write stream:
```
~/.fleet/starbases/starbase-{id}/cargo/{sector}/{mission_id}/raw-output.md
```

- Every line from `appendOutput()` is written to BOTH the in-memory buffer (capped, for UI) AND the disk stream (uncapped, full output)
- Uses `fs.createWriteStream` with default Node.js buffering (~64KB internal buffer)
- Stream is closed when crew exits
- 20 concurrent crews = 20 append streams = negligible I/O on modern SSDs

### Existing In-Memory Buffer

The current `this.outputLines` array with its caps remains unchanged — it's used for `observeCrew()` and UI display. The disk stream is a separate, parallel capture path.

## 4. First Officer Cargo Evaluation

### New FO Mode: `'cargo-evaluation'`

Modeled after the existing `'consult'` mode. Triggered by the sentinel when it detects missions in `'awaiting-cargo-check'` with `cargo_checked=0`.

### FO Evaluation Logic

1. Check mission type
2. Check if explicit cargo already exists for this mission (`SELECT FROM cargo WHERE mission_id = ?`)
3. If explicit cargo exists:
   - Set `cargo_checked = 1`
   - Transition mission to `'completed'`
4. If NO explicit cargo exists:
   - For research/architect/repair/review: read `raw-output.md`, create cargo record from it
   - For code: transition to `'completed'` (code missions don't typically produce cargo)
   - Set `cargo_checked = 1`

### Dispatch

The sentinel adds a cargo evaluation sweep:
```
Query: missions WHERE status = 'awaiting-cargo-check' AND cargo_checked = 0
For each: dispatch FO in 'cargo-evaluation' mode
```

### Safety Net

If mission has been in `'awaiting-cargo-check'` with `cargo_checked = 0` for > 5 minutes (FO crashed/timed out), sentinel auto-escalates to admiral.

## 5. Remove Current Auto-Cargo from Hull

### Remove

- hull.ts:969-972 — `INSERT INTO cargo ... 'documentation_full'` (research/architect completion)
- hull.ts:974-977 — `INSERT INTO cargo ... 'documentation_summary'` (same block)
- hull.ts:1139-1141 — `INSERT INTO cargo ... 'documentation_full'` (safety guard block)
- hull.ts:1143-1146 — `INSERT INTO cargo ... 'documentation_summary'` (same block)
- Cargo dir creation, manifest building, and file writing code surrounding those inserts
- The output truncation/summary extraction logic tied to cargo creation

### Keep

- `buildCargoHeader()` — kept but made graceful (returns empty string if no cargo exists for dependencies). Dependent missions still get cargo context if it was sent.
- `this.outputLines` in-memory buffer — still used for UI/observeCrew
- `appendOutput()` method — extended to also write to disk stream

## 6. Crew Prompt Updates

### All Crews Get `fleet cargo send` Instructions

Position as the **preferred/recommended** approach for persisting outputs.

**architect-crew.md** (replace existing "Cargo Workflow" section):
```
## Cargo Workflow
- When your design is complete, save it to a file and send it as cargo:
  fleet cargo send --type blueprint --file blueprint.md
- Use fleet cargo send for any artifacts you want to persist (diagrams, specs, etc.)
- You may send multiple cargo items.
```

**research-crew.md** (replace existing "Cargo Workflow" section):
```
## Cargo Workflow
- When your research is complete, save findings to a file and send as cargo:
  fleet cargo send --type findings --file findings.md
- Use fleet cargo send for any artifacts you want to persist.
- You may send multiple cargo items.
```

**repair-crew.md** (new section):
```
## Cargo Workflow
- If your repair produces artifacts (patches, reports), send them:
  fleet cargo send --type repair-report --file report.md
```

**review-crew.md** (new section):
```
## Cargo Workflow
- If your review produces a detailed report beyond the VERDICT, send it:
  fleet cargo send --type review-report --file review.md
```

**code-crew.md** (new section):
```
## Cargo Workflow
- If your implementation produces artifacts beyond git commits, send them:
  fleet cargo send --type <type> --file <path>
```

## 7. Workspace Template Updates

### Skill Reference (workspace-templates.ts)

Add to cargo section:
```
fleet cargo send --type <type> --file <path>     Send explicit cargo from a file
fleet cargo send --type <type> --content "<str>"  Send explicit cargo inline
```

### Research Mission Output Format Section

Replace auto-capture documentation with explicit send documentation. Remove references to "Fleet captures your full output as cargo automatically."

### Admiral CLAUDE.md

Update cargo reference to explain that crews send cargo explicitly via `fleet cargo send`, and that raw output is captured as a fallback.

### Navigator CLAUDE.md

Update cargo operations sections to reference `fleet cargo send` in protocol step documentation.

## 8. Failure Handling

| # | Scenario | Handling |
|---|----------|----------|
| 1 | Crew exits without sending cargo | FO recovery: creates cargo from `raw-output.md` |
| 2 | FO crashes/times out | Sentinel safety net: auto-escalate after 5 min in `'awaiting-cargo-check'` with `cargo_checked=0` |
| 3 | `fleet cargo send` fails (disk/path) | Return error to crew. Crew retries or falls through to FO recovery |
| 4 | Cargo sent but mission transition fails | `cargo.send` handler wraps INSERT + UPDATE in transaction (atomic) |
| 5 | Race: cargo send in-flight, crew exits | Socket server handles cargo.send independently of crew lifecycle |
| 6 | FO says "no cargo needed" incorrectly | For research/architect, FO always creates cargo from raw output. Only skips for code missions |
| 7 | raw-output.md write fails | Hull logs error. FO falls back to mission.result field or escalates |
| 8 | Multiple cargo sends | Allowed — each creates a separate cargo record |

## Files Changed

### Remove
- hull.ts: 4 `INSERT INTO cargo` statements and surrounding manifest/file-writing code

### Modify
- hull.ts: 4 status transitions from `'completed'` → `'awaiting-cargo-check'`; add write stream for raw output
- mission-service.ts: `completeMission()` → set `'awaiting-cargo-check'`
- socket-server.ts: review approved → `'awaiting-cargo-check'`; add `cargo.send` case
- sentinel.ts: add cargo evaluation sweep; add 5-min safety net
- fleet-cli.ts: add `cargo.send` command mapping and validation
- cargo-service.ts: add `sendCargo()` method
- first-officer.ts: add cargo evaluation mode and prompts
- workspace-templates.ts: update skill reference, research output docs, Admiral CLAUDE.md, Navigator CLAUDE.md
- migrations.ts: add `cargo_checked` column

### Add
- Crew prompts: update all 5 (architect, research, repair, review, code)
- Tests: cargo-service, socket-server, fleet-cli, hull, sentinel, first-officer
