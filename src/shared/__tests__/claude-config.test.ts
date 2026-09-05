import { describe, it, expect } from 'vitest';
import {
  resolveClaudeConfig,
  defaultClaudeConfigDir,
  suggestClaudeConfigDir
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
