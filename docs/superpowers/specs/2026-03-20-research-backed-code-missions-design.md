# Research-Backed Code Missions — Design Spec

**Date:** 2026-03-20
**Status:** Approved for implementation

---

## Overview

Code missions can optionally depend on one or more research missions. When a code mission has research dependencies, the research missions must all reach a terminal state before the code mission becomes eligible to deploy. Hull injects a lightweight cargo header into the code crew's initial message so it knows where to find the findings.

Attaching research missions to code missions is optional but encouraged for non-trivial changes.

---

## 1. Database — `mission_dependencies` Junction Table

### New table

```sql
CREATE TABLE IF NOT EXISTS mission_dependencies (
  mission_id             INTEGER NOT NULL REFERENCES missions(id),
  depends_on_mission_id  INTEGER NOT NULL REFERENCES missions(id),
  PRIMARY KEY (mission_id, depends_on_mission_id)
);
```

### Migration strategy

Both steps must be a **single migration version entry** in `migrations.ts` (one `db.transaction()` block). Splitting them into two separate migration versions risks leaving the table created but un-backfilled if a crash occurs between them — the version counter would skip the backfill permanently.

```sql
-- Single migration version: create table AND backfill existing data
CREATE TABLE IF NOT EXISTS mission_dependencies (
  mission_id             INTEGER NOT NULL REFERENCES missions(id),
  depends_on_mission_id  INTEGER NOT NULL REFERENCES missions(id),
  PRIMARY KEY (mission_id, depends_on_mission_id)
);

INSERT OR IGNORE INTO mission_dependencies (mission_id, depends_on_mission_id)
SELECT id, depends_on_mission_id FROM missions WHERE depends_on_mission_id IS NOT NULL;
```

The old `depends_on_mission_id` column is left in place but **ignored by all new code**. No destructive migration is performed.

### Dependency unblocking policy

A code mission is eligible when **all** its dependencies have reached a terminal state — either `completed`, `failed`, or `aborted`. If a research dependency fails or is aborted, the code mission is unblocked and proceeds. The code crew receives a header noting which research missions ran and can inspect their cargo (if any was produced before failure).

This prevents code missions from being permanently blocked by a failed research mission.

### `nextMission()` query update

```sql
SELECT * FROM missions
WHERE sector_id = ? AND status = 'queued'
AND (
  -- No dependencies at all
  NOT EXISTS (
    SELECT 1 FROM mission_dependencies WHERE mission_id = missions.id
  )
  OR
  -- All dependencies are in a terminal state (completed, failed, or aborted)
  NOT EXISTS (
    SELECT 1 FROM mission_dependencies md
    JOIN missions dep ON dep.id = md.depends_on_mission_id
    WHERE md.mission_id = missions.id
      AND dep.status NOT IN ('completed', 'failed', 'aborted')
  )
)
ORDER BY priority ASC, created_at ASC
LIMIT 1
```

### All dependency-checking sites to update

The old `depends_on_mission_id IS NULL OR depends_on_mission_id IN (SELECT id FROM missions WHERE status = 'completed')` guard appears in **multiple places** and all must be updated to use the junction table:

- `mission-service.ts` — `nextMission()`
- `crew-service.ts` — `nextQueuedMission()` and `autoDeployNext()` (the atomic `UPDATE ... WHERE id = (SELECT ...)` variant)
- `socket-server.ts` — the `mission.deploy` handler's manual dependency check

---

## 2. `MissionService` Changes

### `addMission()` signature update

```typescript
type AddMissionOpts = {
  sectorId: string;
  summary: string;
  prompt: string;
  acceptanceCriteria?: string;
  priority?: number;
  dependsOnMissionIds?: number[]; // replaces dependsOnMissionId (singular)
  type?: string;
  prBranch?: string;
};
```

After inserting the mission row, insert one row per dependency ID into `mission_dependencies`:

```typescript
for (const depId of opts.dependsOnMissionIds ?? []) {
  db.prepare(
    'INSERT OR IGNORE INTO mission_dependencies (mission_id, depends_on_mission_id) VALUES (?, ?)'
  ).run(result.lastInsertRowid, depId);
}
```

### New methods

```typescript
getDependencies(missionId: number): MissionRow[]
// Returns all missions that missionId depends on (rows in mission_dependencies where mission_id = missionId)

getDependents(missionId: number): MissionRow[]
// Returns all missions that depend on missionId (rows in mission_dependencies where depends_on_mission_id = missionId)
```

Both return `[]` when there are no rows — never `undefined`.

### `nextMission()` rewrite

Updated to use the junction table query from §1.

---

