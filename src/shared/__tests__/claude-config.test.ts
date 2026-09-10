import { describe, it, expect } from 'vitest';
import {
  resolveClaudeConfig,
  defaultClaudeConfigDir,
  suggestClaudeConfigDir,
  resolveClaudeFilePath,
  allowedClaudeFilePaths,
  isAllowedClaudeFilePath,
  isSafeClaudeDir
} from '../claude-config';

describe('defaultClaudeConfigDir', () => {
  it('appends .claude to a posix home', () => {
    expect(defaultClaudeConfigDir('/Users/ada')).toBe('/Users/ada/.claude');
  });

  it('uses a backslash for a Windows home', () => {
    expect(defaultClaudeConfigDir('C:\\Users\\ada')).toBe('C:\\Users\\ada\\.claude');
  });

  it('does not double the separator on a trailing slash', () => {
    expect(defaultClaudeConfigDir('/Users/ada/')).toBe('/Users/ada/.claude');
  });
});

describe('resolveClaudeConfig', () => {
  const homeDir = '/Users/ada';

  it('falls back to the Claude default when nothing is configured', () => {
    expect(resolveClaudeConfig({ defaultDir: '', homeDir })).toEqual({
      path: '/Users/ada/.claude',
      source: 'default'
    });
  });

  it('inherits the Fleet default when the workspace has no override', () => {
    expect(resolveClaudeConfig({ defaultDir: '/shared/claude', homeDir })).toEqual({
      path: '/shared/claude',
      source: 'default'
    });
  });

  it('prefers a workspace override over the default', () => {
    expect(
      resolveClaudeConfig({ defaultDir: '/shared/claude', overrideDir: '/work/claude', homeDir })
    ).toEqual({ path: '/work/claude', source: 'custom' });
  });

  it('treats a blank override as no override at all', () => {
    // A saved-but-empty override would otherwise read as "custom" and show an
    // empty folder as this workspace's assignment.
    expect(
      resolveClaudeConfig({ defaultDir: '/shared/claude', overrideDir: '   ', homeDir })
    ).toEqual({ path: '/shared/claude', source: 'default' });
  });

  it('resolves inheriting workspaces to the new default when it changes', () => {
    const before = resolveClaudeConfig({ defaultDir: '', homeDir });
    const after = resolveClaudeConfig({ defaultDir: '/moved/claude', homeDir });
    expect(before.path).not.toBe(after.path);
    expect(after.source).toBe('default');
  });
});

describe('suggestClaudeConfigDir', () => {
  it('puts the workspace slug beside the default folder', () => {
    expect(suggestClaudeConfigDir('/Users/k/.claude', 'My Work')).toBe('/Users/k/.claude-my-work');
  });

  it('drops punctuation and collapses runs of separators', () => {
    expect(suggestClaudeConfigDir('/Users/k/.claude', '  Client: Acme // 2  ')).toBe(
      '/Users/k/.claude-client-acme-2'
    );
  });

  it('offers nothing when the name has no usable characters', () => {
    expect(suggestClaudeConfigDir('/Users/k/.claude', '  ...  ')).toBe('');
  });

  it('does not double a trailing separator on the default folder', () => {
    expect(suggestClaudeConfigDir('/Users/k/.claude/', 'Work')).toBe('/Users/k/.claude-work');
  });
});

const DIRS = {
  configDir: '/Users/ada/.claude',
  sessionDir: '/Users/ada/code/app/packages/api',
  localSettingsRoot: '/Users/ada/code/app'
};

