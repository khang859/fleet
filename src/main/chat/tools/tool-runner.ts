import { z } from 'zod';
import { tmpdir } from 'os';
import { IPC_CHANNELS } from '../../../shared/ipc-channels';
import type { ChatToolsConfig, ChatToolStatusPayload } from '../../../shared/chat-types';
import type { PermissionManager } from '../permissions/permission-manager';
import { readFileTool, globTool, searchTool, defaultWorkspace } from './fs-tools';
import { runBash } from './bash-exec';
import { makeSandboxWrap } from './sandbox';

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

/** Tool schemas exposed to the model for the given mode. */
export function buildFsToolDefs(mode: ChatToolsConfig['mode']): unknown[] {
  if (mode === 'off') return [];
  const defs: unknown[] = [READ_FILE_TOOL, GLOB_TOOL, SEARCH_TOOL];
  if (mode === 'ask' || mode === 'auto') defs.push(BASH_TOOL);
  return defs;
}

export const FS_TOOL_NAMES = new Set(['read_file', 'glob', 'search', 'bash']);

type ExecCtx = { streamId: string; signal: AbortSignal };

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
    private readonly emit: (channel: string, payload: unknown) => void
  ) {}

  /** Returns the tool result content fed back into the model loop. */
  async run(name: string, argsJson: string, ctx: ExecCtx): Promise<string> {
    const cfg = this.getConfig();
    const cwd = defaultWorkspace(cfg.workspaceDir);
    try {
      switch (name) {
        case 'read_file': {
          const a = readArgs.parse(JSON.parse(argsJson));
          return readFileTool({ ...a, cwd });
        }
        case 'glob': {
          const a = globArgs.parse(JSON.parse(argsJson));
          const files = globTool({ ...a, cwd });
          return files.length ? files.join('\n') : 'No files matched.';
        }
        case 'search': {
          const a = searchArgs.parse(JSON.parse(argsJson));
          const hits = searchTool({ ...a, cwd });
          return hits.length
            ? hits.map((h) => `${h.file}:${h.line}: ${h.text}`).join('\n')
            : 'No matches.';
        }
        case 'bash': {
          const a = bashArgs.parse(JSON.parse(argsJson));
          return await this.runBashGated(a.command, cwd, cfg, ctx);
        }
        default:
          return `Unknown tool: ${name}`;
      }
    } catch (err) {
      return `Error: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  private async runBashGated(
    command: string,
    cwd: string,
    cfg: ChatToolsConfig,
    ctx: ExecCtx
  ): Promise<string> {
    if (cfg.mode === 'off' || cfg.mode === 'read-only') {
      return 'bash is disabled in read-only mode. The user must enable command execution in Chat settings.';
    }

    const wrap = cfg.sandbox
      ? makeSandboxWrap({ writableRoots: [cwd, tmpdir()], denyNetwork: true })
      : null;
    const sandboxRequestedButMissing = cfg.sandbox && wrap === null;

    if (cfg.mode === 'auto') {
      const verdict = this.permissions.evaluate('Bash', command);
      if (verdict === 'deny') return 'This command is blocked by a deny rule.';
      if (verdict !== 'allow') {
        // Not explicitly allowed: auto-run only if provably sandboxed.
        if (wrap) {
          // sandboxed → skip prompt
        } else if (cfg.failClosed) {
          return 'Refused: sandbox unavailable and fail-closed is on.';
        } else {
          const grant = await this.permissions.request({
            streamId: ctx.streamId,
            tool: 'Bash',
            command,
            cwd,
            signal: ctx.signal
          });
          if (grant !== 'allow') return 'The user denied this command.';
        }
      }
    } else {
      // ask mode: deny → deny, allow → allow, otherwise prompt.
      if (sandboxRequestedButMissing && cfg.failClosed) {
        return 'Refused: sandbox unavailable and fail-closed is on.';
      }
      const grant = await this.permissions.request({
        streamId: ctx.streamId,
        tool: 'Bash',
        command,
        cwd,
        signal: ctx.signal
      });
      if (grant !== 'allow') return 'The user denied this command.';
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
    return parts.join('\n');
  }
}