## 3. CLI — `--depends-on` Flag

### `parseArgs` update

`parseArgs` in `fleet-cli.ts` currently assigns `result[key] = next` as a plain scalar. It must be extended to **accumulate array values** for `--depends-on`: when the same key appears more than once, collect values into an array rather than overwriting.

```typescript
// Before (scalar):
result['depends-on'] = '15'; // second occurrence silently drops '12'

// After (array accumulation for --depends-on):
result['depends-on'] = ['12', '15'];
```

### Usage

```bash
# Single research dependency
fleet missions add --sector my-app --type code \
  --summary "Implement JWT auth" \
  --prompt "..." \
  --depends-on 12

# Multiple research dependencies
fleet missions add --sector my-app --type code \
  --summary "Implement JWT auth" \
  --prompt "..." \
  --depends-on 12 --depends-on 15
```

### Soft nudge

The soft nudge is appended to the **socket server's success response text** for `mission.create` when `type === 'code'` and no `--depends-on` IDs were provided:

```
Mission #42 created.

Tip: Consider attaching a research mission to provide context before this code
mission runs. Use --depends-on <research-mission-id> to link one.
Skip this for trivial changes.
```

The fleet-cli prints whatever the server returns, so the nudge lives in the server response, not the CLI formatting layer.

### Validation (in `fleet-cli.ts` `validateCommand`)

- Parse `args['depends-on']` as an array (normalise single string to `[string]`)
- Error if any value is non-numeric or non-positive

---

## 4. Socket Server — `mission.create` Handler

### Parsing `--depends-on`

`args['depends-on']` may arrive as a string (single value) or an array of strings (multiple values, after `parseArgs` update). Normalise explicitly:

```typescript
const rawDeps = args['depends-on'];
const dependsOnMissionIds: number[] =
  rawDeps == null
    ? []
    : (Array.isArray(rawDeps) ? rawDeps : [rawDeps]).map(Number).filter((n) => !isNaN(n) && n > 0);
```

### Validation

For each ID in `dependsOnMissionIds`:

- Verify the mission exists; if not, throw `BAD_REQUEST` with a clear message
- Warn (not error) if the mission is not `research` type — the dependency model is flexible

### After inserting the mission

Call `missionService.addMission({ ..., dependsOnMissionIds })` which handles junction table insertion.

### Response

Return the mission row enriched with `dependencies: number[]` (the IDs that were linked).

### Soft nudge

Append the tip text to the success response string when `type === 'code'` and `dependsOnMissionIds.length === 0`.

---

## 5. Hull — Cargo Context Header for Code Missions

### When it applies

Only for `missionType === 'code'` missions that have one or more rows in `mission_dependencies`.

### What gets injected

A lightweight header prepended to the **`content` string of the initial user message** (before the worktree warning). It is not prepended to the serialised JSON `initMsg` string — it modifies the `content` field before serialisation:

```typescript
const cargoHeader = buildCargoHeader(db, missionId); // returns '' if nothing to inject

const content = `${cargoHeader}${worktreeWarning}${researchGuidance}Read and execute the mission prompt in ${promptFile}. Delete the file when done.`;

const initMsg =
  JSON.stringify({
    type: 'user',
    message: { role: 'user', content },
    parent_tool_use_id: null,
    session_id: ''
  }) + '\n';
```

### Header format

```
RESEARCH CONTEXT: The following research mission(s) completed before this code
mission. Use the Read tool to load their findings if your task requires context.

- Mission #12 "Investigate auth session bug"
  Summary cargo: /path/to/summary.md
- Mission #15 "Audit token storage patterns"
  Summary cargo: /path/to/summary.md

```

Only missions with verified, readable cargo files are listed. Dependencies with no cargo or missing files are silently omitted from the list (not from the header — if at least one entry is valid, the header appears).

If no entries are valid, the entire header is omitted silently.

### `buildCargoHeader(db, missionId)` implementation