describe('resolveClaudeFilePath', () => {
  it('resolves user settings inside the config dir', () => {
    expect(resolveClaudeFilePath({ scope: 'user', kind: 'settings', dirs: DIRS })).toBe(
      '/Users/ada/.claude/settings.json'
    );
  });

  it('resolves user memory inside the config dir', () => {
    expect(resolveClaudeFilePath({ scope: 'user', kind: 'memory', dirs: DIRS })).toBe(
      '/Users/ada/.claude/CLAUDE.md'
    );
  });

  it('resolves shared project settings against the session dir, not the repo root', () => {
    expect(resolveClaudeFilePath({ scope: 'project', kind: 'settings', dirs: DIRS })).toBe(
      '/Users/ada/code/app/packages/api/.claude/settings.json'
    );
  });

  it('puts project memory at the folder root, not inside .claude', () => {
    expect(resolveClaudeFilePath({ scope: 'project', kind: 'memory', dirs: DIRS })).toBe(
      '/Users/ada/code/app/packages/api/CLAUDE.md'
    );
  });

  it('resolves local settings against the local-settings root', () => {
    expect(resolveClaudeFilePath({ scope: 'projectLocal', kind: 'settings', dirs: DIRS })).toBe(
      '/Users/ada/code/app/.claude/settings.local.json'
    );
  });

  it('has no local-scope memory file', () => {
    expect(resolveClaudeFilePath({ scope: 'projectLocal', kind: 'memory', dirs: DIRS })).toBeNull();
  });

  it('returns null when the directory a scope needs was not chosen', () => {
    const dirs = { configDir: '/Users/ada/.claude' };
    expect(resolveClaudeFilePath({ scope: 'project', kind: 'settings', dirs })).toBeNull();
    expect(resolveClaudeFilePath({ scope: 'projectLocal', kind: 'settings', dirs })).toBeNull();
  });

  it('keeps backslashes on a Windows layout', () => {
    const dirs = {
      configDir: 'C:\\Users\\ada\\.claude',
      sessionDir: 'C:\\code\\app',
      localSettingsRoot: 'C:\\code\\app'
    };
    expect(resolveClaudeFilePath({ scope: 'user', kind: 'settings', dirs })).toBe(
      'C:\\Users\\ada\\.claude\\settings.json'
    );
    expect(resolveClaudeFilePath({ scope: 'projectLocal', kind: 'settings', dirs })).toBe(
      'C:\\code\\app\\.claude\\settings.local.json'
    );
  });

  it('does not double a trailing separator', () => {
    const dirs = { configDir: '/Users/ada/.claude/', sessionDir: '/code/app/' };
    expect(resolveClaudeFilePath({ scope: 'user', kind: 'settings', dirs })).toBe(
      '/Users/ada/.claude/settings.json'
    );
    expect(resolveClaudeFilePath({ scope: 'project', kind: 'memory', dirs })).toBe(
      '/code/app/CLAUDE.md'
    );
  });
});

describe('isSafeClaudeDir', () => {
  it('accepts an absolute posix path', () => {
    expect(isSafeClaudeDir('/Users/ada/code/app')).toBe(true);
  });

  it('accepts an absolute Windows path and a UNC path', () => {
    expect(isSafeClaudeDir('C:\\code\\app')).toBe(true);
    expect(isSafeClaudeDir('\\\\server\\share')).toBe(true);
  });

  it('refuses a relative path', () => {
    expect(isSafeClaudeDir('code/app')).toBe(false);
    expect(isSafeClaudeDir('')).toBe(false);
  });

  it('refuses a traversal segment on either separator', () => {
    expect(isSafeClaudeDir('/Users/ada/../../etc')).toBe(false);
    expect(isSafeClaudeDir('C:\\code\\..\\..\\Windows')).toBe(false);
  });

  it('allows a name that merely contains dots', () => {
    expect(isSafeClaudeDir('/Users/ada/my..app')).toBe(true);
  });

  it('refuses a NUL byte', () => {
    expect(isSafeClaudeDir('/Users/ada\0/app')).toBe(false);
  });
});

describe('allowedClaudeFilePaths', () => {
  it('lists exactly the five files the page may touch', () => {
    expect(allowedClaudeFilePaths(DIRS)).toEqual([
      '/Users/ada/.claude/settings.json',
      '/Users/ada/.claude/CLAUDE.md',
      '/Users/ada/code/app/packages/api/.claude/settings.json',
      '/Users/ada/code/app/packages/api/CLAUDE.md',
      '/Users/ada/code/app/.claude/settings.local.json'
    ]);
  });

  it('drops the files whose directory was never chosen', () => {
    expect(allowedClaudeFilePaths({ configDir: '/Users/ada/.claude' })).toEqual([
      '/Users/ada/.claude/settings.json',
      '/Users/ada/.claude/CLAUDE.md'
    ]);
  });
});

describe('isAllowedClaudeFilePath', () => {
  it('accepts the project CLAUDE.md even though it sits outside .claude', () => {
    expect(isAllowedClaudeFilePath('/Users/ada/code/app/packages/api/CLAUDE.md', DIRS)).toBe(true);
  });

  it('refuses a sibling file inside the same .claude directory', () => {
    expect(isAllowedClaudeFilePath('/Users/ada/.claude/history.jsonl', DIRS)).toBe(false);
    expect(isAllowedClaudeFilePath('/Users/ada/.claude/settings.local.json', DIRS)).toBe(false);
  });

  it('refuses the global config file', () => {
    expect(isAllowedClaudeFilePath('/Users/ada/.claude.json', DIRS)).toBe(false);
  });

  it('refuses every file when a directory contains a traversal segment', () => {
    const hostile = { ...DIRS, sessionDir: '/Users/ada/code/app/../../../etc' };
    expect(
      isAllowedClaudeFilePath('/Users/ada/code/app/../../../etc/.claude/settings.json', hostile)
    ).toBe(false);
    // The safe directories in the same set still resolve.
    expect(isAllowedClaudeFilePath('/Users/ada/.claude/settings.json', hostile)).toBe(true);
  });

  it('refuses a relative directory', () => {
    const relative = { configDir: '.claude' };
    expect(isAllowedClaudeFilePath('.claude/settings.json', relative)).toBe(false);
  });
});
