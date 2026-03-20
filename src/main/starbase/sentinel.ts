import type Database from 'better-sqlite3';
import { access } from 'fs/promises';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { createConnection } from 'node:net';
import { join } from 'path';
import { Notification } from 'electron';
import type { ConfigService } from './config-service';
import type { EventBus } from '../event-bus';
import type { SocketSupervisor } from '../socket-supervisor';
import { getAvailableMemoryBytes } from './available-memory';
import type { FirstOfficer } from './first-officer';
import type { CrewService } from './crew-service';
import type { SettingsStore } from '../settings-store';
import { computeFingerprint, classifyError } from './error-fingerprint';

const execFileAsync = promisify(execFile);

type SentinelDeps = {
  db: Database.Database;
  configService: ConfigService;
  eventBus?: EventBus;
  supervisor?: SocketSupervisor;
  socketPath?: string;
  firstOfficer?: FirstOfficer;
  crewService?: CrewService;
  settingsStore?: SettingsStore;
  onNudgeClick?: () => void;
};

type CrewRow = {
  id: string;
  sector_id: string;
  status: string;
  last_lifesign: string | null;
  deadline: string | null;
  pid: number | null;
};

type SectorRow = {
  id: string;
  root_path: string;
};

export class Sentinel {
  private interval: ReturnType<typeof setInterval> | null = null;
  private sweepCount = 0;
  private sweepInProgress = false;
  private consecutivePingFailures = 0;
  private diskCacheBytes: number | null = null;
  private diskCacheTime = 0;
  /** Last sent alert level per type — only re-send when level changes or clears */
  private lastAlertLevel: Record<string, string | null> = {};
  private lastNudgeAt = 0;

  constructor(private deps: SentinelDeps) {}

  start(intervalMs?: number): void {
    const ms = intervalMs ?? (this.deps.configService.get('lifesign_interval_sec') as number) * 1000;
    this.interval = setInterval(() => {
      this.runSweep().catch((err) => {
        console.error('[sentinel] Sweep failed:', err);
      });
    }, ms);
  }

  stop(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
  }

  async runSweep(): Promise<void> {
    if (this.sweepInProgress) return;
    this.sweepInProgress = true;
    try {
      await this._runSweep();
    } finally {
      this.sweepInProgress = false;
    }
  }

