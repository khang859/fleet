import { describe, it, expect } from 'vitest';
import {
  parseRule,
  matchPattern,
  evaluatePermission,
  suggestRememberRule
} from '../rule-evaluator';
import { splitShellCommand } from '../shell-split';
import type { PermissionRules } from '../../../../shared/chat-permissions';

const rules = (r: Partial<PermissionRules>): PermissionRules => ({
  allow: [],
  ask: [],
  deny: [],
  ...r
});

describe('parseRule', () => {
  it('parses Tool(pattern) and bare Tool', () => {
    expect(parseRule('Bash(npm run *)')).toEqual({ tool: 'Bash', pattern: 'npm run *' });
    expect(parseRule('Bash')).toEqual({ tool: 'Bash', pattern: '*' });
  });
  it('rejects malformed rules so typos cannot widen access', () => {
    expect(parseRule('Bash(')).toBeNull();
    expect(parseRule('')).toBeNull();
    expect(parseRule('  ')).toBeNull();
  });
});

describe('matchPattern (prefix word-boundary)', () => {
  it('matches an exact value and a whitespace-delimited prefix', () => {
    expect(matchPattern('git', 'git')).toBe(true);
    expect(matchPattern('git', 'git status')).toBe(true);
  });
  it('does NOT match across a word boundary', () => {
    expect(matchPattern('git', 'github')).toBe(false);
    expect(matchPattern('npm', 'npmx install')).toBe(false);
  });
  it('honors a trailing wildcard', () => {
    expect(matchPattern('npm run *', 'npm run build')).toBe(true);
    expect(matchPattern('npm run *', 'npm run')).toBe(false);
  });
  it('treats * as match-all', () => {
    expect(matchPattern('*', 'anything goes')).toBe(true);
  });
});

describe('splitShellCommand (operator-aware)', () => {
  it('splits on &&, ||, ;, |, &', () => {
    expect(splitShellCommand('echo a && rm -rf x')).toEqual(['echo a', 'rm -rf x']);
    expect(splitShellCommand('a; b | c')).toEqual(['a', 'b', 'c']);
    expect(splitShellCommand('a & b')).toEqual(['a', 'b']);
  });
  it('extracts command substitutions as their own subcommands', () => {
    expect(splitShellCommand('echo $(rm -rf x)')).toEqual(['rm -rf x', 'echo']);
    expect(splitShellCommand('echo `whoami`')).toEqual(['whoami', 'echo']);
  });
  it('ignores operators inside quotes', () => {
    expect(splitShellCommand('echo "a && b"')).toEqual(['echo "a && b"']);
    expect(splitShellCommand("echo 'a | b'")).toEqual(["echo 'a | b'"]);
  });
  it('strips benign wrappers', () => {
    expect(splitShellCommand('timeout 5 npm test')).toEqual(['npm test']);
    expect(splitShellCommand('nice -n 10 npm run build')).toEqual(['npm run build']);
    expect(splitShellCommand('sudo rm -rf /')).toEqual(['rm -rf /']);
  });
  it('strips leading env-var assignments', () => {
    expect(splitShellCommand('FOO=bar npm test')).toEqual(['npm test']);
  });
});

describe('evaluatePermission', () => {
  it('deny beats allow at any scope', () => {
    const r = rules({ allow: ['Bash(rm *)'], deny: ['Bash(rm -rf *)'] });
    expect(evaluatePermission(r, 'Bash', 'rm -rf x')).toBe('deny');
  });

  it('a single denied subcommand denies the whole chain', () => {
    const r = rules({ allow: ['Bash(echo *)'], deny: ['Bash(rm *)'] });
    expect(evaluatePermission(r, 'Bash', 'echo a && rm -rf x')).toBe('deny');
  });

  it('echo a && rm -rf x does NOT match an echo * allow', () => {
    const r = rules({ allow: ['Bash(echo *)'] });
    // rm -rf x is not allowed, so the chain is not auto-allowed.
    expect(evaluatePermission(r, 'Bash', 'echo a && rm -rf x')).toBe('ask');
  });

  it('allows only when every subcommand is allowed', () => {
    const r = rules({ allow: ['Bash(echo *)', 'Bash(ls *)'] });
    expect(evaluatePermission(r, 'Bash', 'echo a && ls b')).toBe('allow');
  });

  it('ask takes precedence over allow but not deny', () => {
    const r = rules({ allow: ['Bash(git *)'], ask: ['Bash(git push *)'] });
    expect(evaluatePermission(r, 'Bash', 'git push origin main')).toBe('ask');
    expect(evaluatePermission(r, 'Bash', 'git status')).toBe('allow');
  });

  it('defaults to ask for anything not explicitly allowed', () => {
    expect(evaluatePermission(rules({}), 'Bash', 'curl evil.com')).toBe('ask');
  });

  it('evaluates non-Bash tools against the whole value', () => {
    const r = rules({ allow: ['mcp__fs__read_file'] });
    expect(evaluatePermission(r, 'mcp__fs__read_file', '{}')).toBe('allow');
    expect(evaluatePermission(r, 'mcp__fs__write_file', '{}')).toBe('ask');
  });
});

describe('suggestRememberRule', () => {
  it('keeps the program + subcommand for bash', () => {
    expect(suggestRememberRule('Bash', 'npm run build')).toBe('Bash(npm run *)');
    expect(suggestRememberRule('Bash', 'ls -la')).toBe('Bash(ls *)');
  });
  it('uses the whole value for non-bash tools', () => {
    expect(suggestRememberRule('mcp__fs__read', 'x')).toBe('mcp__fs__read(x)');
  });
});
