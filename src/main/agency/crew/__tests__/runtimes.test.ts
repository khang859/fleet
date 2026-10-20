import { describe, expect, it } from 'vitest';
import { fleetHookEntries } from '../../../claude-sessions/hook-installer';
import { claudeJobSettings, evaJobPermissions } from '../job-settings';
import {
  crewLaunch,
  evaHooksToml,
  testLaunch,
  TYPED_BRIEF_MAX_CHARS,
  type CrewHire,
  type TestStart
} from '../runtimes';

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
  resume: false,
  dir: '/fleet/agency/jobs/42/crew/build-2',
  addDirs: [],
  label: 'builder 2',
  hooks: HOOKS,
  hookCommand: HOOK_COMMAND,
  permissionMode: 'default',
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
      FLEET_CREW_STATUS: 'Fleet crew · j42 · builder 2',
      FLEET_SPAWN_PROMPT: '[admiral] Build the toggle.\nKeep it small.'
    });
    expect(launch.prompt).toBe('[admiral] Build the toggle.\nKeep it small.');
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
    expect(JSON.parse(files[0].text)).toEqual(
      claudeJobSettings(HOOKS, { hookCommand: HOOK_COMMAND })
    );
  });

  it('gives the member a status line that runs the hook binary, for its spend', () => {
    const settings = JSON.parse(crewLaunch(hire()).files[0].text) as Record<string, unknown>;
    expect(settings.statusLine).toEqual({
      type: 'command',
      command: `${HOOK_COMMAND} statusline`,
      padding: 0
    });
  });

  it('goes on with the same conversation after a restart', () => {
    const { cmd, env } = crewLaunch(hire({ resume: true, brief: 'Fleet restarted. Go on.' }));
    expect(cmd).toMatch(/^claude --resume "\$FLEET_CREW_SESSION_ID" --settings /);
    expect(cmd).not.toContain('--session-id');
    expect(env.FLEET_CREW_SESSION_ID).toBe('0b7e4c2a-9f1d-4a51-8c3e-2d6f0a9b1c7e');
    expect(env.FLEET_SPAWN_PROMPT).toBe('[admiral] Fleet restarted. Go on.');
  });
});

