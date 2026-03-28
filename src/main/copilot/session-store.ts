import { createLogger } from '../logger';
import type {
  CopilotSession,
  CopilotSessionPhase,
  CopilotPendingPermission,
  CopilotToolInfo,
} from '../../shared/types';

const log = createLogger('copilot:session-store');

export type HookEvent = {
  session_id: string;
  cwd: string;
  event: string;
  status: string;
  pid?: number;
  tty?: string;
  tool?: string;
  tool_input?: Record<string, unknown>;
  tool_use_id?: string;
  notification_type?: string;
  message?: string;
};

function statusToPhase(status: string): CopilotSessionPhase {
  switch (status) {
    case 'processing':
    case 'running_tool':
      return 'processing';
    case 'waiting_for_input':
      return 'waitingForInput';
    case 'waiting_for_approval':
      return 'waitingForApproval';
    case 'compacting':
      return 'compacting';
    case 'ended':
      return 'ended';
    default:
      return 'idle';
  }
}

function projectNameFromCwd(cwd: string): string {
  const parts = cwd.split('/');
  return parts[parts.length - 1] || cwd;
}

export class CopilotSessionStore {
  private sessions = new Map<string, CopilotSession>();
  private toolUseIdCache = new Map<string, string[]>();
  private onChange: (() => void) | null = null;

  setOnChange(cb: () => void): void {
    this.onChange = cb;
  }

  getSessions(): CopilotSession[] {
    return Array.from(this.sessions.values()).filter((s) => s.phase !== 'ended');
  }

  getSession(sessionId: string): CopilotSession | undefined {
    return this.sessions.get(sessionId);
  }

  processHookEvent(event: HookEvent): void {
    const { session_id, cwd, status, pid, tty, tool, tool_input, tool_use_id } = event;
    let phase = statusToPhase(status);
    const now = Date.now();

    let session = this.sessions.get(session_id);

    if (!session) {
      session = {
        sessionId: session_id,
        cwd,
        projectName: projectNameFromCwd(cwd),
        phase: 'idle',
        pid,
        tty,
        pendingPermissions: [],
        lastActivity: now,
        createdAt: now,
      };
      this.sessions.set(session_id, session);
      log.info('session created', { sessionId: session_id, cwd });
    }

    if (pid) session.pid = pid;
    if (tty) session.tty = tty;
    session.lastActivity = now;

    // Cache tool_use_id from PreToolUse
    if (event.event === 'PreToolUse' && tool_use_id && tool) {
      const cacheKey = `${session_id}:${tool}:${JSON.stringify(tool_input ?? {})}`;
      const queue = this.toolUseIdCache.get(cacheKey) ?? [];
      queue.push(tool_use_id);
      this.toolUseIdCache.set(cacheKey, queue);
    }

    // Handle permission requests (AskUserQuestion is a user question, not a permission)
    if (status === 'waiting_for_approval' && tool) {
      if (tool === 'AskUserQuestion') {
        // AskUserQuestion is rendered in the chat view with clickable options —
        // treat it as waiting for user input, not a permission request
        phase = 'waitingForInput';
      } else {
        const toolInfo: CopilotToolInfo = {
          toolName: tool,
          toolInput: tool_input ?? {},
          toolUseId: tool_use_id ?? this.popCachedToolUseId(session_id, tool, tool_input),
        };
        const pending: CopilotPendingPermission = {
          sessionId: session_id,
          toolUseId: toolInfo.toolUseId ?? `unknown-${now}`,
          tool: toolInfo,
          receivedAt: now,
        };
        session.pendingPermissions.push(pending);
        log.info('permission requested', { sessionId: session_id, tool });
      }
    }

    // Clear completed permissions on PostToolUse
    if (event.event === 'PostToolUse' && tool_use_id) {
      session.pendingPermissions = session.pendingPermissions.filter(
        (p) => p.toolUseId !== tool_use_id
      );
    }

    session.phase = phase;

    if (phase === 'ended') {
      this.cleanupToolUseCache(session_id);
      setTimeout(() => {
        this.sessions.delete(session_id);
        this.onChange?.();
      }, 30_000);
    }

    this.onChange?.();
  }

  removePermission(sessionId: string, toolUseId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    session.pendingPermissions = session.pendingPermissions.filter(
      (p) => p.toolUseId !== toolUseId
    );
    if (session.pendingPermissions.length === 0 && session.phase === 'waitingForApproval') {
      session.phase = 'processing';
    }
    this.onChange?.();
  }

  private popCachedToolUseId(
    sessionId: string,
    tool: string,
    toolInput?: Record<string, unknown>
  ): string | undefined {
    const cacheKey = `${sessionId}:${tool}:${JSON.stringify(toolInput ?? {})}`;
    const queue = this.toolUseIdCache.get(cacheKey);
    if (!queue || queue.length === 0) return undefined;
    return queue.shift();
  }

  private cleanupToolUseCache(sessionId: string): void {
    for (const key of this.toolUseIdCache.keys()) {
      if (key.startsWith(`${sessionId}:`)) {
        this.toolUseIdCache.delete(key);
      }
    }
  }
}
