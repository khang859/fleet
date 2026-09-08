import { describe, it, expect, vi } from 'vitest';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

vi.mock('electron', () => ({
  app: { isPackaged: false, getPath: () => tmpdir() }
}));

const { loadReleaseHistory } = await import('../release-notes-history');

describe('loadReleaseHistory', () => {
  it('resolves to an empty history when the changelog is not there', async () => {
    // The failure this has to survive: a bundled-resource path that is wrong in
    // a packaged build. The list goes missing; nothing else on the page does.
    await expect(loadReleaseHistory(join(tmpdir(), 'fleet-no-such-changelog.md'))).resolves.toEqual(
      []
    );
  });

  it('parses a changelog it can read', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fleet-changelog-'));
    const path = join(dir, 'CHANGELOG.md');
    writeFileSync(path, '# Changelog\n\n## v2.0.0\n\n- newer\n\n## v1.0.0\n\n- older\n');

    await expect(loadReleaseHistory(path)).resolves.toEqual([
      { version: '2.0.0', notes: '- newer' },
      { version: '1.0.0', notes: '- older' }
    ]);
  });
});
