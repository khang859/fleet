import type Database from 'better-sqlite3'
import { execSync, ExecSyncOptions } from 'child_process'
import { writeFileSync, unlinkSync, mkdirSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import type { PtyManager } from '../pty-manager'
import { inferCommitType, deriveSummary, formatCommitMessage, formatCommitSubject } from './conventional-commits'
import { generateSkillMd } from './workspace-templates'

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
  onComplete?: () => void
  /** Environment variables for the PTY (enriched PATH so `claude` is found). */
  env?: Record<string, string>
  /** Called with PTY data — wire to renderer for live terminal output. */
  onPtyData?: (paneId: string, data: string) => void
  /** Called on PTY exit — wire to renderer for exit handling. */
  onPtyExit?: (paneId: string, exitCode: number) => void
}

type HullStatus = 'pending' | 'active' | 'complete' | 'error' | 'timeout' | 'aborted'

const MAX_OUTPUT_LINES = 200

export class Hull {
  private status: HullStatus = 'pending'
  private outputLines: string[] = []
  private lifesignTimer: ReturnType<typeof setInterval> | null = null
  private timeoutTimer: ReturnType<typeof setTimeout> | null = null
  private paneId: string | null = null
  private promptFile: string | null = null
  private pid: number | null = null

  private static ghAvailable: boolean | null = null

  constructor(private opts: HullOpts) {}

  /**
   * Start the Hull lifecycle. Requires a PtyManager to spawn the agent.
   * Returns the paneId of the created PTY.
   */
  async start(ptyManager: PtyManager, paneId: string): Promise<void> {
    this.paneId = paneId
    const { crewId, sectorId, missionId, prompt, worktreePath, worktreeBranch, db } = this.opts
    const lifesignSec = this.opts.lifesignIntervalSec ?? 10
    const timeoutMin = this.opts.timeoutMin ?? 15

    // Insert crew record
    db.prepare(
      `INSERT INTO crew (id, tab_id, sector_id, mission_id, sector_path, worktree_path,
        worktree_branch, status, mission_summary, pid, deadline, last_lifesign)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, NULL, datetime('now', '+${timeoutMin} minutes'), datetime('now'))`
    ).run(
      crewId,
      paneId,
      sectorId,
      missionId,
      this.opts.sectorPath,
      worktreePath,
      worktreeBranch,
      prompt.slice(0, 100)
    )

    // Activate mission
    db.prepare(
      "UPDATE missions SET status = 'active', crew_id = ?, started_at = datetime('now') WHERE id = ?"
    ).run(crewId, missionId)

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
        this.handleTimeout(ptyManager)
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

    // Spawn agent PTY
    try {
      // Write prompt to a temp file to avoid shell escaping issues with complex prompts.
      // Claude Code reads the file via its Read tool on first turn.
      const promptDir = join(tmpdir(), 'fleet-prompts')
      mkdirSync(promptDir, { recursive: true })
      const promptFile = join(promptDir, `${crewId}.md`)
      writeFileSync(promptFile, prompt, 'utf-8')
      this.promptFile = promptFile

      const model = this.opts.model || 'claude-sonnet-4-6'
      const cmdParts = [
        'claude',
        '--dangerously-skip-permissions',
        `--model ${model}`
      ]
      if (this.opts.systemPrompt) {
        // Append to default prompt so Claude Code retains its built-in tool instructions
        const spFile = join(promptDir, `${crewId}-system-prompt.md`)
        writeFileSync(spFile, this.opts.systemPrompt, 'utf-8')
        cmdParts.push(`--append-system-prompt-file "${spFile}"`)
      }
      if (this.opts.allowedTools) {
        cmdParts.push(`--allowedTools "${this.opts.allowedTools}"`)
      }
      if (this.opts.mcpConfig) {
        cmdParts.push(`--mcp-config "${this.opts.mcpConfig}"`)
      }
      cmdParts.push(`-p "Read and execute the mission prompt in ${promptFile}. Delete the file when done."`)

      const result = ptyManager.create({
        paneId,
        cwd: worktreePath,
        cmd: cmdParts.join(' '),
        env: {
          ...this.opts.env,
          FLEET_CREW_ID: crewId,
          FLEET_SECTOR_ID: this.opts.sectorId,
          FLEET_MISSION_ID: String(this.opts.missionId)
        }
      })
      this.pid = result.pid
      ptyManager.protect(paneId)
      db.prepare('UPDATE crew SET pid = ? WHERE id = ?').run(result.pid, crewId)
    } catch (err) {
      this.cleanup('error', `Spawn failed: ${err instanceof Error ? err.message : 'unknown'}`).catch(
        (cleanupErr) => {
          console.error('[hull] cleanup error:', cleanupErr)
        }
      )
      return
    }

    // Listen for output (also forward to renderer if callback provided)
    ptyManager.onData(paneId, (data) => {
      this.appendOutput(data)
      this.opts.onPtyData?.(paneId, data)
    })

    // Listen for exit (also forward to renderer if callback provided)
    ptyManager.onExit(paneId, (exitCode) => {
      this.opts.onPtyExit?.(paneId, exitCode)
      const status = exitCode === 0 ? 'complete' : 'error'
      this.cleanup(status, exitCode === 0 ? 'Completed successfully' : `Exit code: ${exitCode}`).catch(
        (cleanupErr) => {
          console.error('[hull] cleanup error:', cleanupErr)
        }
      )
    })
  }

