import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  mkdirSync,
  statSync,
  utimesSync,
  existsSync
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  readClaudeFile,
  writeClaudeFile,
  writeClaudeSettings,
  writeClaudeScope,
  readClaudeScope
} from '../claude-config/claude-config-fs';
import type { ClaudeFileRevision } from '../../shared/claude-config-types';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'fleet-claude-config-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const ABSENT: ClaudeFileRevision = { exists: false, mtimeMs: 0, size: 0 };

function revisionOf(path: string): ClaudeFileRevision {
  const s = statSync(path);
  return { exists: true, mtimeMs: s.mtimeMs, size: s.size };
}

describe('readClaudeFile', () => {
  it('gives a missing settings file an empty object so the form can render', () => {
    const result = readClaudeFile(join(dir, 'settings.json'), 'settings');
    expect(result.text).toBe('{}');
    expect(result.exists).toBe(false);
    expect(result.revision.exists).toBe(false);
  });

  it('gives a missing memory file empty text', () => {
    const result = readClaudeFile(join(dir, 'CLAUDE.md'), 'memory');
    expect(result.text).toBe('');
    expect(result.exists).toBe(false);
  });

  it('treats an empty settings file as an empty object', () => {
    const path = join(dir, 'settings.json');
    writeFileSync(path, '');
    const result = readClaudeFile(path, 'settings');
    expect(result.text).toBe('{}');
    expect(result.exists).toBe(true);
  });

  it('treats a whitespace-only settings file as an empty object', () => {
    const path = join(dir, 'settings.json');
    writeFileSync(path, '\n  \n\t');
    expect(readClaudeFile(path, 'settings').text).toBe('{}');
  });

  it('leaves an empty memory file empty rather than substituting an object', () => {
    const path = join(dir, 'CLAUDE.md');
    writeFileSync(path, '');
    const result = readClaudeFile(path, 'memory');
    expect(result.text).toBe('');
    expect(result.exists).toBe(true);
  });

  it('returns a populated file verbatim with its revision', () => {
    const path = join(dir, 'settings.json');
    writeFileSync(path, '{"model":"claude-opus-5"}');
    const result = readClaudeFile(path, 'settings');
    expect(result.text).toBe('{"model":"claude-opus-5"}');
    expect(result.revision.exists).toBe(true);
    expect(result.revision.size).toBeGreaterThan(0);
  });
});

describe('writeClaudeFile revision guard', () => {
  it('creates a file that was absent at read', () => {
    const path = join(dir, 'nested', '.claude', 'settings.json');
    const result = writeClaudeFile(path, '{"a":1}', ABSENT);
    expect(result.ok).toBe(true);
    expect(readFileSync(path, 'utf8')).toBe('{"a":1}');
  });

  it('writes when the revision still matches', () => {
    const path = join(dir, 'settings.json');
    writeFileSync(path, 'old');
    const result = writeClaudeFile(path, 'new', revisionOf(path));
    expect(result.ok).toBe(true);
    expect(readFileSync(path, 'utf8')).toBe('new');
  });

  it('refuses when the file gained a newer modification', () => {
    const path = join(dir, 'settings.json');
    writeFileSync(path, 'old');
    const loaded = revisionOf(path);
    writeFileSync(path, 'changed by someone else');
    const result = writeClaudeFile(path, 'mine', loaded);
    expect(result).toMatchObject({ ok: false, reason: 'modified' });
    expect(readFileSync(path, 'utf8')).toBe('changed by someone else');
  });

  it('refuses a replacement whose mtime is OLDER than the loaded revision', () => {
    const path = join(dir, 'settings.json');
    writeFileSync(path, 'current content');
    const loaded = revisionOf(path);
    // A restored backup: different content, timestamp pushed into the past.
    writeFileSync(path, 'restored from a backup');
    const past = new Date(Date.now() - 60_000);
    utimesSync(path, past, past);
    const result = writeClaudeFile(path, 'mine', loaded);
    expect(result).toMatchObject({ ok: false, reason: 'modified' });
    expect(readFileSync(path, 'utf8')).toBe('restored from a backup');
  });

  it('refuses a replacement with an equal mtime but a different size', () => {
    const path = join(dir, 'settings.json');
    writeFileSync(path, 'twelve chars');
    const loaded = revisionOf(path);
    writeFileSync(path, 'a much longer replacement string');
    utimesSync(path, new Date(loaded.mtimeMs), new Date(loaded.mtimeMs));
    const result = writeClaudeFile(path, 'mine', loaded);
    expect(result).toMatchObject({ ok: false, reason: 'modified' });
  });

  it('refuses when the file was deleted after it was read', () => {
    const path = join(dir, 'settings.json');
    writeFileSync(path, 'old');
    const loaded = revisionOf(path);
    rmSync(path);
    const result = writeClaudeFile(path, 'mine', loaded);
    expect(result).toMatchObject({ ok: false, reason: 'deleted' });
    expect(existsSync(path)).toBe(false);
  });

  it('refuses when the file was created after it was read as absent', () => {
    const path = join(dir, 'settings.json');
    writeFileSync(path, 'someone got here first');
    const result = writeClaudeFile(path, 'mine', ABSENT);
    expect(result).toMatchObject({ ok: false, reason: 'created' });
    expect(readFileSync(path, 'utf8')).toBe('someone got here first');
  });

  it('reports the current revision on refusal so the page can reload', () => {
    const path = join(dir, 'settings.json');
    writeFileSync(path, 'old');
    const loaded = revisionOf(path);
    writeFileSync(path, 'much longer replacement');
    const result = writeClaudeFile(path, 'mine', loaded);
    expect(result.ok).toBe(false);
    expect(result.revision.size).toBe(statSync(path).size);
  });

  it('leaves no temp file behind after a successful write', () => {
    writeClaudeFile(join(dir, 'settings.json'), '{}', ABSENT);
    expect(readdirSync(dir).filter((f) => f.includes('fleet-tmp'))).toEqual([]);
  });
});

