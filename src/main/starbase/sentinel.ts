import type Database from 'better-sqlite3';
import { access } from 'fs/promises';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { createConnection } from 'node:net';
import { Notification } from 'electron';
import type { ConfigService } from './config-service';
import type { EventBus } from '../event-bus';
import type { SocketSupervisor } from '../socket-supervisor';
import { getAvailableMemoryBytes } from './available-memory';
import type { FirstOfficer } from './first-officer';
import type { CrewService } from './crew-service';
import type { SettingsStore } from '../settings-store';
import { computeFingerprint, classifyError } from './error-fingerprint';
import type { Navigator } from './navigator';
import type { MissionService } from './mission-service';
import { ProtocolService } from './protocol-service';
import { GLOBAL_SECTOR_ID } from './sector-service';

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
  navigator?: Navigator;
  missionService?: MissionService;
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

type FailedCrewRow = {
  crew_id: string;
  sector_id: string;
  mission_id: number;
  mid: number;
  summary: string;
  prompt: string;
  acceptance_criteria: string | null;
  mission_status: string;
  result: string | null;
  verify_result: string | null;
  review_notes: string | null;
  first_officer_retry_count: number;
  last_error_fingerprint: string | null;
  mission_deployment_count: number;
  sector_name: string;
  verify_command: string | null;
};

type UnansweredHailingRow = {
  comm_id: number;
  from_crew: string;
  payload: string;
  created_at: string;
  sector_id: string;
  mission_id: number | null;
  sector_name: string;
};

type PendingReviewRow = {
  id: number;
  sector_id: string;
  summary: string;
  acceptance_criteria: string | null;
  pr_branch: string;
  review_round: number;
  review_notes: string | null;
  base_branch: string;
  verify_command: string | null;
  sector_name: string;
};

type ChangesRequestedRow = {
  id: number;
  sector_id: string;
  summary: string;
  prompt: string;
  acceptance_criteria: string | null;
  pr_branch: string;
  review_round: number;
  review_notes: string | null;
  base_branch: string;
  sector_name: string;
};

type NavigatorFanoutRow = {
  executionId: string;
  protocol_id: string;
  current_step: number;
  feature_request: string;
  context: string | null;
};

type ApprovedMissionRow = {
  id: number;
  sector_id: string;
  summary: string;
  prompt: string;
  pr_branch: string;
  review_round: number;
};

const MAX_REPAIR_ROUNDS = 2;

export class Sentinel {
  private interval: ReturnType<typeof setInterval> | null = null;
  private prMonitorInterval: ReturnType<typeof setInterval> | null = null;
  private sweepCount = 0;
  private sweepInProgress = false;
  private consecutivePingFailures = 0;
  private diskCacheBytes: number | null = null;
  private diskCacheTime = 0;
  /** Last sent alert level per type — only re-send when level changes or clears */
  private lastAlertLevel: Record<string, string | null> = {};
  private lastNudgeAt = 0;
  private protocolService: ProtocolService;
  private navigator?: Navigator;
  private db: Database.Database;
  private eventBus?: EventBus;
  private configService: ConfigService;

  constructor(private deps: SentinelDeps) {
    this.db = deps.db;
    this.eventBus = deps.eventBus;
    this.configService = deps.configService;
    this.navigator = deps.navigator;
    this.protocolService = new ProtocolService(deps.db);
  }

  start(intervalMs?: number): void {
    const ms = intervalMs ?? this.deps.configService.getNumber('lifesign_interval_sec') * 1000;
    this.interval = setInterval(() => {
      this.runSweep().catch((err) => {
        console.error('[sentinel] Sweep failed:', err);
      });
    }, ms);

    // PR monitor runs every 5 minutes — separate timer to avoid GitHub API rate limits
    this.prMonitorInterval = setInterval(() => {
      this.prMonitorSweep().catch((err) => {
        console.error('[sentinel] prMonitorSweep failed:', err);
      });
    }, 5 * 60 * 1000);
  }

