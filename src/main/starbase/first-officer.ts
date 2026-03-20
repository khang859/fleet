import { spawn, ChildProcess } from 'child_process'
import { writeFileSync, mkdirSync, existsSync, unlinkSync, readdirSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import type Database from 'better-sqlite3'
import type { ConfigService } from './config-service'
import type { EventBus } from '../event-bus'

type FirstOfficerDeps = {
  db: Database.Database
  configService: ConfigService
  eventBus?: EventBus
  starbaseId: string
  /** Enriched env with PATH containing claude binary */
  crewEnv?: Record<string, string>
  /** Directory containing the fleet CLI binary */
  fleetBinDir?: string
}

export type ActionableEvent = {
  crewId: string
  missionId: number
  sectorId: string
  sectorName: string
  eventType: string
  missionSummary: string
  missionPrompt: string
  acceptanceCriteria: string | null
  verifyCommand: string | null
  crewOutput: string
  verifyResult: string | null
  reviewNotes: string | null
  retryCount: number
  attemptHistory?: string
}

type RunningProcess = {
  proc: ChildProcess
  crewId: string
  missionId: number
  startedAt: number
}

export class FirstOfficer {
  private running = new Map<string, RunningProcess>()

  constructor(private deps: FirstOfficerDeps) {}

  /** Key for dedup map */
  private key(crewId: string, missionId: number): string {
    return `${crewId}:${missionId}`
  }

  /** How many First Officer processes are currently running */
  get activeCount(): number {
    return this.running.size
  }

  /** Is a process already running for this crew+mission? */
  isRunning(crewId: string, missionId: number): boolean {
    return this.running.has(this.key(crewId, missionId))
  }

  /** Get status text for UI */
  getStatusText(): string {
    if (this.running.size === 0) return 'Idle'
    const entries = [...this.running.values()]
    if (entries.length === 1) return `Triaging ${entries[0].crewId}`
    return `Triaging ${entries.length} issues`
  }

  /** Get status for UI: 'idle' | 'working' | 'memo' */
  getStatus(): 'idle' | 'working' | 'memo' {
    if (this.running.size > 0) return 'working'
    const row = this.deps.db.prepare(
      "SELECT COUNT(*) as cnt FROM comms WHERE type IN ('memo', 'hailing-memo') AND to_crew = 'admiral' AND read = 0"
    ).get() as { cnt: number }
    if (row.cnt > 0) return 'memo'
    return 'idle'
  }

  /**
   * Spawn a First Officer process to handle an actionable event.
   * Returns false if dedup/concurrency prevents spawning.
   */
  async dispatch(
    event: ActionableEvent,
    callbacks?: { onExit?: (code: number | null) => void },
  ): Promise<boolean> {
    const { configService } = this.deps
    const maxConcurrent = configService.get('first_officer_max_concurrent') as number
    const maxRetries = configService.get('first_officer_max_retries') as number
    const timeout = configService.get('first_officer_timeout') as number
    const model = configService.get('first_officer_model') as string

    const k = this.key(event.crewId, event.missionId)

    // Dedup: already running for this crew+mission
    if (this.running.has(k)) return false

    // Concurrency limit
    if (this.running.size >= maxConcurrent) return false

    // Retries exhausted — force escalation
    if (event.retryCount >= maxRetries) {
      this.writeEscalationMemo(event, 'Maximum retries exhausted')
      return true
    }

    // Ensure workspace exists
    const workspace = this.getWorkspacePath()
    const memosDir = join(workspace, 'memos')
    mkdirSync(memosDir, { recursive: true })

    // Ensure CLAUDE.md exists
    const claudeMdPath = join(workspace, 'CLAUDE.md')
    if (!existsSync(claudeMdPath)) {
      writeFileSync(claudeMdPath, this.generateClaudeMd(), 'utf-8')
    }

    // Write system prompt to temp file
    const promptDir = join(tmpdir(), 'fleet-first-officer')
    mkdirSync(promptDir, { recursive: true })
    const spFile = join(promptDir, `${event.crewId}-sp.md`)
    writeFileSync(spFile, this.buildSystemPrompt(event, maxRetries), 'utf-8')

    // Write initial message to temp file
    const msgFile = join(promptDir, `${event.crewId}-msg.md`)
    writeFileSync(msgFile, this.buildInitialMessage(event), 'utf-8')

    // Build CLI args
    const cmdArgs = [
      '--output-format', 'stream-json',
      '--verbose',
      '--input-format', 'stream-json',
      '--dangerously-skip-permissions',
      '--model', model,
      '--append-system-prompt-file', spFile,
    ]

    const mergedEnv: Record<string, string> = {
      ...(this.deps.crewEnv ?? (process.env as Record<string, string>)),
      FLEET_FIRST_OFFICER: '1',
      FLEET_CREW_ID: event.crewId,
      FLEET_MISSION_ID: String(event.missionId),
      ...(this.deps.fleetBinDir ? { FLEET_BIN_DIR: this.deps.fleetBinDir } : {}),
    }

    try {
      const proc = spawn('claude', cmdArgs, {
        cwd: workspace,
        env: mergedEnv,
        stdio: ['pipe', 'pipe', 'pipe'],
      })

      const entry: RunningProcess = {
        proc,
        crewId: event.crewId,
        missionId: event.missionId,
        startedAt: Date.now(),
      }
      this.running.set(k, entry)

      // Send initial message
      const initMsg = JSON.stringify({
        type: 'user',
        message: {
          role: 'user',
          content: `Read and execute the triage instructions in ${msgFile}. Delete the file when done.`,
        },
        parent_tool_use_id: null,
        session_id: '',
      }) + '\n'
      proc.stdin!.write(initMsg)

      // Parse stdout for result message
      let stdoutBuffer = ''
      proc.stdout!.on('data', (chunk: Buffer) => {
        stdoutBuffer += chunk.toString()
        const lines = stdoutBuffer.split('\n')
        stdoutBuffer = lines.pop() ?? ''
        for (const line of lines) {
          if (!line.trim()) continue
          try {
            const msg = JSON.parse(line)
            if (msg.type === 'result') {
              try { proc.stdin?.end() } catch { /* ignore */ }
            }
          } catch { /* non-JSON */ }
        }
      })

      proc.stderr!.on('data', (chunk: Buffer) => {
        console.error(`[first-officer:${event.crewId}] stderr:`, chunk.toString().trim())
      })

      // Hard timeout
      const timer = setTimeout(() => {
        if (!proc.killed) {
          console.warn(`[first-officer] Timeout for ${k}, killing`)
          try { proc.kill('SIGTERM') } catch { /* already dead */ }
          setTimeout(() => {
            if (!proc.killed) try { proc.kill('SIGKILL') } catch { /* ignore */ }
          }, 5000)
        }
      }, timeout * 1000)

      // Cleanup on exit
      proc.on('exit', (code) => {
        clearTimeout(timer)
        this.running.delete(k)

        // Clean up temp files
        try { unlinkSync(spFile) } catch { /* ignore */ }
        try { unlinkSync(msgFile) } catch { /* ignore */ }

        if (code !== 0) {
          // First Officer itself crashed — fallback escalation
          this.writeEscalationMemo(event, `First Officer process crashed (exit code: ${code})`)
        }

        // Check if new memos were written and insert DB records
        this.scanForNewMemos(event)

        callbacks?.onExit?.(code)
        this.deps.eventBus?.emit('starbase-changed', { type: 'starbase-changed' })
      })

      proc.on('error', (err) => {
        clearTimeout(timer)
        this.running.delete(k)
        this.writeEscalationMemo(event, `First Officer spawn failed: ${err.message}`)
        this.deps.eventBus?.emit('starbase-changed', { type: 'starbase-changed' })
      })

      this.deps.eventBus?.emit('starbase-changed', { type: 'starbase-changed' })
      return true
    } catch (err) {
      this.writeEscalationMemo(
        event,
        `First Officer spawn failed: ${err instanceof Error ? err.message : 'unknown'}`,
      )
      return false
    }
  }

  /** Scan memos dir for files not yet in DB and insert records */
  private scanForNewMemos(event: ActionableEvent): void {
    const memosDir = join(this.getWorkspacePath(), 'memos')
    if (!existsSync(memosDir)) return

    try {
      const files = readdirSync(memosDir)
      for (const file of files) {
        if (!file.endsWith('.md')) continue
        const filePath = join(memosDir, file)
        // Check if already tracked
        const existing = this.deps.db
          .prepare(
            `SELECT 1 FROM comms WHERE type = 'memo' AND mission_id = ? AND payload LIKE ? LIMIT 1`
          )
          .get(event.missionId, `%${filePath.replace(/"/g, '\\"')}%`)
        if (existing) continue

        this.deps.db.prepare(
          `INSERT INTO comms (from_crew, to_crew, type, mission_id, payload)
           VALUES ('first-officer', 'admiral', 'memo', ?, ?)`
        ).run(
          event.missionId,
          JSON.stringify({
            missionId: event.missionId,
            crewId: event.crewId,
            eventType: event.eventType,
            summary: `New memo from ${event.crewId}`,
            filePath,
            retryCount: event.retryCount,
          })
        )
      }
    } catch { /* ignore scan errors */ }
  }

  /** Write a fallback escalation memo when the First Officer itself fails */
  private writeEscalationMemo(event: ActionableEvent, reason: string): void {
    const memosDir = join(this.getWorkspacePath(), 'memos')
    mkdirSync(memosDir, { recursive: true })

    const slug = event.missionSummary
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .slice(0, 40)
    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 16)
    const filename = `${ts}-${event.crewId}-${slug}.md`
    const filePath = join(memosDir, filename)

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
`

    writeFileSync(filePath, content, 'utf-8')
    this.deps.db.prepare(
      `INSERT INTO comms (from_crew, to_crew, type, mission_id, payload)
       VALUES ('first-officer', 'admiral', 'memo', ?, ?)`
    ).run(
      event.missionId,
      JSON.stringify({
        missionId: event.missionId,
        crewId: event.crewId,
        eventType: event.eventType,
        summary: reason,
        filePath,
        retryCount: event.retryCount,
        fingerprint: null,
        classification: 'escalation',
      })
    )
    this.deps.eventBus?.emit('starbase-changed', { type: 'starbase-changed' })
  }

  /** Write a memo for an unanswered hailing request (no process spawn needed) */
  writeHailingMemo(opts: {
    crewId: string
    missionId: number | null
    sectorName: string
    payload: string
    createdAt: string
  }): void {
    const memosDir = join(this.getWorkspacePath(), 'memos')
    mkdirSync(memosDir, { recursive: true })

    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 16)
    const filename = `${ts}-${opts.crewId}-hailing.md`
    const filePath = join(memosDir, filename)

    let payloadText = ''
    try {
      const parsed = JSON.parse(opts.payload)
      payloadText = parsed.message ?? parsed.question ?? JSON.stringify(parsed, null, 2)
    } catch {
      payloadText = opts.payload
    }

    const content = `## Unanswered Hailing: ${opts.crewId}

**Crew:** ${opts.crewId} · **Sector:** ${opts.sectorName} · **Waiting since:** ${opts.createdAt}

### Message
${payloadText}

### Action Required
This crew has been waiting for a response for over 60 seconds. Please review and respond via the Admiral.
`
    writeFileSync(filePath, content, 'utf-8')
    this.deps.db.prepare(
      `INSERT INTO comms (from_crew, to_crew, type, mission_id, payload)
       VALUES ('first-officer', 'admiral', 'hailing-memo', ?, ?)`
    ).run(
      opts.missionId,
      JSON.stringify({
        crewId: opts.crewId,
        missionId: opts.missionId,
        summary: `Unanswered hailing from ${opts.crewId} in ${opts.sectorName}`,
        filePath,
      })
    )
    this.deps.eventBus?.emit('starbase-changed', { type: 'starbase-changed' })
  }

  writeAutoEscalationComm(opts: {
    crewId: string
    missionId: number
    classification: string
    fingerprint: string
    summary: string
    errorText: string
  }): void {
    const memosDir = join(this.getWorkspacePath(), 'memos')
    mkdirSync(memosDir, { recursive: true })

    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 16)
    const slug = opts.summary.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40)
    const filename = `${ts}-auto-${slug}.md`
    const filePath = join(memosDir, filename)

    const content = `## Auto-Escalated: ${opts.summary}

**Classification:** ${opts.classification}
**Fingerprint:** ${opts.fingerprint}
**Crew:** ${opts.crewId}

### Error Output (tail)
\`\`\`
${opts.errorText}
\`\`\`

### Why Auto-Escalated
${opts.classification === 'persistent' ? 'Same error fingerprint as previous attempt — retrying will not help.' : 'Error matches non-retryable pattern — requires manual intervention.'}
`
    writeFileSync(filePath, content, 'utf-8')

    this.deps.db.prepare(
      `INSERT INTO comms (from_crew, to_crew, type, mission_id, payload)
       VALUES ('first-officer', 'admiral', 'memo', ?, ?)`
    ).run(
      opts.missionId,
      JSON.stringify({
        missionId: opts.missionId,
        crewId: opts.crewId,
        eventType: 'auto-escalation',
        summary: `Auto-escalated (${opts.classification}): ${opts.summary}`,
        filePath,
        fingerprint: opts.fingerprint,
        classification: opts.classification,
      })
    )
    this.deps.eventBus?.emit('starbase-changed', { type: 'starbase-changed' })
  }

  private getWorkspacePath(): string {
    return join(
      process.env.HOME ?? '~',
      '.fleet', 'starbases',
      `starbase-${this.deps.starbaseId}`,
      'first-officer',
    )
  }

  private generateClaudeMd(): string {
    const fleetBin = this.deps.fleetBinDir ? `${this.deps.fleetBinDir}/fleet` : 'fleet'

    return `# First Officer

You are the First Officer aboard Star Command. You are NOT the Admiral.
Ignore any CLAUDE.md instructions about the Admiral role.

## Your Role
You triage failed missions. For each invocation you will:
1. Analyze why a crew's mission failed
2. Decide whether to RETRY (re-queue with a revised prompt) or ESCALATE (write a memo)

## Retry Workflow

Use the \`fleet\` CLI to recall the errored crew and re-queue the mission with a revised prompt:

\`\`\`bash
# 1. Recall the errored crew (clean up the old process)
${fleetBin} crew recall <crew-id>

# 2. Re-queue the mission with a revised prompt
${fleetBin} missions update <mission-id> --status queued --prompt "revised prompt addressing the failure..."

# 3. Deploy a new crew for the re-queued mission
${fleetBin} crew deploy --sector <sector-id> --mission <mission-id>
\`\`\`

When revising the prompt:
- Fix test expectations based on failure output
- Narrow scope if the mission was too broad
- Add missing context the crew needed
- Reference specific error messages so the new crew knows what to watch for

## Escalate

If retrying won't help, write a markdown memo to \`./memos/\` with:
- What happened (failure details)
- What was tried (retry history)
- Recommendation (split mission, manual fix, etc.)

## Useful Commands

\`\`\`bash
${fleetBin} crew list                        # Check current crew status
${fleetBin} crew observe <crew-id>           # View errored crew's output
${fleetBin} missions show <mission-id>       # View mission details
${fleetBin} missions list --sector <id>      # List missions in a sector
\`\`\`

## Rules
- Never create new missions unrelated to the failure
- Never modify sectors or supply routes
- Never answer hailing questions — only escalate them as memos
- Keep memos concise and actionable
- Always recall the errored crew before deploying a new one
- When choosing RETRY, you MUST ALSO write a short memo to ./memos/ documenting what you tried and why you expect the retry to succeed. This is mandatory for audit trail.
`
  }

  private buildSystemPrompt(event: ActionableEvent, maxRetries: number): string {
    const fleetBin = this.deps.fleetBinDir ? `${this.deps.fleetBinDir}/fleet` : 'fleet'

    return `You are the First Officer aboard Star Command. Your role is to
triage failed missions and decide whether to retry or escalate.

You are NOT the Admiral. Ignore any CLAUDE.md instructions about
the Admiral role. Your job is narrowly scoped to this specific failure.

You are analyzing a failure for crew ${event.crewId} on mission "${event.missionSummary}"
in sector ${event.sectorName} (sector ID: ${event.sectorId}).

## Context
- Mission ID: ${event.missionId}
- Crew ID: ${event.crewId}
- Sector ID: ${event.sectorId}
- Retry attempt: ${event.retryCount + 1}/${maxRetries}
- Failure type: ${event.eventType}
- Sector verify command: ${event.verifyCommand ?? 'none configured'}
- Acceptance criteria: ${event.acceptanceCriteria ?? 'none specified'}

## Your Options

### 1. RETRY — recall errored crew, revise prompt, deploy new crew
\`\`\`bash
# Step 1: Recall the errored crew
${fleetBin} crew recall ${event.crewId}

# Step 2: Re-queue with revised prompt
${fleetBin} missions update ${event.missionId} --status queued --prompt "your revised prompt here"

# Step 3: Deploy fresh crew
${fleetBin} crew deploy --sector ${event.sectorId} --mission ${event.missionId}
\`\`\`

### 2. ESCALATE — write a memo to ./memos/ explaining what happened

## Decision Rules
- If this is a transient failure (crash, OOM, timeout on a reasonable scope), retry with the same or slightly adjusted prompt
- If tests failed, read the test output and adjust the prompt to address specific failures
- If you've seen the same failure pattern across retries, escalate
- If the mission scope seems too large, recommend splitting in your memo
- Never retry more than ${maxRetries} times total
- Write memos in markdown
`
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
`

    if (event.verifyResult) {
      msg += `\n## Verification Result\n\`\`\`json\n${event.verifyResult}\n\`\`\`\n`
    }

    if (event.reviewNotes) {
      msg += `\n## Review Notes\n${event.reviewNotes}\n`
    }

    if (event.attemptHistory) {
      msg += `\n## Previous Attempts\n| # | Action | Fingerprint | Classification |\n|---|--------|-------------|----------------|\n${event.attemptHistory}\n`
    }

    msg += `\nAnalyze this failure and decide: RETRY or ESCALATE.\n`
    return msg
  }

  /** Kill all running processes (app shutdown) */
  shutdown(): void {
    for (const [k, entry] of this.running) {
      try { entry.proc.kill('SIGKILL') } catch { /* already dead */ }
      this.running.delete(k)
    }
  }

  /** Clean up orphaned processes on startup (reconciliation) */
  reconcile(): void {
    // First Officer processes are ephemeral (max 120s) — if Fleet restarted,
    // they're already dead. Just clear the map.
    this.running.clear()
  }
}
