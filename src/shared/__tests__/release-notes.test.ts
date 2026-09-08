import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseChangelog } from '../release-notes';

/** The repo root, counted from this test file - not through any app code. */
const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

describe('parseChangelog', () => {
  it('produces one entry per version heading, in the order the file lists them', () => {
    const entries = parseChangelog(
      ['# Changelog', '', '## v2.0.0', '', '- newer', '', '## v1.9.0', '', '- older', ''].join('\n')
    );

    expect(entries).toEqual([
      { version: '2.0.0', notes: '- newer' },
      { version: '1.9.0', notes: '- older' }
    ]);
  });

  it('drops the document title and anything else before the first version', () => {
    const entries = parseChangelog(
      ['# Changelog', '', 'Everything worth knowing.', '', '## v1.0.0', '', '- shipped'].join('\n')
    );

    expect(entries).toHaveLength(1);
    expect(entries[0].notes).toBe('- shipped');
    expect(entries[0].notes).not.toContain('Everything worth knowing');
  });

  it('runs the last section to the end of the file', () => {
    const entries = parseChangelog(['## v1.0.0', '', '- first', '- second'].join('\n'));

    expect(entries[0].notes).toBe('- first\n- second');
  });

  it('still produces an entry for a version with no body', () => {
    const entries = parseChangelog(['## v2.0.0', '', '## v1.0.0', '', '- something'].join('\n'));

    expect(entries).toEqual([
      { version: '2.0.0', notes: '' },
      { version: '1.0.0', notes: '- something' }
    ]);
  });

  it('does not treat another second-level heading as a version', () => {
    // A `v` prefix on its own is not enough: a section called "Versioning"
    // would otherwise parse as a release and swallow the notes under it.
    const entries = parseChangelog(
      ['## Unreleased', '', '- pending', '', '## Versioning policy', '', '- semver'].join('\n')
    );

    expect(entries).toEqual([]);
  });

  it('carries a prerelease suffix through untouched', () => {
    expect(parseChangelog('## v2.118.0-beta.1\n\n- trying it')[0].version).toBe('2.118.0-beta.1');
  });

  it('returns nothing for a changelog with no versions in it', () => {
    expect(parseChangelog('')).toEqual([]);
    expect(parseChangelog('# Changelog\n\nNothing released yet.\n')).toEqual([]);
  });

  it('finds the current package version in the changelog this repo actually ships', () => {
    // The real file, not a fixture: this is what the release script reads and
    // what the app will show, and its shape is the thing worth pinning.
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { version: string };
    const entries = parseChangelog(readFileSync(join(root, 'CHANGELOG.md'), 'utf8'));

    const current = entries.find((e) => e.version === pkg.version);
    expect(current, `no changelog entry for v${pkg.version}`).toBeDefined();
    expect(current?.notes.length).toBeGreaterThan(0);

    // Deliberately not asserting that the newest entry *is* the running
    // version: the notes for a release are written and pushed before the
    // version bump that carries them, so between those two commits the head of
    // the changelog is legitimately one release ahead of package.json.
    expect(new Set(entries.map((e) => e.version)).size).toBe(entries.length);
    // The heading itself never leaks into a body.
    expect(entries.every((e) => !e.notes.startsWith('## v'))).toBe(true);
  });
});
