import { z } from 'zod';
import { tmpdir } from 'os';
import { IPC_CHANNELS } from '../../../shared/ipc-channels';
import type {
  ChatToolsConfig,
  ChatToolStatusPayload,
  ChatAuditDecision,
  ChatAuditStatus
} from '../../../shared/chat-types';
import type { PermissionManager } from '../permissions/permission-manager';
import { readFileTool, globTool, searchTool, defaultWorkspace } from './fs-tools';
import { runBash } from './bash-exec';
import { makeSandboxWrap } from './sandbox';
import { assertWritablePath } from './fs-safety';
import { planWrite, planEdit, applyWrite } from './write-tools';
import { isMcpToolName } from '../../../shared/mcp-types';

/** The subset of McpManager the executor needs (kept narrow for testing). */
export type McpRouter = {
  hasTool: (name: string) => boolean;
  callTool: (name: string, argsJson: string) => Promise<string>;
};

export const READ_FILE_TOOL = {
  type: 'function',
  function: {
    name: 'read_file',
    description:
      'Read a slice of a UTF-8 text file from the local filesystem. Read-only and never modifies anything. Returns the requested lines prefixed with line numbers.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path, absolute or relative to the workspace.' },
        offset: { type: 'integer', description: 'Zero-based line to start from (default 0).' },
        limit: { type: 'integer', description: 'Max lines to read (default 2000).' }
      },
      required: ['path']
    }
  }
} as const;

