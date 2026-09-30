import { statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, isAbsolute, join, relative } from 'node:path';
import {
  ORCHESTRATOR_PREFIX,
  type FleetApprover,
  type FleetOpenTabRequest,
  type FleetSpawnArgs,
  type FleetToolOutput
} from '../../../shared/fleet-tools';
import { cleanPrompt, promptProblem } from '../../claude-sessions/input';
import { sessionRef, type FleetHost } from './host';
import type { FleetLedgerStore } from './ledger-store';
import type { ActLimiter } from './limiter';
import type { FleetSpawns } from './spawns';

export type FleetSpawnDeps = {
  host: FleetHost;
  ledger: FleetLedgerStore;
  limiter: ActLimiter;
  spawns: FleetSpawns;
  platform: NodeJS.Platform;
  /** Ask the renderer for an unfocused tab; `null` once it is open, or why not. */
  openTab: (req: Omit<FleetOpenTabRequest, 'requestId'>) => Promise<string | null>;
  worktrees: {
    create(
      repoPath: string,
      branch?: string
    ): Promise<{ worktreePath: string; branchName: string }>;
    remove(worktreePath: string): Promise<void>;
  };
  /** Record the prompt as Fleet's, for the session that will report from this pane. */
  notePaneInput: (paneId: string, text: string) => void;
  newPaneId: () => string;
};

/** The folder asked for, as an absolute path to a directory that exists. */
function checkedFolder(cwd: string): string {
  const expanded =
    cwd === '~' ? homedir() : cwd.startsWith('~/') ? join(homedir(), cwd.slice(2)) : cwd;
  if (!isAbsolute(expanded))
    throw new Error(`Not started: give cwd as an absolute path, not "${cwd}".`);
  try {
    if (statSync(expanded).isDirectory()) return expanded;
  } catch {
    // Reported below, the same as a file.
  }
  throw new Error(`Not started: ${expanded} is not a folder.`);
}

/**
 * `fleet_spawn`: open a new tab running Claude Code with a prompt, optionally
 * in a new worktree, after the user says yes, and write it in the ledger.
 *
 * Nothing is created before the user answers: the worktree, the tab and the
 * pane all come after. The tab opens without taking focus, and the prompt goes
 * to the pane's PTY through `FleetSpawns`, never through the layout.
 */
export async function spawnSession(
  deps: FleetSpawnDeps,
  threadId: string,
  paneCwd: string,
  args: FleetSpawnArgs,
  approve: FleetApprover
): Promise<FleetToolOutput> {
  // Windows is also the only place a WSL profile exists.
  if (deps.platform === 'win32') {
    throw new Error('Not started: fleet_spawn is not available on Windows yet.');
  }
  const cwd = checkedFolder(args.cwd ?? paneCwd);
  if (args.branch !== undefined && args.worktree !== true) {
    throw new Error('Not started: branch names the branch of a new worktree, so set worktree too.');
  }
  let repo: string | null = null;
  if (args.worktree === true) {
    try {
      repo = (await deps.host.git(cwd, ['rev-parse', '--show-toplevel'])).stdout.trim();
    } catch {
      throw new Error(
        `Not started: ${cwd} is not in a git repository, so it cannot have a worktree.`
      );
    }
  }
  const text = cleanPrompt(`${ORCHESTRATOR_PREFIX} ${args.prompt}`);
  const problem = promptProblem(text);
  if (problem !== null) throw new Error(problem.replace('Not sent', 'Not started'));
  const limited = deps.limiter.refusal(threadId, deps.host.now());
  if (limited !== null) throw new Error(limited);

  const where =
    repo === null
      ? cwd
      : `a new worktree of ${repo}${args.branch === undefined ? '' : ` on branch ${args.branch}`}`;
  const allowed = await approve({ action: 'spawn', sessionId: null, target: where, prompt: text });
  if (!allowed) throw new Error('The user did not let this session be started.');

  let folder = cwd;
  let worktree: FleetOpenTabRequest['worktree'] = null;
  if (repo !== null) {
    const made = await deps.worktrees.create(repo, args.branch);
    worktree = { path: made.worktreePath, branch: made.branchName };
    // The same place within the new checkout as within the old one.
    folder = join(made.worktreePath, relative(repo, cwd));
  }

  const paneId = deps.newPaneId();
  const at = deps.host.now();
  deps.spawns.add({ paneId, cwd: folder, prompt: text, at });
  deps.notePaneInput(paneId, text);
  const label = worktree?.branch ?? basename(folder);
  const error = await deps.openTab({ paneId, cwd: folder, label, worktree });
  if (error !== null) {
    deps.spawns.settle(paneId);
    if (worktree !== null) await deps.worktrees.remove(worktree.path).catch(() => {});
    throw new Error(`Not started: ${error}`);
  }

  deps.limiter.note(threadId, at);
  const ref = sessionRef(paneId);
  const entry = deps.ledger.addEntry(threadId, {
    action: 'spawn',
    ref,
    paneId,
    sessionId: null,
    epoch: null,
    prompt: text,
    why: args.why,
    expect: args.expect,
    at,
    started: false
  });
  const place = worktree === null ? folder : `${folder}, on the new branch ${worktree.branch}`;
  return {
    text: [
      `Started a Claude Code session in a new tab (ref ${ref}) in ${place}, as ledger entry ${entry.id}.`,
      "It shows as starting until Claude Code reports. If it stays that way, it is probably waiting at Claude Code's folder trust dialog, which only the user can answer."
    ].join(' '),
    summary: `started ${ref}`
  };
}
