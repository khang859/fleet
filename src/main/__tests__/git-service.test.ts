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

// Mock the WSL spawn boundary so we can drive git output without a real distro.
const mockExecInContext = vi.fn();
vi.mock('../run-in-context', () => ({
  execInContext: (...args: unknown[]) => mockExecInContext(...args)
}));

const wsl = { kind: 'wsl', distro: 'Ubuntu-24.04' } as const;
const ok = (
  stdout: string
): { stdout: string; stderr: string; code: number; timedOut: boolean } => ({
  stdout,
  stderr: '',
  code: 0,
  timedOut: false
});

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

  describe('WSL context (runs git inside the distro)', () => {
    // Resolve based on the git subcommand so a single mock covers a full status.
    function routeGit(gitArgs: string[]): {
      stdout: string;
      stderr: string;
      code: number;
      timedOut: boolean;
    } {
      const a = gitArgs.join(' ');
      if (a.includes('rev-parse --is-inside-work-tree')) return ok('true\n');
      if (a.includes('rev-parse --show-toplevel')) return ok('/home/khang/repo\n');
      if (a.includes('branch --show-current')) return ok('main\n');
      if (a.includes('status --porcelain=v1')) {
        return ok(' M src/app.ts\n?? new-file.ts\n');
      }
      if (a.includes('diff HEAD --numstat')) return ok('3\t1\tsrc/app.ts\n');
      if (a.includes('diff --no-index')) {
        return {
          stdout:
            'diff --git a/new-file.ts b/new-file.ts\nnew file\n--- /dev/null\n+++ b/new-file.ts\n@@ -0,0 +1 @@\n+content\n',
          stderr: '',
          code: 1, // --no-index always exits 1 when files differ
          timedOut: false
        };
      }
      if (a.includes('diff HEAD')) {
        return ok(
          'diff --git a/src/app.ts b/src/app.ts\n--- a/src/app.ts\n+++ b/src/app.ts\n@@ -1 +1 @@\n-old\n+new\n'
        );
      }
      return ok('');
    }

    beforeEach(() => {
      mockExecInContext.mockImplementation(async (_ctx, _cmd, args: string[]) => routeGit(args));
    });

    it('checkIsRepo runs rev-parse inside the distro', async () => {
      const result = await service.checkIsRepo('/home/khang/repo', wsl);
      expect(result).toEqual({ isRepo: true });
      // never falls back to simple-git for a WSL pane
      expect(mockGit.checkIsRepo).not.toHaveBeenCalled();
      const [ctx, cmd, args] = mockExecInContext.mock.calls[0];
      expect(ctx).toEqual(wsl);
      expect(cmd).toBe('git');
      expect(args).toEqual(['rev-parse', '--is-inside-work-tree']);
    });

    it('checkIsRepo returns false when not a work tree', async () => {
      mockExecInContext.mockResolvedValueOnce({
        stdout: '',
        stderr: 'fatal: not a git repository',
        code: 128,
        timedOut: false
      });
      expect(await service.checkIsRepo('/tmp', wsl)).toEqual({ isRepo: false });
    });

    it('repoRoot returns the posix toplevel', async () => {
      expect(await service.repoRoot('/home/khang/repo', wsl)).toEqual({
        root: '/home/khang/repo'
      });
    });

    it('getFullStatus builds the same payload shape as native', async () => {
      const result = await service.getFullStatus('/home/khang/repo', undefined, wsl);
      expect(result.isRepo).toBe(true);
      expect(result.branch).toBe('main');
      expect(result.files).toHaveLength(2);
      expect(result.files[0]).toMatchObject({
        path: 'src/app.ts',
        status: 'modified',
        insertions: 3,
        deletions: 1
      });
      expect(result.files[1]).toMatchObject({ path: 'new-file.ts', status: 'untracked' });
      expect(result.diff).toContain('diff --git a/src/app.ts');
      expect(result.diff).toContain('diff --git a/new-file.ts');
      expect(result.error).toBeUndefined();
      expect(mockGit.status).not.toHaveBeenCalled();
    });

    it('getFullStatus handles a rename in porcelain output', async () => {
      mockExecInContext.mockImplementation(async (_ctx, _cmd, args: string[]) => {
        const a = args.join(' ');
        if (a.includes('rev-parse --is-inside-work-tree')) return ok('true\n');
        if (a.includes('branch --show-current')) return ok('main\n');
        if (a.includes('status --porcelain=v1')) return ok('R  old.ts -> new.ts\n');
        if (a.includes('--numstat')) return ok('1\t1\tnew.ts\n');
        if (a.includes('diff HEAD')) return ok('diff --git a/new.ts b/new.ts\n');
        return ok('');
      });
      const result = await service.getFullStatus('/home/khang/repo', undefined, wsl);
      expect(result.files).toHaveLength(1);
      expect(result.files[0]).toMatchObject({ path: 'new.ts', status: 'renamed' });
    });
  });
});