  private async _runSweep(): Promise<void> {
    this.sweepCount++;
    const { db, configService } = this.deps;

    const lifesignTimeout = configService.get('lifesign_timeout_sec') as number;

    // 1. Lifesign check
    const staleCrew = db
      .prepare(
        `SELECT id, sector_id FROM crew
         WHERE status = 'active' AND last_lifesign < datetime('now', '-${lifesignTimeout} seconds')`,
      )
      .all() as CrewRow[];

    for (const crew of staleCrew) {
      db.prepare("UPDATE crew SET status = 'lost', updated_at = datetime('now') WHERE id = ?").run(
        crew.id,
      );
      db.prepare(
        "INSERT INTO ships_log (crew_id, event_type, detail) VALUES (?, 'lifesign_lost', ?)",
      ).run(crew.id, JSON.stringify({ sectorId: crew.sector_id }));
      // Send transmission to Admiral
      db.prepare(
        "INSERT INTO comms (from_crew, to_crew, type, payload) VALUES (?, 'admiral', 'lifesign_lost', ?)",
      ).run(crew.id, JSON.stringify({ crewId: crew.id, sectorId: crew.sector_id }));
    }

    // 2. Mission deadline check
    const expiredCrew = db
      .prepare(
        `SELECT id, sector_id, pid FROM crew
         WHERE status = 'active' AND deadline IS NOT NULL AND deadline < datetime('now')`,
      )
      .all() as CrewRow[];

    for (const crew of expiredCrew) {
      // Try to kill the process
      if (crew.pid) {
        try {
          process.kill(crew.pid, 'SIGTERM');
        } catch {
          // Process already dead
        }
      }
      db.prepare("UPDATE crew SET status = 'timeout', updated_at = datetime('now') WHERE id = ?").run(
        crew.id,
      );
      db.prepare(
        "INSERT INTO ships_log (crew_id, event_type, detail) VALUES (?, 'timeout', ?)",
      ).run(crew.id, JSON.stringify({ reason: 'deadline expired' }));
    }

    // 3. Sector path validation
    const sectors = db.prepare('SELECT id, root_path FROM sectors').all() as SectorRow[];
    for (const sector of sectors) {
      let pathExists = true;
      try {
        await access(sector.root_path);
      } catch {
        pathExists = false;
      }
      if (!pathExists) {
        // Mark all crew in this sector as lost
        db.prepare(
          "UPDATE crew SET status = 'lost', updated_at = datetime('now') WHERE sector_id = ? AND status = 'active'",
        ).run(sector.id);
        db.prepare(
          "INSERT INTO ships_log (event_type, detail) VALUES ('sector_path_missing', ?)",
        ).run(JSON.stringify({ sectorId: sector.id, path: sector.root_path }));
        db.prepare(
          "INSERT INTO comms (to_crew, type, payload) VALUES ('admiral', 'sector_path_missing', ?)",
        ).run(JSON.stringify({ sectorId: sector.id, path: sector.root_path }));
      }
    }

    // 4. Dependency deadlock detection (skip — Phase 5)

    // 5. Disk usage check
    const diskBudgetGb = configService.get('worktree_disk_budget_gb') as number;
    const diskBytes = await this.getDiskUsage();
    if (diskBytes !== null) {
      const usedGb = diskBytes / (1024 * 1024 * 1024);
      const pct = (usedGb / diskBudgetGb) * 100;
      const diskLevel = pct >= 90 ? 'warning' : null;
      if (diskLevel && this.lastAlertLevel['disk_warning'] !== diskLevel) {
        this.lastAlertLevel['disk_warning'] = diskLevel;
        db.prepare(
          "INSERT INTO comms (to_crew, type, payload) VALUES ('admiral', 'disk_warning', ?)",
        ).run(JSON.stringify({ usedGb: usedGb.toFixed(2), budgetGb: diskBudgetGb, percent: pct.toFixed(0) }));
      } else if (!diskLevel) {
        this.lastAlertLevel['disk_warning'] = null;
      }
    }

    // 6. System memory check (uses available memory, not just free pages)
    const availableBytes = await getAvailableMemoryBytes();
    const availableGb = availableBytes / (1024 * 1024 * 1024);
    const memLevel = availableGb < 0.5 ? 'critical' : availableGb < 1 ? 'warning' : null;
    if (memLevel && this.lastAlertLevel['memory_warning'] !== memLevel) {
      this.lastAlertLevel['memory_warning'] = memLevel;
      db.prepare(
        "INSERT INTO comms (to_crew, type, payload) VALUES ('admiral', 'memory_warning', ?)",
      ).run(JSON.stringify({ freeMemoryGb: availableGb.toFixed(2), level: memLevel }));
    } else if (!memLevel) {
      this.lastAlertLevel['memory_warning'] = null;
    }

    // 7. Comms rate limit reset (every 6th sweep = ~60 seconds)
    if (this.sweepCount % 6 === 0) {
      db.prepare('UPDATE crew SET comms_count_minute = 0').run();
      this.deps.eventBus?.emit('starbase-changed', { type: 'starbase-changed' });
    }

    // 8. Socket health check
    if (this.deps.supervisor && this.deps.socketPath) {
      await this.checkSocketHealth();
    }

    // 9. PR Review sweep — dispatch review/fix crews for pending-review and changes-requested missions
    if (this.deps.crewService) {
      await this.reviewSweep()
    }

    // 10. First Officer triage — detect actionable failures and dispatch
    if (this.deps.firstOfficer) {
      await this.firstOfficerSweep()
    }
  }

  private async getDiskUsage(): Promise<number | null> {
    const now = Date.now();
    if (this.diskCacheBytes !== null && now - this.diskCacheTime < 60_000) {
      return this.diskCacheBytes;
    }

    try {
      const homePath = process.env.HOME ?? '~';
      const worktreePath = `${homePath}/.fleet/worktrees`;
      try {
        await access(worktreePath);
      } catch {
        return 0;
      }

      const { stdout } = await execFileAsync('du', ['-sk', worktreePath], { timeout: 10_000 });
      const match = stdout.match(/^(\d+)/);
      if (!match) return null;

      const kb = parseInt(match[1], 10);
      this.diskCacheBytes = kb * 1024;
      this.diskCacheTime = now;
      return this.diskCacheBytes;
    } catch {
      return null;
    }
  }