  stop(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
    if (this.prMonitorInterval) {
      clearInterval(this.prMonitorInterval);
      this.prMonitorInterval = null;
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

    const lifesignTimeout = configService.getNumber('lifesign_timeout_sec');

    // 1. Lifesign check
    const staleCrew = db
      .prepare<[], CrewRow>(
        `SELECT id, sector_id FROM crew
         WHERE status = 'active' AND last_lifesign < datetime('now', '-${lifesignTimeout} seconds')`
      )
      .all();

    for (const crew of staleCrew) {
      db.prepare("UPDATE crew SET status = 'lost', updated_at = datetime('now') WHERE id = ?").run(
        crew.id
      );
      db.prepare(
        "INSERT INTO ships_log (crew_id, event_type, detail) VALUES (?, 'lifesign_lost', ?)"
      ).run(crew.id, JSON.stringify({ sectorId: crew.sector_id }));
      // Send transmission to Admiral
      db.prepare(
        "INSERT INTO comms (from_crew, to_crew, type, payload) VALUES (?, 'admiral', 'lifesign_lost', ?)"
      ).run(crew.id, JSON.stringify({ crewId: crew.id, sectorId: crew.sector_id }));
    }

    // 2. Mission deadline check
    const expiredCrew = db
      .prepare<[], CrewRow>(
        `SELECT id, sector_id, pid FROM crew
         WHERE status = 'active' AND deadline IS NOT NULL AND deadline < datetime('now')`
      )
      .all();

    for (const crew of expiredCrew) {
      // Try to kill the process
      if (crew.pid) {
        try {
          process.kill(crew.pid, 'SIGTERM');
        } catch {
          // Process already dead
        }
      }
      db.prepare(
        "UPDATE crew SET status = 'timeout', updated_at = datetime('now') WHERE id = ?"
      ).run(crew.id);
      db.prepare(
        "INSERT INTO ships_log (crew_id, event_type, detail) VALUES (?, 'timeout', ?)"
      ).run(crew.id, JSON.stringify({ reason: 'deadline expired' }));
    }

    // 3. Sector path validation
    const sectors = db.prepare<[], SectorRow>('SELECT id, root_path FROM sectors').all();
    for (const sector of sectors) {
      if (sector.id === GLOBAL_SECTOR_ID) continue;
      let pathExists = true;
      try {
        await access(sector.root_path);
      } catch {
        pathExists = false;
      }
      if (!pathExists) {
        // Mark all crew in this sector as lost
        db.prepare(
          "UPDATE crew SET status = 'lost', updated_at = datetime('now') WHERE sector_id = ? AND status = 'active'"
        ).run(sector.id);
        db.prepare(
          "INSERT INTO ships_log (event_type, detail) VALUES ('sector_path_missing', ?)"
        ).run(JSON.stringify({ sectorId: sector.id, path: sector.root_path }));
        db.prepare(
          "INSERT INTO comms (to_crew, type, payload) VALUES ('admiral', 'sector_path_missing', ?)"
        ).run(JSON.stringify({ sectorId: sector.id, path: sector.root_path }));
      }
    }

    // 4. Dependency deadlock detection (skip — Phase 5)

    // 5. Disk usage check
    const diskBudgetGb = configService.getNumber('worktree_disk_budget_gb');
    const diskBytes = await this.getDiskUsage();
    if (diskBytes !== null) {
      const usedGb = diskBytes / (1024 * 1024 * 1024);
      const pct = (usedGb / diskBudgetGb) * 100;
      const diskLevel = pct >= 90 ? 'warning' : null;
      if (diskLevel && this.lastAlertLevel['disk_warning'] !== diskLevel) {
        this.lastAlertLevel['disk_warning'] = diskLevel;
        db.prepare(
          "INSERT INTO comms (to_crew, type, payload) VALUES ('admiral', 'disk_warning', ?)"
        ).run(
          JSON.stringify({
            usedGb: usedGb.toFixed(2),
            budgetGb: diskBudgetGb,
            percent: pct.toFixed(0)
          })
        );
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
        "INSERT INTO comms (to_crew, type, payload) VALUES ('admiral', 'memory_warning', ?)"
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
      await this.reviewSweep();
    }

    // 10. First Officer triage — detect actionable failures and dispatch
    if (this.deps.firstOfficer) {
      await this.firstOfficerSweep();
    }

    // 11. Navigator sweep — crew-failed fan-out for protocol missions + gate expiry
    await this.navigatorSweep();
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
        this.deps.db
          .prepare(
            "INSERT INTO comms (to_crew, type, payload) VALUES ('admiral', 'socket_restart', ?)"
          )
          .run(JSON.stringify({ reason: '3 consecutive ping failures' }));
        this.deps.db
          .prepare("INSERT INTO ships_log (event_type, detail) VALUES ('socket_restart', ?)")
          .run(JSON.stringify({ reason: '3 consecutive ping failures' }));
      }

      supervisor.restart().catch((err) => {
        console.error('[sentinel] Supervisor restart failed:', err);
      });
    }
  }