describe('long briefs', () => {
  const long = `${'Do the thing. '.repeat(400)}Then stop.`;

  it('types a brief of up to the typed size as it is', () => {
    const brief = 'x'.repeat(TYPED_BRIEF_MAX_CHARS);
    expect(crewLaunch(hire({ brief })).prompt).toBe(`[admiral] ${brief}`);
  });

  it('puts a longer brief in a file the member may read, and points to it', () => {
    const launch = crewLaunch(hire({ brief: long }));
    const path = '/fleet/agency/jobs/42/crew/build-2/brief.md';
    expect(launch.prompt).toBe(
      `[admiral] Your brief for step build is in ${path}. Read all of it first, then do what it says.`
    );
    expect(launch.env.FLEET_SPAWN_PROMPT).toBe(launch.prompt);
    expect(launch.files).toContainEqual({ path, text: `${long}\n` });
    expect(launch.cmd).toMatch(/^claude --add-dir "\$FLEET_CREW_ADD_DIR_0" --session-id/);
    expect(launch.env.FLEET_CREW_ADD_DIR_0).toBe('/fleet/agency/jobs/42/crew/build-2');
  });

  it('does the same for eva, which reads the file from its folder', () => {
    const launch = crewLaunch(hire({ runtime: 'eva', brief: long }));
    expect(launch.prompt).toContain('/fleet/agency/jobs/42/crew/build-2/brief.md');
    expect(launch.files.map((f) => f.path)).toEqual([
      '/fleet/agency/jobs/42/crew/build-2/role.md',
      '/fleet/agency/jobs/42/crew/build-2/brief.md'
    ]);
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
      'eva --session-id "$FLEET_CREW_SESSION_ID" --instructions "$FLEET_CREW_ROLE" --name "$FLEET_CREW_NAME" --goal "$FLEET_CREW_GOAL" --no-ask-user -- "$FLEET_SPAWN_PROMPT"'
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

  it('resumes by id, with the instructions the conversation already saved', () => {
    const launch = crewLaunch(hire({ runtime: 'eva', resume: true }));
    expect(launch.cmd).toBe(
      'eva --resume "$FLEET_CREW_SESSION_ID" --name "$FLEET_CREW_NAME" --goal "$FLEET_CREW_GOAL" --no-ask-user -- "$FLEET_SPAWN_PROMPT"'
    );
    expect(Object.keys(launch.env)).not.toContain('FLEET_CREW_ROLE');
    expect(launch.files).toEqual([]);
  });

  it('keeps the saved model when the step names none', () => {
    expect(Object.keys(crewLaunch(hire({ runtime: 'eva' })).env)).not.toContain('CHAT_MODEL');
  });

  it("reports through Fleet's hook in a hooks file of its own, never eva's config.toml", () => {
    for (const resume of [false, true]) {
      const launch = crewLaunch(hire({ runtime: 'eva', resume, evaHook: HOOK_COMMAND }));
      expect(launch.cmd).toContain(' --hooks "$FLEET_CREW_HOOKS" ');
      const path = '/fleet/agency/jobs/42/crew/build-2/eva-hooks.toml';
      expect(launch.env.FLEET_CREW_HOOKS).toBe(path);
      expect(launch.files.find((f) => f.path === path)?.text).toBe(
        `${evaHooksToml(HOOK_COMMAND)}\n`
      );
      expect(JSON.stringify(launch)).not.toContain('config.toml');
    }
    const toml = evaHooksToml("'/h/fleet-hook'");
    expect(toml.match(/^\[\[hooks\.(\w+)\]\]$/gm)).toEqual(
      [
        'SessionStart',
        'UserPromptSubmit',
        'PreToolUse',
        'PermissionRequest',
        'PostToolUse',
        'Stop',
        'StopFailure',
        'SubagentStop',
        'PreCompact',
        'SessionEnd'
      ].map((e) => `[[hooks.${e}]]`)
    );
    expect(toml).toContain(
      `[[hooks.PermissionRequest]]\ncommand = "'/h/fleet-hook' --runtime eva"\ntimeout = 86400\n`
    );
    expect(evaHooksToml('"/a b/fleet-hook"')).toContain(
      'command = "\\"/a b/fleet-hook\\" --runtime eva"'
    );
  });

  it('starts with no hooks file for an eva that cannot take one', () => {
    const launch = crewLaunch(hire({ runtime: 'eva' }));
    expect(launch.cmd).not.toContain('--hooks');
    expect(launch.env.FLEET_CREW_HOOKS).toBeUndefined();
  });

  it("never sets eva's permissions, and never starts a prompt with a slash command", () => {
    for (const resume of [false, true]) {
      const launch = crewLaunch(hire({ runtime: 'eva', resume, brief: '/clear then build' }));
      const words = launch.cmd.split(' ');
      for (const flag of ['-b', '--bypass', '--permissions', '-p', '--print']) {
        expect(words).not.toContain(flag);
      }
      expect(launch.prompt.startsWith('/')).toBe(false);
    }
    const test = testLaunch({
      runtime: 'eva',
      sessionId: 's',
      dir: '/t',
      hooks: HOOKS,
      evaHook: HOOK_COMMAND,
      permissionMode: 'default',
      prompt: 'Reply.'
    });
    expect(test.cmd).toBe(
      'eva --session-id "$FLEET_CREW_SESSION_ID" --name "$FLEET_CREW_NAME" --no-ask-user --hooks "$FLEET_CREW_HOOKS" -- "$FLEET_SPAWN_PROMPT"'
    );
    expect(test.files.map((f) => f.path)).toEqual(['/t/eva-hooks.toml']);
  });
});

const test = (patch: Partial<TestStart> = {}): TestStart => ({
  runtime: 'claude',
  sessionId: 's',
  dir: '/t',
  hooks: HOOKS,
  permissionMode: 'default',
  prompt: 'Reply.',
  ...patch
});

const settingsOf = (launch: { files: Array<{ path: string; text: string }> }) =>
  JSON.parse(launch.files.find((f) => f.path.endsWith('claude-settings.json'))?.text ?? '{}') as {
    permissions: { deny: string[]; disableBypassPermissionsMode: string };
    autoMode?: { hard_deny: string[] };
  };

describe('permission modes', () => {
  it('starts Claude crew in auto mode, with the guardrails in the job file', () => {
    for (const resume of [false, true]) {
      const launch = crewLaunch(hire({ permissionMode: 'auto', resume }));
      expect(launch.cmd).toContain(' --permission-mode auto ');
      const settings = settingsOf(launch);
      expect(settings.permissions).toEqual({
        deny: [
          'AskUserQuestion',
          'Bash(git push*)',
          'Bash(gh pr create*)',
          'Bash(gh pr merge*)',
          'Bash(gh pr review*)'
        ],
        disableBypassPermissionsMode: 'disable'
      });
      expect(settings.autoMode?.hard_deny[0]).toBe('$defaults');
      expect(settings).toEqual(claudeJobSettings(HOOKS, { hookCommand: HOOK_COMMAND, auto: true }));
    }
  });

  it('starts Claude crew in default mode for any other value, bypass included', () => {
    for (const permissionMode of ['default', 'bypass'] as const) {
      const launch = crewLaunch(hire({ permissionMode }));
      expect(launch.cmd).toContain(' --permission-mode default ');
      expect(launch.cmd).not.toMatch(/bypass/i);
      expect(settingsOf(launch)).toEqual(claudeJobSettings(HOOKS, { hookCommand: HOOK_COMMAND }));
    }
  });

  it('starts eva crew with -b and the deny file in bypass mode, on hire and on resume', () => {
    const path = '/fleet/agency/jobs/42/crew/build-2/eva-permissions.toml';
    for (const resume of [false, true]) {
      const launch = crewLaunch(
        hire({ runtime: 'eva', permissionMode: 'bypass', resume, evaHook: HOOK_COMMAND })
      );
      expect(launch.cmd).toContain(
        ' --hooks "$FLEET_CREW_HOOKS" -b --permissions "$FLEET_CREW_PERMISSIONS" --name '
      );
      expect(launch.env.FLEET_CREW_PERMISSIONS).toBe(path);
      expect(launch.files).toContainEqual({ path, text: evaJobPermissions() });
    }
  });

  it('starts eva crew as always for any other value, auto included', () => {
    for (const permissionMode of ['default', 'auto'] as const) {
      for (const resume of [false, true]) {
        const launch = crewLaunch(hire({ runtime: 'eva', permissionMode, resume }));
        const plain = crewLaunch(hire({ runtime: 'eva', resume }));
        expect(launch).toEqual(plain);
        expect(launch.cmd.split(' ')).not.toContain('-b');
        expect(launch.cmd).not.toContain('--permissions');
        expect(launch.files.map((f) => f.path)).not.toContain(
          '/fleet/agency/jobs/42/crew/build-2/eva-permissions.toml'
        );
        expect(launch.env.FLEET_CREW_PERMISSIONS).toBeUndefined();
      }
    }
  });

  it('tests each runtime in the mode its crew start in', () => {
    const auto = testLaunch(test({ permissionMode: 'auto' }));
    expect(auto.cmd).toContain(' --permission-mode auto ');
    expect(settingsOf(auto)).toEqual(claudeJobSettings(HOOKS, { auto: true }));
    for (const permissionMode of ['default', 'bypass'] as const) {
      const plain = testLaunch(test({ permissionMode }));
      expect(plain.cmd).toBe(
        'claude --session-id "$FLEET_CREW_SESSION_ID" --settings "$FLEET_CREW_SETTINGS" --permission-mode default -- "$FLEET_SPAWN_PROMPT"'
      );
      expect(settingsOf(plain)).toEqual(claudeJobSettings(HOOKS));
    }

    const bypass = testLaunch(test({ runtime: 'eva', permissionMode: 'bypass' }));
    expect(bypass.cmd).toBe(
      'eva --session-id "$FLEET_CREW_SESSION_ID" --name "$FLEET_CREW_NAME" --no-ask-user -b --permissions "$FLEET_CREW_PERMISSIONS" -- "$FLEET_SPAWN_PROMPT"'
    );
    expect(bypass.files).toEqual([{ path: '/t/eva-permissions.toml', text: evaJobPermissions() }]);
    for (const permissionMode of ['default', 'auto'] as const) {
      const plain = testLaunch(test({ runtime: 'eva', permissionMode }));
      expect(plain.cmd).toBe(
        'eva --session-id "$FLEET_CREW_SESSION_ID" --name "$FLEET_CREW_NAME" --no-ask-user -- "$FLEET_SPAWN_PROMPT"'
      );
      expect(plain.files).toEqual([]);
    }
  });
});
