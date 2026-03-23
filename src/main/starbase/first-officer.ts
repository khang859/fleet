import { spawn, type ChildProcess } from 'child_process';
import { access } from 'fs/promises';
import { mkdir, unlink, writeFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import type Database from 'better-sqlite3';
import type { CargoService } from './cargo-service';
import type { ConfigService } from './config-service';
import type { CrewService } from './crew-service';
import type { MissionService } from './mission-service';
import type { EventBus } from '../event-bus';
import type { Analyst } from './analyst';
import { filterEnv } from '../env-utils';

function isRecord(v: unknown): v is Record<string, unknown> {
  return v != null && typeof v === 'object' && !Array.isArray(v);
}

type FirstOfficerDeps = {
  db: Database.Database;
  configService: ConfigService;
  missionService: MissionService;
  crewService: CrewService;
  cargoService: CargoService;
  eventBus?: EventBus;
  analyst?: Analyst;
  starbaseId: string;
  crewEnv?: Record<string, string>;
  fleetBinDir?: string;
};

export type ActionableEvent = {
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
  attemptHistory?: string;
  fingerprint?: string | null;
  classification?: string | null;
  deploymentBudgetExhausted?: boolean;
};

export type FirstOfficerDecision = {
  decision: 'retry' | 'recover-and-dismiss' | 'escalate-and-dismiss';
  reason: string;
  revisedPrompt?: string;
  deleteCrew?: boolean;
  salvage?: {
    shouldCreateCargo: boolean;
    title?: string;
    contentMarkdown?: string;
    sourceKinds?: string[];
    summary?: string;
  };
};

type RunningProcess = {
  proc: ChildProcess;
  crewId: string;
  missionId: number;
  startedAt: number;
};

type DispatchCallbacks = {
  onExit?: (code: number | null) => void;
};

export class FirstOfficer {
  private running = new Map<string, RunningProcess>();

  constructor(private deps: FirstOfficerDeps) {}

  private key(crewId: string, missionId: number): string {
    return `${crewId}:${missionId}`;
  }

  get activeCount(): number {
    return this.running.size;
  }

  isRunning(crewId: string, missionId: number): boolean {
    return this.running.has(this.key(crewId, missionId));
  }

  getStatusText(): string {
    if (this.running.size === 0) return 'Idle';
    const entries = [...this.running.values()];
    if (entries.length === 1) return `Triaging ${entries[0].crewId}`;
    return `Triaging ${entries.length} issues`;
  }

  getStatus(): 'idle' | 'working' | 'memo' {
    if (this.running.size > 0) return 'working';
    const row = this.deps.db
      .prepare<
        [],
        { cnt: number }
      >("SELECT COUNT(*) as cnt FROM comms WHERE type IN ('memo', 'hailing-memo') AND to_crew = 'admiral' AND read = 0")
      .get();
    return row && row.cnt > 0 ? 'memo' : 'idle';
  }

  async dispatch(event: ActionableEvent, callbacks?: DispatchCallbacks): Promise<boolean> {
    const { configService } = this.deps;
    const maxConcurrent = configService.getNumber('first_officer_max_concurrent');
    const maxRetries = configService.getNumber('first_officer_max_retries');
    const timeout = configService.getNumber('first_officer_timeout');
    const model = configService.getString('first_officer_model');

    const k = this.key(event.crewId, event.missionId);
    if (this.running.has(k)) return false;
    if (this.running.size >= maxConcurrent) return false;

    if (event.retryCount >= maxRetries) {
      await this.resolveEscalation(
        event,
        'Maximum retries exhausted',
        'Maximum retries exhausted before First Officer analysis.'
      );
      callbacks?.onExit?.(0);
      return true;
    }

    const workspace = this.getWorkspacePath();
    const memosDir = join(workspace, 'memos');
    await mkdir(memosDir, { recursive: true });

    const claudeMdPath = join(workspace, 'CLAUDE.md');
    try {
      await access(claudeMdPath);
    } catch {
      await writeFile(claudeMdPath, this.generateClaudeMd(), 'utf-8');
    }

    const promptDir = join(tmpdir(), 'fleet-first-officer');
    await mkdir(promptDir, { recursive: true });
    const spFile = join(promptDir, `${event.crewId}-sp.md`);
    const msgFile = join(promptDir, `${event.crewId}-msg.md`);
    await writeFile(spFile, this.buildSystemPrompt(event, maxRetries), 'utf-8');
    await writeFile(msgFile, this.buildInitialMessage(event), 'utf-8');

    const cmdArgs = [
      '--output-format',
      'stream-json',
      '--verbose',
      '--input-format',
      'stream-json',
      '--dangerously-skip-permissions',
      '--model',
      model,
      '--append-system-prompt-file',
      spFile
    ];

    const mergedEnv: Record<string, string> = {
      ...(this.deps.crewEnv ?? filterEnv()),
      FLEET_FIRST_OFFICER: '1',
      FLEET_CREW_ID: event.crewId,
      FLEET_MISSION_ID: String(event.missionId),
      ...(this.deps.fleetBinDir ? { FLEET_BIN_DIR: this.deps.fleetBinDir } : {})
    };

    try {
      const proc = spawn('claude', cmdArgs, {
        cwd: workspace,
        env: mergedEnv,
        stdio: ['pipe', 'pipe', 'pipe']
      });

      this.running.set(k, {
        proc,
        crewId: event.crewId,
        missionId: event.missionId,
        startedAt: Date.now()
      });

      let stdoutBuffer = '';
      let assistantOutput = '';
      let resultText = '';

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
      proc.stdin.write(initMsg);

      proc.stdout.on('data', (chunk: Buffer) => {
        stdoutBuffer += chunk.toString();
        const lines = stdoutBuffer.split('\n');
        stdoutBuffer = lines.pop() ?? '';
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            type ParsedMsg = {
              type?: string;
              result?: string;
              message?: { content?: Array<{ type?: string; text?: string }> };
            };
            const rawMsg: unknown = JSON.parse(line);
            if (!rawMsg || typeof rawMsg !== 'object') continue;
            const msg = rawMsg as ParsedMsg;

            if (msg.type === 'assistant' && msg.message?.content) {
              const text = msg.message.content
                .filter((part) => part.type === 'text' && part.text)
                .map((part) => part.text)
                .join('\n');
              if (text) assistantOutput += `${text}\n`;
            }

            if (msg.type === 'result') {
              if (typeof msg.result === 'string') resultText = msg.result;
              try {
                proc.stdin.end();
              } catch {
                /* ignore */
              }
            }
          } catch {
            // ignore startup noise and malformed lines
          }
        }
      });

      proc.stderr.on('data', (chunk: Buffer) => {
        console.error(`[first-officer:${event.crewId}] stderr:`, chunk.toString().trim());
      });

      const timer = setTimeout(() => {
        if (!proc.killed) {
          console.warn(`[first-officer] Timeout for ${k}, killing`);
          try {
            proc.kill('SIGTERM');
          } catch {
            /* ignore */
          }
          setTimeout(() => {
            if (!proc.killed) {
              try {
                proc.kill('SIGKILL');
              } catch {
                /* ignore */
              }
            }
          }, 5000);
        }
      }, timeout * 1000);

      proc.on('exit', (code) => {
        clearTimeout(timer);
        void this.handleProcessExit({
          key: k,
          code,
          event,
          spFile,
          msgFile,
          callbacks,
          decisionText: resultText || assistantOutput
        });
      });

      proc.on('error', (err) => {
        clearTimeout(timer);
        void this.handleSpawnError(k, event, spFile, msgFile, err, callbacks);
      });

      this.deps.eventBus?.emit('starbase-changed', { type: 'starbase-changed' });
      return true;
    } catch (err) {
      await this.resolveEscalation(
        event,
        `First Officer spawn failed: ${err instanceof Error ? err.message : 'unknown'}`,
        'First Officer could not start, so this failure was escalated automatically.'
      );
      return false;
    }
  }

  async writeHailingMemo(opts: {
    crewId: string;
    missionId: number | null;
    sectorName: string;
    payload: string;
    createdAt: string;
  }): Promise<void> {
    let payloadText = '';
    try {
      const rawParsed: unknown = JSON.parse(opts.payload);
      const parsed: Record<string, unknown> = isRecord(rawParsed) ? rawParsed : {};
      const msg = typeof parsed['message'] === 'string' ? parsed['message'] : undefined;
      const question = typeof parsed.question === 'string' ? parsed.question : undefined;
      payloadText = msg ?? question ?? JSON.stringify(rawParsed, null, 2);
    } catch {
      payloadText = opts.payload;
    }

    let hailingContext: string | null = null;
    if (this.deps.analyst) {
      hailingContext = await this.deps.analyst.writeHailingContext(payloadText);
    }

    const actionRequired = hailingContext
      ? hailingContext
      : 'This crew has been waiting for a response for over 60 seconds. Please review and respond via the Admiral.';

    const filePath = await this.writeMemoFile(
      `${opts.crewId}-hailing`,
      `## Unanswered Hailing: ${opts.crewId}

**Crew:** ${opts.crewId} · **Sector:** ${opts.sectorName} · **Waiting since:** ${opts.createdAt}

### Message
${payloadText}

### Action Required
${actionRequired}
`
    );

    this.deps.db
      .prepare(
        `INSERT INTO comms (from_crew, to_crew, type, mission_id, payload)
       VALUES ('first-officer', 'admiral', 'hailing-memo', ?, ?)`
      )
      .run(
        opts.missionId,
        JSON.stringify({
          crewId: opts.crewId,
          missionId: opts.missionId,
          summary: `Unanswered hailing from ${opts.crewId} in ${opts.sectorName}`,
          filePath
        })
      );
    this.deps.eventBus?.emit('starbase-changed', { type: 'starbase-changed' });
  }

  async writeAutoEscalationComm(opts: {
    crewId: string;
    missionId: number;
    classification: string;
    fingerprint: string;
    summary: string;
    errorText: string;
  }): Promise<void> {
    const filePath = await this.writeMemoFile(
      `auto-${opts.summary}`,
      `## Auto-Escalated: ${opts.summary}

**Classification:** ${opts.classification}
**Fingerprint:** ${opts.fingerprint}
**Crew:** ${opts.crewId}

### Error Output (tail)
\`\`\`
${opts.errorText}
\`\`\`

### Why Auto-Escalated
${opts.classification === 'persistent' ? 'Same error fingerprint as previous attempt; retrying is unlikely to help.' : 'Error matches a non-retryable pattern and requires manual intervention.'}
`
    );

    this.deps.db
      .prepare(
        `INSERT INTO comms (from_crew, to_crew, type, mission_id, payload)
       VALUES ('first-officer', 'admiral', 'memo', ?, ?)`
      )
      .run(
        opts.missionId,
        JSON.stringify({
          missionId: opts.missionId,
          crewId: opts.crewId,
          eventType: 'auto-escalation',
          summary: `Auto-escalated (${opts.classification}): ${opts.summary}`,
          filePath,
          fingerprint: opts.fingerprint,
          classification: opts.classification
        })
      );
    this.deps.eventBus?.emit('starbase-changed', { type: 'starbase-changed' });
  }

  shutdown(): void {
    for (const [k, entry] of this.running) {
      try {
        entry.proc.kill('SIGKILL');
      } catch {
        /* ignore */
      }
      this.running.delete(k);
    }
  }

  reconcile(): void {
    this.running.clear();
  }

  private async handleSpawnError(
    key: string,
    event: ActionableEvent,
    spFile: string,
    msgFile: string,
    err: Error,
    callbacks?: DispatchCallbacks
  ): Promise<void> {
    this.running.delete(key);
    await this.safeCleanupTempFiles(spFile, msgFile);
    await this.resolveEscalation(
      event,
      `First Officer spawn failed: ${err.message}`,
      'First Officer could not start, so this failure was escalated automatically.'
    );
    callbacks?.onExit?.(1);
  }

  private async handleProcessExit(opts: {
    key: string;
    code: number | null;
    event: ActionableEvent;
    spFile: string;
    msgFile: string;
    callbacks?: DispatchCallbacks;
    decisionText: string;
  }): Promise<void> {
    this.running.delete(opts.key);
    await this.safeCleanupTempFiles(opts.spFile, opts.msgFile);

    try {
      if (opts.code !== 0) {
        await this.resolveEscalation(
          opts.event,
          `First Officer process crashed (exit code: ${opts.code})`,
          'First Officer failed during triage, so the mission was escalated automatically.'
        );
      } else {
        const decision = this.parseDecision(opts.decisionText, opts.event);
        await this.applyDecision(opts.event, decision);
      }
    } finally {
      opts.callbacks?.onExit?.(opts.code);
      this.deps.eventBus?.emit('starbase-changed', { type: 'starbase-changed' });
    }
  }

  private parseDecision(raw: string, event: ActionableEvent): FirstOfficerDecision {
    const extracted = this.extractJsonObject(raw);
    if (!extracted) {
      return {
        decision: 'escalate-and-dismiss',
        reason: 'First Officer returned an invalid decision format.'
      };
    }

    try {
      const rawExtracted: unknown = JSON.parse(extracted);
      const parsed: Record<string, unknown> = isRecord(rawExtracted) ? rawExtracted : {};
      const decision = this.normalizeDecision(parsed.decision);
      const revisedPrompt =
        typeof parsed.revisedPrompt === 'string'
          ? parsed.revisedPrompt.trim()
          : typeof parsed.missionUpdate === 'string'
            ? parsed.missionUpdate.trim()
            : undefined;
      const salvageMaybe = parsed.salvage;
      function isSalvageRecord(v: unknown): v is Record<string, unknown> {
        return v != null && typeof v === 'object' && !Array.isArray(v);
      }
      const salvageRaw: Record<string, unknown> = isSalvageRecord(salvageMaybe) ? salvageMaybe : {};

      if (!decision) {
        return {
          decision: 'escalate-and-dismiss',
          reason: 'First Officer returned an unknown decision.'
        };
      }

      if (decision === 'retry' && event.deploymentBudgetExhausted) {
        return {
          decision: 'escalate-and-dismiss',
          reason: 'Retry was requested after the deployment budget was exhausted.'
        };
      }

      return {
        decision,
        reason:
          typeof parsed.reason === 'string' && parsed.reason.trim().length > 0
            ? parsed.reason.trim()
            : 'No reason provided.',
        revisedPrompt,
        salvage: {
          shouldCreateCargo: Boolean(salvageRaw.shouldCreateCargo),
          title: typeof salvageRaw.title === 'string' ? salvageRaw.title.trim() : undefined,
          contentMarkdown:
            typeof salvageRaw.contentMarkdown === 'string'
              ? salvageRaw.contentMarkdown.trim()
              : undefined,
          sourceKinds: Array.isArray(salvageRaw.sourceKinds)
            ? salvageRaw.sourceKinds.filter(
                (item): item is string => typeof item === 'string' && item.trim().length > 0
              )
            : undefined,
          summary: typeof salvageRaw.summary === 'string' ? salvageRaw.summary.trim() : undefined
        }
      };
    } catch {
      return {
        decision: 'escalate-and-dismiss',
        reason: 'First Officer returned malformed JSON.'
      };
    }
  }

  private normalizeDecision(value: unknown): FirstOfficerDecision['decision'] | null {
    if (typeof value !== 'string') return null;
    const normalized = value.trim().toLowerCase();
    if (normalized === 'retry') return 'retry';
    if (normalized === 'recover-and-dismiss' || normalized === 'recover_and_dismiss')
      return 'recover-and-dismiss';
    if (normalized === 'escalate-and-dismiss' || normalized === 'escalate_and_dismiss')
      return 'escalate-and-dismiss';
    return null;
  }

  private extractJsonObject(raw: string): string | null {
    const trimmed = raw.trim();
    if (!trimmed) return null;

    const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
    const candidate = fenced?.[1]?.trim() ?? trimmed;
    const start = candidate.indexOf('{');
    const end = candidate.lastIndexOf('}');
    if (start === -1 || end <= start) return null;
    return candidate.slice(start, end + 1);
  }

  private async applyDecision(
    event: ActionableEvent,
    decision: FirstOfficerDecision
  ): Promise<void> {
    if (decision.decision === 'retry') {
      await this.resolveRetry(event, decision);
      return;
    }

    if (decision.decision === 'recover-and-dismiss') {
      await this.resolveRecovery(event, decision);
      return;
    }

    await this.resolveEscalation(
      event,
      decision.reason,
      'First Officer determined the mission is not safely recoverable.',
      decision
    );
  }

  private async resolveRetry(
    event: ActionableEvent,
    decision: FirstOfficerDecision
  ): Promise<void> {
    const revisedPrompt = decision.revisedPrompt?.trim() || event.missionPrompt;
    const summary = `Retrying mission #${event.missionId} after First Officer triage`;
    const memo = `## First Officer Retry: ${event.missionSummary}

**Crew:** ${event.crewId}
**Mission:** ${event.missionId}
**Decision:** retry

### Why
${decision.reason}

### Revised Prompt
${revisedPrompt}
`;

    await this.writeDecisionMemo(event, summary, memo, 'retry');

    this.deps.crewService.recallCrew(event.crewId);
    this.deps.missionService.updateMission(event.missionId, { prompt: revisedPrompt });
    this.deps.missionService.resetForRequeue(event.missionId);

    let deployResult: string;
    try {
      await this.deps.crewService.deployCrew({
        sectorId: event.sectorId,
        prompt: revisedPrompt,
        missionId: event.missionId
      });
      deployResult = 'Crew re-deployed successfully.';
    } catch (err) {
      deployResult = `Redeploy attempt failed: ${err instanceof Error ? err.message : 'unknown error'}. Mission remains queued or escalated by caller state.`;
    }

    this.deps.db
      .prepare(
        "INSERT INTO ships_log (crew_id, event_type, detail) VALUES (?, 'first_officer_retried', ?)"
      )
      .run(
        event.crewId,
        JSON.stringify({
          missionId: event.missionId,
          reason: decision.reason,
          revisedPrompt,
          deployResult
        })
      );
  }

  private async resolveRecovery(
    event: ActionableEvent,
    decision: FirstOfficerDecision
  ): Promise<void> {
    this.deps.crewService.recallCrew(event.crewId);
    if (decision.deleteCrew) {
      this.deps.crewService.deleteCrew(event.crewId);
    }
    this.deps.missionService.escalateMission(event.missionId, decision.reason);

    let cargoCreated = false;
    if (decision.salvage?.shouldCreateCargo) {
      const content =
        decision.salvage.contentMarkdown?.trim() || this.buildFallbackSalvageContent(event);
      const summary = decision.salvage.summary?.trim() || decision.reason;
      await this.deps.cargoService.produceRecoveredCargo({
        crewId: event.crewId,
        missionId: event.missionId,
        sectorId: event.sectorId,
        title: decision.salvage.title?.trim() || `Recovered cargo from ${event.crewId}`,
        contentMarkdown: content,
        summary,
        sourceKinds: decision.salvage.sourceKinds?.length
          ? decision.salvage.sourceKinds
          : ['crew-output', 'verification-output'],
        fingerprint: event.fingerprint ?? null,
        classification: event.classification ?? null,
        starbaseId: this.deps.starbaseId
      });
      cargoCreated = true;
    }

    const summary = cargoCreated
      ? `Recovered partial cargo from ${event.crewId} and dismissed the crew`
      : `Dismissed ${event.crewId} after unrecoverable failure`;

    const memo = `## First Officer Recovery: ${event.missionSummary}

**Crew:** ${event.crewId}
**Mission:** ${event.missionId}
**Decision:** recover-and-dismiss
**Recovered Cargo:** ${cargoCreated ? 'yes' : 'no'}

### Why
${decision.reason}

### Recovery Notes
${decision.salvage?.summary ?? 'Partial mission output was preserved for later operator review.'}
`;

    await this.writeDecisionMemo(event, summary, memo, 'recover-and-dismiss');

    this.deps.db
      .prepare(
        "INSERT INTO ships_log (crew_id, event_type, detail) VALUES (?, 'first_officer_recovered', ?)"
      )
      .run(
        event.crewId,
        JSON.stringify({
          missionId: event.missionId,
          reason: decision.reason,
          cargoCreated,
          fingerprint: event.fingerprint ?? null,
          classification: event.classification ?? null
        })
      );
  }

  private async resolveEscalation(
    event: ActionableEvent,
    summaryReason: string,
    recommendation: string,
    decision?: FirstOfficerDecision
  ): Promise<void> {
    this.deps.crewService.recallCrew(event.crewId);
    if (decision?.deleteCrew) {
      this.deps.crewService.deleteCrew(event.crewId);
    }
    this.deps.missionService.escalateMission(event.missionId, summaryReason);

    let cargoCreated = false;
    if (decision?.salvage?.shouldCreateCargo) {
      await this.deps.cargoService.produceRecoveredCargo({
        crewId: event.crewId,
        missionId: event.missionId,
        sectorId: event.sectorId,
        title: decision.salvage.title?.trim() || `Recovered cargo from ${event.crewId}`,
        contentMarkdown:
          decision.salvage.contentMarkdown?.trim() || this.buildFallbackSalvageContent(event),
        summary: decision.salvage.summary?.trim() || summaryReason,
        sourceKinds: decision.salvage.sourceKinds?.length
          ? decision.salvage.sourceKinds
          : ['crew-output', 'verification-output'],
        fingerprint: event.fingerprint ?? null,
        classification: event.classification ?? null,
        starbaseId: this.deps.starbaseId
      });
      cargoCreated = true;
    }

    const content = `## First Officer Escalation: ${event.missionSummary}

**Crew:** ${event.crewId} · **Sector:** ${event.sectorName} · **Attempts:** ${event.retryCount}/${String(this.deps.configService.get('first_officer_max_retries'))}
**Decision:** escalate-and-dismiss
**Recovered Cargo:** ${cargoCreated ? 'yes' : 'no'}

### What happened
${summaryReason}

### Failure type
${event.eventType}

### Recommendation
${recommendation}

### Last crew output (tail)
\`\`\`
${event.crewOutput.split('\n').slice(-30).join('\n')}
\`\`\`
`;

    await this.writeDecisionMemo(
      event,
      cargoCreated ? `Escalated ${event.crewId} with recovered cargo` : summaryReason,
      content,
      'escalate-and-dismiss',
      event.fingerprint ?? null,
      event.classification ?? 'escalation'
    );

    this.deps.db
      .prepare(
        "INSERT INTO ships_log (crew_id, event_type, detail) VALUES (?, 'first_officer_dismissed', ?)"
      )
      .run(
        event.crewId,
        JSON.stringify({
          missionId: event.missionId,
          reason: summaryReason,
          cargoCreated,
          fingerprint: event.fingerprint ?? null,
          classification: event.classification ?? null
        })
      );
  }

  private async writeDecisionMemo(
    event: ActionableEvent,
    summary: string,
    content: string,
    eventType: string,
    fingerprint?: string | null,
    classification?: string | null
  ): Promise<void> {
    const filePath = await this.writeMemoFile(`${event.crewId}-${event.missionSummary}`, content);

    this.deps.db
      .prepare(
        `INSERT INTO comms (from_crew, to_crew, type, mission_id, payload)
       VALUES ('first-officer', 'admiral', 'memo', ?, ?)`
      )
      .run(
        event.missionId,
        JSON.stringify({
          missionId: event.missionId,
          crewId: event.crewId,
          eventType,
          summary,
          filePath,
          retryCount: event.retryCount,
          fingerprint: fingerprint ?? null,
          classification: classification ?? null
        })
      );
    this.deps.eventBus?.emit('starbase-changed', { type: 'starbase-changed' });
  }

  private async writeMemoFile(slugSource: string, content: string): Promise<string> {
    const memosDir = join(this.getWorkspacePath(), 'memos');
    await mkdir(memosDir, { recursive: true });

    const slug =
      slugSource
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .slice(0, 40) || 'memo';

    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 16);
    const filePath = join(memosDir, `${ts}-${slug}.md`);
    await writeFile(filePath, content, 'utf-8');
    return filePath;
  }

  private async safeCleanupTempFiles(...paths: string[]): Promise<void> {
    await Promise.all(
      paths.map(async (path) => {
        try {
          await unlink(path);
        } catch {
          // ignore cleanup errors
        }
      })
    );
  }

  private buildFallbackSalvageContent(event: ActionableEvent): string {
    const parts = [
      `# Recovered Cargo: ${event.missionSummary}`,
      '',
      `- Crew: ${event.crewId}`,
      `- Mission: ${event.missionId}`,
      `- Sector: ${event.sectorName} (${event.sectorId})`,
      '',
      '## Crew Output',
      '```',
      event.crewOutput.trim() || 'No crew output captured.',
      '```'
    ];

    if (event.verifyResult) {
      parts.push('', '## Verification Result', '```json', event.verifyResult, '```');
    }

    return parts.join('\n');
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

You are the First Officer aboard Star Command. You are not the Admiral.
Your only job is to analyze failed crew runs and return a structured decision.

Do not modify code, deploy crews, recall crews, or write files yourself.
The Fleet app applies your decision after you return it.

Always end with a single JSON object and no prose after it.
`;
  }

  private buildSystemPrompt(event: ActionableEvent, maxRetries: number): string {
    return `You are the First Officer aboard Star Command.

You are analyzing one failed crew run and must choose exactly one decision:
- "retry"
- "recover-and-dismiss"
- "escalate-and-dismiss"

You must return a single JSON object with this shape:
\`\`\`json
{
  "decision": "retry | recover-and-dismiss | escalate-and-dismiss",
  "reason": "short explanation",
  "revisedPrompt": "required only for retry",
  "deleteCrew": true,
  "salvage": {
    "shouldCreateCargo": true,
    "title": "Recovered cargo title",
    "summary": "short cargo summary",
    "contentMarkdown": "# recovered notes",
    "sourceKinds": ["crew-output", "verification-output"]
  }
}
\`\`\`

Rules:
- If retrying is not likely to help, choose recover-and-dismiss or escalate-and-dismiss.
- If there is meaningful partial output worth preserving, set salvage.shouldCreateCargo=true.
- Use recover-and-dismiss when partial output is useful but the mission should not be retried automatically.
- Use escalate-and-dismiss when the mission is not recoverable and there is little or no useful partial output.
- Never choose retry when retries are exhausted or deployment budget is exhausted.
- Never include any text before or after the JSON object.
- Set deleteCrew: true when the crew record should be permanently removed after recall (e.g. the failure was a transient environment issue and the crew entry has no long-term value). Omit or set to false to retain the crew record. Never set deleteCrew on retry decisions.

Mission context:
- Mission ID: ${event.missionId}
- Crew ID: ${event.crewId}
- Sector ID: ${event.sectorId}
- Retry attempt: ${event.retryCount + 1}/${maxRetries}
- Failure type: ${event.eventType}
- Acceptance criteria: ${event.acceptanceCriteria ?? 'none specified'}
- Verify command: ${event.verifyCommand ?? 'none configured'}
- Error classification hint: ${event.classification ?? 'unknown'}
- Error fingerprint hint: ${event.fingerprint ?? 'none'}
- Deployment budget exhausted: ${event.deploymentBudgetExhausted ? 'yes' : 'no'}
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

## Crew Output
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

    if (event.attemptHistory) {
      msg += `\n## Previous Attempts\n| # | Action | Fingerprint | Classification |\n|---|--------|-------------|----------------|\n${event.attemptHistory}\n`;
    }

    msg += '\nReturn only the JSON decision object.\n';
    return msg;
  }
}
