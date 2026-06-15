import { spawn, type ChildProcess } from 'child_process';
import { mkdirSync, writeFileSync, readFileSync, renameSync } from 'fs';
import { join } from 'path';
import { randomUUID } from 'crypto';
import { z } from 'zod';
import { createLogger } from '../logger';
import { CodedError } from '../errors';
import { RUNE_NOT_INSTALLED_MESSAGE } from '../../shared/rune';
import { isAuthFailureText } from './spawn-worker';
import { readRuneSession } from '../sessions/rune-source';
import { buildPmAgentsMd } from './pm-agents';
import { learningsMcpEntry } from '../learnings/learnings-mcp-registrar';
import { pmBoardDir, pmDocsDir } from './pm-paths';
import type { KanbanMcpServer } from './kanban-mcp-server';
import type { TranscriptMessage } from '../../shared/sessions';
import type {
  PmChatState,
  PmChatStatusPayload,
  PmChatTranscriptPayload
} from '../../shared/ipc-api';
import type { Project } from '../../shared/kanban-types';

const log = createLogger('kanban-pm');

/** A PM turn that runs longer than this is assumed hung and killed. */
const PM_TURN_TIMEOUT_MS = 5 * 60 * 1000;
/** After SIGTERM on a timed-out turn, wait this long for a clean exit before SIGKILL. */
const PM_TURN_SIGKILL_GRACE_MS = 5 * 1000;
/** Keep only this much of the child's output in memory (see docs/learnings on stdout OOM). */
const OUTPUT_CAP = 64 * 1024;
/** Defensive cap on MEMORY.md injection (persona asks for ~200 lines). */
const MEMORY_INJECT_CAP = 16 * 1024;

const sessionsFileSchema = z.record(z.string(), z.string());

interface BoardChat {
  sessionId: string | null;
  inFlight: boolean;
  error: string | null;
}

export interface PmChatServiceOptions {
  mcp: KanbanMcpServer;
  mcpPort: number;
  /** Kanban home dir (~/.fleet/kanban); PM state lives under <home>/pm. */
  kanbanHome: string;
  emitStatus: (payload: PmChatStatusPayload) => void;
  emitTranscript: (payload: PmChatTranscriptPayload) => void;
  /** Board project registry, injected into the PM persona each turn. */
  getProjects: (boardId: string) => Project[];
}

/**
 * Drives the PM chat: one rune session per board, advanced one headless turn per
 * user message (`rune --prompt`, then `rune --resume <id> --prompt`). The turn's
 * board mutations arrive through the kanban MCP server under a board-scoped
 * token; the conversation transcript is read back from rune's session JSON.
 */
export class PmChatService {
  private chats = new Map<string, BoardChat>();
  private opts: PmChatServiceOptions;
  private sessionsLoaded = false;
  private inFlightChildren = new Set<ChildProcess>();

  constructor(opts: PmChatServiceOptions) {
    this.opts = opts;
  }

  /** Kill any in-flight PM rune turns (app shutdown). */
  dispose(): void {
    for (const child of this.inFlightChildren) child.kill('SIGTERM');
    this.inFlightChildren.clear();
  }

  private sessionsPath(): string {
    return join(this.opts.kanbanHome, 'pm', 'pm-sessions.json');
  }

  /** Lazily hydrate persisted board→session ids so conversations survive restarts. */
  private chat(boardId: string): BoardChat {
    if (!this.sessionsLoaded) {
      this.sessionsLoaded = true;
      try {
        const raw = sessionsFileSchema.parse(
          JSON.parse(readFileSync(this.sessionsPath(), 'utf-8'))
        );
        for (const [board, sessionId] of Object.entries(raw)) {
          this.chats.set(board, { sessionId, inFlight: false, error: null });
        }
      } catch {
        // first run or unreadable file — start fresh
      }
    }
    let c = this.chats.get(boardId);
    if (!c) {
      c = { sessionId: null, inFlight: false, error: null };
      this.chats.set(boardId, c);
    }
    return c;
  }

