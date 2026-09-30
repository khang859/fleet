import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock async fs so we can count how often transcripts are actually re-read.
const { readFile, readdir, stat } = vi.hoisted(() => ({
  readFile: vi.fn(),
  readdir: vi.fn(),
  stat: vi.fn()
}));
vi.mock('node:fs/promises', () => ({ readFile, readdir, stat }));

import { listClaudeSessions, __clearClaudeSummaryCache } from '../claude-source';

const TRANSCRIPT = [
  JSON.stringify({
    type: 'user',
    uuid: 'u1',
    cwd: '/Users/me/proj',
    message: { role: 'user', content: 'hello there' }
  })
].join('\n');

/** The projects root holds `proj`, which holds `files`; no session has subagents. */
function listing(files: string[]): void {
  readdir.mockImplementation((p: string) => {
    if (String(p).endsWith('projects')) return ['proj'];
    if (String(p).endsWith('subagents')) throw new Error('ENOENT');
    return files;
  });
}

describe('listClaudeSessions caching', () => {
  beforeEach(() => {
    __clearClaudeSummaryCache();
    readFile.mockReset();
    readdir.mockReset();
    stat.mockReset();
    // root -> one project dir; project dir -> one transcript file
    listing(['sess.jsonl']);
    stat.mockResolvedValue({ mtimeMs: 111, size: 222 });
    readFile.mockResolvedValue(TRANSCRIPT);
  });

  it('does not re-read a transcript whose mtime/size is unchanged', async () => {
    const first = await listClaudeSessions();
    expect(first).toHaveLength(1);
    expect(readFile).toHaveBeenCalledTimes(1);

    // Second scan, nothing changed on disk -> must serve from cache, no re-read.
    const second = await listClaudeSessions();
    expect(second).toHaveLength(1);
    expect(second[0]).toEqual(first[0]);
    expect(readFile).toHaveBeenCalledTimes(1);
  });

  it('re-reads when mtime or size changes', async () => {
    await listClaudeSessions();
    expect(readFile).toHaveBeenCalledTimes(1);

    stat.mockResolvedValue({ mtimeMs: 999, size: 500 }); // file grew (new message appended)
    await listClaudeSessions();
    expect(readFile).toHaveBeenCalledTimes(2);
  });

  it('drops cache entries for transcripts that disappear', async () => {
    await listClaudeSessions();
    expect(readFile).toHaveBeenCalledTimes(1);

    // File is gone now.
    listing([]);
    const out = await listClaudeSessions();
    expect(out).toHaveLength(0);

    // It comes back -> must be re-read, proving the stale entry was pruned.
    listing(['sess.jsonl']);
    await listClaudeSessions();
    expect(readFile).toHaveBeenCalledTimes(2);
  });
});