  private async firstOfficerSweep(): Promise<void> {
    const { db, configService, firstOfficer } = this.deps;
    if (!firstOfficer) return;

    const maxDeployments = configService.getNumber('max_mission_deployments');

    const failedCrew = db
      .prepare<[number], FailedCrewRow>(
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
           AND m.first_officer_retry_count <= ?
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
      .all(configService.getNumber('first_officer_max_retries'));

    for (const row of failedCrew) {
      if (firstOfficer.isRunning(row.crew_id, row.mid)) continue;

      // Compute error fingerprint from current failure
      const errorText = (row.result ?? '') + '\n' + (row.verify_result ?? '');
      const fingerprint = computeFingerprint(errorText);

      // Classify the error
      const classification = classifyError(
        errorText,
        fingerprint,
        row.last_error_fingerprint ?? undefined
      );

      // Update fingerprint on the mission
      db.prepare('UPDATE missions SET last_error_fingerprint = ? WHERE id = ?').run(
        fingerprint,
        row.mid
      );

      // Get crew output for FO context
      let crewOutput = row.result ?? 'No output captured';
      if (this.deps.crewService) {
        const hullOutput = this.deps.crewService.observeCrew(row.crew_id);
        if (hullOutput) crewOutput = hullOutput;
      }
      if (row.verify_result) {
        try {
          const rawVr: unknown = JSON.parse(row.verify_result);
          const vr =
            rawVr != null && typeof rawVr === 'object'
              ? (rawVr as { stdout?: string; stderr?: string })
              : {};
          if (vr.stdout) crewOutput += '\n\n--- Verification Output ---\n' + vr.stdout;
          if (vr.stderr) crewOutput += '\n\n--- Verification Stderr ---\n' + vr.stderr;
        } catch {
          /* ignore parse errors */
        }
      }

      // Build attempt history from previous memo comms
      const prevMemos = db
        .prepare<[number], { payload: string }>(
          `SELECT payload FROM comms
         WHERE type = 'memo' AND mission_id = ? ORDER BY created_at ASC LIMIT 10`
        )
        .all(row.mid);

      const attemptHistory = prevMemos
        .map((m, i) => {
          try {
            const rawP: unknown = JSON.parse(m.payload);
            const p =
              rawP != null && typeof rawP === 'object'
                ? (rawP as { summary?: string; fingerprint?: string; classification?: string })
                : {};
            return `| ${i + 1} | ${p.summary?.slice(0, 60) ?? 'unknown'} | ${p.fingerprint ?? '—'} | ${p.classification ?? '—'} |`;
          } catch {
            return null;
          }
        })
        .filter(Boolean)
        .join('\n');

      // Increment retry count BEFORE dispatch (prevents race on next sweep)
      db.prepare(
        'UPDATE missions SET first_officer_retry_count = first_officer_retry_count + 1 WHERE id = ?'
      ).run(row.mid);

      // Fire-and-forget dispatch (async, non-blocking)
      firstOfficer
        .dispatch(
          {
            crewId: row.crew_id,
            missionId: row.mid,
            sectorId: row.sector_id,
            sectorName: row.sector_name,
            eventType:
              row.mission_status === 'failed-verification' ? 'verification-failed' : 'error',
            missionSummary: row.summary,
            missionPrompt: row.prompt,
            acceptanceCriteria: row.acceptance_criteria,
            verifyCommand: row.verify_command,
            crewOutput,
            verifyResult: row.verify_result,
            reviewNotes: row.review_notes,
            retryCount: row.first_officer_retry_count,
            attemptHistory: attemptHistory || undefined,
            fingerprint,
            classification,
            deploymentBudgetExhausted: row.mission_deployment_count >= maxDeployments
          },
          {
            onExit: (code) => {
              db.prepare(
                "INSERT INTO ships_log (crew_id, event_type, detail) VALUES (?, 'first_officer_dispatched', ?)"
              ).run(
                row.crew_id,
                JSON.stringify({
                  missionId: row.mid,
                  retryCount: row.first_officer_retry_count + 1,
                  exitCode: code
                })
              );
              this.deps.eventBus?.emit('starbase-changed', { type: 'starbase-changed' });
            }
          }
        )
        .catch((err) => {
          console.error(`[sentinel] FO dispatch error for mission ${row.mid}:`, err);
        });
    }

    // Check for unanswered hailing > 60s (escalation only, no auto-answer)
    const unansweredHailing = db
      .prepare<[], UnansweredHailingRow>(
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
      .all();

    for (const hail of unansweredHailing) {
      await firstOfficer.writeHailingMemo({
        crewId: hail.from_crew,
        missionId: hail.mission_id,
        sectorName: hail.sector_name,
        payload: hail.payload,
        createdAt: hail.created_at
      });
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
            .prepare<[], { from_crew: string | null }>(
              `SELECT from_crew FROM comms
               WHERE to_crew = 'admiral' AND read = 0
                 AND created_at < datetime('now', '-5 minutes')`
            )
            .all();

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

  private async navigatorSweep(): Promise<void> {
    const gateExpirySeconds = this.configService.getNumber('navigator_gate_expiry');

    // Gate expiry — mark stale gate-pending executions as gate-expired
    const stale = this.protocolService.getStaleGatePendingExecutions(gateExpirySeconds);
    for (const exec of stale) {
      this.protocolService.updateExecutionStatus(exec.id, 'gate-expired');
      this.db
        .prepare(
          `INSERT INTO comms (from_crew, to_crew, type, execution_id, payload)
         VALUES ('navigator', 'admiral', 'gate-expired', ?, ?)`
        )
        .run(
          exec.id,
          JSON.stringify({
            executionId: exec.id,
            reason: 'Gate expired after inactivity',
            protocolId: exec.protocol_id
          })
        );
      this.eventBus?.emit('starbase-changed', { type: 'starbase-changed' });
    }

    if (!this.navigator) return;

    // Crew-failed fan-out — detect FO escalations for protocol missions
    const rows = this.db
      .prepare<[], NavigatorFanoutRow>(
        `
      SELECT m.protocol_execution_id as executionId, pe.protocol_id, pe.current_step, pe.feature_request, pe.context
      FROM comms c
      JOIN missions m ON c.mission_id = m.id
      JOIN protocol_executions pe ON m.protocol_execution_id = pe.id
      WHERE c.type = 'memo'
        AND m.protocol_execution_id IS NOT NULL
        AND c.read = 0
        AND pe.status = 'running'
      GROUP BY m.protocol_execution_id
    `
      )
      .all();

    for (const row of rows) {
      if (this.navigator.isRunning(row.executionId)) continue;
      const proto = this.db
        .prepare<[string], { slug: string }>('SELECT slug FROM protocols WHERE id = ?')
        .get(row.protocol_id);
      if (!proto) continue;

      // Mark triggering memo comms as read to prevent repeated fan-out on next sweep
      this.db
        .prepare(
          `UPDATE comms SET read = 1
         WHERE type = 'memo' AND read = 0
           AND mission_id IN (
             SELECT id FROM missions WHERE protocol_execution_id = ?
           )`
        )
        .run(row.executionId);

      await this.navigator.dispatch({
        executionId: row.executionId,
        protocolSlug: proto.slug,
        featureRequest: row.feature_request,
        currentStep: row.current_step,
        context: row.context,
        eventType: 'crew-failed'
      });
    }

    // Crew-completed fan-out — detect successful protocol missions and nudge Navigator
    const completedRows = this.db
      .prepare<
        [],
        {
          executionId: string;
          protocol_id: string;
          current_step: number;
          feature_request: string;
          context: string | null;
          missionId: number;
        }
      >(
        `SELECT m.protocol_execution_id as executionId, pe.protocol_id,
                pe.current_step, pe.feature_request, pe.context, m.id as missionId
         FROM missions m
         JOIN protocol_executions pe ON m.protocol_execution_id = pe.id
         WHERE m.status = 'done'
           AND m.protocol_execution_id IS NOT NULL
           AND pe.status = 'running'
           AND NOT EXISTS (
             SELECT 1 FROM comms
             WHERE type = 'crew-completed'
               AND execution_id = m.protocol_execution_id
               AND mission_id = m.id
           )`
      )
      .all();

    for (const row of completedRows) {
      const proto = this.db
        .prepare<[string], { slug: string }>('SELECT slug FROM protocols WHERE id = ?')
        .get(row.protocol_id);
      if (!proto) continue;

      // Write crew-completed signal tagged with execution_id so Navigator can poll it
      this.db
        .prepare(
          `INSERT INTO comms (from_crew, to_crew, type, mission_id, execution_id, payload)
           VALUES ('sentinel', 'navigator', 'crew-completed', ?, ?, ?)`
        )
        .run(row.missionId, row.executionId, JSON.stringify({ missionId: row.missionId }));

      // Re-dispatch Navigator if not already running for this execution
      if (!this.navigator.isRunning(row.executionId)) {
        await this.navigator.dispatch({
          executionId: row.executionId,
          protocolSlug: proto.slug,
          featureRequest: row.feature_request,
          currentStep: row.current_step,
          context: row.context,
          eventType: 'crew-completed'
        });
      }

      this.eventBus?.emit('starbase-changed', { type: 'starbase-changed' });
    }
  }

  private async reviewSweep(): Promise<void> {
    const { db, configService, crewService } = this.deps;
    if (!crewService) return;

    const maxConcurrent = configService.getNumber('review_crew_max_concurrent');

    // Count active review crews
    const activeReviewCount =
      db
        .prepare<
          [],
          { cnt: number }
        >("SELECT COUNT(*) as cnt FROM crew c JOIN missions m ON m.id = c.mission_id WHERE c.status = 'active' AND m.type = 'review'")
        .get()?.cnt ?? 0;

    if (activeReviewCount >= maxConcurrent) return;

    // Find missions needing review
    const pendingReview = db
      .prepare<[number], PendingReviewRow>(
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
      )
      .all(maxConcurrent - activeReviewCount);

    for (const mission of pendingReview) {
      // Transition to reviewing (dedup guard)
      db.prepare(
        "UPDATE missions SET status = 'reviewing' WHERE id = ? AND status = 'pending-review'"
      ).run(mission.id);
      const changed = db.prepare<[], { c: number }>('SELECT changes() as c').get();
      if (!changed || changed.c === 0) continue; // Another sweep already claimed it

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
NOTES: <your review notes — specific file:line references for issues>`;

      try {
        await crewService.deployCrew({
          sectorId: mission.sector_id,
          prompt: reviewPrompt,
          missionId: mission.id,
          type: 'review',
          prBranch: mission.pr_branch
        });

        db.prepare(
          "INSERT INTO ships_log (event_type, detail) VALUES ('review_crew_dispatched', ?)"
        ).run(JSON.stringify({ missionId: mission.id, prBranch: mission.pr_branch }));
      } catch (err) {
        // Deployment failed — revert to pending-review so next sweep retries
        db.prepare("UPDATE missions SET status = 'pending-review' WHERE id = ?").run(mission.id);
        console.error(`[sentinel] Review crew deploy failed for mission ${mission.id}:`, err);
      }
    }

    // Find missions needing fix crews (changes-requested)
    const changesRequested = db
      .prepare<[], ChangesRequestedRow>(
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
      )
      .all();

    for (const mission of changesRequested) {
      // Check max review rounds
      if (mission.review_round >= 2) {
        db.prepare("UPDATE missions SET status = 'escalated' WHERE id = ?").run(mission.id);

        // Send escalation comms
        db.prepare(
          "INSERT INTO comms (from_crew, to_crew, type, payload) VALUES ('first-officer', 'admiral', 'review_escalated', ?)"
        ).run(
          JSON.stringify({
            missionId: mission.id,
            reason: `Max review rounds (${mission.review_round}) reached`,
            reviewNotes: mission.review_notes,
            prBranch: mission.pr_branch
          })
        );

        db.prepare("INSERT INTO ships_log (event_type, detail) VALUES ('review_escalated', ?)").run(
          JSON.stringify({ missionId: mission.id, reviewRound: mission.review_round })
        );
        continue;
      }

      // Atomically claim the mission — skip if another process already claimed it
      const claim = db
        .prepare(
          "UPDATE missions SET status = 'deploying' WHERE id = ? AND status = 'changes-requested'"
        )
        .run(mission.id);
      if (claim.changes === 0) {
        continue;
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
4. Commit and push your fixes to the existing branch`;

      try {
        await crewService.deployCrew({
          sectorId: mission.sector_id,
          prompt: fixPrompt,
          missionId: mission.id,
          type: 'code',
          prBranch: mission.pr_branch
        });

        db.prepare(
          "INSERT INTO ships_log (event_type, detail) VALUES ('fix_crew_dispatched', ?)"
        ).run(
          JSON.stringify({
            missionId: mission.id,
            prBranch: mission.pr_branch,
            round: mission.review_round
          })
        );
      } catch (err) {
        // Deploy failed — revert to changes-requested for next sweep
        db.prepare(
          "UPDATE missions SET status = 'changes-requested' WHERE id = ? AND status = 'deploying'"
        ).run(mission.id);
        console.error(`[sentinel] Fix crew deploy failed for mission ${mission.id}:`, err);
      }
    }

    // Auto-approved missions — transition to completed and notify admiral
    const autoApproved = db
      .prepare<[], { id: number; summary: string; pr_branch: string | null }>(
        `SELECT id, summary, pr_branch FROM missions
         WHERE status = 'approved'`
      )
      .all();

    for (const mission of autoApproved) {
      db.prepare(
        "UPDATE missions SET status = 'completed', completed_at = datetime('now') WHERE id = ?"
      ).run(mission.id);
      db.prepare(
        "INSERT INTO comms (from_crew, to_crew, type, payload) VALUES ('admiral', 'admiral', 'mission_approved', ?)"
      ).run(
        JSON.stringify({
          missionId: mission.id,
          summary: mission.summary,
          pr_branch: mission.pr_branch
        })
      );
      this.deps.eventBus?.emit('starbase-changed', { type: 'starbase-changed' });
    }
  }

  private async pingSocket(socketPath: string, timeoutMs: number): Promise<boolean> {
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
            const rawParsed: unknown = JSON.parse(buffer.split('\n')[0]);
            const parsed =
              rawParsed != null && typeof rawParsed === 'object'
                ? (rawParsed as { ok?: boolean; data?: { pong?: boolean } })
                : {};
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

  private async prMonitorSweep(): Promise<void> {
    const { db, crewService, missionService } = this.deps;
    if (!crewService || !missionService) return;

    // Guard: gh must be available — we rely on try/catch in checkAndRepairMission if not
    const missions = db
      .prepare<[], ApprovedMissionRow>(
        `SELECT id, sector_id, summary, prompt, pr_branch, review_round
         FROM missions
         WHERE pr_branch IS NOT NULL
           AND status IN ('approved', 'ci-failed')
           AND type = 'code'`
      )
      .all();

    for (const mission of missions) {
      try {
        await this.checkAndRepairMission(mission, crewService, missionService);
      } catch (err) {
        console.error(`[sentinel] prMonitorSweep error for mission ${mission.id}:`, err);
        // Continue checking other missions
      }
    }
  }

  private async checkAndRepairMission(
    mission: ApprovedMissionRow,
    crewService: NonNullable<SentinelDeps['crewService']>,
    missionService: NonNullable<SentinelDeps['missionService']>
  ): Promise<void> {
    const db = this.db;

    // Escalate if max repair rounds exceeded
    if (mission.review_round >= MAX_REPAIR_ROUNDS) {
      db.prepare("UPDATE missions SET status = 'escalated' WHERE id = ?").run(mission.id);
      db.prepare(
        `INSERT INTO comms (from_crew, to_crew, type, mission_id, payload)
         VALUES ('first-officer', 'admiral', 'memo', ?, ?)`
      ).run(
        mission.id,
        JSON.stringify({
          missionId: mission.id,
          eventType: 'repair-escalation',
          summary: `Mission #${mission.id} has hit max repair rounds (${MAX_REPAIR_ROUNDS}) — manual intervention needed`
        })
      );
      return;
    }

    // Check CI status via gh CLI
    let ciOutput: string;
    try {
      const { stdout } = await execFileAsync('gh', [
        'pr', 'checks', mission.pr_branch,
        '--json', 'name,state,conclusion,required'
      ]);
      ciOutput = stdout;
    } catch {
      // PR may be closed, branch deleted, or gh not authenticated — skip silently
      return;
    }

    let ciParsed: unknown;
    try {
      ciParsed = JSON.parse(ciOutput);
    } catch {
      return;
    }
    if (!Array.isArray(ciParsed)) return;

    const hasFailure = ciParsed.some((c: unknown) => {
      if (c === null || typeof c !== 'object') return false;
      return 'required' in c && 'conclusion' in c &&
        (c as { required: unknown }).required === true &&
        (c as { conclusion: unknown }).conclusion === 'failure';
    });
    if (!hasFailure) return;

    // Fetch CI failure log
    let failureLog = '(could not fetch CI logs)';
    try {
      const { stdout: runList } = await execFileAsync('gh', [
        'run', 'list',
        '--branch', mission.pr_branch,
        '--json', 'databaseId',
        '--limit', '1'
      ]);
      const rawRuns: unknown = JSON.parse(runList);
      if (Array.isArray(rawRuns) && rawRuns.length > 0) {
        const first: unknown = rawRuns[0];
        const runId =
          first !== null && typeof first === 'object' && 'databaseId' in first
            ? first.databaseId
            : undefined;
          if (typeof runId === 'number') {
            const { stdout: log } = await execFileAsync('gh', [
              'run', 'view', String(runId), '--log-failed'
            ]);
            failureLog = log.slice(0, 4000);
          }
        }
    } catch {
      // Best-effort — proceed with placeholder log
    }

    // Atomically claim the mission — prevents race with Admiral manual deploy
    const claim = db
      .prepare(
        "UPDATE missions SET status = 'repairing', review_round = review_round + 1 WHERE id = ? AND status IN ('approved', 'ci-failed')"
      )
      .run(mission.id);
    if (claim.changes === 0) return; // Another process claimed it

    // Build repair prompt
    const repairPrompt = [
      mission.prompt,
      '',
      '---',
      '',
      '## Repair Context',
      '',
      `**Reason:** CI failure detected on PR branch \`${mission.pr_branch}\``,
      `**Repair round:** ${mission.review_round + 1}`,
      '',
      '## CI Failure Output',
      '',
      failureLog,
      '',
      'Push your fixes to the current branch — the PR already exists and will be updated automatically.',
      'Do NOT create a new PR.',
    ].join('\n');

    // Create repair mission
    let repairMission: { id: number; prompt: string } | undefined;
    try {
      repairMission = missionService.addMission({
        sectorId: mission.sector_id,
        type: 'repair',
        summary: `Fix CI failures: ${mission.summary}`,
        prompt: repairPrompt,
        prBranch: mission.pr_branch,
        originalMissionId: mission.id
      });
    } catch (err) {
      // Rollback
      db.prepare("UPDATE missions SET status = 'ci-failed' WHERE id = ? AND status = 'repairing'").run(mission.id);
      throw err;
    }

    // Deploy repair crew
    try {
      await crewService.deployCrew({
        sectorId: mission.sector_id,
        missionId: repairMission.id,
        prompt: repairMission.prompt,
        prBranch: mission.pr_branch,
        type: 'repair'
      });
    } catch (err) {
      // Rollback original mission and remove orphaned repair mission
      db.prepare("UPDATE missions SET status = 'ci-failed' WHERE id = ? AND status = 'repairing'").run(mission.id);
      db.prepare('DELETE FROM missions WHERE id = ?').run(repairMission.id);
      throw err;
    }
  }
}
