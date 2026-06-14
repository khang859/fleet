import { spawn, type ChildProcess } from 'child_process';
import { mkdirSync, writeFileSync, readFileSync, renameSync } from 'fs';
import { join } from 'path';
import { z } from 'zod';
import { createLogger } from '../logger';
import { CodedError } from '../errors';
import { RUNE_NOT_INSTALLED_MESSAGE } from '../../shared/rune';
import { isAuthFailureText } from '../kanban/spawn-worker';
import { readRuneSession } from '../sessions/rune-source';
import {
  buildAssistArgs,
  buildContextLine,
  composeAssistPrompt,
  parseRuneSessionId,
  lastAssistantText,
  extractChangedFiles
} from '../../shared/rune-assist';
import type { TranscriptMessage } from '../../shared/sessions';
import type {
  RuneAssistSendRequest,
  RuneAssistState,
  RuneAssistStatusPayload,
  RuneAssistResultPayload
} from '../../shared/ipc-api';

const log = createLogger('rune-assist');

/** A turn that runs longer than this is assumed hung and killed. */
const TURN_TIMEOUT_MS = 5 * 60 * 1000;
/** Keep only this much child output in memory (see docs/learnings on stdout OOM). */
const OUTPUT_CAP = 64 * 1024;

const sessionsFileSchema = z.record(z.string(), z.string());

interface CwdChat {
  sessionId: string | null;
  inFlight: boolean;
  error: string | null;
}

export interface RuneFileChatServiceOptions {
  /** Directory for persisted state (app.getPath('userData')). */
  stateDir: string;
  emitStatus: (payload: RuneAssistStatusPayload) => void;
  emitResult: (payload: RuneAssistResultPayload) => void;
}

/**
 * Drives the Rune Quick-Assist overlay: one resumable rune session per workspace `cwd`,
 * advanced one headless turn per request (`rune --prompt`, then `rune --resume <id> --prompt`).
 * One turn in flight per cwd; the originating paneId is echoed back on every event so the
 * renderer routes the pill / answer / reload to the right pane.
 */
export class RuneFileChatService {
  private chats = new Map<string, CwdChat>();
  private opts: RuneFileChatServiceOptions;
  private sessionsLoaded = false;
  private inFlightChildren = new Set<ChildProcess>();
  /** Active child per cwd, so stop(cwd) can SIGTERM the right one. */
  private childByCwd = new Map<string, ChildProcess>();

  constructor(opts: RuneFileChatServiceOptions) {
    this.opts = opts;
  }

  /** Kill any in-flight turns (app shutdown). */
  dispose(): void {
    for (const child of this.inFlightChildren) child.kill('SIGTERM');
    this.inFlightChildren.clear();
    this.childByCwd.clear();
  }

  private sessionsPath(): string {
    return join(this.opts.stateDir, 'rune-assist-sessions.json');
  }

  /** Lazily hydrate persisted cwd→session ids so conversations survive restarts. */
  private chat(cwd: string): CwdChat {
    if (!this.sessionsLoaded) {
      this.sessionsLoaded = true;
      try {
        const raw = sessionsFileSchema.parse(
          JSON.parse(readFileSync(this.sessionsPath(), 'utf-8'))
        );
        for (const [key, sessionId] of Object.entries(raw)) {
          this.chats.set(key, { sessionId, inFlight: false, error: null });
        }
      } catch {
        // first run or unreadable file — start fresh
      }
    }
    let c = this.chats.get(cwd);
    if (!c) {
      c = { sessionId: null, inFlight: false, error: null };
      this.chats.set(cwd, c);
    }
    return c;
  }

