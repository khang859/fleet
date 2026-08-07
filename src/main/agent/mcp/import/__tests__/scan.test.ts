import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { scanClaudeCode } from '../claude-code';
import { scanOpenCode } from '../opencode';
import type { ScanPaths } from '../found';

/**
 * Reading the real files, from copies of the real files.
 *
 * The fixtures are this machine's own Claude Code and OpenCode configs with the
 * keys replaced - same shapes, same oddities, same scopes. They are copied into
 * a temp directory per test so the folder-scoped entries can be keyed by an
 * absolute path that actually exists, which is how those files really work.
 */

const FIXTURES = join(fileURLToPath(new URL('.', import.meta.url)), 'fixtures');

let paths: ScanPaths;
let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'fleet-mcp-import-'));
  paths = { home: join(root, 'home'), cwd: join(root, 'project') };

  cpSync(join(FIXTURES, 'home'), paths.home, { recursive: true });
  cpSync(join(FIXTURES, 'project'), paths.cwd, { recursive: true });

  // The folder-scoped block in `.claude.json` is keyed by absolute path, so the
  // fixture's stand-in is swapped for where this test actually put the folder.
  const claude = join(paths.home, '.claude.json');
  writeFileSync(claude, readFileSync(claude, 'utf-8').replaceAll('/work/demo', paths.cwd));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function named(found: Array<{ name: string }>, name: string): unknown {
  return found.find((f) => f.name === name);
}

describe('reading Claude Code', () => {
  it('finds the servers that follow the user everywhere', () => {
    const found = scanClaudeCode(paths);

    expect(named(found, 'auggie-mcp')).toMatchObject({
      scope: 'user',
      config: { command: 'auggie', args: ['mcp'], enabled: true }
    });
  });

  it('finds the ones bound to this folder, and not another folder', () => {
    const found = scanClaudeCode(paths);

    expect(named(found, 'playwright')).toMatchObject({
      scope: 'project',
      config: { command: 'npx', args: ['-y', '@playwright/mcp@latest'] }
    });
    // Another project's block sits in the same file. Reading it would offer the
    // user servers belonging to a folder they are not in.
    expect(named(found, 'not-ours')).toBeUndefined();
  });

  it('finds the ones committed alongside the code', () => {
    const found = scanClaudeCode(paths);

    expect(named(found, 'team-docs')).toMatchObject({
      scope: 'project',
      path: join(paths.cwd, '.mcp.json'),
      config: { url: 'https://docs.example.com/mcp' }
    });
  });

  it('takes a url as a url whatever the entry calls itself', () => {
    const found = scanClaudeCode(paths);

    // `http`, `streamable-http`, `sse`, and no type at all - four spellings of
    // the same thing across configs written at different times.
    for (const name of ['context7', 'team-docs', 'linear', 'no-type-but-a-url']) {
      expect(named(found, name)).toMatchObject({ config: { url: expect.any(String) } });
    }
  });

  it('leaves out an entry with nothing to connect to', () => {
    expect(named(scanClaudeCode(paths), 'broken')).toBeUndefined();
  });

  it('says which file each one came from', () => {
    const found = scanClaudeCode(paths);
    expect(named(found, 'auggie-mcp')).toMatchObject({ path: join(paths.home, '.claude.json') });
  });
});

describe('reading OpenCode', () => {
  it('turns a one-array command into a command and its arguments', () => {
    const found = scanOpenCode(paths);

    expect(named(found, 'filesystem')).toMatchObject({
      config: {
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-filesystem', '/work'],
        env: { FS_ROOT: '/work' }
      }
    });
  });

  it('reads a remote server, headers and all', () => {
    const found = scanOpenCode(paths);

    expect(named(found, 'context7')).toMatchObject({
      source: 'opencode',
      scope: 'user',
      config: { url: 'https://mcp.context7.com/mcp', enabled: true }
    });
  });

  it('keeps a server that was switched off switched off', () => {
    // Arriving switched on would have Fleet start talking to something the user
    // had deliberately quietened.
    expect(named(scanOpenCode(paths), 'exa')).toMatchObject({ config: { enabled: false } });
  });

  it('reads a project config that has comments in it', () => {
    const found = scanOpenCode(paths);

    expect(named(found, 'project-docs')).toMatchObject({
      scope: 'project',
      // The `//` inside this URL is the thing a careless comment stripper eats.
      config: { url: 'https://docs.example.com/mcp' }
    });
  });

  it('leaves an entry with an empty command out', () => {
    expect(named(scanOpenCode(paths), 'empty-command')).toBeUndefined();
  });
});

describe('a file that will not parse', () => {
  it('yields nothing rather than stopping the scan', () => {
    const broken: ScanPaths = { home: paths.home, cwd: join(FIXTURES, 'broken') };

    expect(scanClaudeCode(broken).some((f) => f.name === 'half-written')).toBe(false);
    // The user's own servers are still found, which is the point: one tool's
    // half-written file must not hide everything else on the machine.
    expect(scanClaudeCode(broken).some((f) => f.name === 'auggie-mcp')).toBe(true);
  });

  it('yields nothing for a file that is not there at all', () => {
    const empty: ScanPaths = { home: join(root, 'nowhere'), cwd: join(root, 'nowhere') };

    expect(scanClaudeCode(empty)).toEqual([]);
    expect(scanOpenCode(empty)).toEqual([]);
  });
});