  private async checkSocketHealth(): Promise<void> {
    const { supervisor, socketPath } = this.deps;
    if (!supervisor || !socketPath) return;

    const healthy = await this.pingSocket(socketPath, 3000);

    if (healthy) {
      this.consecutivePingFailures = 0;
      supervisor.resetBackoff();
      return;
    }

    this.consecutivePingFailures++;
    console.warn(`[sentinel] Socket ping failed (${this.consecutivePingFailures}/3)`);

    if (this.consecutivePingFailures >= 3) {
      console.error('[sentinel] Socket unresponsive, triggering restart');
      this.consecutivePingFailures = 0;

      const alertLevel = 'warning';
      if (this.lastAlertLevel['socket_health'] !== alertLevel) {
        this.lastAlertLevel['socket_health'] = alertLevel;
        this.deps.db.prepare(
          "INSERT INTO comms (to_crew, type, payload) VALUES ('admiral', 'socket_restart', ?)",
        ).run(JSON.stringify({ reason: '3 consecutive ping failures' }));
        this.deps.db.prepare(
          "INSERT INTO ships_log (event_type, detail) VALUES ('socket_restart', ?)",
        ).run(JSON.stringify({ reason: '3 consecutive ping failures' }));
      }

      supervisor.restart().catch((err) => {
        console.error('[sentinel] Supervisor restart failed:', err);
      });
    }
  }