```typescript
function buildCargoHeader(db: Database.Database, missionId: number): string {
  const deps = db
    .prepare(
      `SELECT md.depends_on_mission_id, m.summary, m.type
     FROM mission_dependencies md
     JOIN missions m ON m.id = md.depends_on_mission_id
     WHERE md.mission_id = ?`
    )
    .all(missionId) as Array<{ depends_on_mission_id: number; summary: string; type: string }>;

  if (deps.length === 0) return '';

  const lines: string[] = [];

  for (const dep of deps) {
    const cargo = db
      .prepare(
        `SELECT manifest FROM cargo
       WHERE mission_id = ? AND type = 'documentation_summary' AND verified = 1
       LIMIT 1`
      )
      .get(dep.depends_on_mission_id) as { manifest: string } | undefined;

    if (!cargo) continue;

    let path: string | null = null;
    try {
      const manifest = JSON.parse(cargo.manifest) as { path?: string };
      if (manifest.path && fs.existsSync(manifest.path)) {
        path = manifest.path;
      }
    } catch {
      continue;
    }

    if (!path) continue; // { content } manifests or missing files: skip

    lines.push(
      `- Mission #${dep.depends_on_mission_id} "${dep.summary}"\n  Summary cargo: ${path}`
    );
  }

  if (lines.length === 0) return '';

  return [
    'RESEARCH CONTEXT: The following research mission(s) completed before this code mission.',
    'Use the Read tool to load their findings if your task requires context.',
    '',
    ...lines,
    ''
  ].join('\n');
}
```

`fs.existsSync` is called before including any path in the header. Missing files (e.g. purged by `CargoService.cleanup()`) are silently omitted.

---

## 6. Workspace Templates — Admiral CLAUDE.md and Fleet Skill

### `generateClaudeMd()` — Deployment Workflow section

Add a **Research-First Workflow** subsection after the existing deployment example:

```markdown
### Research-First Workflow (recommended for non-trivial code missions)

For anything beyond a trivial change, create a research mission first to gather
context, then create a code mission that depends on it. The code mission will not
be scheduled until the research mission reaches a terminal state.

\`\`\`bash

# 1. Create the research mission

fleet missions add --sector <id> --type research \\
--summary "Investigate X" \\
--prompt "Investigate..."

# 2. Create the code mission that depends on the research

fleet missions add --sector <id> --type code \\
--summary "Implement X" \\
--prompt "..." \\
--depends-on <research-mission-id>

# 3. Deploy the research crew first

fleet crew deploy --sector <id> --mission <research-mission-id>

# 4. When research completes, deploy the code crew

fleet crew deploy --sector <id> --mission <code-mission-id>
\`\`\`

When the code crew starts, it receives a header listing the research cargo file
paths and can use the Read tool to load findings if the task requires them.
```

### `generateSkillMd()` changes

1. Add `--depends-on` to the `missions add` command reference block
2. Add a **Research-First Workflow** section mirroring the above
3. Update the "Required fields for `missions add`" note to mention `--depends-on`
4. Add a note to the **Research Mission Output Format** section:

```
When a research mission completes, its summary cargo path is referenced in the
initial message of any code missions that depend on it. The code crew can Read
the file on demand if the task requires the findings.
```

---

## Non-Goals

- No UI changes (dependency display in the Fleet app is out of scope)
- No enforcement — code missions without research dependencies are fully valid
- No semantic relevance filtering — the crew decides whether to read the cargo
- No injection of cargo content inline — paths only

---

## Affected Files

| File                                         | Change                                                                                                                                                                                          |
| -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/main/starbase/migrations.ts`            | Add single migration version: create `mission_dependencies` table + backfill existing `depends_on_mission_id` values                                                                            |
| `src/main/starbase/mission-service.ts`       | Update `AddMissionOpts`, `addMission()`, `nextMission()`; add `getDependencies()`, `getDependents()`                                                                                            |
| `src/main/starbase/crew-service.ts`          | Update `nextQueuedMission()` and `autoDeployNext()` to use junction table instead of old `depends_on_mission_id` guard                                                                          |
| `src/main/starbase/hull.ts`                  | Add `buildCargoHeader()` and inject header into `content` field of initial user message for code missions                                                                                       |
| `src/main/socket-server.ts`                  | Parse `--depends-on` as array, validate IDs, pass `dependsOnMissionIds` to `addMission`, add soft nudge to response, update `mission.deploy` dependency check                                   |
| `src/main/fleet-cli.ts`                      | Extend `parseArgs` to accumulate array values for `--depends-on`; add validation in `mission.create` case                                                                                       |
| `src/main/starbase/workspace-templates.ts`   | Update `generateClaudeMd()` and `generateSkillMd()`                                                                                                                                             |
| `src/main/__tests__/mission-service.test.ts` | Tests for `getDependencies()`, `getDependents()`, updated `nextMission()` including: all completed, one failed, one aborted, mix of terminal states, zero-row return values, backfill migration |
| `src/main/__tests__/hull.test.ts`            | Tests for cargo header injection: valid cargo path, missing file (skip), `{content}` manifest (skip), no dependencies (empty string), partial valid entries                                     |
| `src/main/__tests__/socket-api.test.ts`      | Tests for `--depends-on` single value, multiple values, invalid ID, non-existent ID, nudge text on code mission without deps                                                                    |
