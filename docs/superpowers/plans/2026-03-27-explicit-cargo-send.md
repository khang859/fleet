# Explicit Cargo Send API Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the fragile automatic cargo capture system with explicit `fleet cargo send` command, FO-backed cargo evaluation, and full raw output streaming to disk.

**Architecture:** Add `cargo.send` socket command backed by `CargoService.sendCargo()`. Hull streams full output to disk via `fs.createWriteStream` and transitions missions to `'awaiting-cargo-check'` instead of `'completed'`. Sentinel dispatches FO in a new `'cargo-evaluation'` mode to recover cargo from raw output when crews don't send explicitly.

**Tech Stack:** TypeScript, better-sqlite3, node-pty, fs.createWriteStream, Claude CLI (First Officer)

---

## File Structure

| File | Action | Responsibility |
|------|--------|---------------|
| `src/main/starbase/migrations.ts` | Modify | Add migration 017 for `cargo_checked` column |
| `src/main/starbase/cargo-service.ts` | Modify | Add `sendCargo()` method |
| `src/main/socket-server.ts` | Modify | Add `cargo.send` dispatch case; change review-approved transition |
| `src/main/starbase-runtime-socket-services.ts` | Modify | Expose `sendCargo` in service proxy |
| `src/main/fleet-cli.ts` | Modify | Add `cargo.send` mapping and validation |
| `src/main/starbase/hull.ts` | Modify | Stream output to disk; remove auto-cargo; use `'awaiting-cargo-check'` |
| `src/main/starbase/mission-service.ts` | Modify | Change `completeMission()` to set `'awaiting-cargo-check'` |
| `src/main/starbase/sentinel.ts` | Modify | Add cargo evaluation sweep + safety net |
| `src/main/starbase/first-officer.ts` | Modify | Add cargo evaluation mode |
| `src/main/starbase/workspace-templates.ts` | Modify | Update skill ref, research output docs, Admiral/Navigator CLAUDE.md |
| `src/main/starbase/prompts/research-crew.md` | Modify | Replace "Cargo Workflow" section |
| `src/main/starbase/prompts/architect-crew.md` | Modify | Replace "Cargo Workflow" section |
| `src/main/starbase/prompts/code-crew.md` | Modify | Add "Cargo Workflow" section |
| `src/main/starbase/prompts/repair-crew.md` | Modify | Add "Cargo Workflow" section |
| `src/main/starbase/prompts/review-crew.md` | Modify | Add "Cargo Workflow" section |
| `src/main/__tests__/cargo-service.test.ts` | Modify | Add tests for `sendCargo()` |
| `src/main/__tests__/socket-server.test.ts` | Modify | Add tests for `cargo.send` dispatch |
| `src/main/__tests__/fleet-cli.test.ts` | Modify | Add tests for `cargo.send` validation |
| `src/main/__tests__/hull.test.ts` | Modify | Add tests for raw output streaming and status change |
| `src/main/__tests__/sentinel.test.ts` | Modify | Add tests for cargo evaluation sweep |

---

### Task 1: Database Migration — Add `cargo_checked` Column

**Files:**
- Modify: `src/main/starbase/migrations.ts:345-346` (after last migration, before closing bracket)

- [ ] **Step 1: Write the migration**

Add migration version 17 after the existing version 16 entry at line 345:

```typescript
  {
    version: 17,
    name: '017-cargo-checked',
    sql: `
      ALTER TABLE missions ADD COLUMN cargo_checked INTEGER DEFAULT 0;
    `
  }
```

Insert this before the closing `];` on line 346.

- [ ] **Step 2: Run typecheck**

Run: `npm run typecheck`
Expected: PASS — migration array accepts the new entry.

- [ ] **Step 3: Commit**

```bash
git add src/main/starbase/migrations.ts
git commit -m "feat(cargo): add migration 017 for cargo_checked column on missions"
```

---

### Task 2: `CargoService.sendCargo()` Method

**Files:**
- Modify: `src/main/starbase/cargo-service.ts`
- Test: `src/main/__tests__/cargo-service.test.ts`

- [ ] **Step 1: Write the failing test**

Open `src/main/__tests__/cargo-service.test.ts`. Add a new `describe('sendCargo')` block. The test needs a real SQLite database. Check how existing tests in this file set up the database and follow the same pattern.

