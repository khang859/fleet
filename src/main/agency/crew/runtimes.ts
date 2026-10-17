import { join } from 'node:path';
import { jobDisplayId } from '../../../shared/agency';
import type { CrewRuntime } from '../../../shared/agency-crew';
import { SPAWN_PROMPT_ENV } from '../../agent/fleet/spawns';
import type { HookEntry } from '../../claude-sessions/hook-installer';
import { cleanPrompt } from '../../claude-sessions/input';
import { claudeJobSettings } from './job-settings';

/** One crew member about to be hired: who it is, and what it works on. */
export type CrewHire = {
  jobId: number;
  stepId: string;
  /** 1 for the first member of a step, 2 for the second of a `count: 2` step. */
  member: number;
  runtime: CrewRuntime;
  /** The step's model, else the role's; unset takes the runtime's default. */
  model?: string;
  /** The role's body, which the member keeps as part of its system prompt. */
  rolePrompt: string;
  brief: string;
  /** The session id Fleet picks, so the session maps to the member and can be resumed. */
  sessionId: string;
  /** This member's folder in the job folder, for the files its command reads. Never a worktree. */
  dir: string;
  /** Folders besides the working folder the member may use. */
  addDirs: string[];
  /** Fleet's hook entries, as the global install in the member's Claude config folder writes them. */
  hooks: Record<string, HookEntry[]>;
};

/**
 * How a crew pane starts. `cmd` is a shell line that names every value it
 * needs as `"$VAR"`, and `env` holds the values, so nothing needs quoting for
 * whichever shell the pane runs. `files` are written before the pane starts.
 * `prompt` is the first message, which the prompt check compares with what
 * the session reports.
 */
export type CrewLaunch = {
  cmd: string;
  env: Record<string, string>;
  files: Array<{ path: string; text: string }>;
  prompt: string;
};

const ENV = {
  session: 'FLEET_CREW_SESSION_ID',
  settings: 'FLEET_CREW_SETTINGS',
  role: 'FLEET_CREW_ROLE',
  model: 'FLEET_CREW_MODEL',
  name: 'FLEET_CREW_NAME',
  goal: 'FLEET_CREW_GOAL',
  addDir: (i: number) => `FLEET_CREW_ADD_DIR_${i}`
} as const;

const ref = (name: string): string => `"$${name}"`;

/**
 * Claude Code as the user runs it, with interactive flags only: never `-p`
 * or `--print`, never an `ANTHROPIC_*` variable, and nothing written to the
 * Claude config folder. `--add-dir` takes several folders, so it goes first,
 * where the next flag ends its list. `--` ends the options, so a brief that
 * starts with a dash is still the prompt.
 */
function claudeLaunch(hire: CrewHire, prompt: string): CrewLaunch {
  const settings = join(hire.dir, 'claude-settings.json');
  const env: Record<string, string> = {
    [ENV.session]: hire.sessionId,
    [ENV.settings]: settings,
    [ENV.role]: hire.rolePrompt,
    [SPAWN_PROMPT_ENV]: prompt
  };
  const args: string[] = [];
  if (hire.addDirs.length > 0) {
    hire.addDirs.forEach((dir, i) => (env[ENV.addDir(i)] = dir));
    args.push('--add-dir', ...hire.addDirs.map((_, i) => ref(ENV.addDir(i))));
  }
  args.push(
    '--session-id',
    ref(ENV.session),
    '--settings',
    ref(ENV.settings),
    '--permission-mode',
    'default',
    '--append-system-prompt',
    ref(ENV.role)
  );
  if (hire.model !== undefined) {
    env[ENV.model] = hire.model;
    args.push('--model', ref(ENV.model));
  }
  return {
    cmd: ['claude', ...args, '--', ref(SPAWN_PROMPT_ENV)].join(' '),
    env,
    files: [
      { path: settings, text: `${JSON.stringify(claudeJobSettings(hire.hooks), null, 2)}\n` }
    ],
    prompt
  };
}

/**
 * eva in the same way: the role as instructions kept with the conversation,
 * a goal that keeps it working until the step is done, and no question tool.
 * Never `-b`, so eva asks before each change as the user's settings say. Its
 * model comes from `CHAT_MODEL`, which takes the place of the saved one.
 */
function evaLaunch(hire: CrewHire, prompt: string): CrewLaunch {
  const instructions = join(hire.dir, 'role.md');
  const env: Record<string, string> = {
    [ENV.session]: hire.sessionId,
    [ENV.name]: `${jobDisplayId(hire.jobId)} ${hire.stepId}-${hire.member}`,
    [ENV.role]: instructions,
    [ENV.goal]: `Step ${hire.stepId} of ${jobDisplayId(hire.jobId)} is done as its brief asks, with the work committed.`,
    [SPAWN_PROMPT_ENV]: prompt
  };
  if (hire.model !== undefined) env.CHAT_MODEL = hire.model;
  const cmd = [
    'eva',
    '--session-id',
    ref(ENV.session),
    '--name',
    ref(ENV.name),
    '--instructions',
    ref(ENV.role),
    '--goal',
    ref(ENV.goal),
    '--no-ask-user',
    '--',
    ref(SPAWN_PROMPT_ENV)
  ].join(' ');
  return { cmd, env, files: [{ path: instructions, text: hire.rolePrompt }], prompt };
}

const LAUNCH: Record<CrewRuntime, (hire: CrewHire, prompt: string) => CrewLaunch> = {
  claude: claudeLaunch,
  eva: evaLaunch
};

/** How a crew member's pane starts on its runtime, with its brief as the first message. */
export function crewLaunch(hire: CrewHire): CrewLaunch {
  return LAUNCH[hire.runtime](hire, cleanPrompt(hire.brief));
}