export const GLOB_TOOL = {
  type: 'function',
  function: {
    name: 'glob',
    description:
      'Find files by name using a glob pattern (supports *, **, ?). Read-only. Returns matching paths relative to the search root.',
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Glob, e.g. **/*.ts' },
        path: { type: 'string', description: 'Directory to search from (default workspace root).' }
      },
      required: ['pattern']
    }
  }
} as const;

export const SEARCH_TOOL = {
  type: 'function',
  function: {
    name: 'search',
    description:
      'Search file contents with a regular expression. Read-only. Returns file:line: matches.',
    parameters: {
      type: 'object',
      properties: {
        regex: { type: 'string', description: 'JavaScript regular expression.' },
        path: { type: 'string', description: 'Directory to search from (default workspace root).' },
        glob: { type: 'string', description: 'Optional glob to restrict which files are searched.' }
      },
      required: ['regex']
    }
  }
} as const;

export const BASH_TOOL = {
  type: 'function',
  function: {
    name: 'bash',
    description:
      'Run a shell command in the workspace. Gated: the user must approve it (or it must match an allow rule). Returns exit code, stdout, and stderr.',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'The shell command to run.' }
      },
      required: ['command']
    }
  }
} as const;

export const WRITE_FILE_TOOL = {
  type: 'function',
  function: {
    name: 'write_file',
    description:
      'Create or overwrite a file with the given content. Gated: the user approves a diff before it is applied. Confined to the workspace.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path within the workspace.' },
        content: { type: 'string', description: 'The full new file content.' }
      },
      required: ['path', 'content']
    }
  }
} as const;

export const EDIT_FILE_TOOL = {
  type: 'function',
  function: {
    name: 'edit_file',
    description:
      'Replace an exact unique string in a file with a new string. Gated: the user approves a diff before it is applied. old_string must occur exactly once.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path within the workspace.' },
        old_string: { type: 'string', description: 'Exact text to replace (must be unique).' },
        new_string: { type: 'string', description: 'Replacement text.' }
      },
      required: ['path', 'old_string', 'new_string']
    }
  }
} as const;

/** Tool schemas exposed to the model for the given mode. */
export function buildFsToolDefs(mode: ChatToolsConfig['mode']): unknown[] {
  if (mode === 'off') return [];
  const defs: unknown[] = [READ_FILE_TOOL, GLOB_TOOL, SEARCH_TOOL];
  if (mode === 'ask' || mode === 'auto') {
    defs.push(BASH_TOOL, WRITE_FILE_TOOL, EDIT_FILE_TOOL);
  }
  return defs;
}

export const FS_TOOL_NAMES = new Set([
  'read_file',
  'glob',
  'search',
  'bash',
  'write_file',
  'edit_file'
]);

type ExecCtx = { streamId: string; conversationId: string; signal: AbortSignal };

/** What a tool did, for both the model (output) and the audit ledger. */
type ToolOutcome = {
  output: string;
  detail: string;
  decision: ChatAuditDecision;
  status: ChatAuditStatus;
};

/** Sink for audit records; the conversationId/tool/cwd are added by run(). */
export type AuditSink = (entry: {
  conversationId: string;
  tool: string;
  detail: string;
  cwd: string;
  decision: ChatAuditDecision;
  status: ChatAuditStatus;
  result: string;
}) => void;

const readArgs = z.object({
  path: z.string(),
  offset: z.number().int().optional(),
  limit: z.number().int().optional()
});
const globArgs = z.object({ pattern: z.string(), path: z.string().optional() });
const searchArgs = z.object({
  regex: z.string(),
  path: z.string().optional(),
  glob: z.string().optional()
});
const bashArgs = z.object({ command: z.string() });
const writeArgs = z.object({ path: z.string(), content: z.string() });
const editArgs = z.object({
  path: z.string(),
  old_string: z.string(),
  new_string: z.string()
});

/**
 * Executes the native fs/bash tools. Read tools run directly (no prompt) with
 * credential-path denies enforced. Bash is gated: deny → ask → allow over every
 * parsed subcommand, with mode + sandbox policy applied here in the main
 * process. The model never decides whether a command is safe.
 */
export class ChatToolExecutor {
  constructor(
    private readonly permissions: PermissionManager,
    private readonly getConfig: () => ChatToolsConfig,
    private readonly emit: (channel: string, payload: unknown) => void,
    private readonly mcp: McpRouter | null = null,
    private readonly onAudit: AuditSink | null = null
  ) {}

  /** Returns the tool result content fed back into the model loop. */
  async run(name: string, argsJson: string, ctx: ExecCtx): Promise<string> {
    const cfg = this.getConfig();
    const cwd = defaultWorkspace(cfg.workspaceDir);
    let outcome: ToolOutcome;
    try {
      outcome = await this.dispatch(name, argsJson, cfg, cwd, ctx);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      outcome = { output: `Error: ${msg}`, detail: name, decision: 'error', status: 'error' };
    }
    // Audit every tool action — including denied/blocked/errored attempts.
    this.onAudit?.({
      conversationId: ctx.conversationId,
      tool: name,
      detail: outcome.detail,
      cwd,
      decision: outcome.decision,
      status: outcome.status,
      result: outcome.output
    });
    return outcome.output;
  }

  private async dispatch(
    name: string,
    argsJson: string,
    cfg: ChatToolsConfig,
    cwd: string,
    ctx: ExecCtx
  ): Promise<ToolOutcome> {
    if (isMcpToolName(name)) return this.runMcpGated(name, argsJson, ctx);
    switch (name) {
      case 'read_file': {
        const a = readArgs.parse(JSON.parse(argsJson));
        return {
          output: readFileTool({ ...a, cwd }),
          detail: a.path,
          decision: 'allowed',
          status: 'ok'
        };
      }
      case 'glob': {
        const a = globArgs.parse(JSON.parse(argsJson));
        const files = globTool({ ...a, cwd });
        return {
          output: files.length ? files.join('\n') : 'No files matched.',
          detail: a.pattern,
          decision: 'allowed',
          status: 'ok'
        };
      }
      case 'search': {
        const a = searchArgs.parse(JSON.parse(argsJson));
        const hits = searchTool({ ...a, cwd });
        return {
          output: hits.length
            ? hits.map((h) => `${h.file}:${h.line}: ${h.text}`).join('\n')
            : 'No matches.',
          detail: a.regex,
          decision: 'allowed',
          status: 'ok'
        };
      }
      case 'bash': {
        const a = bashArgs.parse(JSON.parse(argsJson));
        return this.runBashGated(a.command, cwd, cfg, ctx);
      }
      case 'write_file': {
        const a = writeArgs.parse(JSON.parse(argsJson));
        return this.runWriteGated(a.path, (abs) => planWrite(abs, a.content), cwd, cfg, ctx);
      }
      case 'edit_file': {
        const a = editArgs.parse(JSON.parse(argsJson));
        return this.runWriteGated(
          a.path,
          (abs) => planEdit(abs, a.old_string, a.new_string),
          cwd,
          cfg,
          ctx
        );
      }
      default:
        return {
          output: `Unknown tool: ${name}`,
          detail: name,
          decision: 'error',
          status: 'error'
        };
    }
  }

  private async runBashGated(
    command: string,
    cwd: string,
    cfg: ChatToolsConfig,
    ctx: ExecCtx
  ): Promise<ToolOutcome> {
    const blocked = (output: string): ToolOutcome => ({
      output,
      detail: command,
      decision: 'blocked',
      status: 'denied'
    });
    const denied = (output: string): ToolOutcome => ({
      output,
      detail: command,
      decision: 'denied',
      status: 'denied'
    });
    if (cfg.mode === 'off' || cfg.mode === 'read-only') {
      return blocked(
        'bash is disabled in read-only mode. The user must enable command execution in Chat settings.'
      );
    }

    const wrap = cfg.sandbox
      ? makeSandboxWrap({ writableRoots: [cwd, tmpdir()], denyNetwork: true })
      : null;
    const sandboxRequestedButMissing = cfg.sandbox && wrap === null;

    // How the command was authorized — recorded in the audit ledger.
    let decision: ChatAuditDecision;
    if (cfg.mode === 'auto') {
      const verdict = this.permissions.evaluate('Bash', command);
      if (verdict === 'deny') return blocked('This command is blocked by a deny rule.');
      if (verdict === 'allow') {
        decision = 'auto';
      } else if (wrap) {
        decision = 'auto'; // sandboxed → skip prompt
      } else if (cfg.failClosed) {
        return blocked('Refused: sandbox unavailable and fail-closed is on.');
      } else {
        const grant = await this.permissions.request({
          streamId: ctx.streamId,
          tool: 'Bash',
          command,
          cwd,
          signal: ctx.signal
        });
        if (grant !== 'allow') return denied('The user denied this command.');
        decision = 'approved';
      }
    } else {
      // ask mode: deny → deny, allow → allow, otherwise prompt.
      if (sandboxRequestedButMissing && cfg.failClosed) {
        return blocked('Refused: sandbox unavailable and fail-closed is on.');
      }
      const grant = await this.permissions.request({
        streamId: ctx.streamId,
        tool: 'Bash',
        command,
        cwd,
        signal: ctx.signal
      });
      if (grant !== 'allow') return denied('The user denied this command.');
      decision = 'approved';
    }

    this.emit(IPC_CHANNELS.CHAT_TOOL_STATUS, {
      streamId: ctx.streamId,
      state: 'generating',
      label: `$ ${command}`
    } satisfies ChatToolStatusPayload);

    const result = await runBash({ command, cwd, signal: ctx.signal, wrap: wrap ?? undefined });

    this.emit(IPC_CHANNELS.CHAT_TOOL_STATUS, {
      streamId: ctx.streamId,
      state: 'done',
      label: 'Command finished'
    } satisfies ChatToolStatusPayload);

    const parts = [`Exit code: ${result.timedOut ? 'timed out' : result.exitCode}`];
    if (result.stdout) parts.push(`stdout:\n${result.stdout}`);
    if (result.stderr) parts.push(`stderr:\n${result.stderr}`);
    if (result.truncated) parts.push('(output truncated)');
    return { output: parts.join('\n'), detail: command, decision, status: 'ok' };
  }

  /**
   * Gate and apply a file write/edit. Always confined to the workspace (never a
   * .git internal or credential path — circuit-breakers that hold even in auto
   * mode). In ask mode a diff is shown for approval; in auto mode it applies
   * unless a deny rule blocks it.
   */
  private async runWriteGated(
    relPath: string,
    plan: (abs: string) => { newContent: string; diff: string; isNew: boolean },
    cwd: string,
    cfg: ChatToolsConfig,
    ctx: ExecCtx
  ): Promise<ToolOutcome> {
    if (cfg.mode === 'off' || cfg.mode === 'read-only') {
      return {
        output: 'File edits are disabled. The user must enable Ask or Auto mode in Chat settings.',
        detail: relPath,
        decision: 'blocked',
        status: 'denied'
      };
    }
    // Circuit-breakers + workspace confinement (throws → surfaced as Error by run()).
    const abs = assertWritablePath(relPath, cwd, [cwd]);
    const planned = plan(abs);

    let decision: ChatAuditDecision;
    if (cfg.mode === 'auto') {
      if (this.permissions.evaluate('Edit', relPath) === 'deny') {
        return {
          output: 'This edit is blocked by a deny rule.',
          detail: relPath,
          decision: 'blocked',
          status: 'denied'
        };
      }
      decision = 'auto';
    } else {
      const grant = await this.permissions.request({
        streamId: ctx.streamId,
        tool: 'Edit',
        command: relPath,
        cwd,
        diff: planned.diff,
        signal: ctx.signal
      });
      if (grant !== 'allow') {
        return {
          output: 'The user denied this edit.',
          detail: relPath,
          decision: 'denied',
          status: 'denied'
        };
      }
      decision = 'approved';
    }

    applyWrite(abs, planned.newContent);
    const label = `${planned.isNew ? 'Created' : 'Updated'} ${relPath}`;
    this.emit(IPC_CHANNELS.CHAT_TOOL_STATUS, {
      streamId: ctx.streamId,
      state: 'done',
      label
    } satisfies ChatToolStatusPayload);
    return { output: label, detail: relPath, decision, status: 'ok' };
  }

  /**
   * Gate and run an MCP tool call. Approval reuses the permission engine + card
   * (tool `Mcp`, the namespaced tool name as the value). Allow rules like
   * `Mcp(mcp__server__*)` auto-approve trusted read-only tools.
   */
  private async runMcpGated(name: string, argsJson: string, ctx: ExecCtx): Promise<ToolOutcome> {
    if (!this.mcp?.hasTool(name)) {
      return { output: `Unknown tool: ${name}`, detail: name, decision: 'error', status: 'error' };
    }
    const grant = await this.permissions.request({
      streamId: ctx.streamId,
      tool: 'Mcp',
      command: name,
      signal: ctx.signal
    });
    if (grant !== 'allow') {
      return {
        output: 'The user denied this tool call.',
        detail: name,
        decision: 'denied',
        status: 'denied'
      };
    }
    this.emit(IPC_CHANNELS.CHAT_TOOL_STATUS, {
      streamId: ctx.streamId,
      state: 'generating',
      label: `Calling ${name}…`
    } satisfies ChatToolStatusPayload);
    const out = await this.mcp.callTool(name, argsJson);
    this.emit(IPC_CHANNELS.CHAT_TOOL_STATUS, {
      streamId: ctx.streamId,
      state: 'done',
      label: 'Tool finished'
    } satisfies ChatToolStatusPayload);
    return { output: out, detail: name, decision: 'approved', status: 'ok' };
  }
}
