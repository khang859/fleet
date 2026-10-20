import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { Captured } from '../../exec';
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
    /** What eva's rules files hold, by path, for the `lock_bypass` read. */
    evaRules?: Record<string, string>;
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
    shell: async (line, cwd) => {
      lines.push(line);
      if (line.includes('lock_bypass')) return Promise.resolve(evaRules(line, cwd, opts.evaRules));
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

/** The `lock_bypass` read, run for real by `sh` over files written to a scratch folder. */
function evaRules(line: string, cwd: string, rules: Record<string, string> = {}): Captured {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'fleet-eva-rules-')));
  try {
    for (const [path, text] of Object.entries(rules)) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), text);
    }
    mkdirSync(join(root, cwd), { recursive: true });
    const out = spawnSync('sh', ['-c', line], {
      cwd: join(root, cwd),
      env: { PATH: process.env.PATH, HOME: join(root, 'home/u') },
      encoding: 'utf8'
    });
    return { code: out.status ?? 1, stdout: out.stdout.replaceAll(root, '') };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
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
    const check = await checkRuntime('claude', '/repo', 'default', d);
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
    const missing = await checkRuntime('eva', '/repo', 'default', deps({ bins: { eva: null } }));
    expect(missing.checks).toEqual([
      {
        name: 'Installed',
        state: 'fail',
        note: 'eva is not installed, or not on the PATH a terminal pane gets.'
      }
    ]);
    const old = await checkRuntime(
      'claude',
      '/repo',
      'default',
      deps({ bins: { claude: '2.1.69' } })
    );
    expect(runtimeProblems(old)).toEqual([
      'Claude Code 2.1.69 is older than 2.1.78, the oldest crew run on.'
    ]);
    const eva = await checkRuntime('eva', '/repo', 'default', deps({ bins: { eva: 'eva 0.2.0' } }));
    expect(runtimeProblems(eva)).toEqual([
      'eva 0.2.0 is older than 0.3.0, the oldest crew run on.'
    ]);
  });

  it('refuses Claude Code when the hook is out of date or hooks are off', async () => {
    const check = await checkRuntime(
      'claude',
      '/repo',
      'default',
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
      'default',
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
      '/home/u/.claude/settings.json starts Claude Code in bypass mode. Crew never start in bypass mode, with bypass mode locked off.',
      'Managed settings turn on vim mode, so text Fleet types into a crew pane can run as vim commands. Roles can still be hired.'
    ]);
  });

  it('warns when eva cannot take a hooks file, so its crew cannot report', async () => {
    const help = 'Options:\n      --hooks <FILE>  Hooks for this session\n';
    const takes = await checkRuntime('eva', '/repo', 'default', deps({ evaHelp: help }));
    expect(takes.checks.map((c) => [c.name, c.state])).toEqual([
      ['Installed', 'ok'],
      ['Version', 'ok'],
      ['Fleet hook', 'ok'],
      ['Hooks file', 'ok']
    ]);
    const old = await checkRuntime(
      'eva',
      '/repo',
      'default',
      deps({ evaHelp: '--hooks-dir is not it' })
    );
    expect(runtimeProblems(old)).toEqual([]);
    expect(runtimeWarnings(old)).toEqual([
      'This eva cannot take a hooks file (--hooks), so eva crew send Fleet no events and show as needing you. Update eva once a version with --hooks is out.'
    ]);
  });

  it('warns in auto mode when a settings file turns auto mode off', async () => {
    const files = {
      '/home/u/.claude/settings.json': { disableAutoMode: 'disable' },
      '/repo/.claude/settings.local.json': { permissions: { disableAutoMode: 'disable' } }
    };
    const auto = await checkRuntime('claude', '/repo', 'auto', deps({ files }));
    expect(auto.checks.map((c) => c.name)).toEqual([
      'Installed',
      'Version',
      'Fleet hook',
      'Hooks on',
      'No bypass mode',
      'Auto mode available',
      'Vim mode off'
    ]);
    expect(runtimeProblems(auto)).toEqual([]);
    expect(runtimeWarnings(auto)).toEqual([
      '/home/u/.claude/settings.json turns off auto mode, so Claude crew start in Manual mode and ask as before. /repo/.claude/settings.local.json turns off auto mode, so Claude crew start in Manual mode and ask as before.'
    ]);

    const clear = await checkRuntime('claude', '/repo', 'auto', deps());
    expect(clear.checks.find((c) => c.name === 'Auto mode available')).toEqual({
      name: 'Auto mode available',
      state: 'ok',
      note: 'Crew run routine work without asking.'
    });

    const off = await checkRuntime('claude', '/repo', 'default', deps({ files }));
    expect(off.checks.map((c) => c.name)).not.toContain('Auto mode available');
    expect(runtimeWarnings(off)).toEqual([]);
  });

  it('fails eva bypass when a rules file locks bypass, in that mode only', async () => {
    const config = 'api_key = "sk-secret"\nmodel = "m"\n\n[permissions]\nlock_bypass = true\n';
    const project = '[permissions]\ndeny = ["bash(rm*)"]\nlock_bypass = true # no\n';
    for (const [path, text, where] of [
      ['home/u/.eva/config.toml', config, '/home/u/.eva/config.toml'],
      ['repo/.eva/settings.toml', project, '/repo/.eva/settings.toml']
    ]) {
      const d = deps({ evaRules: { [path]: text } });
      const bypass = await checkRuntime('eva', '/repo', 'bypass', d);
      expect(runtimeProblems(bypass)).toEqual([
        `lock_bypass in ${where} stops eva crew starting in bypass mode. Turn eva bypass off in Settings, or remove the lock.`
      ]);
      // The key never leaves the shell.
      expect(JSON.stringify(bypass)).not.toContain('sk-secret');

      const plain = deps({ evaRules: { [path]: text } });
      const off = await checkRuntime('eva', '/repo', 'default', plain);
      expect(off.checks.map((c) => c.name)).not.toContain('Bypass allowed');
      expect(plain.lines.some((l) => l.includes('lock_bypass'))).toBe(false);
    }

    const unlocked = await checkRuntime(
      'eva',
      '/repo',
      'bypass',
      deps({
        evaRules: {
          'home/u/.eva/config.toml': 'lock_bypass = true\n[permissions]\nlock_bypass = false\n',
          'repo/.eva/settings.toml': '[other]\nlock_bypass = true\n'
        }
      })
    );
    expect(unlocked.checks.at(-1)).toEqual({
      name: 'Bypass allowed',
      state: 'ok',
      note: 'eva crew can start in bypass mode.'
    });
  });

  it('reads no eva settings, since they hold its key', async () => {
    const read: string[] = [];
    const d = deps();
    await checkRuntime('eva', '/repo', 'default', {
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
