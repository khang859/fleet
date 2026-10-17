import { describe, expect, it } from 'vitest';
import { fleetHookEntries } from '../../../claude-sessions/hook-installer';
import { claudeJobSettings } from '../job-settings';
import { crewLaunch, type CrewHire } from '../runtimes';

const HOOKS = fleetHookEntries('/home/u/.claude');
const HOOK_COMMAND = HOOKS.UserPromptSubmit[0].hooks[0].command;

const hire = (patch: Partial<CrewHire> = {}): CrewHire => ({
  jobId: 42,
  stepId: 'build',
  member: 2,
  runtime: 'claude',
  rolePrompt: '- You build what the brief asks.',
  brief: 'Build the toggle.\r\nKeep it small.',
  sessionId: '0b7e4c2a-9f1d-4a51-8c3e-2d6f0a9b1c7e',
  dir: '/fleet/agency/jobs/42/crew/build-2',
  addDirs: [],
  hooks: HOOKS,
  ...patch
});

describe('claude launch', () => {
  it('runs the interactive TUI with every value from the environment', () => {
    const launch = crewLaunch(hire({ model: 'sonnet', addDirs: ['/briefs', '/specs'] }));
    expect(launch.cmd).toBe(
      'claude --add-dir "$FLEET_CREW_ADD_DIR_0" "$FLEET_CREW_ADD_DIR_1" --session-id "$FLEET_CREW_SESSION_ID" --settings "$FLEET_CREW_SETTINGS" --permission-mode default --append-system-prompt "$FLEET_CREW_ROLE" --model "$FLEET_CREW_MODEL" -- "$FLEET_SPAWN_PROMPT"'
    );
    expect(launch.env).toEqual({
      FLEET_CREW_ADD_DIR_0: '/briefs',
      FLEET_CREW_ADD_DIR_1: '/specs',
      FLEET_CREW_SESSION_ID: '0b7e4c2a-9f1d-4a51-8c3e-2d6f0a9b1c7e',
      FLEET_CREW_SETTINGS: '/fleet/agency/jobs/42/crew/build-2/claude-settings.json',
      FLEET_CREW_ROLE: '- You build what the brief asks.',
      FLEET_CREW_MODEL: 'sonnet',
      FLEET_SPAWN_PROMPT: 'Build the toggle.\nKeep it small.'
    });
    expect(launch.prompt).toBe('Build the toggle.\nKeep it small.');
  });

  it('leaves out --model and --add-dir when there is nothing to give them', () => {
    const { cmd, env } = crewLaunch(hire());
    expect(cmd).not.toContain('--model');
    expect(cmd).not.toContain('--add-dir');
    expect(Object.keys(env)).not.toContain('FLEET_CREW_MODEL');
  });

  it('never prints, never runs the SDK, and never sets an ANTHROPIC_ variable', () => {
    for (const patch of [{}, { model: 'opus' }, { addDirs: ['/x'] }]) {
      const { cmd, env } = crewLaunch(hire(patch));
      const words = cmd.split(' ');
      expect(words).not.toContain('-p');
      expect(words).not.toContain('--print');
      expect(cmd).not.toMatch(/dangerously|bypass/i);
      expect(Object.keys(env).filter((k) => k.startsWith('ANTHROPIC_'))).toEqual([]);
    }
  });

  it('writes the job settings file into the member folder, not a worktree', () => {
    const { files } = crewLaunch(hire());
    expect(files.map((f) => f.path)).toEqual([
      '/fleet/agency/jobs/42/crew/build-2/claude-settings.json'
    ]);
    expect(JSON.parse(files[0].text)).toEqual(claudeJobSettings(HOOKS));
  });
});

describe('job settings', () => {
  it('denies AskUserQuestion, locks bypass mode off, and repeats the global hooks', () => {
    const text = JSON.stringify(claudeJobSettings(HOOKS), null, 2).replaceAll(
      JSON.stringify(HOOK_COMMAND).slice(1, -1),
      '<fleet hook>'
    );
    expect(text).toMatchSnapshot();
  });

  it('uses the same command string as the global install, so Claude Code runs it once', () => {
    const settings = claudeJobSettings(HOOKS) as { hooks: typeof HOOKS };
    const commands = Object.values(settings.hooks).flatMap((entries) =>
      entries.flatMap((e) => e.hooks.map((h) => h.command))
    );
    expect(new Set(commands)).toEqual(new Set([HOOK_COMMAND]));
    expect(Object.keys(settings.hooks)).toEqual(
      expect.arrayContaining(['PermissionRequest', 'StopFailure', 'SessionStart', 'Stop'])
    );
  });
});

describe('eva launch', () => {
  it('runs eva with the role as instructions, a goal, no question tool, and never -b', () => {
    const launch = crewLaunch(hire({ runtime: 'eva', model: 'qwen3-coder' }));
    expect(launch.cmd).toBe(
      'eva --session-id "$FLEET_CREW_SESSION_ID" --name "$FLEET_CREW_NAME" --instructions "$FLEET_CREW_ROLE" --goal "$FLEET_CREW_GOAL" --no-ask-user -- "$FLEET_SPAWN_PROMPT"'
    );
    expect(launch.cmd.split(' ')).not.toContain('-b');
    expect(launch.cmd).not.toContain('--bypass');
    expect(launch.env).toMatchObject({
      FLEET_CREW_NAME: 'j42 build-2',
      FLEET_CREW_ROLE: '/fleet/agency/jobs/42/crew/build-2/role.md',
      CHAT_MODEL: 'qwen3-coder'
    });
    expect(launch.files).toEqual([
      {
        path: '/fleet/agency/jobs/42/crew/build-2/role.md',
        text: '- You build what the brief asks.'
      }
    ]);
  });

  it('keeps the saved model when the step names none', () => {
    expect(Object.keys(crewLaunch(hire({ runtime: 'eva' })).env)).not.toContain('CHAT_MODEL');
  });
});
