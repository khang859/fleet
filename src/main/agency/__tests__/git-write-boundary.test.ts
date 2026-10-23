import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

/**
 * The agency writes to git in two places only: `workspaces/` adds crew
 * worktrees and pushes their branches, and `cleanup/` removes them.
 * Everything else reads. This scans
 * the source for git write verbs in argument lists, so a new write site has
 * to be added here on purpose.
 */

const ROOT = join(__dirname, '..');
const ALLOWED = ['workspaces/', 'cleanup/'];

const WRITES = [
  /\[\s*'(add|commit|push|pull|fetch|reset|checkout|switch|merge|rebase|cherry-pick|revert|stash|clean|rm|mv|tag|update-ref|apply|am|restore|gc|prune)'/,
  /'worktree'\s*,\s*'(add|remove|move|prune|repair)'/,
  /'branch'\s*,\s*'(-d|-D|-m|-M|--delete|--move|--force|-f)'/,
  /'submodule'\s*,\s*'(update|add|deinit|sync)'/,
  /'config'\s*,\s*'(?!--get)/
];

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === '__tests__' ? [] : sources(path);
    return entry.name.endsWith('.ts') ? [path] : [];
  });
}

describe('git write boundary', () => {
  it('writes to git only from workspaces/ and cleanup/', () => {
    const files = sources(ROOT);
    expect(files.length).toBeGreaterThan(20);
    const offenders = files
      .map((path) => relative(ROOT, path))
      .filter((path) => !ALLOWED.some((dir) => path.startsWith(dir)))
      .flatMap((path) =>
        readFileSync(join(ROOT, path), 'utf8')
          .split('\n')
          .map((line, i) => ({ line: line.trim(), at: `${path}:${i + 1}` }))
          .filter(({ line }) => WRITES.some((verb) => verb.test(line)))
          .map(({ line, at }) => `${at} ${line}`)
      );
    expect(offenders).toEqual([]);
  });

  it('catches a write verb', () => {
    const caught = (line: string): boolean => WRITES.some((verb) => verb.test(line));
    expect(caught("await git(['commit', '-m', 'x'], root)")).toBe(true);
    expect(caught("run(['worktree', 'remove', path])")).toBe(true);
    expect(caught("git(['branch', '-D', name])")).toBe(true);
    expect(caught("git(['--no-optional-locks', 'status', '--porcelain'], root)")).toBe(false);
    expect(caught("git(['rev-list', '--count', 'HEAD'], root)")).toBe(false);
  });
});
