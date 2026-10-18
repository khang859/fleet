import { describe, expect, it, vi } from 'vitest';
import { runtimeProblems, runtimeWarnings } from '../../../../shared/agency-crew';
import {
  checkRuntime,
  claudeSignedIn,
  versionAtLeast,
  type RuntimeCheckDeps
} from '../availability';

const MANAGED = '/Library/Application Support/ClaudeCode/managed-settings.json';

/** A machine with `claude` and `eva` at the given versions, and these settings files. */
function deps(
  opts: {
    bins?: Record<string, string | null>;
    files?: Record<string, unknown>;
    hookCurrent?: boolean;
    /** What `eva --help` prints. */
    evaHelp?: string;
  } = {}
): RuntimeCheckDeps & { lines: string[] } {
  const bins = opts.bins ?? { claude: '2.1.302 (Claude Code)', eva: 'eva 0.3.0' };
  const lines: string[] = [];
  return {
    lines,
    platform: 'darwin',
    claudeConfigDir: '/home/u/.claude',
    hookCurrent: () => opts.hookCurrent ?? true,
    readJson: async (path) => Promise.resolve(opts.files?.[path] ?? null),
    shell: async (line) => {
      lines.push(line);
      const [cmd, arg, third] = line.split(' ');
      const name = cmd === 'command' ? third : cmd;
      const version = bins[name] as string | null | undefined;
      if (version == null) return Promise.resolve({ code: 1, stdout: '' });
      if (arg === '--help') return Promise.resolve({ code: 0, stdout: opts.evaHelp ?? '' });
      return Promise.resolve({
        code: 0,
        stdout: arg === '-v' ? `/usr/local/bin/${name}` : version
      });
    }
  };
}

describe('versionAtLeast', () => {
  it('compares each part as a number', () => {
    expect(versionAtLeast('2.1.100', '2.1.78')).toBe(true);
    expect(versionAtLeast('2.1.78', '2.1.78')).toBe(true);
    expect(versionAtLeast('2.1.9', '2.1.78')).toBe(false);
    expect(versionAtLeast('3.0', '2.1.78')).toBe(true);
  });
});

describe('checkRuntime', () => {
  it('passes Claude Code that is new enough, with the hook in place', async () => {
    const d = deps();
    const check = await checkRuntime('claude', '/repo', d);
    expect(check).toMatchObject({
      runtime: 'claude',
      path: '/usr/local/bin/claude',
      version: '2.1.302'
    });
    expect(check.checks.map((c) => [c.name, c.state])).toEqual([
      ['Installed', 'ok'],
      ['Version', 'ok'],
      ['Fleet hook', 'ok'],
      ['Hooks on', 'ok'],
      ['No bypass mode', 'ok'],
      ['Vim mode off', 'ok']
    ]);
    // Through the pane's shell, so its PATH and a wrapper script are what is checked.
    expect(d.lines).toEqual(['command -v claude', 'claude --version']);
  });

  it('refuses a runtime that is missing or too old', async () => {
    const missing = await checkRuntime('eva', '/repo', deps({ bins: { eva: null } }));
    expect(missing.checks).toEqual([
      {
        name: 'Installed',
        state: 'fail',
        note: 'eva is not installed, or not on the PATH a terminal pane gets.'
      }
    ]);
    const old = await checkRuntime('claude', '/repo', deps({ bins: { claude: '2.1.69' } }));
    expect(runtimeProblems(old)).toEqual([
      'Claude Code 2.1.69 is older than 2.1.78, the oldest crew run on.'
    ]);
    const eva = await checkRuntime('eva', '/repo', deps({ bins: { eva: 'eva 0.2.0' } }));
    expect(runtimeProblems(eva)).toEqual([
      'eva 0.2.0 is older than 0.3.0, the oldest crew run on.'
    ]);
  });

  it('refuses Claude Code when the hook is out of date or hooks are off', async () => {
    const check = await checkRuntime(
      'claude',
      '/repo',
      deps({
        hookCurrent: false,
        files: { '/repo/.claude/settings.json': { disableAllHooks: true } }
      })
    );
    expect(runtimeProblems(check)).toEqual([
      "Fleet's hook is missing or out of date. Turn on Track Claude Code sessions in Settings > Workspaces.",
      'disableAllHooks is on in /repo/.claude/settings.json, so Fleet cannot follow Claude crew. Turn it off to hire them.'
    ]);
  });

  it('warns about bypass mode and managed vim mode, which the job settings cannot both undo', async () => {
    const check = await checkRuntime(
      'claude',
      '/repo',
      deps({
        files: {
          '/home/u/.claude/settings.json': {
            permissions: { defaultMode: 'bypassPermissions' },
            editorMode: 'vim'
          },
          [MANAGED]: { editorMode: 'vim' }
        }
      })
    );
    expect(runtimeProblems(check)).toEqual([]);
    expect(runtimeWarnings(check)).toEqual([
      '/home/u/.claude/settings.json starts Claude Code in bypass mode. Crew start in default mode, with bypass mode locked off.',
      'Managed settings turn on vim mode, so text Fleet types into a crew pane can run as vim commands. Roles can still be hired.'
    ]);
  });

  it('warns when eva cannot take a hooks file, so its crew cannot report', async () => {
    const help = 'Options:\n      --hooks <FILE>  Hooks for this session\n';
    const takes = await checkRuntime('eva', '/repo', deps({ evaHelp: help }));
    expect(takes.checks.map((c) => [c.name, c.state])).toEqual([
      ['Installed', 'ok'],
      ['Version', 'ok'],
      ['Fleet hook', 'ok'],
      ['Hooks file', 'ok']
    ]);
    const old = await checkRuntime('eva', '/repo', deps({ evaHelp: '--hooks-dir is not it' }));
    expect(runtimeProblems(old)).toEqual([]);
    expect(runtimeWarnings(old)).toEqual([
      'This eva cannot take a hooks file (--hooks), so eva crew send Fleet no events and show as needing you. Update eva once a version with --hooks is out.'
    ]);
  });

  it('reads no eva settings, since they hold its key', async () => {
    const read: string[] = [];
    const d = deps();
    await checkRuntime('eva', '/repo', {
      ...d,
      readJson: async (path) => {
        read.push(path);
        return Promise.resolve(null);
      }
    });
    expect(read).toEqual([]);
  });
});

describe('claudeSignedIn', () => {
  const shell = (stdout: string | null): RuntimeCheckDeps['shell'] =>
    vi
      .fn<RuntimeCheckDeps['shell']>()
      .mockResolvedValue(stdout === null ? null : { code: 0, stdout });

  it('takes only the yes or no the shell passes on', async () => {
    expect(await claudeSignedIn('/repo', {}, shell('yes\n'))).toBe(true);
    expect(await claudeSignedIn('/repo', {}, shell('no\n'))).toBe(false);
    expect(await claudeSignedIn('/repo', {}, shell(''))).toBeNull();
    expect(await claudeSignedIn('/repo', {}, shell(null))).toBeNull();
  });

  it('lets Claude Code read its own login, with the folder a crew pane gets', async () => {
    const run = shell('yes\n');
    await claudeSignedIn('/repo', { CLAUDE_CONFIG_DIR: '/cfg' }, run);
    const [line, cwd, env] = vi.mocked(run).mock.calls[0];
    expect(line).toMatch(/^claude auth status --json 2>\/dev\/null \| awk /);
    expect(cwd).toBe('/repo');
    expect(env).toEqual({ CLAUDE_CONFIG_DIR: '/cfg' });
  });
});