  private persistSessions(): void {
    const data: Record<string, string> = {};
    for (const [board, c] of this.chats) {
      if (c.sessionId) data[board] = c.sessionId;
    }
    const path = this.sessionsPath();
    mkdirSync(join(this.opts.kanbanHome, 'pm'), { recursive: true });
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, JSON.stringify(data, null, 2));
    renameSync(tmp, path);
  }

  async getState(boardId: string): Promise<PmChatState> {
    const c = this.chat(boardId);
    return {
      boardId,
      inFlight: c.inFlight,
      error: c.error,
      messages: await this.readMessages(c.sessionId)
    };
  }

  /** Forget the conversation (the rune session file is left untouched). */
  reset(boardId: string): void {
    const c = this.chat(boardId);
    if (c.inFlight) {
      throw new CodedError('wait for the PM to finish responding first', 'BAD_REQUEST');
    }
    c.sessionId = null;
    c.error = null;
    this.persistSessions();
  }

  sendMessage(boardId: string, text: string): void {
    const body = text.trim();
    if (body === '') throw new CodedError('message is empty', 'BAD_REQUEST');
    const c = this.chat(boardId);
    if (c.inFlight) {
      throw new CodedError('the PM is still responding', 'BAD_REQUEST');
    }
    c.inFlight = true;
    c.error = null;
    this.opts.emitStatus({ boardId, status: 'thinking' });

    const token = randomUUID();
    let child: ChildProcess | undefined;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    let sessionId: string | null = c.sessionId;

    // The single funnel that guarantees inFlight is cleared. Every exit path routes
    // here: synchronous setup failure, child 'error'/'exit', and the turn timeout.
    // One-shot: a failed spawn fires 'error' AND 'exit', and the second call would
    // clobber the specific error with the generic exit fallback.
    let finished = false;
    const finish = (error: string | null): void => {
      if (finished) return;
      finished = true;
      if (timeout) clearTimeout(timeout);
      if (killTimer) clearTimeout(killTimer);
      if (child) this.inFlightChildren.delete(child);
      this.opts.mcp.unregisterRun(token);
      c.inFlight = false;
      c.error = error;
      if (sessionId && sessionId !== c.sessionId) {
        c.sessionId = sessionId;
        this.persistSessions();
      }
      void this.readMessages(c.sessionId)
        .then((messages) => {
          if (messages.length > 0) this.opts.emitTranscript({ boardId, messages });
        })
        .catch(() => {
          // reading the transcript back is best-effort; never block the status transition
        })
        .finally(() => {
          this.opts.emitStatus(
            error ? { boardId, status: 'error', error } : { boardId, status: 'idle' }
          );
        });
    };

    try {
      this.opts.mcp.registerRun(token, { kind: 'board', boardId });

      const dir = pmBoardDir(this.opts.kanbanHome, boardId);
      const runeDir = join(dir, '.rune');
      mkdirSync(runeDir, { recursive: true });
      mkdirSync(pmDocsDir(this.opts.kanbanHome, boardId), { recursive: true });
      let memory: string | null = null;
      try {
        memory = readFileSync(join(dir, 'MEMORY.md'), 'utf-8').slice(0, MEMORY_INJECT_CAP);
      } catch {
        // no memory yet — first turn or never written
      }
      let projects: Project[] = [];
      try {
        projects = this.opts.getProjects(boardId);
      } catch {
        // registry unavailable must never block the chat turn
      }
      writeFileSync(join(dir, 'AGENTS.md'), buildPmAgentsMd({ projects, memory }));
      const mcpConfigPath = join(runeDir, 'mcp.json');
      const url = `http://127.0.0.1:${this.opts.mcpPort}/mcp?run=${token}`;
      const learnings = learningsMcpEntry();
      const servers: Record<string, { type: 'http'; url: string }> = {
        kanban: { type: 'http', url },
        ...(learnings ? { 'fleet-learnings': learnings } : {})
      };
      writeFileSync(mcpConfigPath, JSON.stringify({ servers }, null, 2));

      const args = ['--prompt', body];
      if (c.sessionId) args.push('--resume', c.sessionId);
      const spawned = spawn('rune', args, {
        cwd: dir,
        // Treat the chat message as literal text — don't let rune auto-attach (and inline)
        // files for path-like tokens the user happens to mention; the PM uses tools to read.
        env: { ...process.env, RUNE_MCP_CONFIG: mcpConfigPath, RUNE_NO_ATTACH: '1' },
        stdio: ['ignore', 'pipe', 'pipe']
      });
      child = spawned;
      this.inFlightChildren.add(spawned);

      let output = ''; // merged stdout+stderr tail, for error classification
      const collect = (chunk: Buffer): void => {
        output = (output + chunk.toString('utf-8')).slice(-OUTPUT_CAP);
        if (!sessionId) {
          sessionId = /^session-id: ([A-Za-z0-9_-]+)$/m.exec(output)?.[1] ?? null;
        }
      };
      spawned.stdout.on('data', collect);
      spawned.stderr.on('data', collect);

      timeout = setTimeout(() => {
        log.warn('pm turn timed out; killing rune', { boardId, pid: spawned.pid });
        spawned.kill('SIGTERM');
        // Escalate if rune traps/ignores SIGTERM, so the turn can't hang inFlight forever.
        killTimer = setTimeout(() => {
          if (finished) return;
          log.warn('pm turn ignored SIGTERM; sending SIGKILL', { boardId, pid: spawned.pid });
          spawned.kill('SIGKILL');
        }, PM_TURN_SIGKILL_GRACE_MS);
      }, PM_TURN_TIMEOUT_MS);

      spawned.on('error', (err: NodeJS.ErrnoException) => {
        log.error('pm rune failed to spawn', { boardId, error: err.message });
        finish(err.code === 'ENOENT' ? RUNE_NOT_INSTALLED_MESSAGE : err.message);
      });
      spawned.on('exit', (code, signal) => {
        if (code === 0) {
          finish(null);
          return;
        }
        if (signal) {
          finish('the PM run was interrupted; try again');
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
        finish(lastLine ? lastLine.slice(0, 300) : `the PM run failed (exit ${code ?? '?'})`);
      });
    } catch (err) {
      // Synchronous setup failure (fs error, spawn throw, registry). Route through
      // finish() so inFlight is cleared and the renderer leaves 'thinking', then
      // surface the error to the caller as before.
      finish(err instanceof Error ? err.message : String(err));
      throw err;
    }
  }

  private async readMessages(sessionId: string | null): Promise<TranscriptMessage[]> {
    if (!sessionId) return [];
    const transcript = await readRuneSession(sessionId);
    return transcript?.messages ?? [];
  }
}