```typescript
describe('sendCargo', () => {
  it('creates cargo record with explicit sourceType and writes file to disk', async () => {
    // Setup: create a sector and mission in the test DB
    db.exec("INSERT INTO sectors (id, name, root_path) VALUES ('test-sector', 'Test', '/tmp/test')");
    db.exec(
      "INSERT INTO missions (sector_id, summary, prompt, status) VALUES ('test-sector', 'Test mission', 'Do stuff', 'active')"
    );
    const mission = db.prepare<[], { id: number }>('SELECT id FROM missions LIMIT 1').get()!;

    const result = await cargoService.sendCargo({
      crewId: 'test-crew',
      missionId: mission.id,
      sectorId: 'test-sector',
      type: 'findings',
      content: 'These are my research findings.',
      starbaseId: 'test123'
    });

    expect(result.crew_id).toBe('test-crew');
    expect(result.mission_id).toBe(mission.id);
    expect(result.type).toBe('findings');
    expect(result.verified).toBe(1);

    const manifest = JSON.parse(result.manifest!);
    expect(manifest.sourceType).toBe('explicit');
    expect(manifest.title).toBe('findings');
    expect(manifest.size).toBeGreaterThan(0);
  });

  it('transitions mission from awaiting-cargo-check to completed', async () => {
    db.exec("INSERT INTO sectors (id, name, root_path) VALUES ('s2', 'S2', '/tmp/s2')");
    db.exec(
      "INSERT INTO missions (sector_id, summary, prompt, status) VALUES ('s2', 'M2', 'Do', 'awaiting-cargo-check')"
    );
    const mission = db.prepare<[], { id: number }>('SELECT id FROM missions LIMIT 1').get()!;

    await cargoService.sendCargo({
      crewId: 'crew2',
      missionId: mission.id,
      sectorId: 's2',
      type: 'findings',
      content: 'Findings',
      starbaseId: 'test123'
    });

    const updated = db
      .prepare<[number], { status: string }>('SELECT status FROM missions WHERE id = ?')
      .get(mission.id)!;
    expect(updated.status).toBe('completed');
  });

  it('does NOT transition mission if status is active', async () => {
    db.exec("INSERT INTO sectors (id, name, root_path) VALUES ('s3', 'S3', '/tmp/s3')");
    db.exec(
      "INSERT INTO missions (sector_id, summary, prompt, status) VALUES ('s3', 'M3', 'Do', 'active')"
    );
    const mission = db.prepare<[], { id: number }>('SELECT id FROM missions LIMIT 1').get()!;

    await cargoService.sendCargo({
      crewId: 'crew3',
      missionId: mission.id,
      sectorId: 's3',
      type: 'findings',
      content: 'Findings',
      starbaseId: 'test123'
    });

    const updated = db
      .prepare<[number], { status: string }>('SELECT status FROM missions WHERE id = ?')
      .get(mission.id)!;
    expect(updated.status).toBe('active');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/main/__tests__/cargo-service.test.ts --reporter=verbose`
Expected: FAIL — `cargoService.sendCargo is not a function`

- [ ] **Step 3: Add the `SendCargoOpts` type and `sendCargo()` method**

In `src/main/starbase/cargo-service.ts`, add the type after `ListCargoFilter` (around line 44):

```typescript
type SendCargoOpts = {
  crewId: string;
  missionId: number;
  sectorId: string;
  type: string;
  content?: string;
  filePath?: string;
  starbaseId: string;
};
```

Add the method to `CargoService` class (after `produceRecoveredCargo`, around line 139):

```typescript
  async sendCargo(opts: SendCargoOpts): Promise<CargoRow> {
    if (!opts.content && !opts.filePath) {
      throw new Error('sendCargo requires either content or filePath');
    }

    const cargoDir = join(
      process.env.HOME ?? '~',
      '.fleet',
      'starbases',
      `starbase-${opts.starbaseId}`,
      'cargo',
      opts.sectorId,
      String(opts.missionId)
    );

    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const ext = opts.filePath ? opts.filePath.split('.').pop() ?? 'md' : 'md';
    const fileName = `${ts}-${opts.type}.${ext}`;
    const destPath = join(cargoDir, fileName);

    let content: string;
    if (opts.filePath) {
      const { readFile } = await import('fs/promises');
      content = await readFile(opts.filePath, 'utf-8');
    } else {
      content = opts.content!;
    }

    await mkdir(cargoDir, { recursive: true });
    await writeFile(destPath, content, 'utf-8');

    const manifest = JSON.stringify({
      title: opts.type,
      path: destPath,
      size: Buffer.byteLength(content, 'utf-8'),
      originalName: opts.filePath ? opts.filePath.split('/').pop() : null,
      sourceType: 'explicit'
    });

    const cargo = this.produceCargo({
      crewId: opts.crewId,
      missionId: opts.missionId,
      sectorId: opts.sectorId,
      type: opts.type,
      manifest
    });

    // If mission is awaiting-cargo-check, transition to completed atomically
    const mission = this.db
      .prepare<[number], { status: string }>('SELECT status FROM missions WHERE id = ?')
      .get(opts.missionId);

    if (mission?.status === 'awaiting-cargo-check') {
      this.db
        .prepare(
          "UPDATE missions SET status = 'completed', cargo_checked = 1, completed_at = datetime('now') WHERE id = ?"
        )
        .run(opts.missionId);
    }

    return cargo;
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/main/__tests__/cargo-service.test.ts --reporter=verbose`
Expected: PASS