  kill(ptyManager: PtyManager): void {
    if (this.paneId && ptyManager.has(this.paneId)) {
      ptyManager.kill(this.paneId)
    }
    this.cleanup('aborted', 'Recalled by Star Command').catch((err) => {
      console.error('[hull] cleanup error:', err)
    })
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
    if (this.outputLines.length > MAX_OUTPUT_LINES) {
      this.outputLines = this.outputLines.slice(-MAX_OUTPUT_LINES)
    }
  }

  getOutputBuffer(): string {
    return this.outputLines.join('\n')
  }

  private handleTimeout(ptyManager: PtyManager): void {
    if (this.paneId && ptyManager.has(this.paneId)) {
      ptyManager.kill(this.paneId)
    }
    // Cleanup will be called by the onExit handler, but if kill doesn't trigger exit:
    setTimeout(() => {
      if (this.status === 'active') {
        this.cleanup('timeout', 'Mission deadline exceeded').catch((err) => {
          console.error('[hull] cleanup error:', err)
        })
      }
    }, 5000)
  }

  private async cleanup(status: HullStatus, reason: string): Promise<void> {
    if (this.status !== 'active' && this.status !== 'pending') return // Already cleaned up

    this.status = status
    const { crewId, missionId, worktreePath, worktreeBranch, baseBranch, sectorPath, db } =
      this.opts

    // Clean up prompt file and system prompt file
    if (this.promptFile) {
      try { unlinkSync(this.promptFile) } catch { /* may already be deleted by agent */ }
      // Also clean up companion system-prompt file if it exists
      const spFile = this.promptFile.replace(`${this.opts.crewId}.md`, `${this.opts.crewId}-system-prompt.md`)
      try { unlinkSync(spFile) } catch { /* may not exist */ }
      this.promptFile = null
    }

    // Stop timers
    if (this.lifesignTimer) clearInterval(this.lifesignTimer)
    if (this.timeoutTimer) clearTimeout(this.timeoutTimer)

    const gitOpts: ExecSyncOptions = { cwd: worktreePath, stdio: 'pipe' }
    let overrideStatus: HullStatus | null = null

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
        // No work produced
        db.prepare(
          "UPDATE missions SET status = 'failed', result = ?, completed_at = datetime('now') WHERE id = ?"
        ).run('No work produced', missionId)
        overrideStatus = 'error'
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
      let labelArgs = `--label fleet --label "sector/${sectorId}" --label "mission/${missionId}"`
      if (hasLintWarnings) {
        labelArgs += ' --label lint-warnings'
      }
      execSync(
        `gh pr create --title '${prTitle.replace(/'/g, "'\\''")}' --body-file "${bodyFile}" --base "${baseBranch}" --head "${worktreeBranch}" ${draftFlag} ${labelArgs}`,
        { cwd: sectorPath, stdio: 'pipe' }
      )

      // Gate 3: If review_mode is admiral-review, send pr_review_request comms
      if (this.opts.reviewMode === 'admiral-review') {
        try {
          const prViewOutput = execSync(`gh pr view "${worktreeBranch}" --json number,url`, {
            cwd: sectorPath,
            stdio: 'pipe'
          }).toString()
          const prData = JSON.parse(prViewOutput) as { number: number; url: string }

          // Get acceptance criteria from mission
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

          // Update mission status to pending-review
          db.prepare("UPDATE missions SET status = 'pending-review' WHERE id = ?").run(missionId)
        } catch {
          // PR view failed — skip review request, continue normally
        }
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