  private async firstOfficerSweep(): Promise<void> {
    const { db, configService, firstOfficer } = this.deps
    if (!firstOfficer) return

    const maxRetries = configService.get('first_officer_max_retries') as number
    const maxDeployments = configService.get('max_mission_deployments') as number ?? 8

    const failedCrew = db
      .prepare(
        `SELECT c.id as crew_id, c.sector_id, c.mission_id,
                m.id as mid, m.summary, m.prompt, m.acceptance_criteria,
                m.status as mission_status, m.result, m.verify_result,
                m.review_notes, m.first_officer_retry_count,
                m.last_error_fingerprint, m.mission_deployment_count,
                s.name as sector_name, s.verify_command
         FROM crew c
         JOIN missions m ON m.id = c.mission_id
         JOIN sectors s ON s.id = c.sector_id
         WHERE c.status IN ('error', 'lost', 'timeout')
           AND m.status IN ('failed', 'failed-verification')
           AND m.first_officer_retry_count < ?
           AND m.mission_deployment_count < ?
           AND c.id = (
             SELECT c2.id FROM crew c2
             WHERE c2.mission_id = m.id
               AND c2.status IN ('error', 'lost', 'timeout')
             ORDER BY c2.updated_at DESC
             LIMIT 1
           )
           AND NOT EXISTS (
             SELECT 1 FROM comms
             WHERE type = 'memo' AND mission_id = m.id AND read = 0
           )`
      )
      .all(maxRetries, maxDeployments) as Array<{
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
        last_error_fingerprint: string | null
        mission_deployment_count: number
        sector_name: string
        verify_command: string | null
      }>

    for (const row of failedCrew) {
      if (firstOfficer.isRunning(row.crew_id, row.mid)) continue

      // Compute error fingerprint from current failure
      const errorText = (row.result ?? '') + '\n' + (row.verify_result ?? '')
      const fingerprint = computeFingerprint(errorText)

      // Classify the error
      const classification = classifyError(
        errorText,
        fingerprint,
        row.last_error_fingerprint ?? undefined,
      )

      // Update fingerprint on the mission
      db.prepare('UPDATE missions SET last_error_fingerprint = ? WHERE id = ?')
        .run(fingerprint, row.mid)

      // Non-retryable or persistent → auto-escalate without FO
      if (classification !== 'transient') {
        firstOfficer.writeAutoEscalationComm({
          crewId: row.crew_id,
          missionId: row.mid,
          classification,
          fingerprint,
          summary: row.summary,
          errorText: errorText.split('\n').slice(-30).join('\n'),
        })
        continue
      }

      // Get crew output for FO context
      let crewOutput = row.result ?? 'No output captured'
      if (this.deps.crewService) {
        const hullOutput = this.deps.crewService.observeCrew(row.crew_id)
        if (hullOutput) crewOutput = hullOutput
      }
      if (row.verify_result) {
        try {
          const vr = JSON.parse(row.verify_result)
          if (vr.stdout) crewOutput += '\n\n--- Verification Output ---\n' + vr.stdout
          if (vr.stderr) crewOutput += '\n\n--- Verification Stderr ---\n' + vr.stderr
        } catch { /* ignore parse errors */ }
      }

      // Build attempt history from previous memo comms
      const prevMemos = db.prepare(
        `SELECT payload FROM comms
         WHERE type = 'memo' AND mission_id = ? ORDER BY created_at ASC LIMIT 10`
      ).all(row.mid) as Array<{ payload: string }>

      const attemptHistory = prevMemos.map((m, i) => {
        try {
          const p = JSON.parse(m.payload)
          return `| ${i + 1} | ${p.summary?.slice(0, 60) ?? 'unknown'} | ${p.fingerprint ?? '—'} | ${p.classification ?? '—'} |`
        } catch { return null }
      }).filter(Boolean).join('\n')

      // Increment retry count BEFORE dispatch (prevents race on next sweep)
      db.prepare(
        'UPDATE missions SET first_officer_retry_count = first_officer_retry_count + 1 WHERE id = ?'
      ).run(row.mid)

      // Fire-and-forget dispatch (async, non-blocking)
      firstOfficer.dispatch(
        {
          crewId: row.crew_id,
          missionId: row.mid,
          sectorId: row.sector_id,
          sectorName: row.sector_name,
          eventType: row.mission_status === 'failed-verification' ? 'verification-failed' : 'error',
          missionSummary: row.summary,
          missionPrompt: row.prompt,
          acceptanceCriteria: row.acceptance_criteria,
          verifyCommand: row.verify_command,
          crewOutput,
          verifyResult: row.verify_result,
          reviewNotes: row.review_notes,
          retryCount: row.first_officer_retry_count,
          attemptHistory: attemptHistory || undefined,
        },
        {
          onExit: (code) => {
            db.prepare(
              "INSERT INTO ships_log (crew_id, event_type, detail) VALUES (?, 'first_officer_dispatched', ?)"
            ).run(row.crew_id, JSON.stringify({
              missionId: row.mid,
              retryCount: row.first_officer_retry_count + 1,
              exitCode: code,
            }))
            this.deps.eventBus?.emit('starbase-changed', { type: 'starbase-changed' })
          },
        },
      ).catch(err => {
        console.error(`[sentinel] FO dispatch error for mission ${row.mid}:`, err)
      })
    }

    // Check for unanswered hailing > 60s (escalation only, no auto-answer)
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
           AND cr.mission_id IS NOT NULL
           AND NOT EXISTS (
             SELECT 1 FROM comms
             WHERE type = 'hailing-memo' AND mission_id = cr.mission_id AND read = 0
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
      firstOfficer.writeHailingMemo({
        crewId: hail.from_crew,
        missionId: hail.mission_id,
        sectorName: hail.sector_name,
        payload: hail.payload,
        createdAt: hail.created_at,
      })
    }

    // Nudge: summary notification for comms unread >5 minutes
    const { settingsStore } = this.deps;
    if (settingsStore && Notification.isSupported()) {
      const settings = settingsStore.get();
      if (settings.notifications.comms.os) {
        const NUDGE_INTERVAL_MS = 5 * 60 * 1000;
        const now = Date.now();
        if (now - this.lastNudgeAt >= NUDGE_INTERVAL_MS) {
          const staleComms = db
            .prepare(
              `SELECT from_crew FROM comms
               WHERE to_crew = 'admiral' AND read = 0
                 AND created_at < datetime('now', '-5 minutes')`
            )
            .all() as Array<{ from_crew: string | null }>;

          if (staleComms.length > 0) {
            const uniqueCrews = new Set(staleComms.map((c) => c.from_crew).filter(Boolean));
            const body = `${staleComms.length} unread transmission${staleComms.length > 1 ? 's' : ''} from ${uniqueCrews.size} crew${uniqueCrews.size > 1 ? 's' : ''}`;
            const notif = new Notification({ title: 'Fleet', body });
            if (this.deps.onNudgeClick) {
              notif.on('click', this.deps.onNudgeClick);
            }
            notif.show();
            this.lastNudgeAt = now;
          }
        }
      }
    }
  }

