// src/main/starbase/analyst.ts
import type Database from 'better-sqlite3';
import { spawn } from 'child_process';
import { filterEnv as defaultFilterEnv } from '../env-utils';

const DEFAULT_MODEL = 'claude-haiku-4-5-20251001';
const TIMEOUT_MS = 30_000; // 30 seconds — allows for Claude CLI cold-start + network latency
const DEGRADED_COOLDOWN_MS = 5 * 60 * 1000;

export class AnalystError extends Error {
  constructor(
    message: string,
    public readonly method: string
  ) {
    super(message);
    this.name = 'AnalystError';
  }
}

export interface AnalystDeps {
  db: Database.Database;
  filterEnv?: () => Record<string, string>;
  model?: string;
  timeoutMs?: number;
}

export class Analyst {
  private readonly db: Database.Database;
  private readonly getEnv: () => Record<string, string>;
  private readonly model: string;
  private readonly timeoutMs: number;
  private readonly lastDegradedAt = new Map<string, number>();

  constructor(deps: AnalystDeps) {
    this.db = deps.db;
    this.getEnv = deps.filterEnv ?? defaultFilterEnv;
    this.model = deps.model ?? DEFAULT_MODEL;
    this.timeoutMs = deps.timeoutMs ?? TIMEOUT_MS;
  }

  /** Extract the first JSON object from free-form LLM text output. */
  private extractJson(text: string): unknown {
    const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
    const candidate = fenced?.[1]?.trim() ?? text.trim();
    const start = candidate.indexOf('{');
    if (start === -1) throw new Error('No JSON object found in output');
    // Find matching closing brace
    let depth = 0;
    let end = -1;
    for (let i = start; i < candidate.length; i++) {
      if (candidate[i] === '{') depth++;
      else if (candidate[i] === '}') {
        depth--;
        if (depth === 0) {
          end = i;
          break;
        }
      }
    }
    if (end === -1) throw new Error('No JSON object found in output');
    return JSON.parse(candidate.slice(start, end + 1));
  }

  /**
   * Single attempt: spawn `claude --print --model <model>`, write prompt to stdin,
   * collect stdout, parse the first JSON object from the response.
   * Kills the process and rejects with 'Analyst subprocess timed out' after timeoutMs.
   */
  private async runAttempt(prompt: string): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const proc = spawn('claude', ['--print', '--model', this.model], {
        env: this.getEnv(),
        stdio: ['pipe', 'pipe', 'pipe']
      });

      let stdout = '';
      let timedOut = false;

      const timer = setTimeout(() => {
        timedOut = true;
        proc.kill('SIGKILL');
        reject(new Error('Analyst subprocess timed out'));
      }, this.timeoutMs);

      proc.stdout.on('data', (chunk: Buffer) => {
        stdout += chunk.toString();
      });

      proc.stderr.on('data', () => {
        /* drain */
      });

      proc.stdin.write(prompt);
      proc.stdin.end();

      proc.on('close', (code) => {
        clearTimeout(timer);
        if (timedOut) return;
        if (code !== 0) {
          reject(new Error(`Analyst subprocess exited with code ${String(code)}`));
          return;
        }
        try {
          resolve(this.extractJson(stdout));
        } catch (err) {
          reject(err instanceof Error ? err : new Error(String(err)));
        }
      });

