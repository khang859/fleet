import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock async fs so we can count how often session files are actually re-read.
const { readFile, readdir, stat } = vi.hoisted(() => ({
  readFile: vi.fn(),
  readdir: vi.fn(),
  stat: vi.fn()
}));
vi.mock('node:fs/promises', () => ({ readFile, readdir, stat }));

import { listRuneSessions, __clearRuneSummaryCache } from '../rune-source';

const SESSION = JSON.stringify({ id: 's1', cwd: '/Users/me/proj', name: 'demo' });

describe('listRuneSessions caching', () => {
  beforeEach(() => {
    __clearRuneSummaryCache();
    readFile.mockReset();
    readdir.mockReset();
    stat.mockReset();
    readdir.mockResolvedValue(['s1.json']);
    stat.mockResolvedValue({ mtimeMs: 111, size: 222 });
    readFile.mockResolvedValue(SESSION);
  });

  it('does not re-read a session whose mtime/size is unchanged', async () => {
    const first = await listRuneSessions();
    expect(first).toHaveLength(1);
    expect(readFile).toHaveBeenCalledTimes(1);

    const second = await listRuneSessions();
    expect(second[0]).toEqual(first[0]);
    expect(readFile).toHaveBeenCalledTimes(1);
  });

  it('re-reads when mtime or size changes', async () => {
    await listRuneSessions();
    expect(readFile).toHaveBeenCalledTimes(1);

    stat.mockResolvedValue({ mtimeMs: 999, size: 500 });
    await listRuneSessions();
    expect(readFile).toHaveBeenCalledTimes(2);
  });

  it('drops cache entries for sessions that disappear', async () => {
    await listRuneSessions();
    expect(readFile).toHaveBeenCalledTimes(1);

    readdir.mockResolvedValue([]);
    expect(await listRuneSessions()).toHaveLength(0);

    readdir.mockResolvedValue(['s1.json']);
    await listRuneSessions();
    expect(readFile).toHaveBeenCalledTimes(2);
  });
});
