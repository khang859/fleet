import { spawn } from 'child_process';
import { mkdirSync, writeFileSync, openSync, closeSync } from 'fs';
import { join, dirname } from 'path';
import { createLogger } from '../logger';

const log = createLogger('kanban-spawn');

export interface WorkerTaskInfo {
  id: string;
  title: string;
  body: string;
  assignee: string | null;
  modelOverride: string | null;
}

export interface BuildWorkerInput {
  task: WorkerTaskInfo;
  workspace: string;
  mcpPort: number;
  runToken: string;
  logPath: string;
}

export interface WorkerInvocation {
  command: string;
  args: string[];
  env: Record<string, string>;
  cwd: string;
  logPath: string;
}

/** Computes the rune invocation and writes the scoped mcp.json into the workspace. */
export function buildWorkerInvocation(input: BuildWorkerInput): WorkerInvocation {
  const runeDir = join(input.workspace, '.rune');
  mkdirSync(runeDir, { recursive: true });
  const mcpConfigPath = join(runeDir, 'mcp.json');
  const url = `http://127.0.0.1:${input.mcpPort}/mcp?run=${input.runToken}`;
  writeFileSync(
    mcpConfigPath,
    JSON.stringify({ servers: { kanban: { type: 'http', url } } }, null, 2)
  );

  const prompt = `work kanban task ${input.task.id}: ${input.task.title}\n\n${input.task.body}`;
  const args = ['--prompt', prompt];
  if (input.task.assignee) args.push('--profile', input.task.assignee);
  if (input.task.modelOverride) args.push('--model', input.task.modelOverride);

  return {
    command: 'rune',
    args,
    cwd: input.workspace,
    logPath: input.logPath,
    env: {
      RUNE_MCP_CONFIG: mcpConfigPath,
      FLEET_KANBAN_TASK: input.task.id,
      FLEET_KANBAN_RUN: input.runToken
    }
  };
}

/** Spawns the worker as a detached child; returns its pid (or undefined on failure). */
export function spawnRuneWorker(input: BuildWorkerInput): number | undefined {
  const inv = buildWorkerInvocation(input);
  mkdirSync(dirname(inv.logPath), { recursive: true });
  const out = openSync(inv.logPath, 'a');
  const child = spawn(inv.command, inv.args, {
    cwd: inv.cwd,
    env: { ...process.env, ...inv.env },
    detached: true,
    stdio: ['ignore', out, out]
  });
  // The child has its own dup of the fd; close the parent's copy to avoid leaking fds across spawns.
  closeSync(out);
  child.unref();
  log.info('spawned rune worker', { taskId: input.task.id, pid: child.pid });
  return child.pid;
}
