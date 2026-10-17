import { describe, expect, it } from 'vitest';
import { checkRuntime, versionAtLeast, type RuntimeCheckDeps } from '../availability';

const MANAGED = '/Library/Application Support/ClaudeCode/managed-settings.json';

/** A machine with `claude` and `eva` at the given versions, and these settings files. */
function deps(
  opts: {
    bins?: Record<string, string | null>;
    files?: Record<string, unknown>;
    hookCurrent?: boolean;
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
    expect(await checkRuntime('claude', '/repo', d)).toEqual({
      runtime: 'claude',
      path: '/usr/local/bin/claude',
      version: '2.1.302',
      problems: [],
      warnings: []
    });
    // Through the pane's shell, so its PATH and a wrapper script are what is checked.
    expect(d.lines).toEqual(['command -v claude', 'claude --version']);
  });

  it('refuses a runtime that is missing or too old', async () => {
    const missing = await checkRuntime('eva', '/repo', deps({ bins: { eva: null } }));
    expect(missing.problems).toEqual([
      'eva is not installed, or not on the PATH a terminal pane gets.'
    ]);
    const old = await checkRuntime('claude', '/repo', deps({ bins: { claude: '2.1.69' } }));
    expect(old.problems).toEqual([
      'Claude Code 2.1.69 is older than 2.1.78, the oldest crew run on.'
    ]);
    const eva = await checkRuntime('eva', '/repo', deps({ bins: { eva: 'eva 0.2.0' } }));
    expect(eva.problems).toEqual(['eva 0.2.0 is older than 0.3.0, the oldest crew run on.']);
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
    expect(check.problems).toEqual([
      "Fleet's Claude Code hook is missing or out of date. Turn on Track Claude Code sessions in Settings > Workspaces.",
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
    expect(check.problems).toEqual([]);
    expect(check.warnings).toEqual([
      'Managed settings turn on vim mode, so text Fleet types into a crew pane can run as vim commands.',
      '/home/u/.claude/settings.json starts Claude Code in bypass mode. Crew start in default mode, with bypass mode locked off.'
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