      proc.on('error', (err) => {
        if (timedOut) return;
        clearTimeout(timer);
        reject(err);
      });
    });
  }

  /**
   * Run the analyst subprocess, retrying once on timeout to guard against
   * transient cold-start spikes. A second timeout propagates to the caller.
   */
  private async run(prompt: string): Promise<unknown> {
    try {
      return await this.runAttempt(prompt);
    } catch (err: unknown) {
      if (err instanceof Error && err.message === 'Analyst subprocess timed out') {
        return this.runAttempt(prompt);
      }
      throw err;
    }
  }

  /** Write a rate-limited analyst_degraded comms to the Admiral. */
  private writeDegradedComm(method: string, reason: string): void {
    const now = Date.now();
    const last = this.lastDegradedAt.get(method) ?? 0;
    if (now - last < DEGRADED_COOLDOWN_MS) return;
    this.lastDegradedAt.set(method, now);
    try {
      this.db
        .prepare(
          `INSERT INTO comms (from_crew, to_crew, type, payload)
           VALUES ('analyst', 'admiral', 'analyst_degraded', ?)`
        )
        .run(JSON.stringify({ method, reason: reason.slice(0, 500) }));
    } catch {
      // Best-effort — don't throw if DB write fails
    }
  }

  /**
   * Classify an error as transient, persistent, or non-retryable.
   * Returns null if the Analyst subprocess fails (caller falls back to regex).
   * Input: last 50 lines / up to 10,000 chars of error output.
   */
  async classifyError(
    errorTail: string
  ): Promise<'transient' | 'persistent' | 'non-retryable' | null> {
    const prompt = `Given this error output, classify it as one of: "transient" (safe to retry, likely network/timing), "non-retryable" (config/auth/missing file — retrying won't help), or "persistent" (same error repeating across attempts). Reply with {"classification": "...", "reason": "..."} only.\n\n${errorTail.slice(0, 10000)}`;
    try {
      const result = await this.run(prompt);
      if (
        result !== null &&
        typeof result === 'object' &&
        'classification' in result &&
        (result as Record<string, unknown>).classification !== undefined
      ) {
        const c = (result as Record<string, unknown>).classification;
        if (c === 'transient' || c === 'persistent' || c === 'non-retryable') return c;
      }
      throw new Error('Invalid classification schema');
    } catch (err) {
      this.writeDegradedComm('classifyError', String(err));
      return null;
    }
  }

  /**
   * Summarize CI failure logs, extracting only the root cause lines.
   * Returns null if the Analyst fails (caller passes raw logs as-is).
   * Input: pre-truncated to 4,000 chars by caller.
   */
  async summarizeCILogs(rawLogs: string): Promise<string | null> {
    const prompt = `Extract only the root cause error lines from this CI failure log. Ignore setup, teardown, and passing step output. Be concise. Reply with {"summary": "..."} only.\n\n${rawLogs}`;
    try {
      const result = await this.run(prompt);
      if (
        result !== null &&
        typeof result === 'object' &&
        'summary' in result &&
        typeof (result as Record<string, unknown>).summary === 'string'
      ) {
        const { summary } = result as Record<string, unknown>;
        return String(summary);
      }
      throw new Error('Invalid summary schema');
    } catch (err) {
      this.writeDegradedComm('summarizeCILogs', String(err));
      return null;
    }
  }

  /**
   * Extract review verdict and notes from crew output.
   * Returns null if the Analyst fails (caller falls back to VERDICT: regex).
   * Input: last 4,000 chars of fullOutput, truncated by caller.
   */
  async extractPRVerdict(crewOutput: string): Promise<{
    verdict: 'APPROVE' | 'REQUEST_CHANGES' | 'ESCALATE';
    notes: string;
  } | null> {
    const prompt = `Extract the review verdict and notes from this crew output. The verdict must be one of: APPROVE, REQUEST_CHANGES, ESCALATE. Reply with {"verdict": "...", "notes": "..."} only.\n\n${crewOutput}`;
    try {
      const result = await this.run(prompt);
      if (
        result !== null &&
        typeof result === 'object' &&
        'verdict' in result &&
        'notes' in result
      ) {
        const r = result as Record<string, unknown>;
        const v = r.verdict;
        if (v === 'APPROVE' || v === 'REQUEST_CHANGES' || v === 'ESCALATE') {
          const notes = r.notes;
          return { verdict: v, notes: typeof notes === 'string' ? notes : '' };
        }
      }
      throw new Error('Invalid verdict schema');
    } catch (err) {
      this.writeDegradedComm('extractPRVerdict', String(err));
      return null;
    }
  }

  /**
   * Write 2-3 sentences of context for a hailing memo.
   * Returns null if the Analyst fails (caller uses template text).
   * Input: payloadText already resolved from the hailing comms JSON.
   */
  async writeHailingContext(payloadText: string): Promise<string | null> {
    const prompt = `A crew is stuck and unresponsive. They sent this hailing message and have received no response for over 60 seconds. Write 2-3 sentences explaining what likely happened and what the operator should check. Reply with {"context": "..."} only.\n\n${payloadText}`;
    try {
      const result = await this.run(prompt);
      if (
        result !== null &&
        typeof result === 'object' &&
        'context' in result &&
        typeof (result as Record<string, unknown>).context === 'string'
      ) {
        const { context } = result as Record<string, unknown>;
        return String(context);
      }
      throw new Error('Invalid context schema');
    } catch (err) {
      this.writeDegradedComm('writeHailingContext', String(err));
      return null;
    }
  }
}
