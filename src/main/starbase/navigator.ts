import { spawn, type ChildProcess } from 'child_process';
import { writeFileSync, mkdirSync, existsSync, unlinkSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import type Database from 'better-sqlite3';
import type { ConfigService } from './config-service';
import type { EventBus } from '../event-bus';
import { filterEnv } from '../env-utils';

type NavigatorDeps = {
  db: Database.Database;
  configService: ConfigService;
  eventBus?: EventBus;
  starbaseId: string;
  crewEnv?: Record<string, string>;
  fleetBinDir?: string;
};

export type NavigatorEvent = {
  executionId: string;
  protocolSlug: string;
  featureRequest: string;
  currentStep: number;
  context: string | null;
  eventType?: string; // 'resume' | 'crew-failed' | 'gate-approved' | 'gate-rejected'
  gateResponse?: string;
};

type RunningProcess = {
  proc: ChildProcess;
  executionId: string;
  startedAt: number;
};

export class Navigator {
  private running = new Map<string, RunningProcess>();

  constructor(private deps: NavigatorDeps) {}

  get activeCount(): number {
    return this.running.size;
  }

  isRunning(executionId: string): boolean {
    return this.running.has(executionId);
  }

  async dispatch(
    event: NavigatorEvent,
    callbacks?: { onExit?: (code: number | null) => void }
  ): Promise<boolean> {
    const { configService } = this.deps;
    const maxConcurrent = configService.getNumber('navigator_max_concurrent');
    const timeout = configService.getNumber('navigator_timeout');
    const model = configService.getString('navigator_model');

    if (this.running.has(event.executionId)) return false;
    if (this.running.size >= maxConcurrent) return false;

    const workspace = this.getWorkspacePath();
    mkdirSync(workspace, { recursive: true });

    const claudeMdPath = join(workspace, 'CLAUDE.md');
    if (!existsSync(claudeMdPath)) {
      const { generateNavigatorClaudeMd } = await import('./workspace-templates');
      writeFileSync(
        claudeMdPath,
        generateNavigatorClaudeMd({ fleetBinDir: this.deps.fleetBinDir }),
        'utf-8'
      );
    }

    const promptDir = join(tmpdir(), 'fleet-navigator');
    mkdirSync(promptDir, { recursive: true });
    const spFile = join(promptDir, `${event.executionId}-sp.md`);
    const msgFile = join(promptDir, `${event.executionId}-msg.md`);

    writeFileSync(spFile, this.buildSystemPrompt(event), 'utf-8');
    writeFileSync(msgFile, this.buildInitialMessage(event), 'utf-8');

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
      FLEET_NAVIGATOR: '1',
      FLEET_EXECUTION_ID: event.executionId,
      FLEET_STARBASE_ID: this.deps.starbaseId,
      ...(this.deps.fleetBinDir ? { FLEET_BIN_DIR: this.deps.fleetBinDir } : {})
    };

    try {
      const proc = spawn('claude', cmdArgs, {
        cwd: workspace,
        env: mergedEnv,
        stdio: ['pipe', 'pipe', 'pipe']
      });

      this.running.set(event.executionId, {
        proc,
        executionId: event.executionId,
        startedAt: Date.now()
      });

      const initMsg =
        JSON.stringify({
          type: 'user',
          message: {
            role: 'user',
            content: `Read and execute the Navigator instructions in ${msgFile}. Delete the file when done.`
          },
          parent_tool_use_id: null,
          session_id: ''
        }) + '\n';
      proc.stdin.write(initMsg);

      let stdoutBuffer = '';
      proc.stdout.on('data', (chunk: Buffer) => {
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

      proc.stderr.on('data', (chunk: Buffer) => {
        console.error(`[navigator:${event.executionId}] stderr:`, chunk.toString().trim());
      });

      const timer = setTimeout(() => {
        if (!proc.killed) {
          console.warn(`[navigator] Timeout for ${event.executionId}, killing`);
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

      proc.on('exit', (code) => {
        clearTimeout(timer);
        this.running.delete(event.executionId);
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
          this.writeFailedComm(event, `Navigator process crashed (exit code: ${code})`);
        }

        callbacks?.onExit?.(code);
        this.deps.eventBus?.emit('starbase-changed', { type: 'starbase-changed' });
      });

      proc.on('error', (err) => {
        clearTimeout(timer);
        this.running.delete(event.executionId);
        this.writeFailedComm(event, `Navigator spawn failed: ${err.message}`);
        this.deps.eventBus?.emit('starbase-changed', { type: 'starbase-changed' });
      });

      this.deps.eventBus?.emit('starbase-changed', { type: 'starbase-changed' });
      return true;
    } catch (err) {
      this.writeFailedComm(
        event,
        `Navigator spawn failed: ${err instanceof Error ? err.message : 'unknown'}`
      );
      return false;
    }
  }

  private writeFailedComm(event: NavigatorEvent, reason: string): void {
    try {
      this.deps.db
        .prepare(
          `INSERT INTO comms (from_crew, to_crew, type, execution_id, payload)
         VALUES ('navigator', 'admiral', 'protocol-failed', ?, ?)`
        )
        .run(
          event.executionId,
          JSON.stringify({
            executionId: event.executionId,
            reason,
            protocolSlug: event.protocolSlug
          })
        );
      this.deps.db
        .prepare(
          `UPDATE protocol_executions SET status = 'failed', updated_at = datetime('now') WHERE id = ?`
        )
        .run(event.executionId);
    } catch {
      /* ignore if DB not available */
    }
    this.deps.eventBus?.emit('starbase-changed', { type: 'starbase-changed' });
  }

  private getWorkspacePath(): string {
    return join(
      process.env.HOME ?? '~',
      '.fleet',
      'starbases',
      `starbase-${this.deps.starbaseId}`,
      'navigator'
    );
  }

  private buildSystemPrompt(event: NavigatorEvent): string {
    const fleetBin = this.deps.fleetBinDir ? `${this.deps.fleetBinDir}/fleet` : 'fleet';
    return `You are the Navigator aboard Star Command. You execute Protocols autonomously using the fleet CLI.

Execution ID: ${event.executionId}
Protocol: ${event.protocolSlug}
Current step: ${event.currentStep}
Event type: ${event.eventType ?? 'resume'}
${event.gateResponse ? `Gate response: ${event.gateResponse}` : ''}

Start by running: ${fleetBin} protocols show ${event.protocolSlug}
Then: ${fleetBin} protocols executions show ${event.executionId}

Always tag crew deploys with --execution ${event.executionId}.
Poll comms with: ${fleetBin} comms inbox --execution ${event.executionId} --unread
`;
  }

  private buildInitialMessage(event: NavigatorEvent): string {
    return `# Navigator Assignment

**Protocol:** ${event.protocolSlug}
**Execution:** ${event.executionId}
**Step:** ${event.currentStep}
**Feature request:** ${event.featureRequest}
${event.context ? `\n## Prior context\n${event.context}` : ''}
${event.gateResponse ? `\n## Gate response from Admiral\n${event.gateResponse}` : ''}

Read the protocol steps, check the execution state, and proceed from step ${event.currentStep}.
`;
  }

  reconcile(): void {
    this.running.clear();
  }

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
}
