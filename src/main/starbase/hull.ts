import type Database from 'better-sqlite3'
import { spawn, ChildProcess, execSync, ExecSyncOptions } from 'child_process'
import { writeFileSync, unlinkSync, mkdirSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { inferCommitType, deriveSummary, formatCommitMessage, formatCommitSubject } from './conventional-commits'
import { generateSkillMd } from './workspace-templates'

// Stream-JSON message types emitted by Claude Code on stdout
type ClaudeInitMessage = {
  type: 'system'
  subtype: 'init'
  session_id: string
}

type ClaudeAssistantMessage = {
  type: 'assistant'
  message: { role: 'assistant'; content: Array<{ type: string; text?: string }> }
  session_id: string
}

type ClaudeResultMessage = {
  type: 'result'
  is_error: boolean
  session_id: string
  total_cost_usd?: number
  result?: string
}

type ClaudeStreamMessage = ClaudeInitMessage | ClaudeAssistantMessage | ClaudeResultMessage | { type: string }

export type HullOpts = {
  crewId: string
  sectorId: string
  missionId: number
  prompt: string
  worktreePath: string
  worktreeBranch: string
  baseBranch: string
  sectorPath: string
  db: Database.Database
  lifesignIntervalSec?: number
  timeoutMin?: number
  mergeStrategy?: string
  verifyCommand?: string
  lintCommand?: string
  reviewMode?: string
  /** Claude model override (default: claude-sonnet-4-6) */
  model?: string
  /** Custom system prompt for the agent session */
  systemPrompt?: string
  /** Comma-separated allowed tools (e.g. "Read,Edit,Bash") */
  allowedTools?: string
  /** Path to an MCP config JSON file */
  mcpConfig?: string
  /** Mission type: 'code' (default), 'research', or 'review' */
  missionType?: string
  /** PR branch name for review/fix crews working on an existing PR */
  prBranch?: string
  /** Starbase ID for cargo file storage paths */
  starbaseId?: string
  onComplete?: () => void
  /** Environment variables for the subprocess (enriched PATH so `claude` is found). */
  env?: Record<string, string>
}

type HullStatus = 'pending' | 'active' | 'complete' | 'error' | 'timeout' | 'aborted'

const MAX_OUTPUT_LINES = 200

export class Hull {
  private status: HullStatus = 'pending'
  private outputLines: string[] = []
  private lifesignTimer: ReturnType<typeof setInterval> | null = null
  private timeoutTimer: ReturnType<typeof setTimeout> | null = null
  private process: ChildProcess | null = null
  private promptFile: string | null = null
  private systemPromptFile: string | null = null
  private pid: number | null = null
  private stdoutBuffer: string = ''
  private sessionId: string | null = null

  private resultText: string | null = null

  private static ghAvailable: boolean | null = null

  constructor(private opts: HullOpts) {}

  /**
   * Start the Hull lifecycle. Spawns a headless Claude Code process
   * using stream-json protocol for bidirectional communication.
   */
  async start(): Promise<void> {
    const { crewId, sectorId, missionId, prompt, worktreePath, worktreeBranch, db } = this.opts
    const lifesignSec = this.opts.lifesignIntervalSec ?? 10
    const timeoutMin = this.opts.timeoutMin ?? 15

    // Insert crew record (tab_id is NULL — headless crew, no terminal tab)
    db.prepare(
      `INSERT INTO crew (id, tab_id, sector_id, mission_id, sector_path, worktree_path,
        worktree_branch, status, mission_summary, pid, deadline, last_lifesign)
       VALUES (?, NULL, ?, ?, ?, ?, ?, 'active', ?, NULL, datetime('now', '+${timeoutMin} minutes'), datetime('now'))`
    ).run(
      crewId,
      sectorId,
      missionId,
      this.opts.sectorPath,
      worktreePath,
      worktreeBranch,
      prompt.slice(0, 100)
    )

    // Activate mission atomically — abort if another crew already claimed it
    const activateResult = db.prepare(
      "UPDATE missions SET status = 'active', crew_id = ?, started_at = datetime('now') WHERE id = ? AND crew_id IS NULL"
    ).run(crewId, missionId)
    if (activateResult.changes === 0) {
      throw new Error(`Mission ${missionId} already has an active crew. Aborting duplicate deployment.`)
    }

    // Log deployment
    db.prepare("INSERT INTO ships_log (crew_id, event_type, detail) VALUES (?, 'deployed', ?)").run(
      crewId,
      JSON.stringify({ sectorId, missionId })
    )

    this.status = 'active'

    // Start lifesign interval
    this.lifesignTimer = setInterval(() => {
      try {
        db.prepare("UPDATE crew SET last_lifesign = datetime('now') WHERE id = ?").run(crewId)
      } catch {
        /* db might be closed */
      }
    }, lifesignSec * 1000)

    // Start timeout timer
    this.timeoutTimer = setTimeout(
      () => {
        this.handleTimeout()
      },
      timeoutMin * 60 * 1000
    )

    // Set up Fleet skill in worktree so crew agents can use the fleet CLI
    try {
      const skillDir = join(worktreePath, '.claude', 'skills', 'fleet')
      mkdirSync(skillDir, { recursive: true })
      writeFileSync(join(skillDir, 'SKILL.md'), generateSkillMd(), 'utf-8')
    } catch {
      // Non-fatal — crew can still work without the skill
    }

    // Spawn headless Claude Code with stream-json protocol
    try {
      // Write prompt to a temp file to avoid shell escaping issues with complex prompts.
      // Claude Code reads the file via its Read tool on first turn.
      const promptDir = join(tmpdir(), 'fleet-prompts')
      mkdirSync(promptDir, { recursive: true })
      const promptFile = join(promptDir, `${crewId}.md`)
      writeFileSync(promptFile, prompt, 'utf-8')
      this.promptFile = promptFile

      const model = this.opts.model || 'claude-sonnet-4-6'
      const cmdArgs = [
        '--output-format', 'stream-json',
        '--verbose',
        '--input-format', 'stream-json',
        '--dangerously-skip-permissions',
        '--model', model
      ]

      // Build system prompt: research preamble (if applicable) + sector system_prompt
      const researchPreamble = this.opts.missionType === 'research'
        ? `# Research Mission Instructions

You are a research crew deployed on a research mission (FLEET_MISSION_TYPE=research).

## Cargo Workflow
- Output your findings as printed text in your responses — do NOT write findings to files in the worktree.
- The Fleet system captures your full output as cargo automatically.
- Use WebSearch, WebFetch, Read, Glob, Grep, and Bash for investigation.

## Constraints
- Do NOT push code or create pull requests. This is a research mission, not a code mission.
- Do NOT commit changes. Any git changes you make will be discarded at the end of the mission.
- Focus on investigation, analysis, and producing written findings.

## Environment
- FLEET_MISSION_TYPE=research (available in your environment)
`
        : null

      const combinedSystemPrompt = [researchPreamble, this.opts.systemPrompt]
        .filter(Boolean)
        .join('\n\n')

      if (combinedSystemPrompt) {
        const spFile = join(promptDir, `${crewId}-system-prompt.md`)
        writeFileSync(spFile, combinedSystemPrompt, 'utf-8')
        this.systemPromptFile = spFile
        cmdArgs.push('--append-system-prompt-file', spFile)
      }
      if (this.opts.allowedTools) {
        cmdArgs.push('--allowedTools', this.opts.allowedTools)
      }
      if (this.opts.mcpConfig) {
        cmdArgs.push('--mcp-config', this.opts.mcpConfig)
      }

      const mergedEnv: Record<string, string> = {
        ...(this.opts.env ?? (process.env as Record<string, string>)),
        FLEET_CREW_ID: crewId,
        FLEET_SECTOR_ID: this.opts.sectorId,
        FLEET_MISSION_ID: String(this.opts.missionId),
        FLEET_MISSION_TYPE: this.opts.missionType ?? 'code'
      }

      const proc = spawn('claude', cmdArgs, {
        cwd: worktreePath,
        env: mergedEnv,
        stdio: ['pipe', 'pipe', 'pipe']
      })

      this.process = proc
      this.pid = proc.pid ?? null
      if (this.pid) {
        db.prepare('UPDATE crew SET pid = ? WHERE id = ?').run(this.pid, crewId)
      }

      // Send initial user message via stream-json stdin
      const worktreeWarning = `IMPORTANT: You are in a git worktree. Your current directory is already the correct working directory for this mission (branch: ${worktreeBranch}). Do NOT cd to any other path. All file edits and git operations must happen in the current directory.\n\n`
      const researchGuidance = this.opts.missionType === 'research'
        ? `RESEARCH MISSION GUIDANCE: Your research findings will be captured as cargo from your terminal output. Print your findings to stdout using console.log, echo, or similar output commands. Do NOT write files to disk — any files you create or modify will be discarded by the git safety guard. Do NOT create pull requests or commit changes. Your mission is to investigate and report findings through your terminal output only.\n\n`
        : ''
      const initMsg = JSON.stringify({
        type: 'user',
        message: { role: 'user', content: `${worktreeWarning}${researchGuidance}Read and execute the mission prompt in ${promptFile}. Delete the file when done.` },
        parent_tool_use_id: null,
        session_id: ''
      }) + '\n'
      proc.stdin!.write(initMsg)

      // Parse NDJSON from stdout
      proc.stdout!.on('data', (chunk: Buffer) => {
        this.stdoutBuffer += chunk.toString()
        const lines = this.stdoutBuffer.split('\n')
        this.stdoutBuffer = lines.pop() ?? ''

        for (const line of lines) {
          if (!line.trim()) continue
          try {
            const msg = JSON.parse(line) as ClaudeStreamMessage
            this.handleStreamMessage(msg)
          } catch {
            // non-JSON line (e.g. claude startup noise) — ignore
          }
        }
      })

      // Log stderr for diagnostics
      proc.stderr!.on('data', (chunk: Buffer) => {
        console.error(`[hull:${crewId}] stderr:`, chunk.toString().trim())
      })

      // Handle process exit → trigger cleanup
      proc.on('exit', (code) => {
        this.process = null
        const status = code === 0 ? 'complete' : 'error'
        this.cleanup(status, code === 0 ? 'Completed successfully' : `Exit code: ${code}`).catch(
          (cleanupErr) => {
            console.error('[hull] cleanup error:', cleanupErr)
          }
        )
      })

      proc.on('error', (err) => {
        this.process = null
        this.cleanup('error', `Spawn failed: ${err.message}`).catch(
          (cleanupErr) => {
            console.error('[hull] cleanup error:', cleanupErr)
          }
        )
      })
    } catch (err) {
      this.cleanup('error', `Spawn failed: ${err instanceof Error ? err.message : 'unknown'}`).catch(
        (cleanupErr) => {
          console.error('[hull] cleanup error:', cleanupErr)
        }
      )
      return
    }
  }

  /**
   * Send a follow-up message to the crew's Claude Code process via stream-json stdin.
   * Resets the timeout deadline.
   */
  sendMessage(message: string): boolean {
    if (this.status !== 'active' || !this.process?.stdin?.writable) {
      return false
    }

    const msg = JSON.stringify({
      type: 'user',
      message: { role: 'user', content: message },
      parent_tool_use_id: null,
      session_id: this.sessionId ?? ''
    }) + '\n'

    this.process.stdin.write(msg)
    this.resetTimeout()
    return true
  }

  kill(): void {
    if (this.process) {
      // Graceful: close stdin so Claude finishes current turn then exits
      try { this.process.stdin?.end() } catch { /* ignore */ }
      // Force kill after 5s if still alive, escalate to SIGKILL after 10s
      const proc = this.process
      const sigterm = setTimeout(() => {
        if (!proc.killed) {
          try { proc.kill('SIGTERM') } catch { /* already dead */ }
        }
      }, 5000)
      const sigkill = setTimeout(() => {
        if (!proc.killed) {
          try { proc.kill('SIGKILL') } catch { /* already dead */ }
        }
      }, 10000)
      proc.once('exit', () => {
        clearTimeout(sigterm)
        clearTimeout(sigkill)
      })
    }
    this.cleanup('aborted', 'Recalled by Star Command').catch((err) => {
      console.error('[hull] cleanup error:', err)
    })
  }

  /** Immediately kill the process (app shutdown — no graceful wait). */
  forceKill(): void {
    if (this.lifesignTimer) clearInterval(this.lifesignTimer)
    if (this.timeoutTimer) clearTimeout(this.timeoutTimer)
    if (this.process && !this.process.killed) {
      try { this.process.kill('SIGKILL') } catch { /* already dead */ }
    }
    this.process = null
    this.status = 'aborted'
  }

  getStatus(): HullStatus {
    return this.status
  }

  getPid(): number | null {
    return this.pid
  }

  appendOutput(data: string): void {
    const lines = data.split('\n')
    this.outputLines.push(...lines)
    const maxLines = (this.opts.missionType === 'research' || this.opts.missionType === 'review') ? 2000 : MAX_OUTPUT_LINES
    if (this.outputLines.length > maxLines) {
      this.outputLines = this.outputLines.slice(-maxLines)
    }
  }

  getOutputBuffer(): string {
    return this.outputLines.join('\n')
  }

  private handleStreamMessage(msg: ClaudeStreamMessage): void {
    if (msg.type === 'system' && (msg as ClaudeInitMessage).subtype === 'init') {
      this.sessionId = (msg as ClaudeInitMessage).session_id
    } else if (msg.type === 'assistant') {
      const am = msg as ClaudeAssistantMessage
      const textParts = am.message.content
        .filter(c => c.type === 'text' && c.text)
        .map(c => c.text!)
      if (textParts.length > 0) {
        this.appendOutput(textParts.join('\n'))
      }
    } else if (msg.type === 'result') {
      // Capture result text for research mission cargo
      const rm = msg as ClaudeResultMessage
      if (rm.result) {
        this.resultText = rm.result
      }
      // Close stdin so the process exits naturally — this triggers the exit handler and cleanup.
      // With --input-format stream-json, Claude waits for more stdin input after a result message.
      // Closing stdin sends EOF, causing Claude to exit and triggering proc.on('exit') → cleanup().
      try { this.process?.stdin?.end() } catch { /* ignore */ }
      // Escalation fallback: if the process doesn't exit after stdin EOF, force it.
      const proc = this.process
      if (proc) {
        const sigterm = setTimeout(() => {
          if (!proc.killed) {
            try { proc.kill('SIGTERM') } catch { /* already dead */ }
          }
        }, 5000)
        const sigkill = setTimeout(() => {
          if (!proc.killed) {
            try { proc.kill('SIGKILL') } catch { /* already dead */ }
          }
        }, 10000)
        proc.once('exit', () => {
          clearTimeout(sigterm)
          clearTimeout(sigkill)
        })
      }
    }
  }

  private resetTimeout(): void {
    if (this.timeoutTimer) {
      clearTimeout(this.timeoutTimer)
    }
    const timeoutMin = this.opts.timeoutMin ?? 15
    this.timeoutTimer = setTimeout(
      () => this.handleTimeout(),
      timeoutMin * 60 * 1000
    )
    // Update DB deadline to match
    try {
      this.opts.db.prepare(
        `UPDATE crew SET deadline = datetime('now', '+${timeoutMin} minutes') WHERE id = ?`
      ).run(this.opts.crewId)
    } catch { /* db might be closed */ }
  }

  private handleTimeout(): void {
    if (this.process) {
      // Graceful: close stdin
      try { this.process.stdin?.end() } catch { /* ignore */ }
      // Force kill after 5s if still alive
      const proc = this.process
      setTimeout(() => {
        if (proc && !proc.killed) {
          proc.kill('SIGTERM')
        }
      }, 5000)
    }
    // Cleanup will be called by the exit handler, but if kill doesn't trigger exit:
    setTimeout(() => {
      if (this.status === 'active') {
        this.cleanup('timeout', 'Mission deadline exceeded').catch((err) => {
          console.error('[hull] cleanup error:', err)
        })
      }
    }, 10000)
  }

  private async cleanup(status: HullStatus, reason: string): Promise<void> {
    if (this.status !== 'active' && this.status !== 'pending') return // Already cleaned up

    this.status = status
    const { crewId, missionId, worktreePath, worktreeBranch, baseBranch, sectorPath, db } =
      this.opts

    // Review crew timeout → escalate instead of entering failure-triage, then skip to finally
    if (this.opts.missionType === 'review' && status === 'timeout') {
      db.prepare("UPDATE missions SET status = 'escalated', result = 'Review crew timed out' WHERE id = ?")
        .run(missionId)
      db.prepare(
        "INSERT INTO comms (from_crew, to_crew, type, payload) VALUES (?, 'admiral', 'review_verdict', ?)"
      ).run(crewId, JSON.stringify({ missionId, verdict: 'escalated', notes: 'Review crew timed out' }))
      return
    }

    // Clean up temp files
    if (this.promptFile) {
      try { unlinkSync(this.promptFile) } catch { /* may already be deleted by agent */ }
      this.promptFile = null
    }
    if (this.systemPromptFile) {
      try { unlinkSync(this.systemPromptFile) } catch { /* may not exist */ }
      this.systemPromptFile = null
    }

    // Stop timers
    if (this.lifesignTimer) clearInterval(this.lifesignTimer)
    if (this.timeoutTimer) clearTimeout(this.timeoutTimer)

    const gitOpts: ExecSyncOptions = { cwd: worktreePath, stdio: 'pipe' }
    let overrideStatus: HullStatus | null = null

    // Remove fleet skill files from worktree before git operations so they don't pollute commits
    try {
      execSync('rm -rf .claude/skills/fleet', gitOpts)
    } catch { /* may not exist */ }

    try {
      // Auto-commit uncommitted files
      try {
        execSync('git add -A', gitOpts)
        execSync('git diff --cached --quiet', gitOpts)
      } catch {
        // There are staged changes — commit them with conventional format
        const commitType = inferCommitType(this.opts.prompt)
        const commitSummary = deriveSummary(this.opts.prompt)
        const commitMsg = formatCommitMessage(commitType, this.opts.sectorId, commitSummary)
        const commitMsgFile = join(tmpdir(), `fleet-commit-msg-${crewId}.txt`)
        writeFileSync(commitMsgFile, commitMsg, 'utf-8')
        try {
          execSync(`git commit -F "${commitMsgFile}"`, gitOpts)
        } catch {
          /* commit might fail if nothing to commit */
        } finally {
          try { unlinkSync(commitMsgFile) } catch { /* already deleted */ }
        }
      }

      // Check for empty diff
      let hasChanges = false
      try {
        const diffStat = execSync(`git diff --stat "${baseBranch}"...HEAD`, gitOpts)
          .toString()
          .trim()
        hasChanges = diffStat.length > 0
      } catch {
        hasChanges = false
      }

      if (!hasChanges) {
        // NEW: Review mission verdict handling
        if (this.opts.missionType === 'review') {
          overrideStatus = 'complete'
          const fullOutput = this.outputLines.join('\n')
          const verdictMatch = fullOutput.match(/VERDICT:\s*(APPROVE|REQUEST_CHANGES|ESCALATE)/i)
          const notesMatch = fullOutput.match(/NOTES:\s*([\s\S]*?)(?:\n\n|$)/)
          const verdict = verdictMatch?.[1]?.toLowerCase().replace(/_/g, '-') ?? 'escalate'
          const notes = notesMatch?.[1]?.trim() ?? fullOutput.slice(-2000)

          const statusMap: Record<string, string> = {
            'approve': 'approved',
            'request-changes': 'changes-requested',
            'escalate': 'escalated',
          }
          const missionStatus = statusMap[verdict] ?? 'escalated'

          db.prepare('UPDATE missions SET review_verdict = ?, review_notes = ?, status = ? WHERE id = ?')
            .run(verdict, notes, missionStatus, missionId)

          if (missionStatus === 'changes-requested') {
            db.prepare('UPDATE missions SET review_round = review_round + 1 WHERE id = ?')
              .run(missionId)
          }

          db.prepare(
            "INSERT INTO comms (from_crew, to_crew, type, payload) VALUES (?, 'admiral', 'review_verdict', ?)"
          ).run(crewId, JSON.stringify({ missionId, verdict, notes: notes.slice(0, 2000) }))

          if (missionStatus === 'escalated') {
            const memoDir = join(
              process.env.HOME ?? '~', '.fleet', 'starbases',
              `starbase-${this.opts.starbaseId}`, 'first-officer', 'memos'
            )
            mkdirSync(memoDir, { recursive: true })
            const memoId = `review-${missionId}-${Date.now()}`
            const memoPath = join(memoDir, `${memoId}.md`)
            const memoContent = `## Review Escalation: Mission #${missionId}\n\n**Verdict:** ${verdict}\n**Branch:** ${this.opts.prBranch ?? worktreeBranch}\n\n### Review Notes\n${notes}\n`
            writeFileSync(memoPath, memoContent, 'utf-8')
            db.prepare(
              "INSERT INTO memos (id, crew_id, mission_id, event_type, file_path, status) VALUES (?, ?, ?, 'review-escalation', ?, 'unread')"
            ).run(memoId, crewId, missionId, memoPath)
          }

          db.prepare("INSERT INTO ships_log (crew_id, event_type, detail) VALUES (?, 'exited', ?)").run(
            crewId,
            JSON.stringify({ status: 'complete', reason: `Review verdict: ${verdict}` })
          )
          return
        }

        // EXISTING code continues: if (status !== 'aborted') { ...
        if (status !== 'aborted') {
          if (this.opts.missionType === 'research' && status !== 'error') {
            // Research mission completed — produce cargo instead of failing
            overrideStatus = 'complete'

            // Write cargo files to starbase directory
            const cargoDir = join(
              process.env.HOME ?? '~',
              '.fleet', 'starbases',
              `starbase-${this.opts.starbaseId}`,
              'cargo', this.opts.sectorId, String(missionId)
            )
            const fullOutput = this.outputLines.join('\n')
            const summary = this.resultText ?? this.outputLines.slice(-20).join('\n')
            const hasOutput = fullOutput.trim().length > 0
            const resultMsg = hasOutput ? 'Research completed' : 'Research completed (no output captured)'

            // Attempt to write cargo files
            let fullManifest: string
            let summaryManifest: string

            try {
              mkdirSync(cargoDir, { recursive: true })
              const fullOutputPath = join(cargoDir, 'full-output.md')
              const summaryPath = join(cargoDir, 'summary.md')
              writeFileSync(fullOutputPath, fullOutput, 'utf-8')
              writeFileSync(summaryPath, summary, 'utf-8')
              fullManifest = JSON.stringify({ path: fullOutputPath })
              summaryManifest = JSON.stringify({ path: summaryPath })
            } catch (fileErr) {
              console.error(`[hull:${crewId}] cargo file write failed:`, fileErr)
              // Fallback: store content directly in manifest
              fullManifest = JSON.stringify({ content: fullOutput.slice(0, 50000) })
              summaryManifest = JSON.stringify({ content: summary.slice(0, 10000) })
            }

            // Insert cargo records
            db.prepare(
              `INSERT INTO cargo (crew_id, mission_id, sector_id, type, manifest, verified)
               VALUES (?, ?, ?, 'documentation_full', ?, 1)`
            ).run(crewId, missionId, this.opts.sectorId, fullManifest)

            db.prepare(
              `INSERT INTO cargo (crew_id, mission_id, sector_id, type, manifest, verified)
               VALUES (?, ?, ?, 'documentation_summary', ?, 1)`
            ).run(crewId, missionId, this.opts.sectorId, summaryManifest)

            // Update mission
            db.prepare(
              "UPDATE missions SET status = 'completed', result = ?, completed_at = datetime('now') WHERE id = ?"
            ).run(resultMsg, missionId)

            // Send comms
            db.prepare(
              "INSERT INTO comms (from_crew, to_crew, type, payload) VALUES (?, 'admiral', 'mission_complete', ?)"
            ).run(crewId, JSON.stringify({
              missionId, status: 'completed', reason: resultMsg, cargoProduced: true
            }))

            // Log exit
            db.prepare("INSERT INTO ships_log (crew_id, event_type, detail) VALUES (?, 'exited', ?)").run(
              crewId,
              JSON.stringify({ status: 'complete', reason: resultMsg })
            )
          } else {
            // Code mission: Genuine failure — no work produced
            db.prepare(
              "UPDATE missions SET status = 'failed', result = ?, completed_at = datetime('now') WHERE id = ?"
            ).run('No work produced', missionId)
            db.prepare(
              "INSERT INTO comms (from_crew, to_crew, type, payload) VALUES (?, 'admiral', 'mission_complete', ?)"
            ).run(crewId, JSON.stringify({ missionId, status: 'failed', reason: 'No work produced' }))
            db.prepare("INSERT INTO ships_log (crew_id, event_type, detail) VALUES (?, 'exited', ?)").run(
              crewId,
              JSON.stringify({ status: 'error', reason: 'No work produced' })
            )
            overrideStatus = 'error'
          }
        } else {
          // Intentional recall with no changes: mark mission as aborted
          db.prepare(
            "UPDATE missions SET status = 'aborted', completed_at = datetime('now') WHERE id = ?"
          ).run(missionId)
        }
        return
      }

      // Safety guard: research crews should never push code — discard changes and produce cargo
      if (this.opts.missionType === 'research') {
        // Capture what will be discarded before cleaning, for ships_log warning
        let discardedFiles: string[] = []
        try {
          const statusOut = execSync('git status --porcelain', gitOpts).toString().trim()
          const cleanOut = execSync('git clean -n -fd', gitOpts).toString().trim()
          const statusFiles = statusOut
            .split('\n')
            .filter(l => l.trim())
            .map(l => l.slice(3).trim())
          const cleanFiles = cleanOut
            .split('\n')
            .filter(l => l.startsWith('Would remove'))
            .map(l => l.replace(/^Would remove /, '').trim())
          discardedFiles = [...new Set([...statusFiles, ...cleanFiles])].filter(Boolean)
        } catch { /* ignore */ }

        try { execSync('git checkout -- .', gitOpts) } catch { /* ignore */ }
        try { execSync('git clean -fd', gitOpts) } catch { /* ignore */ }

        if (discardedFiles.length > 0) {
          db.prepare("INSERT INTO ships_log (crew_id, event_type, detail) VALUES (?, 'safety_guard', ?)").run(
            crewId,
            JSON.stringify({
              warning: 'Research safety guard discarded file changes',
              filesDiscarded: discardedFiles.length,
              paths: discardedFiles.slice(0, 20),
              recommendation: 'Research crews should print findings to stdout — do not write files to disk. Cargo is captured from terminal output.'
            })
          )
        }

        if (status === 'error') {
          db.prepare(
            "UPDATE missions SET status = 'failed', result = ?, completed_at = datetime('now') WHERE id = ?"
          ).run('Research crew error', missionId)
          db.prepare(
            "INSERT INTO comms (from_crew, to_crew, type, payload) VALUES (?, 'admiral', 'mission_complete', ?)"
          ).run(crewId, JSON.stringify({ missionId, status: 'failed', reason: 'Research crew error' }))
          db.prepare("INSERT INTO ships_log (crew_id, event_type, detail) VALUES (?, 'exited', ?)").run(
            crewId, JSON.stringify({ status: 'error', reason: 'Research crew error (git changes discarded)' })
          )
          overrideStatus = 'error'
          return
        }

        overrideStatus = 'complete'

        const cargoDir = join(
          process.env.HOME ?? '~',
          '.fleet', 'starbases',
          `starbase-${this.opts.starbaseId}`,
          'cargo', this.opts.sectorId, String(missionId)
        )
        const fullOutput = this.outputLines.join('\n')
        const summary = this.resultText ?? this.outputLines.slice(-20).join('\n')
        const hasOutput = fullOutput.trim().length > 0
        const resultMsg = hasOutput ? 'Research completed' : 'Research completed (no output captured)'

        let fullManifest: string
        let summaryManifest: string

        try {
          mkdirSync(cargoDir, { recursive: true })
          const fullOutputPath = join(cargoDir, 'full-output.md')
          const summaryPath = join(cargoDir, 'summary.md')
          writeFileSync(fullOutputPath, fullOutput, 'utf-8')
          writeFileSync(summaryPath, summary, 'utf-8')
          fullManifest = JSON.stringify({ path: fullOutputPath })
          summaryManifest = JSON.stringify({ path: summaryPath })
        } catch (fileErr) {
          console.error(`[hull:${crewId}] cargo file write failed:`, fileErr)
          fullManifest = JSON.stringify({ content: fullOutput.slice(0, 50000) })
          summaryManifest = JSON.stringify({ content: summary.slice(0, 10000) })
        }

        db.prepare(
          `INSERT INTO cargo (crew_id, mission_id, sector_id, type, manifest, verified)
           VALUES (?, ?, ?, 'documentation_full', ?, 1)`
        ).run(crewId, missionId, this.opts.sectorId, fullManifest)

        db.prepare(
          `INSERT INTO cargo (crew_id, mission_id, sector_id, type, manifest, verified)
           VALUES (?, ?, ?, 'documentation_summary', ?, 1)`
        ).run(crewId, missionId, this.opts.sectorId, summaryManifest)

        db.prepare(
          "UPDATE missions SET status = 'completed', result = ?, completed_at = datetime('now') WHERE id = ?"
        ).run(resultMsg, missionId)

        db.prepare(
          "INSERT INTO comms (from_crew, to_crew, type, payload) VALUES (?, 'admiral', 'mission_complete', ?)"
        ).run(crewId, JSON.stringify({
          missionId, status: 'completed', reason: resultMsg, cargoProduced: true
        }))

        db.prepare("INSERT INTO ships_log (crew_id, event_type, detail) VALUES (?, 'exited', ?)").run(
          crewId,
          JSON.stringify({ status: 'complete', reason: resultMsg + ' (git changes discarded)' })
        )
        return
      }

      // Safety guard: review crews should never push code — discard changes and parse verdict
      if (this.opts.missionType === 'review') {
        // Reset any accidental changes and fall through to the !hasChanges review path
        try { execSync('git checkout -- .', gitOpts) } catch { /* ignore */ }
        try { execSync('git clean -fd', gitOpts) } catch { /* ignore */ }
        // Re-enter cleanup with no changes — the review verdict path will handle it
        hasChanges = false
      }

      if (!hasChanges && this.opts.missionType === 'review') {
        // Redirect to review verdict handling (same as the !hasChanges block above)
        overrideStatus = 'complete'
        const fullOutput = this.outputLines.join('\n')
        const verdictMatch = fullOutput.match(/VERDICT:\s*(APPROVE|REQUEST_CHANGES|ESCALATE)/i)
        const notesMatch = fullOutput.match(/NOTES:\s*([\s\S]*?)(?:\n\n|$)/)
        const verdict = verdictMatch?.[1]?.toLowerCase().replace(/_/g, '-') ?? 'escalate'
        const notes = notesMatch?.[1]?.trim() ?? fullOutput.slice(-2000)

        const statusMap: Record<string, string> = {
          'approve': 'approved',
          'request-changes': 'changes-requested',
          'escalate': 'escalated',
        }
        const missionStatus = statusMap[verdict] ?? 'escalated'

        db.prepare('UPDATE missions SET review_verdict = ?, review_notes = ?, status = ? WHERE id = ?')
          .run(verdict, notes, missionStatus, missionId)

        if (missionStatus === 'changes-requested') {
          db.prepare('UPDATE missions SET review_round = review_round + 1 WHERE id = ?')
            .run(missionId)
        }

        db.prepare(
          "INSERT INTO comms (from_crew, to_crew, type, payload) VALUES (?, 'admiral', 'review_verdict', ?)"
        ).run(crewId, JSON.stringify({ missionId, verdict, notes: notes.slice(0, 2000) }))

        db.prepare("INSERT INTO ships_log (crew_id, event_type, detail) VALUES (?, 'exited', ?)").run(
          crewId,
          JSON.stringify({ status: 'complete', reason: `Review verdict: ${verdict} (changes discarded)` })
        )
        return
      }

      // Gate 2: Run verify_command if configured
      let verificationFailed = false
      if (this.opts.verifyCommand) {
        const verifyStart = Date.now()
        try {
          const verifyResult = execSync(this.opts.verifyCommand, {
            cwd: worktreePath,
            timeout: 120_000,
            stdio: 'pipe'
          })
          const duration = Date.now() - verifyStart
          db.prepare('UPDATE missions SET verify_result = ? WHERE id = ?').run(
            JSON.stringify({
              stdout: verifyResult.toString(),
              stderr: '',
              exitCode: 0,
              duration
            }),
            missionId
          )
        } catch (verifyErr: unknown) {
          const duration = Date.now() - verifyStart
          const err = verifyErr as {
            stdout?: Buffer
            stderr?: Buffer
            status?: number
            killed?: boolean
          }
          const timedOut = err.killed === true
          db.prepare('UPDATE missions SET verify_result = ? WHERE id = ?').run(
            JSON.stringify({
              stdout: err.stdout?.toString() ?? '',
              stderr: err.stderr?.toString() ?? '',
              exitCode: err.status ?? 1,
              duration,
              timedOut
            }),
            missionId
          )
          verificationFailed = true
          db.prepare("UPDATE missions SET status = 'failed-verification' WHERE id = ?").run(
            missionId
          )
        }
      }

      // Gate 2: Run lint_command if configured (warnings only, non-blocking)
      let hasLintWarnings = false
      let lintOutput = ''
      if (this.opts.lintCommand) {
        try {
          lintOutput = execSync(this.opts.lintCommand, {
            cwd: worktreePath,
            timeout: 60_000,
            stdio: 'pipe'
          }).toString()
        } catch (lintErr: unknown) {
          hasLintWarnings = true
          const err = lintErr as { stdout?: Buffer; stderr?: Buffer }
          lintOutput = err.stdout?.toString() || err.stderr?.toString() || ''
        }
      }

      // Push branch
      let pushSucceeded = false
      const pushRetries = [2000, 8000, 30000]
      for (let i = 0; i <= pushRetries.length; i++) {
        try {
          execSync(`git push -u origin "${worktreeBranch}"`, { cwd: sectorPath, stdio: 'pipe' })
          pushSucceeded = true
          break
        } catch {
          if (i < pushRetries.length) {
            await new Promise((resolve) => setTimeout(resolve, pushRetries[i]))
          }
        }
      }

      // Rebase handling after push
      let hasConflicts = false
      let conflictFiles: string[] = []
      if (pushSucceeded) {
        try {
          const movedCount = execSync(
            `git rev-list "${baseBranch}..origin/${baseBranch}" --count`,
            gitOpts
          )
            .toString()
            .trim()

          if (parseInt(movedCount, 10) > 0) {
            // Base branch has moved — attempt rebase
            try {
              execSync(`git rebase "origin/${baseBranch}"`, gitOpts)
              // Rebase succeeded — force push with lease
              try {
                execSync(`git push --force-with-lease origin "${worktreeBranch}"`, {
                  cwd: sectorPath,
                  stdio: 'pipe'
                })
              } catch {
                // Force push failed — acceptable, branch already pushed
              }
            } catch {
              // Rebase failed — abort and note conflicts
              hasConflicts = true
              try {
                const conflictOutput = execSync('git diff --name-only --diff-filter=U', gitOpts)
                  .toString()
                  .trim()
                conflictFiles = conflictOutput ? conflictOutput.split('\n') : []
              } catch {
                /* ignore */
              }
              try {
                execSync('git rebase --abort', gitOpts)
              } catch {
                /* ignore */
              }
            }
          }
        } catch {
          // Could not check base branch — skip rebase
        }
      }

      // PR creation (always create if branch was pushed and verification passed)
      if (pushSucceeded && !verificationFailed) {
        this.createPR(hasConflicts, conflictFiles, hasLintWarnings, lintOutput)
      }

      // Update mission (but don't overwrite pending-review status set by Gate 3)
      const currentMission = db
        .prepare('SELECT status FROM missions WHERE id = ?')
        .get(missionId) as { status: string } | undefined
      const isPendingReview = currentMission?.status === 'pending-review'
      const missionStatus = isPendingReview
        ? 'pending-review'
        : verificationFailed
          ? 'failed-verification'
          : status === 'complete'
            ? 'completed'
            : status
      if (pushSucceeded) {
        db.prepare(
          `UPDATE missions SET status = ?, result = ?, completed_at = datetime('now') WHERE id = ?`
        ).run(missionStatus, reason, missionId)
      } else {
        db.prepare(
          "UPDATE missions SET status = 'push-pending', result = ?, completed_at = datetime('now') WHERE id = ?"
        ).run(reason, missionId)
      }

      // Send mission_complete Transmission
      const commsPayload: Record<string, unknown> = { missionId, status: missionStatus, reason }
      if (hasConflicts) {
        commsPayload.hasConflicts = true
        commsPayload.conflictFiles = conflictFiles
      }
      if (verificationFailed) {
        commsPayload.verificationFailed = true
      }
      if (hasLintWarnings) {
        commsPayload.hasLintWarnings = true
      }
      db.prepare(
        "INSERT INTO comms (from_crew, to_crew, type, payload) VALUES (?, 'admiral', 'mission_complete', ?)"
      ).run(crewId, JSON.stringify(commsPayload))

      // Log exit
      db.prepare("INSERT INTO ships_log (crew_id, event_type, detail) VALUES (?, 'exited', ?)").run(
        crewId,
        JSON.stringify({ status, reason })
      )
    } finally {
      // Update crew status (use overrideStatus if set, e.g. from !hasChanges early return)
      const finalStatus = overrideStatus ?? status
      db.prepare("UPDATE crew SET status = ?, updated_at = datetime('now') WHERE id = ?").run(
        finalStatus,
        crewId
      )

      // Clean up worktree (skip if push failed — preserve for recovery)
      const missionRow = db.prepare('SELECT status FROM missions WHERE id = ?').get(missionId) as
        | { status: string }
        | undefined
      if (status !== 'error' || missionRow?.status !== 'push-pending') {
        try {
          execSync(`git worktree remove "${worktreePath}"`, { cwd: sectorPath, stdio: 'pipe' })
        } catch {
          try {
            execSync(`git worktree remove "${worktreePath}" --force`, {
              cwd: sectorPath,
              stdio: 'pipe'
            })
          } catch {
            console.error(`[hull] Failed to remove worktree: ${worktreePath}`)
          }
        }
      }

      // Notify completion for auto-deploy (skip if recalled — don't auto-deploy next)
      if (this.opts.onComplete && this.status !== 'aborted') {
        try {
          this.opts.onComplete()
        } catch {
          // Don't let callback errors break cleanup
        }
      }
    }
  }

  private createPR(
    isDraft: boolean,
    conflictFiles: string[],
    hasLintWarnings = false,
    lintOutput = ''
  ): void {
    if (!Hull.isGhAvailable()) return

    const { crewId, sectorId, missionId, prompt, worktreeBranch, baseBranch, sectorPath, db } =
      this.opts
    const mergeStrategy = this.opts.mergeStrategy ?? 'pr'

    const prCommitType = inferCommitType(prompt)
    const prSummary = deriveSummary(prompt)
    const prTitle = formatCommitSubject(prCommitType, sectorId, prSummary)
    const draftFlag = isDraft ? '--draft' : ''

    // Get diff stat for PR body
    let diffStat = ''
    try {
      diffStat = execSync(`git diff --stat "${baseBranch}"...HEAD`, {
        cwd: sectorPath,
        stdio: 'pipe'
      })
        .toString()
        .trim()
    } catch {
      /* ignore */
    }

    // Get verify result for PR body
    let verifySection = '- Build/Test: not configured'
    try {
      const row = db.prepare('SELECT verify_result FROM missions WHERE id = ?').get(missionId) as
        | { verify_result: string | null }
        | undefined
      if (row?.verify_result) {
        const vr = JSON.parse(row.verify_result)
        verifySection =
          vr.exitCode === 0 ? '- Build/Test: passed' : `- Build/Test: failed (exit ${vr.exitCode})`
      }
    } catch {
      /* ignore */
    }

    const lintSection = hasLintWarnings
      ? `- Lint: warnings found\n\n<details><summary>Lint output</summary>\n\n\`\`\`\n${lintOutput.slice(0, 2000)}\n\`\`\`\n\n</details>`
      : '- Lint: clean'

    const conflictNote =
      isDraft && conflictFiles.length > 0
        ? `\n\n### Merge Conflicts\nRebase failed on: ${conflictFiles.join(', ')}`
        : ''

    const body = `## Mission: ${prTitle}\n\n**Sector:** ${sectorId}\n**Crewmate:** ${crewId}\n\n### Changes\n\`\`\`\n${diffStat}\n\`\`\`\n\n### Verification\n${verifySection}\n${lintSection}${conflictNote}\n\n---\nDeployed by Star Command`

    // Write body to temp file to avoid shell injection from diff stat output
    const bodyFile = join(tmpdir(), `fleet-pr-body-${crewId}.md`)
    writeFileSync(bodyFile, body, 'utf-8')

    try {
      // Check if PR already exists on this branch (fix crews push to existing PR)
      try {
        execSync(`gh pr view "${worktreeBranch}" --json number`, {
          cwd: sectorPath,
          stdio: 'pipe'
        })
        // PR exists — store pr_branch, clear crew_id, and set pending-review, skip creating a new PR
        db.prepare("UPDATE missions SET pr_branch = ?, status = 'pending-review', crew_id = NULL WHERE id = ?")
          .run(worktreeBranch, missionId)
        return
      } catch {
        // No existing PR — continue to create one
      }

      execSync(
        `gh pr create --title '${prTitle.replace(/'/g, "'\\''")}' --body-file "${bodyFile}" --base "${baseBranch}" --head "${worktreeBranch}" ${draftFlag}`,
        { cwd: sectorPath, stdio: 'pipe' }
      )

      // Store PR branch and set pending-review for automated FO review
      try {
        const prViewOutput = execSync(`gh pr view "${worktreeBranch}" --json number,url`, {
          cwd: sectorPath,
          stdio: 'pipe'
        }).toString()
        const prData = JSON.parse(prViewOutput) as { number: number; url: string }

        db.prepare('UPDATE missions SET pr_branch = ? WHERE id = ?').run(worktreeBranch, missionId)

        const missionRow = db
          .prepare('SELECT acceptance_criteria FROM missions WHERE id = ?')
          .get(missionId) as { acceptance_criteria: string | null } | undefined

        db.prepare(
          "INSERT INTO comms (from_crew, to_crew, type, payload) VALUES (?, 'admiral', 'pr_review_request', ?)"
        ).run(
          crewId,
          JSON.stringify({
            prNumber: prData.number,
            prUrl: prData.url,
            missionId,
            diffSummary: diffStat.slice(0, 2000),
            acceptanceCriteria: missionRow?.acceptance_criteria ?? ''
          })
        )

        db.prepare("UPDATE missions SET status = 'pending-review', crew_id = NULL WHERE id = ?").run(missionId)
      } catch {
        // PR view failed — skip review request, continue normally
      }

      // Auto-merge if configured
      if (mergeStrategy === 'auto-merge' && !isDraft) {
        try {
          execSync(`gh pr merge --auto --squash "${worktreeBranch}"`, {
            cwd: sectorPath,
            stdio: 'pipe'
          })
        } catch {
          // Auto-merge might fail due to conflicts — warn Admiral
          db.prepare(
            "INSERT INTO comms (from_crew, to_crew, type, payload) VALUES (?, 'admiral', 'auto_merge_failed', ?)"
          ).run(crewId, JSON.stringify({ missionId, worktreeBranch }))
        }
      }
    } catch (err) {
      // PR creation failed — fall back to branch-only, invalidate gh cache
      Hull.ghAvailable = null
      db.prepare(
        "INSERT INTO comms (from_crew, to_crew, type, payload) VALUES (?, 'admiral', 'pr_creation_failed', ?)"
      ).run(
        crewId,
        JSON.stringify({ missionId, error: err instanceof Error ? err.message : 'unknown' })
      )
    } finally {
      try { unlinkSync(bodyFile) } catch { /* may already be deleted */ }
    }
  }

  private static isGhAvailable(): boolean {
    if (Hull.ghAvailable !== null) return Hull.ghAvailable
    try {
      execSync('gh auth status', { stdio: 'pipe' })
      Hull.ghAvailable = true
    } catch {
      Hull.ghAvailable = false
    }
    return Hull.ghAvailable
  }
}