  private persistSessions(): void {
    const data: Record<string, string> = {};
    for (const [key, c] of this.chats) {
      if (c.sessionId) data[key] = c.sessionId;
    }
    const path = this.sessionsPath();
    mkdirSync(this.opts.stateDir, { recursive: true });
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, JSON.stringify(data, null, 2));
    renameSync(tmp, path);
  }

  getState(cwd: string): RuneAssistState {
    const c = this.chat(cwd);
    return { cwd, inFlight: c.inFlight, error: c.error, sessionId: c.sessionId };
  }

  /** Forget the conversation (the rune session file is left untouched). */
  reset(cwd: string): void {
    const c = this.chat(cwd);
    if (c.inFlight)
      throw new CodedError('wait for the current turn to finish first', 'BAD_REQUEST');
    c.sessionId = null;
    c.error = null;
    this.persistSessions();
  }

  /** SIGTERM the in-flight child for this cwd, if any. */
  stop(cwd: string): void {
    this.childByCwd.get(cwd)?.kill('SIGTERM');
  }

  sendMessage(req: RuneAssistSendRequest): void {
    const { cwd, paneId, mode, contextFile, selection } = req;
    const body = req.text.trim();
    if (body === '') throw new CodedError('message is empty', 'BAD_REQUEST');
    const c = this.chat(cwd);
    if (c.inFlight) {
      // Routed to the originating pane so the overlay can show a gentle note.
      this.opts.emitStatus({
        cwd,
        paneId,
        phase: 'error',
        error: 'Rune is still working in this workspace — cancel or wait.'
      });
      return;
    }
    c.inFlight = true;
    c.error = null;
    this.opts.emitStatus({ cwd, paneId, phase: 'working', step: 'starting…' });

    const contextLine = contextFile ? buildContextLine(contextFile, selection) : '';
    const prompt = contextLine ? composeAssistPrompt(mode, contextLine, body) : body;
    const args = buildAssistArgs(prompt, c.sessionId);
    const child = spawn('rune', args, {
      cwd,
      env: { ...process.env },
      stdio: ['ignore', 'pipe', 'pipe']
    });

    this.inFlightChildren.add(child);
    this.childByCwd.set(cwd, child);

    let output = ''; // merged stdout+stderr tail, for error classification
    let sessionId: string | null = c.sessionId;
    const collect = (chunk: Buffer): void => {
      output = (output + chunk.toString('utf-8')).slice(-OUTPUT_CAP);
      if (!sessionId) sessionId = parseRuneSessionId(output);
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);

    let finished = false;
    const finish = (error: string | null): void => {
      if (finished) return;
      finished = true;
      this.inFlightChildren.delete(child);
      this.childByCwd.delete(cwd);
      clearTimeout(timeout);
      c.inFlight = false;
      c.error = error;
      if (sessionId && sessionId !== c.sessionId) {
        c.sessionId = sessionId;
        this.persistSessions();
      }
      if (error) {
        this.opts.emitStatus({ cwd, paneId, phase: 'error', error });
        return;
      }
      void this.readMessages(c.sessionId).then((messages) => {
        const result: RuneAssistResultPayload = { cwd, paneId, mode };
        if (mode === 'ask') {
          result.answer = lastAssistantText(messages);
        } else {
          result.changedFiles = extractChangedFiles(messages);
        }
        this.opts.emitResult(result);
        this.opts.emitStatus({ cwd, paneId, phase: 'idle' });
      });
    };

    const timeout = setTimeout(() => {
      log.warn('rune-assist turn timed out; killing rune', { cwd, pid: child.pid });
      child.kill('SIGTERM');
    }, TURN_TIMEOUT_MS);

    child.on('error', (err: NodeJS.ErrnoException) => {
      log.error('rune-assist failed to spawn', { cwd, error: err.message });
      finish(err.code === 'ENOENT' ? RUNE_NOT_INSTALLED_MESSAGE : err.message);
    });
    child.on('exit', (code, signal) => {
      if (code === 0) {
        finish(null);
        return;
      }
      if (signal) {
        finish('the run was interrupted; try again');
        return;
      }
      if (isAuthFailureText(output)) {
        finish(
          'rune authentication failed — fix the provider credentials (e.g. `rune login`) and retry'
        );
        return;
      }
      const lastLine = output
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean)
        .pop();
      finish(lastLine ? lastLine.slice(0, 300) : `the run failed (exit ${code ?? '?'})`);
    });
  }

  private async readMessages(sessionId: string | null): Promise<TranscriptMessage[]> {
    if (!sessionId) return [];
    const transcript = await readRuneSession(sessionId);
    return transcript?.messages ?? [];
  }
}