  private async reviewSweep(): Promise<void> {
    const { db, configService, crewService } = this.deps
    if (!crewService) return

    const maxConcurrent = (configService.get('review_crew_max_concurrent') as number) ?? 2

    // Count active review crews
    const activeReviewCount = (
      db.prepare(
        "SELECT COUNT(*) as cnt FROM crew c JOIN missions m ON m.id = c.mission_id WHERE c.status = 'active' AND m.type = 'review'"
      ).get() as { cnt: number }
    ).cnt

    if (activeReviewCount >= maxConcurrent) return

    // Find missions needing review
    const pendingReview = db.prepare(
      `SELECT m.id, m.sector_id, m.summary, m.acceptance_criteria, m.pr_branch,
              m.review_round, m.review_notes,
              s.base_branch, s.verify_command, s.name as sector_name
       FROM missions m
       JOIN sectors s ON s.id = m.sector_id
       WHERE m.status = 'pending-review'
         AND m.pr_branch IS NOT NULL
         AND m.type = 'code'
       ORDER BY m.priority ASC, m.completed_at ASC
       LIMIT ?`
    ).all(maxConcurrent - activeReviewCount) as Array<{
      id: number
      sector_id: string
      summary: string
      acceptance_criteria: string | null
      pr_branch: string
      review_round: number
      review_notes: string | null
      base_branch: string
      verify_command: string | null
      sector_name: string
    }>

    for (const mission of pendingReview) {
      // Transition to reviewing (dedup guard)
      db.prepare("UPDATE missions SET status = 'reviewing' WHERE id = ? AND status = 'pending-review'").run(mission.id)
      const changed = db.prepare('SELECT changes() as c').get() as { c: number }
      if (changed.c === 0) continue // Another sweep already claimed it

      // Build review prompt
      const reviewPrompt = `Review the PR on branch \`${mission.pr_branch}\` targeting \`${mission.base_branch}\`.

## Mission Context
Summary: ${mission.summary}
Acceptance Criteria: ${mission.acceptance_criteria ?? 'None specified'}

## Instructions
1. Run the verify command to check tests pass
2. Read the diff: \`git diff ${mission.base_branch}...${mission.pr_branch}\`
3. Review against acceptance criteria and code quality
4. Check for: logic errors, security issues, missing tests, convention violations, unnecessary complexity
5. Only report issues you are >=80% confident about
6. Output your verdict in this exact format:

VERDICT: APPROVE | REQUEST_CHANGES | ESCALATE
NOTES: <your review notes — specific file:line references for issues>`

      try {
        await crewService.deployCrew({
          sectorId: mission.sector_id,
          prompt: reviewPrompt,
          missionId: mission.id,
          type: 'review',
          prBranch: mission.pr_branch,
        })

        db.prepare(
          "INSERT INTO ships_log (event_type, detail) VALUES ('review_crew_dispatched', ?)"
        ).run(JSON.stringify({ missionId: mission.id, prBranch: mission.pr_branch }))
      } catch (err) {
        // Deployment failed — revert to pending-review so next sweep retries
        db.prepare("UPDATE missions SET status = 'pending-review' WHERE id = ?").run(mission.id)
        console.error(`[sentinel] Review crew deploy failed for mission ${mission.id}:`, err)
      }
    }

    // Find missions needing fix crews (changes-requested)
    const changesRequested = db.prepare(
      `SELECT m.id, m.sector_id, m.summary, m.prompt, m.acceptance_criteria,
              m.pr_branch, m.review_round, m.review_notes,
              s.base_branch, s.name as sector_name
       FROM missions m
       JOIN sectors s ON s.id = m.sector_id
       WHERE m.status = 'changes-requested'
         AND m.pr_branch IS NOT NULL
         AND m.type = 'code'
       ORDER BY m.priority ASC
       LIMIT 5`
    ).all() as Array<{
      id: number
      sector_id: string
      summary: string
      prompt: string
      acceptance_criteria: string | null
      pr_branch: string
      review_round: number
      review_notes: string | null
      base_branch: string
      sector_name: string
    }>

    for (const mission of changesRequested) {
      // Check max review rounds
      if (mission.review_round >= 2) {
        db.prepare("UPDATE missions SET status = 'escalated' WHERE id = ?").run(mission.id)

        // Send escalation comms
        db.prepare(
          "INSERT INTO comms (from_crew, to_crew, type, payload) VALUES ('first-officer', 'admiral', 'review_escalated', ?)"
        ).run(JSON.stringify({
          missionId: mission.id,
          reason: `Max review rounds (${mission.review_round}) reached`,
          reviewNotes: mission.review_notes,
          prBranch: mission.pr_branch,
        }))

        db.prepare(
          "INSERT INTO ships_log (event_type, detail) VALUES ('review_escalated', ?)"
        ).run(JSON.stringify({ missionId: mission.id, reviewRound: mission.review_round }))
        continue
      }

      // Atomically claim the mission — skip if another process already claimed it
      const claim = db.prepare(
        "UPDATE missions SET status = 'deploying' WHERE id = ? AND status = 'changes-requested'"
      ).run(mission.id)
      if (claim.changes === 0) {
        continue
      }

      // Deploy fix crew on the same PR branch
      const fixPrompt = `Fix the issues identified in the PR review for branch \`${mission.pr_branch}\`.

## Original Mission
Summary: ${mission.summary}
Acceptance Criteria: ${mission.acceptance_criteria ?? 'None specified'}

## Review Feedback (Round ${mission.review_round})
${mission.review_notes ?? 'No specific notes provided'}

## Instructions
1. Read the review feedback carefully
2. Address each issue mentioned
3. Run the verify command to ensure tests still pass
4. Commit and push your fixes to the existing branch`

      try {
        await crewService.deployCrew({
          sectorId: mission.sector_id,
          prompt: fixPrompt,
          missionId: mission.id,
          type: 'code',
          prBranch: mission.pr_branch,
        })

        db.prepare(
          "INSERT INTO ships_log (event_type, detail) VALUES ('fix_crew_dispatched', ?)"
        ).run(JSON.stringify({ missionId: mission.id, prBranch: mission.pr_branch, round: mission.review_round }))
      } catch (err) {
        // Deploy failed — revert to changes-requested for next sweep
        db.prepare(
          "UPDATE missions SET status = 'changes-requested' WHERE id = ? AND status = 'deploying'"
        ).run(mission.id)
        console.error(`[sentinel] Fix crew deploy failed for mission ${mission.id}:`, err)
      }
    }

    // Auto-approved missions — transition to completed and notify admiral
    const autoApproved = db
      .prepare(
        `SELECT id, summary, pr_branch FROM missions
         WHERE status = 'approved'`
      )
      .all() as { id: number; summary: string; pr_branch: string | null }[]

    for (const mission of autoApproved) {
      db.prepare(
        "UPDATE missions SET status = 'completed', completed_at = datetime('now') WHERE id = ?"
      ).run(mission.id)
      db.prepare(
        "INSERT INTO comms (from_crew, to_crew, type, payload) VALUES ('admiral', 'admiral', 'mission_approved', ?)"
      ).run(JSON.stringify({ missionId: mission.id, summary: mission.summary, pr_branch: mission.pr_branch }))
      this.deps.eventBus?.emit('starbase-changed', { type: 'starbase-changed' })
    }
  }

  private pingSocket(socketPath: string, timeoutMs: number): Promise<boolean> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        socket.destroy();
        resolve(false);
      }, timeoutMs);

      const socket = createConnection(socketPath, () => {
        socket.write(JSON.stringify({ id: 'sentinel-ping', command: 'ping', args: {} }) + '\n');
      });

      let buffer = '';
      socket.on('data', (chunk) => {
        buffer += chunk.toString();
        if (buffer.includes('\n')) {
          clearTimeout(timer);
          socket.end();
          try {
            const parsed = JSON.parse(buffer.split('\n')[0]);
            resolve(parsed.ok === true && parsed.data?.pong === true);
          } catch {
            resolve(false);
          }
        }
      });

      socket.on('error', () => {
        clearTimeout(timer);
        resolve(false);
      });
    });
  }
}