- [ ] **Step 5: Run full typecheck**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/main/starbase/cargo-service.ts src/main/__tests__/cargo-service.test.ts
git commit -m "feat(cargo): add sendCargo() method with explicit file/content support"
```

---

### Task 3: Socket Server `cargo.send` Dispatch

**Files:**
- Modify: `src/main/socket-server.ts:91-96` (cargoService Pick type)
- Modify: `src/main/socket-server.ts:914-931` (after cargo.produce case)
- Modify: `src/main/starbase-runtime-socket-services.ts:54-59` (cargoService proxy)
- Test: `src/main/__tests__/socket-server.test.ts`

- [ ] **Step 1: Write the failing test**

In `src/main/__tests__/socket-server.test.ts`, add a test for the `cargo.send` dispatch. Follow the existing test patterns in this file.

```typescript
describe('cargo.send', () => {
  it('calls cargoService.sendCargo with correct args', async () => {
    const result = await dispatch('cargo.send', {
      type: 'findings',
      content: 'My research findings',
      starbaseId: 'sb-123'
    });
    expect(result).toBeDefined();
  });

  it('rejects when type is missing', async () => {
    await expect(dispatch('cargo.send', { content: 'hello' })).rejects.toThrow();
  });

  it('rejects when both content and file are missing', async () => {
    await expect(dispatch('cargo.send', { type: 'findings' })).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/main/__tests__/socket-server.test.ts --reporter=verbose -t "cargo.send"`
Expected: FAIL — unknown command or missing dispatch case

- [ ] **Step 3: Add `sendCargo` to the service type and proxy**

In `src/main/socket-server.ts`, update the `cargoService` Pick type at line 91-96:

```typescript
  cargoService: Promisified<
    Pick<
      ServiceRegistry['cargoService'],
      'listCargo' | 'getCargo' | 'produceCargo' | 'getUndelivered' | 'sendCargo'
    >
  >;
```

In `src/main/starbase-runtime-socket-services.ts`, update the `cargoService` proxy at line 54-59:

```typescript
    cargoService: {
      listCargo: async (filter?: unknown) => runtime.invoke('cargo.list', filter),
      getCargo: async (id: number) => runtime.invoke('cargo.get', id),
      produceCargo: async (opts: unknown) => runtime.invoke('cargo.produce', opts),
      getUndelivered: async (sectorId: string) => runtime.invoke('cargo.getUndelivered', sectorId),
      sendCargo: async (opts: unknown) => runtime.invoke('cargo.send', opts)
    },
```

- [ ] **Step 4: Add the dispatch case**

In `src/main/socket-server.ts`, after the `cargo.produce` case (around line 931), add:

```typescript
      case 'cargo.send': {
        const cargoType = typeof args.type === 'string' ? args.type : undefined;
        const cargoContent = typeof args.content === 'string' ? args.content : undefined;
        const cargoFile = typeof args.file === 'string' ? args.file : undefined;
        const starbaseId = typeof args.starbaseId === 'string' ? args.starbaseId : undefined;

        if (!cargoType) {
          throw new CodedError(
            'cargo.send requires --type <type>.\n' +
              'Usage: fleet cargo send --type <type> --file <path>\n' +
              '   or: fleet cargo send --type <type> --content "<string>"',
            'BAD_REQUEST'
          );
        }
        if (!cargoContent && !cargoFile) {
          throw new CodedError(
            'cargo.send requires --file <path> or --content "<string>".\n' +
              'Usage: fleet cargo send --type <type> --file <path>',
            'BAD_REQUEST'
          );
        }

        // Auto-detect context from args (set by CLI from env vars)
        const crewId = typeof args.crewId === 'string' ? args.crewId : undefined;
        const missionId = typeof args.missionId === 'string' || typeof args.missionId === 'number'
          ? Number(args.missionId)
          : undefined;
        const sectorId = typeof args.sectorId === 'string' ? args.sectorId : undefined;

        if (!sectorId || !missionId || !crewId) {
          throw new CodedError(
            'cargo.send requires crew context (FLEET_CREW_ID, FLEET_MISSION_ID, FLEET_SECTOR_ID).\n' +
              'This command should be run from within a crew session.',
            'BAD_REQUEST'
          );
        }

        return cargoService.sendCargo({
          crewId,
          missionId,
          sectorId,
          type: cargoType,
          content: cargoContent,
          filePath: cargoFile,
          starbaseId: starbaseId ?? 'unknown'
        });
      }
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run src/main/__tests__/socket-server.test.ts --reporter=verbose -t "cargo.send"`
Expected: PASS

- [ ] **Step 6: Run full typecheck**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add src/main/socket-server.ts src/main/starbase-runtime-socket-services.ts src/main/__tests__/socket-server.test.ts
git commit -m "feat(cargo): add cargo.send socket dispatch with context auto-detection"
```

---

### Task 4: Fleet CLI `cargo send` Command

**Files:**
- Modify: `src/main/fleet-cli.ts:368-372` (COMMAND_MAP)
- Modify: `src/main/fleet-cli.ts:593-600` (validation)
- Test: `src/main/__tests__/fleet-cli.test.ts`

- [ ] **Step 1: Write the failing test**

In `src/main/__tests__/fleet-cli.test.ts`, add tests for `cargo.send`. Follow existing test patterns.

```typescript
describe('cargo send', () => {
  it('maps cargo.send to cargo.send', () => {
    expect(mapCommand('cargo', 'send')).toBe('cargo.send');
  });

  it('rejects cargo.send without --type', () => {
    const err = validateArgs('cargo.send', { file: 'findings.md' });
    expect(err).toContain('--type');
  });

  it('rejects cargo.send without --file or --content', () => {
    const err = validateArgs('cargo.send', { type: 'findings' });
    expect(err).toContain('--file');
  });

  it('accepts cargo.send with --type and --file', () => {
    const err = validateArgs('cargo.send', { type: 'findings', file: 'findings.md' });
    expect(err).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/main/__tests__/fleet-cli.test.ts --reporter=verbose -t "cargo send"`
Expected: FAIL

- [ ] **Step 3: Add command mapping**

In `src/main/fleet-cli.ts`, add to COMMAND_MAP after `'cargo.produce': 'cargo.produce'` (line 372):

```typescript
  'cargo.send': 'cargo.send',
```

- [ ] **Step 4: Add validation**

In `src/main/fleet-cli.ts`, after the `cargo.produce` validation block (around line 600), add:

```typescript
    case 'cargo.send':
      if (!args.type)
        return 'Error: cargo send requires --type <type>.\n\nUsage: fleet cargo send --type <type> --file <path>';
      if (!args.file && !args.content)
        return 'Error: cargo send requires --file <path> or --content "<string>".\n\nUsage: fleet cargo send --type <type> --file <path>';
      // Inject crew context from environment
      if (!args.crewId && process.env.FLEET_CREW_ID) args.crewId = process.env.FLEET_CREW_ID;
      if (!args.missionId && process.env.FLEET_MISSION_ID) args.missionId = process.env.FLEET_MISSION_ID;
      if (!args.sectorId && process.env.FLEET_SECTOR_ID) args.sectorId = process.env.FLEET_SECTOR_ID;
      return null;
```

- [ ] **Step 5: Add help text**

In `src/main/fleet-cli.ts`, find the `cargo` help string (around line 951). Replace it with:

```typescript
  cargo: `# fleet cargo

Inspect, produce, and send Cargo artifacts — outputs from Missions (research findings, files, etc).

## When to use

Use \`fleet cargo\` when you need to view what artifacts a Mission produced, check
for undelivered cargo, send explicit cargo, or record a new artifact.

## Commands

  fleet cargo list                                   List all Cargo items
  fleet cargo show <id>                              Inspect a specific Cargo item
  fleet cargo pending --sector <id>                  Show undelivered Cargo for a Sector
  fleet cargo send --type <type> --file <path>       Send explicit Cargo from a file
  fleet cargo send --type <type> --content "<str>"   Send explicit Cargo inline
  fleet cargo produce --sector <id> --type <type> --path <path>
                                                     Record a produced Cargo artifact

## Arguments for \`cargo send\`

  --type <type>         Required. Cargo type identifier (e.g. findings, blueprint, review-report).
  --file <path>         Path to the artifact file (relative to working directory or absolute).
  --content "<string>"  Inline content string. Use --file for large content.

Note: --file and --content are mutually exclusive. Provide exactly one.
Crew context (crew ID, mission ID, sector ID) is auto-detected from environment variables.

## Examples

\`\`\`bash
fleet cargo list
fleet cargo show 3
fleet cargo pending --sector my-app
fleet cargo send --type findings --file research-findings.md
fleet cargo send --type blueprint --file architecture.md
fleet cargo send --type review-report --content "APPROVE: All checks pass"
fleet cargo produce --sector my-app --type research-findings --path ./findings.md
\`\`\``,
```

- [ ] **Step 6: Run test to verify it passes**

Run: `npx vitest run src/main/__tests__/fleet-cli.test.ts --reporter=verbose -t "cargo send"`
Expected: PASS

- [ ] **Step 7: Run full typecheck**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 8: Commit**

```bash
git add src/main/fleet-cli.ts src/main/__tests__/fleet-cli.test.ts
git commit -m "feat(cargo): add fleet cargo send CLI command with env auto-detection"
```

---

### Task 5: Hull — Raw Output Streaming to Disk

**Files:**
- Modify: `src/main/starbase/hull.ts` (imports, constructor, `appendOutput()`, cleanup)

- [ ] **Step 1: Add WriteStream import**

At the top of `src/main/starbase/hull.ts`, add `createWriteStream` to the existing `fs` import:

```typescript
import { writeFileSync, unlinkSync, mkdirSync, existsSync, readFileSync, createWriteStream } from 'fs';
```

Also add the `WriteStream` type:

```typescript
import type { WriteStream } from 'fs';
```

- [ ] **Step 2: Add WriteStream property to Hull class**

After the existing `private stdoutBuffer = '';` property (line 208), add:

```typescript
  private rawOutputStream: WriteStream | null = null;
```

- [ ] **Step 3: Open the write stream when crew starts**

In the `start()` method, after the crew INSERT statement and before spawning the process (around line 329, before `const mergedEnv`), add:

```typescript
      // Open raw output stream for full capture
      if (this.opts.starbaseId) {
        const rawCargoDir = join(
          process.env.HOME ?? '~',
          '.fleet',
          'starbases',
          `starbase-${this.opts.starbaseId}`,
          'cargo',
          this.opts.sectorId,
          String(missionId)
        );
        try {
          mkdirSync(rawCargoDir, { recursive: true });
          this.rawOutputStream = createWriteStream(
            join(rawCargoDir, 'raw-output.md'),
            { flags: 'w', encoding: 'utf-8' }
          );
        } catch (err) {
          log.error('failed to open raw output stream', {
            error: err instanceof Error ? err.message : String(err),
            crewId
          });
        }
      }
```

- [ ] **Step 4: Write to stream in `appendOutput()`**

Modify `appendOutput()` (line 527) to also write to the disk stream:

```typescript
  appendOutput(data: string): void {
    const lines = data.split('\n');
    this.outputLines.push(...lines);

    // Stream full output to disk (uncapped)
    if (this.rawOutputStream) {
      this.rawOutputStream.write(data + '\n');
    }

    // Cap in-memory buffer for UI/observeCrew
    const maxLines =
      this.opts.missionType === 'research' ||
      this.opts.missionType === 'review' ||
      this.opts.missionType === 'architect'
        ? 2000
        : MAX_OUTPUT_LINES;
    if (this.outputLines.length > maxLines) {
      this.outputLines = this.outputLines.slice(-maxLines);
    }
  }
```

- [ ] **Step 5: Close the stream in cleanup**

Find the `cleanup()` method or the exit handler where lifesign timers are cleared. Add stream closing there. Search for `clearInterval(this.lifesignTimer)` and add nearby:

```typescript
      if (this.rawOutputStream) {
        this.rawOutputStream.end();
        this.rawOutputStream = null;
      }
```

- [ ] **Step 6: Run typecheck**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add src/main/starbase/hull.ts
git commit -m "feat(cargo): stream full raw output to disk via WriteStream"
```

---

### Task 6: Hull — Remove Auto-Cargo and Use `'awaiting-cargo-check'`

**Files:**
- Modify: `src/main/starbase/hull.ts`

This is the largest change. There are two blocks of auto-cargo code to remove, and multiple status transitions to change.

- [ ] **Step 1: Remove auto-cargo from research/architect completion block (lines 926-996)**

Find the block starting around line 922:
```typescript
          if (
            (this.opts.missionType === 'research' || this.opts.missionType === 'architect') &&
            status !== 'error'
          ) {
```

Replace the entire block (from `overrideStatus = 'complete'` through the cargo INSERT statements and mission UPDATE) with:

```typescript
            overrideStatus = 'complete';
            const missionLabel = this.opts.missionType === 'architect' ? 'Architect' : 'Research';
            const hasOutput = this.outputLines.join('\n').trim().length > 0;
            const resultMsg = hasOutput
              ? `${missionLabel} completed`
              : `${missionLabel} completed (no output captured)`;

            db.prepare(
              "UPDATE missions SET status = 'awaiting-cargo-check', cargo_checked = 0, result = ?, completed_at = datetime('now') WHERE id = ?"
            ).run(resultMsg, missionId);

            db.prepare(
              "INSERT INTO comms (from_crew, to_crew, type, payload) VALUES (?, 'admiral', 'mission_complete', ?)"
            ).run(
              crewId,
              JSON.stringify({
                missionId,
                status: 'awaiting-cargo-check',
                reason: resultMsg
              })
            );

            db.prepare(
              "INSERT INTO ships_log (crew_id, event_type, detail) VALUES (?, 'exited', ?)"
            ).run(crewId, JSON.stringify({ status: 'complete', reason: resultMsg }));
```

This removes: cargoDir creation, fullOutput/summary extraction, mkdirSync, writeFileSync, manifest building, and the 4 INSERT INTO cargo statements.

- [ ] **Step 2: Remove auto-cargo from safety guard block (lines 1099-1160)**

Find the safety guard block (around line 1027) where `this.opts.missionType === 'research' || this.opts.missionType === 'architect'` is checked. After the git checkout/clean and the error handling block, replace the cargo creation code (starting at `overrideStatus = 'complete'` around line 1099) with:

```typescript
        overrideStatus = 'complete';
        const missionLabel = this.opts.missionType === 'architect' ? 'Architect' : 'Research';
        const hasOutput = this.outputLines.join('\n').trim().length > 0;
        const resultMsg = hasOutput
          ? `${missionLabel} completed`
          : `${missionLabel} completed (no output captured)`;

        db.prepare(
          "UPDATE missions SET status = 'awaiting-cargo-check', cargo_checked = 0, result = ?, completed_at = datetime('now') WHERE id = ?"
        ).run(resultMsg, missionId);

        db.prepare(
          "INSERT INTO comms (from_crew, to_crew, type, payload) VALUES (?, 'admiral', 'mission_complete', ?)"
        ).run(
          crewId,
          JSON.stringify({
            missionId,
            status: 'awaiting-cargo-check',
            reason: resultMsg
          })
        );

        db.prepare(
          "INSERT INTO ships_log (crew_id, event_type, detail) VALUES (?, 'exited', ?)"
        ).run(crewId, JSON.stringify({ status: 'complete', reason: resultMsg }));
```

- [ ] **Step 3: Change repair completion (line 827)**

Change line 827 from:
```typescript
            "UPDATE missions SET status = 'completed', result = 'No changes needed — CI may have self-healed', completed_at = datetime('now') WHERE id = ?"
```
to:
```typescript
            "UPDATE missions SET status = 'awaiting-cargo-check', cargo_checked = 0, result = 'No changes needed — CI may have self-healed', completed_at = datetime('now') WHERE id = ?"
```

Also update the comms payload on line 838 to use `status: 'awaiting-cargo-check'`.

- [ ] **Step 4: Change repair mission complete (line 1564)**

Change line 1564 from:
```typescript
            "UPDATE missions SET status = 'completed', result = 'Repair complete', completed_at = datetime('now') WHERE id = ?"
```
to:
```typescript
            "UPDATE missions SET status = 'awaiting-cargo-check', cargo_checked = 0, result = 'Repair complete', completed_at = datetime('now') WHERE id = ?"
```

- [ ] **Step 5: Update research/architect guidance in init message**

Find the `researchGuidance` and `architectGuidance` strings (around lines 351-358). Update them to mention `fleet cargo send`:

```typescript
      const researchGuidance =
        this.opts.missionType === 'research'
          ? `RESEARCH MISSION GUIDANCE: When your research is complete, save your findings to a file and send them as cargo:\n  fleet cargo send --type findings --file findings.md\nYou may also print findings to stdout as a backup — raw output is captured to disk. Do NOT create pull requests or commit changes.\n\n`
          : '';
      const architectGuidance =
        this.opts.missionType === 'architect'
          ? `ARCHITECT MISSION GUIDANCE: When your design is complete, save your blueprint to a file and send it as cargo:\n  fleet cargo send --type blueprint --file blueprint.md\nYou may also print your design to stdout as a backup — raw output is captured to disk. Do NOT write code or create pull requests.\n\n`
          : '';
```

- [ ] **Step 6: Update safety guard recommendation**

Find the `recommendation` string in the safety guard ships_log (around line 1067). Change from:
```typescript
                'Research/architect crews should print findings to stdout — do not write files to disk. Cargo is captured from terminal output.'
```
to:
```typescript
                'Research/architect crews should use fleet cargo send to persist findings. Raw output is captured as a fallback.'
```

- [ ] **Step 7: Run typecheck**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 8: Commit**

```bash
git add src/main/starbase/hull.ts
git commit -m "feat(cargo): remove auto-cargo from hull, use awaiting-cargo-check status"
```

---

### Task 7: `MissionService.completeMission()` and Socket Server Changes

**Files:**
- Modify: `src/main/starbase/mission-service.ts:83-89`
- Modify: `src/main/socket-server.ts:559-560`
- Modify: `src/main/starbase/sentinel.ts:1125-1127`

- [ ] **Step 1: Change `completeMission()` to set `'awaiting-cargo-check'`**

In `src/main/starbase/mission-service.ts`, change `completeMission()` at line 83:

```typescript
  completeMission(missionId: number, result: string): void {
    this.db
      .prepare(
        "UPDATE missions SET status = 'awaiting-cargo-check', cargo_checked = 0, result = ?, completed_at = datetime('now') WHERE id = ?"
      )
      .run(result, missionId);
    this.eventBus?.emit('starbase-changed', { type: 'starbase-changed' });
  }
```

- [ ] **Step 2: Change review-approved transition in socket server**

In `src/main/socket-server.ts`, change line 560 from:
```typescript
          await missionService.setStatus(id, 'completed');
```
to:
```typescript
          await missionService.setStatus(id, 'awaiting-cargo-check');
```

- [ ] **Step 3: Change sentinel auto-approved transition**

In `src/main/starbase/sentinel.ts`, change line 1126 from:
```typescript
        "UPDATE missions SET status = 'completed', completed_at = datetime('now') WHERE id = ?"
```
to:
```typescript
        "UPDATE missions SET status = 'awaiting-cargo-check', cargo_checked = 0, completed_at = datetime('now') WHERE id = ?"
```

- [ ] **Step 4: Run typecheck**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/main/starbase/mission-service.ts src/main/socket-server.ts src/main/starbase/sentinel.ts
git commit -m "feat(cargo): transition all completion points to awaiting-cargo-check"
```

---

### Task 8: Sentinel — Cargo Evaluation Sweep + Safety Net

**Files:**
- Modify: `src/main/starbase/sentinel.ts`

- [ ] **Step 1: Add cargo evaluation sweep to `_runSweep()`**

After the navigator sweep (around line 401), add:

```typescript
    // 12. Cargo evaluation sweep — check missions awaiting cargo
    await this.cargoEvaluationSweep();
```

- [ ] **Step 2: Implement `cargoEvaluationSweep()`**

Add the method after `navigatorSweep()`:

```typescript
  private async cargoEvaluationSweep(): Promise<void> {
    const { db } = this.deps;

    // Find missions in awaiting-cargo-check that haven't been evaluated yet
    const awaiting = db
      .prepare<
        [],
        {
          id: number;
          sector_id: string;
          type: string | null;
          crew_id: string | null;
          completed_at: string | null;
        }
      >(
        `SELECT id, sector_id, type, crew_id, completed_at FROM missions
         WHERE status = 'awaiting-cargo-check' AND cargo_checked = 0`
      )
      .all();

    for (const mission of awaiting) {
      // Check if explicit cargo already exists
      const existingCargo = db
        .prepare<[number], { id: number }>(
          `SELECT id FROM cargo WHERE mission_id = ? LIMIT 1`
        )
        .get(mission.id);

      if (existingCargo) {
        // Crew sent cargo explicitly — transition to completed
        db.prepare(
          "UPDATE missions SET status = 'completed', cargo_checked = 1 WHERE id = ?"
        ).run(mission.id);
        this.deps.eventBus?.emit('starbase-changed', { type: 'starbase-changed' });
        continue;
      }

      // No explicit cargo — check mission type
      const missionType = mission.type ?? 'code';
      const needsCargo = ['research', 'architect', 'repair', 'review'].includes(missionType);

      if (!needsCargo) {
        // Code missions don't require cargo — transition to completed
        db.prepare(
          "UPDATE missions SET status = 'completed', cargo_checked = 1 WHERE id = ?"
        ).run(mission.id);
        this.deps.eventBus?.emit('starbase-changed', { type: 'starbase-changed' });
        continue;
      }

      // Needs cargo but none sent — attempt FO recovery from raw output
      const starbaseId = this.deps.firstOfficer
        ? (this.deps as unknown as { starbaseId?: string }).starbaseId
        : undefined;

      // Read raw-output.md if it exists
      const rawOutputPath = join(
        process.env.HOME ?? '~',
        '.fleet',
        'starbases',
        `starbase-${starbaseId ?? 'unknown'}`,
        'cargo',
        mission.sector_id,
        String(mission.id),
        'raw-output.md'
      );

      let rawContent = '';
      try {
        const { readFileSync } = await import('fs');
        rawContent = readFileSync(rawOutputPath, 'utf-8');
      } catch {
        // No raw output file — use empty
      }

      if (rawContent.trim().length > 0) {
        // Recover cargo from raw output
        const ts = new Date().toISOString().replace(/[:.]/g, '-');
        const manifest = JSON.stringify({
          title: `${missionType}-output`,
          path: rawOutputPath,
          size: Buffer.byteLength(rawContent, 'utf-8'),
          sourceType: 'recovered-from-raw-output'
        });

        db.prepare(
          `INSERT INTO cargo (crew_id, mission_id, sector_id, type, manifest, verified)
           VALUES (?, ?, ?, ?, ?, 1)`
        ).run(
          mission.crew_id,
          mission.id,
          mission.sector_id,
          `${missionType}_output`,
          manifest
        );
      }

      // Mark as checked and transition to completed
      db.prepare(
        "UPDATE missions SET status = 'completed', cargo_checked = 1 WHERE id = ?"
      ).run(mission.id);
      this.deps.eventBus?.emit('starbase-changed', { type: 'starbase-changed' });
    }

    // Safety net: auto-escalate missions stuck in awaiting-cargo-check for > 5 minutes
    const stuck = db
      .prepare<
        [],
        { id: number; summary: string }
      >(
        `SELECT id, summary FROM missions
         WHERE status = 'awaiting-cargo-check'
           AND completed_at < datetime('now', '-5 minutes')`
      )
      .all();

    for (const mission of stuck) {
      db.prepare(
        "UPDATE missions SET status = 'escalated', cargo_checked = 1 WHERE id = ?"
      ).run(mission.id);
      db.prepare(
        "INSERT INTO comms (to_crew, type, payload) VALUES ('admiral', 'cargo_stuck', ?)"
      ).run(
        JSON.stringify({
          missionId: mission.id,
          summary: mission.summary,
          reason: 'Mission stuck in awaiting-cargo-check for > 5 minutes'
        })
      );
      this.deps.eventBus?.emit('starbase-changed', { type: 'starbase-changed' });
    }
  }
```

- [ ] **Step 3: Add `join` import if not already present**

Check if `join` from `path` is already imported at the top of `sentinel.ts`. If not, add it.

- [ ] **Step 4: Run typecheck**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/main/starbase/sentinel.ts
git commit -m "feat(cargo): add cargo evaluation sweep with FO recovery and safety net"
```

---

### Task 9: Crew Prompt Updates

**Files:**
- Modify: `src/main/starbase/prompts/research-crew.md`
- Modify: `src/main/starbase/prompts/architect-crew.md`
- Modify: `src/main/starbase/prompts/code-crew.md`
- Modify: `src/main/starbase/prompts/repair-crew.md`
- Modify: `src/main/starbase/prompts/review-crew.md`

- [ ] **Step 1: Update research-crew.md**

Replace lines 27-30 (the "Cargo Workflow" section):

```markdown
## Cargo Workflow
- When your research is complete, save findings to a file and send as cargo:
  `fleet cargo send --type findings --file findings.md`
- Use `fleet cargo send` for any artifacts you want to persist (data files, analyses, etc.)
- You may send multiple cargo items
- Your raw terminal output is also captured to disk as a backup
```

- [ ] **Step 2: Update architect-crew.md**

Replace lines 25-28 (the "Cargo Workflow" section):

```markdown
## Cargo Workflow
- When your design is complete, save your blueprint to a file and send it as cargo:
  `fleet cargo send --type blueprint --file blueprint.md`
- Use `fleet cargo send` for any artifacts you want to persist (diagrams, specs, etc.)
- You may send multiple cargo items
- Your raw terminal output is also captured to disk as a backup
```

- [ ] **Step 3: Add cargo section to code-crew.md**

Add before the existing "## Code Organization" section (at line 25):

```markdown
## Cargo Workflow
- If your implementation produces artifacts beyond git commits (reports, analysis files), send them:
  `fleet cargo send --type <type> --file <path>`

```

- [ ] **Step 4: Add cargo section to repair-crew.md**

Add before the "## Workflow" section (at line 44):

```markdown
## Cargo Workflow
- If your repair produces artifacts (diagnostic reports, analysis), send them:
  `fleet cargo send --type repair-report --file report.md`

```

- [ ] **Step 5: Add cargo section to review-crew.md**

Add before the "## Constraints" section (at line 37):

```markdown
## Cargo Workflow
- If your review produces a detailed report beyond the VERDICT, send it:
  `fleet cargo send --type review-report --file review.md`

```

- [ ] **Step 6: Commit**

```bash
git add src/main/starbase/prompts/
git commit -m "feat(cargo): update all crew prompts with fleet cargo send instructions"
```

---

### Task 10: Workspace Template Updates

**Files:**
- Modify: `src/main/starbase/workspace-templates.ts`

- [ ] **Step 1: Update Cargo CLI reference in skill (lines 257-263)**

Replace the cargo section:

```typescript
### Cargo

\`\`\`
fleet cargo list                       # List all Cargo items
fleet cargo send --type <type> --file <path>       # Send explicit Cargo from a file
fleet cargo send --type <type> --content "<str>"   # Send explicit Cargo inline
fleet cargo produce --sector <id> --type <type> --path <path>  # Record produced Cargo
fleet cargo pending --sector <id>      # Show undelivered Cargo for a Sector
\`\`\`
```

- [ ] **Step 2: Update Research Mission Output Format section (lines 498-532)**

Replace the entire "Research Mission Output Format" section:

```typescript
## Research Mission Output Format

When \`FLEET_MISSION_TYPE=research\` or \`FLEET_MISSION_TYPE=architect\`, use \`fleet cargo send\` to explicitly persist your findings.

**Preferred method — explicit cargo send:**

\`\`\`bash
# Save your findings to a file, then send as cargo
fleet cargo send --type findings --file findings.md
fleet cargo send --type blueprint --file blueprint.md
\`\`\`

**Fallback:** Your raw terminal output is also streamed to disk automatically. If you do not send explicit cargo, the First Officer will recover cargo from this raw output after your mission completes.

**How to structure your output (for either method):**

1. Write findings to a markdown file with clear headers, sections, and conclusions
2. Send the file as cargo using \`fleet cargo send\`
3. Do NOT create pull requests or commits — git changes are discarded automatically for research/architect missions

**Example:**
\`\`\`bash
# Write findings to file
cat > findings.md << 'EOF'
## Research Findings: [Topic]

### Summary
[Brief summary of key findings]

### Details
[Detailed investigation results with file:line references]

### Conclusions
[Actionable conclusions and recommendations]
EOF

# Send as cargo
fleet cargo send --type findings --file findings.md
\`\`\`

When a research mission completes, its cargo is available to dependent code missions via the cargo header in their initial message.
```

- [ ] **Step 3: Update Admiral CLAUDE.md cargo reference (around line 82)**

Change line 82 from:
```
When the code crew starts, it receives a header listing the research cargo file paths and can use the Read tool to load findings if the task requires them.
```
to:
```
When the code crew starts, it receives a header listing the research cargo file paths (sent via \`fleet cargo send\` or recovered from raw output) and can use the Read tool to load findings if the task requires them.
```

- [ ] **Step 4: Update Cargo group description (line 709)**

Change:
```
| cargo | Inspect and produce Cargo artifacts. Use when you need to view outputs produced by research Missions or record new artifacts. |
```
to:
```
| cargo | Inspect, send, and produce Cargo artifacts. Use when you need to view outputs, send explicit cargo from a mission, or record new artifacts. |
```

- [ ] **Step 5: Run typecheck**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/main/starbase/workspace-templates.ts
git commit -m "feat(cargo): update workspace templates with fleet cargo send docs"
```

---

### Task 11: Final Verification

- [ ] **Step 1: Run full typecheck**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 2: Run all tests**

Run: `npx vitest run --reporter=verbose`
Expected: All tests PASS (some existing tests may need updates if they assert `status = 'completed'` — update those to expect `'awaiting-cargo-check'` where appropriate)

- [ ] **Step 3: Run lint**

Run: `npm run lint`
Expected: PASS

- [ ] **Step 4: Run build**

Run: `npm run build`
Expected: PASS

- [ ] **Step 5: Fix any failing tests**

If existing tests fail because they expect `status = 'completed'` where we now set `'awaiting-cargo-check'`, update those test assertions. Common places:
- `src/main/__tests__/hull.test.ts` — mission status after research/architect completion
- `src/main/__tests__/first-officer.test.ts` — mission status after FO decisions
- `src/main/__tests__/sentinel.test.ts` — auto-approved mission status

- [ ] **Step 6: Final commit**

```bash
git add -A
git commit -m "fix: update existing tests for awaiting-cargo-check status transition"
```