describe('writeClaudeSettings hooks merge', () => {
  const fleetEntry = {
    hooks: [{ type: 'command', command: '/u/.claude/hooks/fleet-copilot-darwin-arm64' }]
  };
  const userEntry = {
    matcher: 'Bash',
    hooks: [{ type: 'command', command: '/u/.claude/hooks/mine.sh' }]
  };
  const HOOKS = { Stop: [fleetEntry] };

  it('keeps a Fleet entry the document dropped', () => {
    const path = join(dir, 'settings.json');
    writeFileSync(path, JSON.stringify({ model: 'a', hooks: HOOKS }, null, 2));
    const loaded = revisionOf(path);

    const result = writeClaudeSettings(path, JSON.stringify({ model: 'b' }), loaded);

    expect(result.ok && result.hooksDiscarded).toBe(true);
    expect(JSON.parse(readFileSync(path, 'utf8')).hooks).toEqual(HOOKS);
  });

  it('refuses an edit to a Fleet entry and writes the command on disk', () => {
    const path = join(dir, 'settings.json');
    writeFileSync(path, JSON.stringify({ hooks: HOOKS }, null, 2));
    const loaded = revisionOf(path);

    const tampered = {
      hooks: {
        Stop: [
          {
            hooks: [
              { type: 'command', command: '/u/.claude/hooks/fleet-copilot-darwin-arm64 --evil' }
            ]
          }
        ]
      }
    };
    const result = writeClaudeSettings(path, JSON.stringify(tampered), loaded);

    expect(result.ok && result.hooksDiscarded).toBe(true);
    expect(JSON.parse(readFileSync(path, 'utf8')).hooks).toEqual(HOOKS);
  });

  it('writes a user entry the document added, alongside the Fleet entry', () => {
    const path = join(dir, 'settings.json');
    writeFileSync(path, JSON.stringify({ hooks: HOOKS }, null, 2));
    const loaded = revisionOf(path);

    const doc = { hooks: { Stop: [fleetEntry, userEntry] } };
    const result = writeClaudeSettings(path, JSON.stringify(doc), loaded);

    expect(result.ok && result.hooksDiscarded).toBe(false);
    expect(JSON.parse(readFileSync(path, 'utf8')).hooks).toEqual({ Stop: [fleetEntry, userEntry] });
  });

  it('removes a user entry the document dropped', () => {
    const path = join(dir, 'settings.json');
    writeFileSync(path, JSON.stringify({ hooks: { Stop: [fleetEntry, userEntry] } }, null, 2));
    const loaded = revisionOf(path);

    const result = writeClaudeSettings(path, JSON.stringify({ hooks: HOOKS }), loaded);

    expect(result.ok && result.hooksDiscarded).toBe(false);
    expect(JSON.parse(readFileSync(path, 'utf8')).hooks).toEqual(HOOKS);
  });

  it('adds a whole new event the document introduced', () => {
    const path = join(dir, 'settings.json');
    writeFileSync(path, JSON.stringify({ hooks: HOOKS }, null, 2));
    const loaded = revisionOf(path);

    const doc = { hooks: { Stop: [fleetEntry], PreToolUse: [userEntry] } };
    writeClaudeSettings(path, JSON.stringify(doc), loaded);

    expect(JSON.parse(readFileSync(path, 'utf8')).hooks).toEqual({
      Stop: [fleetEntry],
      PreToolUse: [userEntry]
    });
  });

  it('drops the hooks key when the merge leaves nothing', () => {
    const path = join(dir, 'settings.json');
    writeFileSync(path, JSON.stringify({ model: 'a', hooks: { Stop: [userEntry] } }));
    const loaded = revisionOf(path);

    const result = writeClaudeSettings(path, JSON.stringify({ model: 'b' }), loaded);

    expect(result.ok && result.hooksDiscarded).toBe(false);
    expect(JSON.parse(readFileSync(path, 'utf8'))).not.toHaveProperty('hooks');
  });

  it('reports no discard when the document already carried the disk value', () => {
    const path = join(dir, 'settings.json');
    writeFileSync(path, JSON.stringify({ model: 'a', hooks: HOOKS }, null, 2));
    const loaded = revisionOf(path);

    const result = writeClaudeSettings(path, JSON.stringify({ model: 'b', hooks: HOOKS }), loaded);

    expect(result.ok && result.hooksDiscarded).toBe(false);
  });

  it('writes every other key exactly as supplied, including unknown ones', () => {
    const path = join(dir, 'settings.json');
    writeFileSync(path, JSON.stringify({ hooks: HOOKS }));
    const loaded = revisionOf(path);

    const doc = {
      model: 'claude-opus-5',
      permissions: { allow: ['WebSearch'], defaultMode: 'auto' },
      somethingNewInTheNextRelease: { nested: [1, 2, 3] }
    };
    writeClaudeSettings(path, JSON.stringify(doc), loaded);

    const written = JSON.parse(readFileSync(path, 'utf8'));
    expect(written.model).toBe(doc.model);
    expect(written.permissions).toEqual(doc.permissions);
    expect(written.somethingNewInTheNextRelease).toEqual(doc.somethingNewInTheNextRelease);
  });

  it('refuses a document that is not valid JSON', () => {
    const path = join(dir, 'settings.json');
    const result = writeClaudeSettings(path, '{ not json', ABSENT);
    expect(result).toMatchObject({ ok: false, reason: 'invalidJson' });
  });

  it('refuses a document that is a JSON array rather than an object', () => {
    const path = join(dir, 'settings.json');
    const result = writeClaudeSettings(path, '[1,2]', ABSENT);
    expect(result).toMatchObject({ ok: false, reason: 'invalidJson' });
  });

  it('takes hooks from disk at write time, not from the loaded revision', () => {
    // The overwrite-after-hook-install case: the page loaded the file before
    // the installer ran, and the user chose Overwrite afterwards.
    const path = join(dir, 'settings.json');
    writeFileSync(path, JSON.stringify({ model: 'a' }));
    const stale = revisionOf(path);

    // The installer writes hooks in between.
    writeFileSync(path, JSON.stringify({ model: 'a', hooks: HOOKS }));
    const afterInstall = revisionOf(path);

    // Overwrite re-issues the write against the *current* revision.
    const result = writeClaudeSettings(path, JSON.stringify({ model: 'edited' }), afterInstall);

    expect(result.ok).toBe(true);
    const written = JSON.parse(readFileSync(path, 'utf8'));
    expect(written.hooks).toEqual(HOOKS);
    expect(written.model).toBe('edited');
    expect(stale.mtimeMs).toBeDefined();
  });
});

