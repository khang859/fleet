# First Officer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an automated triage layer (First Officer) that spawns short-lived Claude Code processes to retry failed missions or escalate via markdown memos, reducing operator micro-management.

**Architecture:** The Sentinel watchdog (already running 10s sweeps) gets new checks that detect actionable failures. When found, it spawns a fresh Claude Code CLI process (Sonnet 4.6, headless, stream-json) in its own workspace. The process diagnoses the failure, retries or writes a memo, then exits. The UI shows the First Officer's status in the sidebar and renders memos as GitHub-flavored markdown.

**Tech Stack:** Electron main process (TypeScript), SQLite (better-sqlite3), Claude Code CLI (stream-json protocol), React + Zustand (renderer), react-markdown + remark-gfm + @tailwindcss/typography (memo rendering)

**Spec:** `docs/superpowers/specs/2026-03-19-first-officer-design.md`

---

### Task 1: Database Migration — memos table + missions column

**Files:**

- Modify: `src/main/starbase/migrations.ts`

- [ ] **Step 1: Add migration version 7**

Add to the `MIGRATIONS` array:

```typescript
{
  version: 7,
  name: '007-first-officer',
  sql: `
    CREATE TABLE IF NOT EXISTS memos (
      id TEXT PRIMARY KEY,
      crew_id TEXT REFERENCES crew(id),
      mission_id INTEGER REFERENCES missions(id),
      event_type TEXT NOT NULL,
      file_path TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'unread',
      retry_count INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT (datetime('now')),
      updated_at DATETIME DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_memos_crew_mission ON memos(crew_id, mission_id);
    CREATE INDEX IF NOT EXISTS idx_memos_status ON memos(status);

    ALTER TABLE missions ADD COLUMN first_officer_retry_count INTEGER DEFAULT 0;
  `
}
```

- [ ] **Step 2: Add First Officer config defaults**

Add to `CONFIG_DEFAULTS`:

```typescript
first_officer_max_retries: 3,
first_officer_max_concurrent: 2,
first_officer_timeout: 120,
first_officer_model: 'claude-sonnet-4-6',
```

- [ ] **Step 3: Run the app to verify migration applies**

Run: `npm run dev`
Expected: App starts without migration errors. Check console for `[starbase] Migration 007-first-officer applied`.

- [ ] **Step 4: Commit**

```bash
git add src/main/starbase/migrations.ts
git commit -m "feat(starbase): add first officer database migration"
```

---

### Task 2: MemoService — CRUD for memo records

**Files:**

- Create: `src/main/starbase/memo-service.ts`

- [ ] **Step 1: Create MemoService**

```typescript
import type Database from 'better-sqlite3';
import { randomBytes } from 'crypto';
import type { EventBus } from '../event-bus';

export type MemoRow = {
  id: string;
  crew_id: string | null;
  mission_id: number | null;
  event_type: string;
  file_path: string;
  status: string;
  retry_count: number;
  created_at: string;
  updated_at: string;
};

export class MemoService {
  constructor(
    private db: Database.Database,
    private eventBus?: EventBus
  ) {}

  insert(opts: {
    crewId: string | null;
    missionId: number | null;
    eventType: string;
    filePath: string;
    retryCount?: number;
  }): MemoRow {
    const id = `memo-${randomBytes(4).toString('hex')}`;
    this.db
      .prepare(
        `INSERT INTO memos (id, crew_id, mission_id, event_type, file_path, retry_count)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(id, opts.crewId, opts.missionId, opts.eventType, opts.filePath, opts.retryCount ?? 0);
    this.eventBus?.emit('starbase-changed', { type: 'starbase-changed' });
    return this.get(id)!;
  }

  get(id: string): MemoRow | undefined {
    return this.db.prepare('SELECT * FROM memos WHERE id = ?').get(id) as MemoRow | undefined;
  }

  listUnread(): MemoRow[] {
    return this.db
      .prepare("SELECT * FROM memos WHERE status = 'unread' ORDER BY created_at DESC")
      .all() as MemoRow[];
  }

  listAll(): MemoRow[] {
    return this.db.prepare('SELECT * FROM memos ORDER BY created_at DESC').all() as MemoRow[];
  }

  markRead(id: string): void {
    this.db
      .prepare("UPDATE memos SET status = 'read', updated_at = datetime('now') WHERE id = ?")
      .run(id);
    this.eventBus?.emit('starbase-changed', { type: 'starbase-changed' });
  }

  dismiss(id: string): void {
    this.db
      .prepare("UPDATE memos SET status = 'dismissed', updated_at = datetime('now') WHERE id = ?")
      .run(id);
    this.eventBus?.emit('starbase-changed', { type: 'starbase-changed' });
  }

  getUnreadCount(): number {
    const row = this.db
      .prepare("SELECT COUNT(*) as count FROM memos WHERE status = 'unread'")
      .get() as { count: number };
    return row.count;
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add src/main/starbase/memo-service.ts
git commit -m "feat(starbase): add MemoService for first officer memos"
```

---

### Task 3: FirstOfficer process manager

**Files:**

- Create: `src/main/starbase/first-officer.ts`

This is the core module. It spawns short-lived Claude Code processes for triage, tracks them in-memory, and handles cleanup.

- [ ] **Step 1: Create the FirstOfficer class**

```typescript
import { spawn, ChildProcess } from 'child_process';
import { writeFileSync, mkdirSync, existsSync, readFileSync, unlinkSync, readdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomBytes } from 'crypto';
import type Database from 'better-sqlite3';
import type { ConfigService } from './config-service';
import type { MemoService } from './memo-service';
import type { EventBus } from '../event-bus';

type FirstOfficerDeps = {
  db: Database.Database;
  configService: ConfigService;
  memoService: MemoService;
  eventBus?: EventBus;
  starbaseId: string;
  /** Enriched env with PATH containing claude binary */
  crewEnv?: Record<string, string>;
  /** Path to MCP config JSON for Bridge Controls */
  mcpConfigPath?: string;
};

type ActionableEvent = {
  crewId: string;
  missionId: number;
  sectorId: string;
  sectorName: string;
  eventType: string;
  missionSummary: string;
  missionPrompt: string;
  acceptanceCriteria: string | null;
  verifyCommand: string | null;
  crewOutput: string;
  verifyResult: string | null;
  reviewNotes: string | null;
  retryCount: number;
};

type RunningProcess = {
  proc: ChildProcess;
  crewId: string;
  missionId: number;
  startedAt: number;
};

export class FirstOfficer {
  private running = new Map<string, RunningProcess>();

  constructor(private deps: FirstOfficerDeps) {}

  /** Key for dedup map */
  private key(crewId: string, missionId: number): string {
    return `${crewId}:${missionId}`;
  }

  /** How many First Officer processes are currently running */
  get activeCount(): number {
    return this.running.size;
  }

  /** Is a process already running for this crew+mission? */
  isRunning(crewId: string, missionId: number): boolean {
    return this.running.has(this.key(crewId, missionId));
  }

  /** Get status text for UI */
  getStatusText(): string {
    if (this.running.size === 0) return 'Idle';
    const entries = [...this.running.values()];
    if (entries.length === 1) return `Triaging ${entries[0].crewId}`;
    return `Triaging ${entries.length} issues`;
  }

  /** Get status for UI: 'idle' | 'working' | 'memo' */
  getStatus(): 'idle' | 'working' | 'memo' {
    if (this.running.size > 0) return 'working';
    if (this.deps.memoService.getUnreadCount() > 0) return 'memo';
    return 'idle';
  }

  /**
   * Spawn a First Officer process to handle an actionable event.
   * Returns false if dedup/concurrency prevents spawning.
   */
  async dispatch(event: ActionableEvent): Promise<boolean> {
    const { configService } = this.deps;
    const maxConcurrent = configService.get('first_officer_max_concurrent') as number;
    const maxRetries = configService.get('first_officer_max_retries') as number;
    const timeout = configService.get('first_officer_timeout') as number;
    const model = configService.get('first_officer_model') as string;

    const k = this.key(event.crewId, event.missionId);

    // Dedup: already running for this crew+mission
    if (this.running.has(k)) return false;

    // Concurrency limit
    if (this.running.size >= maxConcurrent) return false;

    // Retries exhausted — force escalation
    if (event.retryCount >= maxRetries) {
      this.writeEscalationMemo(event, 'Maximum retries exhausted');
      return true;
    }

    // Ensure workspace exists
    const workspace = this.getWorkspacePath();
    const memosDir = join(workspace, 'memos');
    mkdirSync(memosDir, { recursive: true });

    // Ensure CLAUDE.md exists
    const claudeMdPath = join(workspace, 'CLAUDE.md');
    if (!existsSync(claudeMdPath)) {
      writeFileSync(claudeMdPath, this.generateClaudeMd(), 'utf-8');
    }

    // Write system prompt to temp file
    const promptDir = join(tmpdir(), 'fleet-first-officer');
    mkdirSync(promptDir, { recursive: true });
    const spFile = join(promptDir, `${event.crewId}-sp.md`);
    writeFileSync(spFile, this.buildSystemPrompt(event, maxRetries), 'utf-8');

    // Write initial message to temp file
    const msgFile = join(promptDir, `${event.crewId}-msg.md`);
    writeFileSync(msgFile, this.buildInitialMessage(event), 'utf-8');

    // Build CLI args
    const cmdArgs = [
      '--output-format',
      'stream-json',
      '--input-format',
      'stream-json',
      '--dangerously-skip-permissions',
      '--model',
      model,
      '--append-system-prompt-file',
      spFile
    ];
    if (this.deps.mcpConfigPath) {
      cmdArgs.push('--mcp-config', this.deps.mcpConfigPath);
    }

    const mergedEnv: Record<string, string> = {
      ...(this.deps.crewEnv ?? (process.env as Record<string, string>)),
      FLEET_FIRST_OFFICER: '1',
      FLEET_CREW_ID: event.crewId,
      FLEET_MISSION_ID: String(event.missionId)
    };

    try {
      const proc = spawn('claude', cmdArgs, {
        cwd: workspace,
        env: mergedEnv,
        stdio: ['pipe', 'pipe', 'pipe']
      });

      const entry: RunningProcess = {
        proc,
        crewId: event.crewId,
        missionId: event.missionId,
        startedAt: Date.now()
      };
      this.running.set(k, entry);

      // Send initial message
      const initMsg =
        JSON.stringify({
          type: 'user',
          message: {
            role: 'user',
            content: `Read and execute the triage instructions in ${msgFile}. Delete the file when done.`
          },
          parent_tool_use_id: null,
          session_id: ''
        }) + '\n';
      proc.stdin!.write(initMsg);

      // Parse stdout for result message
      let stdoutBuffer = '';
      proc.stdout!.on('data', (chunk: Buffer) => {
        stdoutBuffer += chunk.toString();
        const lines = stdoutBuffer.split('\n');
        stdoutBuffer = lines.pop() ?? '';
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const msg = JSON.parse(line);
            if (msg.type === 'result') {
              try {
                proc.stdin?.end();
              } catch {
                /* ignore */
              }
            }
          } catch {
            /* non-JSON */
          }
        }
      });

      proc.stderr!.on('data', (chunk: Buffer) => {
        console.error(`[first-officer:${event.crewId}] stderr:`, chunk.toString().trim());
      });

      // Hard timeout
      const timer = setTimeout(() => {
        if (!proc.killed) {
          console.warn(`[first-officer] Timeout for ${k}, killing`);
          try {
            proc.kill('SIGTERM');
          } catch {
            /* already dead */
          }
          setTimeout(() => {
            if (!proc.killed)
              try {
                proc.kill('SIGKILL');
              } catch {
                /* ignore */
              }
          }, 5000);
        }
      }, timeout * 1000);

      // Cleanup on exit
      proc.on('exit', (code) => {
        clearTimeout(timer);
        this.running.delete(k);

        // Clean up temp files
        try {
          unlinkSync(spFile);
        } catch {
          /* ignore */
        }
        try {
          unlinkSync(msgFile);
        } catch {
          /* ignore */
        }

        if (code !== 0) {
          // First Officer itself crashed — fallback escalation
          this.writeEscalationMemo(event, `First Officer process crashed (exit code: ${code})`);
        }

        // Check if new memos were written and insert DB records
        this.scanForNewMemos(event);

        this.deps.eventBus?.emit('starbase-changed', { type: 'starbase-changed' });
      });

      proc.on('error', (err) => {
        clearTimeout(timer);
        this.running.delete(k);
        this.writeEscalationMemo(event, `First Officer spawn failed: ${err.message}`);
        this.deps.eventBus?.emit('starbase-changed', { type: 'starbase-changed' });
      });

      this.deps.eventBus?.emit('starbase-changed', { type: 'starbase-changed' });
      return true;
    } catch (err) {
      this.writeEscalationMemo(
        event,
        `First Officer spawn failed: ${err instanceof Error ? err.message : 'unknown'}`
      );
      return false;
    }
  }

  /** Scan memos dir for files not yet in DB and insert records */
  private scanForNewMemos(event: ActionableEvent): void {
    const memosDir = join(this.getWorkspacePath(), 'memos');
    if (!existsSync(memosDir)) return;

    try {
      const files = readdirSync(memosDir) as string[];
      for (const file of files) {
        if (!file.endsWith('.md')) continue;
        const filePath = join(memosDir, file);
        // Check if already tracked
        const existing = this.deps.db
          .prepare('SELECT 1 FROM memos WHERE file_path = ? LIMIT 1')
          .get(filePath);
        if (existing) continue;

        this.deps.memoService.insert({
          crewId: event.crewId,
          missionId: event.missionId,
          eventType: event.eventType,
          filePath,
          retryCount: event.retryCount
        });
      }
    } catch {
      /* ignore scan errors */
    }
  }

  /** Write a fallback escalation memo when the First Officer itself fails */
  private writeEscalationMemo(event: ActionableEvent, reason: string): void {
    const memosDir = join(this.getWorkspacePath(), 'memos');
    mkdirSync(memosDir, { recursive: true });

    const slug = event.missionSummary
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .slice(0, 40);
    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 16);
    const filename = `${ts}-${event.crewId}-${slug}.md`;
    const filePath = join(memosDir, filename);

    const content = `## Triage Failed: ${event.missionSummary}

**Crew:** ${event.crewId} · **Sector:** ${event.sectorName} · **Attempts:** ${event.retryCount}/${this.deps.configService.get('first_officer_max_retries')}

### What happened
${reason}

### Failure type
${event.eventType}

### Last crew output (tail)
\`\`\`
${event.crewOutput.split('\n').slice(-30).join('\n')}
\`\`\`

### Recommendation
Manual investigation required. The automated triage process was unable to resolve this issue.
`;

    writeFileSync(filePath, content, 'utf-8');
    this.deps.memoService.insert({
      crewId: event.crewId,
      missionId: event.missionId,
      eventType: event.eventType,
      filePath,
      retryCount: event.retryCount
    });
  }

  private getWorkspacePath(): string {
    return join(
      process.env.HOME ?? '~',
      '.fleet',
      'starbases',
      `starbase-${this.deps.starbaseId}`,
      'first-officer'
    );
  }

  private generateClaudeMd(): string {
    return `# First Officer

You are the First Officer aboard Star Command. You are NOT the Admiral.
Ignore any CLAUDE.md instructions about the Admiral role.

## Your Role
You triage failed missions. For each invocation you will:
1. Analyze why a crew's mission failed
2. Decide whether to RETRY (re-queue with a revised prompt) or ESCALATE (write a memo)

## Retry
Use the mission management MCP tools to re-queue the mission with a revised prompt.
Adjust the prompt based on the failure — fix test expectations, narrow scope, add missing context.

## Escalate
Write a markdown memo to \`./memos/\` with:
- What happened (failure details)
- What was tried (retry history)
- Recommendation (split mission, manual fix, etc.)

## Rules
- Never create new missions unrelated to the failure
- Never modify sectors or supply routes
- Never answer hailing questions — only escalate them as memos
- Keep memos concise and actionable
`;
  }

  private buildSystemPrompt(event: ActionableEvent, maxRetries: number): string {
    return `You are the First Officer aboard Star Command. Your role is to
triage failed missions and decide whether to retry or escalate.

You are NOT the Admiral. Ignore any CLAUDE.md instructions about
the Admiral role. Your job is narrowly scoped to this specific failure.

You are analyzing a failure for crew ${event.crewId} on mission "${event.missionSummary}"
in sector ${event.sectorName}.

## Context
- Retry attempt: ${event.retryCount}/${maxRetries}
- Failure type: ${event.eventType}
- Sector verify command: ${event.verifyCommand ?? 'none configured'}
- Acceptance criteria: ${event.acceptanceCriteria ?? 'none specified'}

## Your Options
1. RETRY — use the mission management tools to re-queue with a revised prompt
2. ESCALATE — write a memo to ./memos/ explaining what happened and recommending next steps

Rules:
- If this is a transient failure (crash, OOM, timeout on a reasonable scope), retry with the same or slightly adjusted prompt
- If tests failed, read the test output and adjust the prompt to address specific failures
- If you've seen the same failure pattern across retries, escalate
- If the mission scope seems too large, recommend splitting in your memo
- Never retry more than ${maxRetries} times total
- Write memos in markdown
`;
  }

  private buildInitialMessage(event: ActionableEvent): string {
    let msg = `# Triage Assignment

## Failed Mission
**Summary:** ${event.missionSummary}
**Crew:** ${event.crewId}
**Sector:** ${event.sectorName} (${event.sectorId})
**Failure type:** ${event.eventType}
**Retry attempt:** ${event.retryCount + 1}

## Original Mission Prompt
${event.missionPrompt}

## Crew Output (last lines)
\`\`\`
${event.crewOutput}
\`\`\`
`;

    if (event.verifyResult) {
      msg += `\n## Verification Result\n\`\`\`json\n${event.verifyResult}\n\`\`\`\n`;
    }

    if (event.reviewNotes) {
      msg += `\n## Review Notes\n${event.reviewNotes}\n`;
    }

    msg += `\nAnalyze this failure and decide: RETRY or ESCALATE.\n`;
    return msg;
  }

  /** Write a memo for an unanswered hailing request (no process spawn needed) */
  writeHailingMemo(opts: {
    crewId: string;
    missionId: number | null;
    sectorName: string;
    payload: string;
    createdAt: string;
  }): void {
    const memosDir = join(this.getWorkspacePath(), 'memos');
    mkdirSync(memosDir, { recursive: true });

    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 16);
    const filename = `${ts}-${opts.crewId}-hailing.md`;
    const filePath = join(memosDir, filename);

    let payloadText = '';
    try {
      const parsed = JSON.parse(opts.payload);
      payloadText = parsed.message ?? parsed.question ?? JSON.stringify(parsed, null, 2);
    } catch {
      payloadText = opts.payload;
    }

    const content = `## Unanswered Hailing: ${opts.crewId}

**Crew:** ${opts.crewId} · **Sector:** ${opts.sectorName} · **Waiting since:** ${opts.createdAt}

### Message
${payloadText}

### Action Required
This crew has been waiting for a response for over 60 seconds. Please review and respond via the Admiral.
`;
    writeFileSync(filePath, content, 'utf-8');
    this.deps.memoService.insert({
      crewId: opts.crewId,
      missionId: opts.missionId,
      eventType: 'unanswered-hailing',
      filePath
    });
  }

  /** Kill all running processes (app shutdown) */
  shutdown(): void {
    for (const [k, entry] of this.running) {
      try {
        entry.proc.kill('SIGKILL');
      } catch {
        /* already dead */
      }
      this.running.delete(k);
    }
  }

  /** Clean up orphaned processes on startup (reconciliation) */
  reconcile(): void {
    // First Officer processes are ephemeral (max 120s) — if Fleet restarted,
    // they're already dead. Just clear the map.
    this.running.clear();
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add src/main/starbase/first-officer.ts
git commit -m "feat(starbase): add FirstOfficer process manager"
```

---

### Task 4: Sentinel integration — detect actionable events and dispatch

**Files:**

- Modify: `src/main/starbase/sentinel.ts`

- [ ] **Step 1: Add FirstOfficer dependency to Sentinel**

Add to the `SentinelDeps` type:

```typescript
import type { FirstOfficer } from './first-officer'
import type { CrewService } from './crew-service'

// In SentinelDeps:
firstOfficer?: FirstOfficer
crewService?: CrewService
```

Add a new `MissionRow` type at the top (after `SectorRow`):

```typescript
type MissionRow = {
  id: number;
  sector_id: string;
  crew_id: string | null;
  summary: string;
  prompt: string;
  acceptance_criteria: string | null;
  status: string;
  result: string | null;
  verify_result: string | null;
  review_notes: string | null;
  first_officer_retry_count: number;
};
```

- [ ] **Step 2: Add First Officer sweep step after socket health check**

At the end of `runSweep()`, after the socket health check (step 8), add:

```typescript
// 9. First Officer triage — detect actionable failures and dispatch
if (this.deps.firstOfficer) {
  await this.firstOfficerSweep();
}
```

- [ ] **Step 3: Implement firstOfficerSweep method**

Add to the `Sentinel` class:

```typescript
private async firstOfficerSweep(): Promise<void> {
  const { db, configService, firstOfficer } = this.deps
  if (!firstOfficer) return

  const maxRetries = configService.get('first_officer_max_retries') as number

  // Find crew that just entered error/lost/timeout status and have a mission
  const failedCrew = db
    .prepare(
      `SELECT c.id as crew_id, c.sector_id, c.mission_id,
              m.id as mid, m.summary, m.prompt, m.acceptance_criteria,
              m.status as mission_status, m.result, m.verify_result,
              m.review_notes, m.first_officer_retry_count,
              s.name as sector_name, s.verify_command
       FROM crew c
       JOIN missions m ON m.id = c.mission_id
       JOIN sectors s ON s.id = c.sector_id
       WHERE c.status IN ('error', 'lost', 'timeout')
         AND m.status IN ('failed', 'failed-verification', 'review-rejected')
         AND m.first_officer_retry_count < ?
         AND NOT EXISTS (
           SELECT 1 FROM memos
           WHERE crew_id = c.id AND mission_id = m.id AND status = 'unread'
         )`
    )
    .all(maxRetries) as Array<{
      crew_id: string
      sector_id: string
      mission_id: number
      mid: number
      summary: string
      prompt: string
      acceptance_criteria: string | null
      mission_status: string
      result: string | null
      verify_result: string | null
      review_notes: string | null
      first_officer_retry_count: number
      sector_name: string
      verify_command: string | null
    }>

  for (const row of failedCrew) {
    if (firstOfficer.isRunning(row.crew_id, row.mid)) continue

    // Get crew output from Hull buffer (via CrewService) or fall back to mission result + verify_result
    let crewOutput = row.result ?? 'No output captured'
    if (this.deps.crewService) {
      const hullOutput = this.deps.crewService.observeCrew(row.crew_id)
      if (hullOutput) crewOutput = hullOutput
    }
    // Append verify_result if available (structured test output)
    if (row.verify_result) {
      try {
        const vr = JSON.parse(row.verify_result)
        if (vr.stdout) crewOutput += '\n\n--- Verification Output ---\n' + vr.stdout
        if (vr.stderr) crewOutput += '\n\n--- Verification Stderr ---\n' + vr.stderr
      } catch { /* ignore parse errors */ }
    }

    const dispatched = await firstOfficer.dispatch({
      crewId: row.crew_id,
      missionId: row.mid,
      sectorId: row.sector_id,
      sectorName: row.sector_name,
      eventType: row.mission_status === 'failed-verification' ? 'verification-failed'
        : row.mission_status === 'review-rejected' ? 'review-rejected' : 'error',
      missionSummary: row.summary,
      missionPrompt: row.prompt,
      acceptanceCriteria: row.acceptance_criteria,
      verifyCommand: row.verify_command,
      crewOutput,
      verifyResult: row.verify_result,
      reviewNotes: row.review_notes,
      retryCount: row.first_officer_retry_count,
    })

    if (dispatched) {
      // Only increment retry count if an actual process was spawned (not escalation-only)
      // Escalation-only happens when retryCount >= maxRetries — dispatch returns true but
      // no process runs. Check if a process is now running for this crew/mission.
      if (firstOfficer.isRunning(row.crew_id, row.mid)) {
        db.prepare(
          'UPDATE missions SET first_officer_retry_count = first_officer_retry_count + 1 WHERE id = ?'
        ).run(row.mid)
      }

      db.prepare(
        "INSERT INTO ships_log (crew_id, event_type, detail) VALUES (?, 'first_officer_dispatched', ?)"
      ).run(row.crew_id, JSON.stringify({ missionId: row.mid, retryCount: row.first_officer_retry_count + 1 }))
    }
  }

  // Also check for unanswered hailing > 60s (escalation only, no auto-answer)
  const unansweredHailing = db
    .prepare(
      `SELECT c.id as comm_id, c.from_crew, c.payload, c.created_at,
              cr.sector_id, cr.mission_id,
              s.name as sector_name
       FROM comms c
       JOIN crew cr ON cr.id = c.from_crew
       JOIN sectors s ON s.id = cr.sector_id
       WHERE c.type = 'hailing'
         AND c.read = 0
         AND c.created_at < datetime('now', '-60 seconds')
         AND NOT EXISTS (
           SELECT 1 FROM memos
           WHERE crew_id = c.from_crew AND event_type = 'unanswered-hailing'
             AND status = 'unread'
         )
       LIMIT 5`
    )
    .all() as Array<{
      comm_id: number
      from_crew: string
      payload: string
      created_at: string
      sector_id: string
      mission_id: number | null
      sector_name: string
    }>

  for (const hail of unansweredHailing) {
    // Write a hailing memo via FirstOfficer's escalation (no process spawn needed)
    firstOfficer.writeHailingMemo({
      crewId: hail.from_crew,
      missionId: hail.mission_id,
      sectorName: hail.sector_name,
      payload: hail.payload,
      createdAt: hail.created_at,
    })
  }
}
```

Add the required import at the top of sentinel.ts:

```typescript
import { join } from 'path';
```

- [ ] **Step 4: Commit**

```bash
git add src/main/starbase/sentinel.ts
git commit -m "feat(starbase): integrate first officer triage into sentinel sweep"
```

---

### Task 5: Wire FirstOfficer into app initialization

**Files:**

- Modify: `src/main/index.ts` (the starbase initialization section)

- [ ] **Step 1: Import and instantiate FirstOfficer + MemoService**

After the existing service instantiations (crewService, missionService, etc.), add:

```typescript
import { MemoService } from './starbase/memo-service';
import { FirstOfficer } from './starbase/first-officer';

// After configService, commsService, etc. are created:
const memoService = new MemoService(starbaseDb.getDb(), eventBus);

const firstOfficer = new FirstOfficer({
  db: starbaseDb.getDb(),
  configService,
  memoService,
  eventBus,
  starbaseId: starbaseDb.getStarbaseId(),
  crewEnv: crewEnv,
  mcpConfigPath: undefined // TODO: wire MCP config when available
});
```

- [ ] **Step 2: Pass FirstOfficer to Sentinel**

Update the Sentinel constructor call to include `firstOfficer`:

```typescript
sentinel = new Sentinel({
  db: starbaseDb.getDb(),
  configService,
  eventBus,
  supervisor: socketSupervisor ?? undefined,
  socketPath: SOCKET_PATH,
  firstOfficer,
  crewService
});
```

- [ ] **Step 3: Add FirstOfficer to app shutdown**

In the `app.on('before-quit')` or shutdown handler, add:

```typescript
firstOfficer.shutdown();
```

- [ ] **Step 4: Add First Officer status to starbase-changed event payload**

In the `eventBus.on('starbase-changed')` handler, add memo data to the payload sent to renderer:

```typescript
eventBus.on('starbase-changed', () => {
  const w = mainWindow;
  if (!w || w.isDestroyed()) return;
  w.webContents.send(IPC_CHANNELS.STARBASE_STATUS_UPDATE, {
    crew: crewService!.listCrew(),
    missions: missionService!.listMissions(),
    sectors: sectorService!.listSectors(),
    unreadCount: commsService!.getUnread('admiral').length,
    firstOfficer: {
      status: firstOfficer.getStatus(),
      statusText: firstOfficer.getStatusText(),
      unreadMemos: memoService.getUnreadCount()
    }
  });
});
```

- [ ] **Step 5: Add reconciliation call and ensure workspace exists**

In the reconciliation section, add:

```typescript
firstOfficer.reconcile();

// Ensure First Officer workspace exists
const foWorkspace = join(
  process.env.HOME ?? '~',
  '.fleet',
  'starbases',
  `starbase-${starbaseDb.getStarbaseId()}`,
  'first-officer'
);
mkdirSync(join(foWorkspace, 'memos'), { recursive: true });
```

- [ ] **Step 6: Commit**

```bash
git add src/main/index.ts
git commit -m "feat(starbase): wire first officer into app initialization"
```

---

### Task 6: IPC handlers for memo operations

**Files:**

- Modify: `src/main/ipc-handlers.ts` (or wherever starbase IPC handlers live)
- Modify: `src/shared/constants.ts` (add IPC channel names)
- Modify: `src/preload/index.ts` (expose to renderer)

- [ ] **Step 1: Add IPC channel constants**

In `src/shared/constants.ts`, add to `IPC_CHANNELS`:

```typescript
MEMO_LIST: 'memo:list',
MEMO_READ: 'memo:read',
MEMO_DISMISS: 'memo:dismiss',
MEMO_CONTENT: 'memo:content',
```

- [ ] **Step 2: Add IPC handlers**

Register handlers for memo operations:

```typescript
ipcMain.handle(IPC_CHANNELS.MEMO_LIST, () => {
  return memoService.listAll();
});

ipcMain.handle(IPC_CHANNELS.MEMO_READ, (_e, id: string) => {
  memoService.markRead(id);
});

ipcMain.handle(IPC_CHANNELS.MEMO_DISMISS, (_e, id: string) => {
  memoService.dismiss(id);
});

ipcMain.handle(IPC_CHANNELS.MEMO_CONTENT, (_e, filePath: string) => {
  // Security: only allow reading from the first-officer/memos/ directory
  const allowedBase = join(process.env.HOME ?? '~', '.fleet', 'starbases');
  const resolved = require('path').resolve(filePath);
  if (!resolved.startsWith(allowedBase) || !resolved.includes('first-officer/memos/')) {
    return null;
  }
  try {
    return readFileSync(resolved, 'utf-8');
  } catch {
    return null;
  }
});
```

- [ ] **Step 3: Expose in preload**

Add to the `starbase` namespace inside `fleetApi` (following the existing `window.fleet.starbase.*` pattern):

```typescript
// Inside the starbase: { ... } block in fleetApi:
memoList: (): Promise<unknown[]> =>
  ipcRenderer.invoke(IPC_CHANNELS.MEMO_LIST),
memoRead: (id: string): Promise<void> =>
  ipcRenderer.invoke(IPC_CHANNELS.MEMO_READ, id),
memoDismiss: (id: string): Promise<void> =>
  ipcRenderer.invoke(IPC_CHANNELS.MEMO_DISMISS, id),
memoContent: (filePath: string): Promise<string | null> =>
  ipcRenderer.invoke(IPC_CHANNELS.MEMO_CONTENT, filePath),
```

- [ ] **Step 4: Commit**

```bash
git add src/shared/constants.ts src/main/ipc-handlers.ts src/preload/index.ts
git commit -m "feat(starbase): add memo IPC handlers"
```

---

### Task 7: Install renderer dependencies

**Files:**

- Modify: `package.json`

- [ ] **Step 1: Install markdown rendering dependencies**

```bash
npm install react-markdown remark-gfm @tailwindcss/typography
```

- [ ] **Step 2: Add typography plugin to Tailwind config**

In the Tailwind config file, add `@tailwindcss/typography` to plugins:

```typescript
plugins: [require('@tailwindcss/typography')];
```

- [ ] **Step 3: Commit**

```bash
git add package.json package-lock.json tailwind.config.*
git commit -m "chore: add react-markdown and typography dependencies"
```

---

### Task 8: Zustand store — First Officer state

**Files:**

- Modify: `src/renderer/src/store/star-command-store.ts`

- [ ] **Step 1: Add First Officer state to the store**

Add types:

```typescript
export type MemoInfo = {
  id: string;
  crew_id: string | null;
  mission_id: number | null;
  event_type: string;
  file_path: string;
  status: string;
  retry_count: number;
  created_at: string;
  updated_at: string;
};

export type FirstOfficerStatus = {
  status: 'idle' | 'working' | 'memo';
  statusText: string;
  unreadMemos: number;
};
```

Add to `StarCommandStore`:

```typescript
// First Officer
firstOfficerStatus: FirstOfficerStatus

// Actions
setFirstOfficerStatus: (status: FirstOfficerStatus) => void
```

Add defaults:

```typescript
firstOfficerStatus: { status: 'idle', statusText: 'Idle', unreadMemos: 0 },

setFirstOfficerStatus: (status) => set({ firstOfficerStatus: status }),
```

- [ ] **Step 2: Update the STARBASE_STATUS_UPDATE handler to include First Officer data**

In the renderer's IPC listener (wherever `STARBASE_STATUS_UPDATE` is handled), extract and set the `firstOfficer` field from the payload.

- [ ] **Step 3: Commit**

```bash
git add src/renderer/src/store/star-command-store.ts
git commit -m "feat(ui): add first officer state to star command store"
```

---

### Task 9: First Officer sidebar section

**Files:**

- Modify: `src/renderer/src/components/star-command/AdmiralSidebar.tsx`

- [ ] **Step 1: Add First Officer section below the Admiral section**

After the Admiral avatar section, add:

```tsx
{
  /* First Officer */
}
<div className="flex flex-col items-center pt-4 pb-4 border-b border-neutral-800">
  <img
    src={foSrc}
    alt="First Officer"
    width={128}
    height={128}
    className="rounded"
    style={{ imageRendering: 'pixelated' }}
  />
  <span className="text-xs font-mono text-teal-400 uppercase tracking-widest mt-2">
    First Officer
  </span>
  <div className="flex items-center gap-1.5 mt-1">
    <span
      className={`w-2 h-2 rounded-full ${
        firstOfficerStatus.status === 'working'
          ? 'bg-teal-400 animate-pulse'
          : firstOfficerStatus.status === 'memo'
            ? 'bg-yellow-400'
            : 'bg-green-400'
      }`}
    />
    <span className="text-[10px] font-mono text-neutral-500 uppercase tracking-wider">
      {firstOfficerStatus.statusText}
    </span>
  </div>
  {firstOfficerStatus.unreadMemos > 0 && (
    <button
      onClick={onMemoClick}
      className="mt-2 flex items-center gap-1.5 px-2 py-1 rounded bg-neutral-800 hover:bg-neutral-700 transition-colors"
    >
      <span className="bg-amber-600 text-white text-[10px] font-mono font-bold rounded-full w-5 h-5 flex items-center justify-center flex-shrink-0">
        {firstOfficerStatus.unreadMemos > 9 ? '9+' : firstOfficerStatus.unreadMemos}
      </span>
      <span className="text-xs text-neutral-300">
        {firstOfficerStatus.unreadMemos === 1 ? 'memo' : 'memos'}
      </span>
    </button>
  )}
</div>;
```

Import First Officer images (use Admiral images as placeholders until real assets are generated):

```typescript
// TODO: Replace with actual First Officer pixel art assets when generated
import foDefault from '../../assets/admiral-default.png';
import foWorking from '../../assets/admiral-thinking.png';
import foEscalation from '../../assets/admiral-alert.png';
import foIdle from '../../assets/admiral-standby.png';

const FO_IMAGES: Record<string, string> = {
  idle: foIdle,
  working: foWorking,
  memo: foEscalation,
  default: foDefault
};
```

Update the `<img>` src to switch based on status:

```typescript
const foSrc = FO_IMAGES[firstOfficerStatus.status] ?? FO_IMAGES.default;
```

Add props for the memo click handler and first officer status from the store.

- [ ] **Step 2: Commit**

```bash
git add src/renderer/src/components/star-command/AdmiralSidebar.tsx
git commit -m "feat(ui): add first officer section to sidebar"
```

---

### Task 10: Memo viewer panel

**Files:**

- Create: `src/renderer/src/components/star-command/MemoPanel.tsx`

- [ ] **Step 1: Create MemoPanel component**

```tsx
import { useState, useEffect } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { MemoInfo } from '../../store/star-command-store';

type MemoPanelProps = {
  onClose: () => void;
};

export function MemoPanel({ onClose }: MemoPanelProps) {
  const [memos, setMemos] = useState<MemoInfo[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [content, setContent] = useState<string | null>(null);

  useEffect(() => {
    loadMemos();
  }, []);

  async function loadMemos() {
    const list = await window.fleet.starbase.memoList();
    setMemos(list);
    if (list.length > 0 && !selectedId) {
      selectMemo(list[0]);
    }
  }

  async function selectMemo(memo: MemoInfo) {
    setSelectedId(memo.id);
    const text = await window.fleet.starbase.memoContent(memo.file_path);
    setContent(text);
    if (memo.status === 'unread') {
      await window.fleet.starbase.memoRead(memo.id);
      loadMemos();
    }
  }

  async function dismissMemo(id: string) {
    await window.fleet.starbase.memoDismiss(id);
    loadMemos();
    if (selectedId === id) {
      setSelectedId(null);
      setContent(null);
    }
  }

  const activeMemos = memos.filter((m) => m.status !== 'dismissed');

  return (
    <div className="flex flex-col h-full bg-neutral-900">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-neutral-800">
        <h2 className="text-sm font-mono text-teal-400 uppercase tracking-widest">
          First Officer Memos
        </h2>
        <button onClick={onClose} className="text-neutral-500 hover:text-neutral-300 text-sm">
          Close
        </button>
      </div>

      <div className="flex flex-1 overflow-hidden">
        {/* Memo list */}
        <div className="w-64 border-r border-neutral-800 overflow-y-auto">
          {activeMemos.length === 0 ? (
            <div className="p-4 text-xs text-neutral-500">No memos</div>
          ) : (
            activeMemos.map((memo) => (
              <button
                key={memo.id}
                onClick={() => selectMemo(memo)}
                className={`w-full text-left px-3 py-2 border-b border-neutral-800 hover:bg-neutral-800 transition-colors ${
                  selectedId === memo.id ? 'bg-neutral-800' : ''
                }`}
              >
                <div className="flex items-center gap-2">
                  {memo.status === 'unread' && (
                    <span className="w-2 h-2 rounded-full bg-amber-500 flex-shrink-0" />
                  )}
                  <span className="text-xs text-neutral-300 truncate">{memo.event_type}</span>
                </div>
                <div className="text-[10px] text-neutral-600 mt-0.5">
                  {memo.crew_id} · {new Date(memo.created_at).toLocaleTimeString()}
                </div>
              </button>
            ))
          )}
        </div>

        {/* Memo content */}
        <div className="flex-1 overflow-y-auto p-6">
          {content ? (
            <div className="prose prose-invert prose-sm max-w-none">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>
            </div>
          ) : (
            <div className="text-xs text-neutral-500">Select a memo to read</div>
          )}

          {selectedId && (
            <div className="mt-4 pt-4 border-t border-neutral-800">
              <button
                onClick={() => dismissMemo(selectedId)}
                className="text-xs text-neutral-500 hover:text-neutral-300 px-3 py-1 rounded border border-neutral-700 hover:border-neutral-600 transition-colors"
              >
                Dismiss
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Wire MemoPanel into StarCommandTab**

Add a state variable `showMemos` and conditionally render `<MemoPanel />` when the user clicks the First Officer's memo badge. Pass the `onMemoClick` handler down to `AdmiralSidebar`.

- [ ] **Step 3: Commit**

```bash
git add src/renderer/src/components/star-command/MemoPanel.tsx
git commit -m "feat(ui): add memo viewer panel with markdown rendering"
```

---

### Task 11: Pixel art asset prompts

**Files:**

- Modify: `star-command-asset-prompts.md`

- [ ] **Step 1: Add First Officer section to the asset prompts file**

Add a new section after the Admiral portraits (section 2):

```markdown
## 2b. First Officer Avatar / Portrait

### 2b-a. First Officer Portrait — Default
```

{style prefix}, pixel art character portrait, front-facing bust shot,
female First Officer with sharp features, short practical hair, small
tactical headset with amber LED accent on one ear, holding a glowing
data-pad at chest level, confident focused expression, fitted dark coat
with high collar similar to Admiral but with amber rank stripe on shoulder,
dark navy background with subtle teal grid lines, 64x64 pixels, portrait
avatar, clean readable face details

```

### 2b-b. First Officer Portrait — Working
```

{style prefix}, pixel art character portrait, front-facing bust shot,
same female First Officer with short practical hair and tactical headset,
eyes focused down on glowing data-pad, small teal processing indicators
near headset, concentrated expression, dark navy background,
64x64 pixels, portrait avatar

```

### 2b-c. First Officer Portrait — Escalation
```

{style prefix}, pixel art character portrait, front-facing bust shot,
same female First Officer with short practical hair and tactical headset,
looking up from data-pad with alert expression, headset flashing amber,
one hand raised slightly as if flagging attention, dark navy background
with subtle amber tint, 64x64 pixels, portrait avatar

```

### 2b-d. First Officer Portrait — Idle
```

{style prefix}, pixel art character portrait, front-facing bust shot,
same female First Officer with short practical hair and tactical headset,
relaxed neutral expression, data-pad lowered to side, headset glow dimmed,
dark navy background slightly darker than default, 64x64 pixels,
portrait avatar

```

```

- [ ] **Step 2: Commit**

```bash
git add star-command-asset-prompts.md
git commit -m "docs: add first officer pixel art asset prompts"
```

---

### Task 12: Integration test

**Files:**

- Create: `src/main/__tests__/first-officer.test.ts`

- [ ] **Step 1: Write test for FirstOfficer dispatch and memo creation**

Test the core flow: create a FirstOfficer with a mock DB, dispatch an event with retries exhausted, verify a memo file is written and DB record created.

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, existsSync, readdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { runMigrations } from '../starbase/db';
import { MemoService } from '../starbase/memo-service';
import { FirstOfficer } from '../starbase/first-officer';
import { ConfigService } from '../starbase/config-service';

describe('FirstOfficer', () => {
  let db: Database.Database;
  let tmpDir: string;
  let memoService: MemoService;
  let configService: ConfigService;
  let firstOfficer: FirstOfficer;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'fo-test-'));
    db = new Database(':memory:');
    runMigrations(db);
    configService = new ConfigService(db);
    memoService = new MemoService(db);

    // Override HOME so workspace is created in tmpDir
    process.env.HOME = tmpDir;

    firstOfficer = new FirstOfficer({
      db,
      configService,
      memoService,
      starbaseId: 'test'
    });
  });

  afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('writes escalation memo when retries exhausted', async () => {
    // Insert test sector + mission + crew
    db.prepare("INSERT INTO sectors (id, name, root_path) VALUES ('api', 'API', '/tmp/api')").run();
    db.prepare(
      "INSERT INTO missions (sector_id, summary, prompt, first_officer_retry_count) VALUES ('api', 'Add rate limiting', 'Add rate limiting to /api/users', 3)"
    ).run();
    db.prepare(
      "INSERT INTO crew (id, sector_id, mission_id, status) VALUES ('api-crew-1234', 'api', 1, 'error')"
    ).run();

    const dispatched = await firstOfficer.dispatch({
      crewId: 'api-crew-1234',
      missionId: 1,
      sectorId: 'api',
      sectorName: 'API',
      eventType: 'error',
      missionSummary: 'Add rate limiting',
      missionPrompt: 'Add rate limiting to /api/users',
      acceptanceCriteria: null,
      verifyCommand: null,
      crewOutput: 'Error: test failed',
      verifyResult: null,
      reviewNotes: null,
      retryCount: 3 // >= max retries
    });

    expect(dispatched).toBe(true);

    // Check memo was created
    const memos = memoService.listAll();
    expect(memos.length).toBe(1);
    expect(memos[0].event_type).toBe('error');
    expect(memos[0].crew_id).toBe('api-crew-1234');
    expect(existsSync(memos[0].file_path)).toBe(true);
  });

  it('respects concurrency limit', async () => {
    expect(firstOfficer.activeCount).toBe(0);
    expect(firstOfficer.getStatus()).toBe('idle');
  });

  it('deduplicates by crew+mission', () => {
    expect(firstOfficer.isRunning('crew-1', 1)).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests**

Run: `npx vitest run src/main/__tests__/first-officer.test.ts`
Expected: All tests pass.

- [ ] **Step 3: Commit**

```bash
git add src/main/__tests__/first-officer.test.ts
git commit -m "test: add first officer unit tests"
```

---

### Task 13: End-to-end verification

- [ ] **Step 1: Start the app and verify First Officer sidebar appears**

Run: `npm run dev`
Expected: Star Command tab shows First Officer section below Admiral with "Idle" status.

- [ ] **Step 2: Verify migration applied**

Check SQLite database for `memos` table and `first_officer_retry_count` column on `missions`.

- [ ] **Step 3: Manually trigger a failure scenario**

Deploy a crew with a mission designed to fail (e.g., impossible acceptance criteria). Wait for it to error. Verify:

- Sentinel detects the failure
- First Officer process spawns (check console logs for `[first-officer]` prefix)
- Either a retry occurs or a memo appears in the sidebar

- [ ] **Step 4: Open memo viewer and verify markdown rendering**

Click the memo badge. Verify the memo panel opens, renders the markdown content with proper formatting (headers, code blocks, bullet points).

- [ ] **Step 5: Commit any fixes**

```bash
git add -A
git commit -m "fix: first officer integration adjustments"
```
