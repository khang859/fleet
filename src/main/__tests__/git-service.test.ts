import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GitService } from '../git-service';

// Mock simple-git
const mockGit = {
  checkIsRepo: vi.fn(),
  branch: vi.fn(),
  status: vi.fn(),
  diff: vi.fn(),
  raw: vi.fn()
};

vi.mock('simple-git', () => ({
  simpleGit: vi.fn(() => mockGit)
}));

describe('GitService', () => {
  let service: GitService;

  beforeEach(() => {
    vi.clearAllMocks();
    service = new GitService();
  });

  describe('checkIsRepo', () => {
    it('returns true when inside a git repo', async () => {
      mockGit.checkIsRepo.mockResolvedValue(true);
      const result = await service.checkIsRepo('/some/repo');
      expect(result).toEqual({ isRepo: true });
    });

    it('returns false when not inside a git repo', async () => {
      mockGit.checkIsRepo.mockResolvedValue(false);
      const result = await service.checkIsRepo('/not/a/repo');
      expect(result).toEqual({ isRepo: false });
    });

    it('returns false when git throws', async () => {
      mockGit.checkIsRepo.mockRejectedValue(new Error('git not found'));
      const result = await service.checkIsRepo('/some/path');
      expect(result).toEqual({ isRepo: false });
    });
  });

  describe('getFullStatus', () => {
    it('returns not-a-repo payload when not in a repo', async () => {
      mockGit.checkIsRepo.mockResolvedValue(false);
      const result = await service.getFullStatus('/not/a/repo');
      expect(result).toEqual({
        isRepo: false,
        branch: '',
        files: [],
        diff: ''
      });
    });

    it('returns full status for a repo with changes', async () => {
      mockGit.checkIsRepo.mockResolvedValue(true);
      mockGit.branch.mockResolvedValue({ current: 'main' });
      mockGit.status.mockResolvedValue({
        files: [
          { path: 'src/app.ts', index: ' ', working_dir: 'M' },
          { path: 'new-file.ts', index: '?', working_dir: '?' }
        ],
        not_added: ['new-file.ts']
      });
      mockGit.diff.mockResolvedValue(
        'diff --git a/src/app.ts b/src/app.ts\n--- a/src/app.ts\n+++ b/src/app.ts\n@@ -1 +1 @@\n-old\n+new\n'
      );
      // diffSummary for tracked files
      mockGit.raw.mockImplementation(async (args: string[]) => {
        if (args.includes('--numstat') && !args.includes('--no-index')) {
          return Promise.resolve('3\t1\tsrc/app.ts\n');
        }
        // For untracked file diff
        if (args.includes('--no-index')) {
          return Promise.resolve(
            'diff --git a/new-file.ts b/new-file.ts\nnew file\n--- /dev/null\n+++ b/new-file.ts\n@@ -0,0 +1 @@\n+content\n'
          );
        }
        return Promise.resolve('');
      });

      const result = await service.getFullStatus('/some/repo');

      expect(result.isRepo).toBe(true);
      expect(result.branch).toBe('main');
      expect(result.files).toHaveLength(2);
      expect(result.files[0]).toMatchObject({ path: 'src/app.ts', status: 'modified' });
      expect(result.files[1]).toMatchObject({ path: 'new-file.ts', status: 'untracked' });
      expect(result.diff).toContain('diff --git');
      expect(result.error).toBeUndefined();
    });

    it('returns error payload when git operation fails', async () => {
      mockGit.checkIsRepo.mockResolvedValue(true);
      mockGit.branch.mockRejectedValue(new Error('fatal: corrupted repo'));

      const result = await service.getFullStatus('/broken/repo');

      expect(result.isRepo).toBe(true);
      expect(result.error).toBe('fatal: corrupted repo');
    });
  });
});