describe('writeClaudeScope allowlist', () => {
  const dirsFor = (base: string) => ({
    configDir: join(base, '.claude'),
    sessionDir: join(base, 'app'),
    localSettingsRoot: join(base, 'app')
  });

  it('writes the project CLAUDE.md at the folder root', () => {
    const dirs = dirsFor(dir);
    mkdirSync(dirs.sessionDir, { recursive: true });
    const result = writeClaudeScope({
      scope: 'project',
      kind: 'memory',
      dirs,
      text: '# Project rules\n',
      expected: ABSENT
    });
    expect(result.ok).toBe(true);
    expect(readFileSync(join(dirs.sessionDir, 'CLAUDE.md'), 'utf8')).toBe('# Project rules\n');
  });

  it('refuses a session directory carrying an unnormalized traversal segment', () => {
    // Written as a raw string, not through `join`, because `join` normalizes
    // `..` away - the guard exists for a path that reaches the main process
    // still carrying one.
    const dirs = { ...dirsFor(dir), sessionDir: `${dir}/app/../../etc` };
    const result = writeClaudeScope({
      scope: 'project',
      kind: 'settings',
      dirs,
      text: '{}',
      expected: ABSENT
    });
    expect(result).toMatchObject({ ok: false, reason: 'refused' });
    expect(existsSync(`${dir}/app/../../etc/.claude/settings.json`)).toBe(false);
  });

  it('refuses a relative session directory', () => {
    const dirs = { ...dirsFor(dir), sessionDir: 'relative/app' };
    const result = writeClaudeScope({
      scope: 'project',
      kind: 'settings',
      dirs,
      text: '{}',
      expected: ABSENT
    });
    expect(result).toMatchObject({ ok: false, reason: 'refused' });
  });

  it('refuses a scope and kind combination that has no file', () => {
    const result = writeClaudeScope({
      scope: 'projectLocal',
      kind: 'memory',
      dirs: dirsFor(dir),
      text: 'x',
      expected: ABSENT
    });
    expect(result).toMatchObject({ ok: false, reason: 'refused' });
  });

  it('round-trips a scope through read and write', () => {
    const dirs = dirsFor(dir);
    const before = readClaudeScope({ scope: 'user', kind: 'settings', dirs });
    expect(before.exists).toBe(false);
    expect(before.text).toBe('{}');

    const write = writeClaudeScope({
      scope: 'user',
      kind: 'settings',
      dirs,
      text: '{"model":"claude-opus-5"}',
      expected: before.revision
    });
    expect(write.ok).toBe(true);

    const after = readClaudeScope({ scope: 'user', kind: 'settings', dirs });
    expect(after.exists).toBe(true);
    expect(JSON.parse(after.text).model).toBe('claude-opus-5');
  });
});
