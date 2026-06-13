import { describe, it, expect, vi, beforeEach } from 'vitest';
import { WorktreeService } from '../worktree-service';
import { toWindowsAccessiblePath } from '../../shared/path-platform';

// Native path uses simple-git; WSL path uses execInContext. Mock both boundaries
// plus the fs calls so no real distro / filesystem is touched.
const mockRaw = vi.fn();
vi.mock('simple-git', () => ({
  simpleGit: vi.fn(() => ({ raw: (args: string[]) => mockRaw(args) }))
}));

const mockExecInContext = vi.fn();
vi.mock('../run-in-context', () => ({
  execInContext: (...args: unknown[]) => mockExecInContext(...args)
}));

const mockMkdir = vi.fn();
const mockRm = vi.fn();
vi.mock('fs/promises', () => ({
  mkdir: (...args: unknown[]) => mockMkdir(...args),
  rm: (...args: unknown[]) => mockRm(...args)
}));

// Avoid loading the real WslService implementation; we inject a stub anyway.
vi.mock('../wsl-service', () => ({ WslService: class {} }));

const wsl = { kind: 'wsl', distro: 'Ubuntu-24.04' } as const;
const ok = (
  stdout: string
): { stdout: string; stderr: string; code: number; timedOut: boolean } => ({
  stdout,
  stderr: '',
  code: 0,
  timedOut: false
});

// A stub WslService whose home is a known posix path (resolved in beforeEach).
const wslStub = { homeDir: vi.fn() };

describe('WorktreeService', () => {
  let service: WorktreeService;

  beforeEach(() => {
    vi.clearAllMocks();
    wslStub.homeDir.mockResolvedValue('/home/khang');
    service = new WorktreeService(wslStub as never);
  });

  describe('native (no context)', () => {
    it('create runs git via simple-git, never inside a distro', async () => {
      mockMkdir.mockResolvedValue(undefined);
      // worktree list (empty) then branch list (empty) then worktree add.
      mockRaw.mockResolvedValue('');

      const { worktreePath, branchName } = await service.create('/repo/proj');

      expect(mockExecInContext).not.toHaveBeenCalled();
      expect(branchName.startsWith('proj-')).toBe(true);
      // base mirrors the native ~/.fleet/worktrees/<repo> layout.
      expect(worktreePath.endsWith(branchName)).toBe(true);
      // the final raw call is the worktree add for that branch
      const addCall = mockRaw.mock.calls.find((c) => c[0][0] === 'worktree' && c[0][1] === 'add');
      expect(addCall?.[0]).toEqual(['worktree', 'add', worktreePath, '-b', branchName]);
    });
  });

  describe('WSL context (runs git inside the distro)', () => {
    function routeGit(gitArgs: string[]): ReturnType<typeof ok> {
      const a = gitArgs.join(' ');
      if (a.startsWith('worktree list')) return ok('');
      if (a.startsWith('branch --list')) return ok('');
      if (a.startsWith('worktree add')) return ok('');
      return ok('');
    }

    beforeEach(() => {
      mockMkdir.mockResolvedValue(undefined);
      mockExecInContext.mockImplementation(async (_ctx, _cmd, args: string[]) => routeGit(args));
    });

    it('create runs git inside the distro and bases the worktree under the distro home', async () => {
      const { worktreePath, branchName } = await service.create('/home/khang/projects/proj', wsl);

      // simple-git is never used for a WSL pane.
      expect(mockRaw).not.toHaveBeenCalled();
      expect(wslStub.homeDir).toHaveBeenCalledWith('Ubuntu-24.04');

      // Worktree lives on the distro filesystem, under ~/.fleet/worktrees/<repo>.
      const base = '/home/khang/.fleet/worktrees/proj';
      expect(worktreePath).toBe(`${base}/${branchName}`);
      expect(branchName.startsWith('proj-')).toBe(true);

      // git worktree add ran inside the distro with the repo as cwd. Call order
      // in create() is fixed: [0] worktree list, [1] branch --list, [2] worktree add.
      const [ctx, cmd, args, opts] = mockExecInContext.mock.calls[2];
      expect(ctx).toEqual(wsl);
      expect(cmd).toBe('git');
      expect(args).toEqual(['worktree', 'add', worktreePath, '-b', branchName]);
      expect(opts).toMatchObject({ cwd: '/home/khang/projects/proj' });

      // The base dir is created over the UNC bridge (Windows-accessible form).
      expect(mockMkdir).toHaveBeenCalledWith(toWindowsAccessiblePath(base, wsl), {
        recursive: true
      });
    });

    it('list parses porcelain output produced inside the distro', async () => {
      mockExecInContext.mockResolvedValueOnce(
        ok('worktree /home/khang/projects/proj\nbranch refs/heads/main\n')
      );
      const worktrees = await service.list('/home/khang/projects/proj', wsl);
      expect(worktrees).toEqual([{ path: '/home/khang/projects/proj', branch: 'main' }]);
    });

    it('remove resolves the main repo and prunes inside the distro', async () => {
      mockExecInContext.mockImplementation(async (_ctx, _cmd, args: string[]) => {
        const a = args.join(' ');
        if (a.includes('--git-common-dir')) return ok('/home/khang/projects/proj/.git\n');
        return ok('');
      });
      await service.remove('/home/khang/.fleet/worktrees/proj/proj-bold-mast-cove', wsl);

      // Call order in remove(): [0] rev-parse --git-common-dir, [1] worktree remove.
      const removeCall = mockExecInContext.mock.calls[1];
      expect(removeCall[2]).toEqual(['worktree', 'remove', expect.any(String)]);
      // worktree remove runs with the resolved main repo (posix) as cwd.
      expect(removeCall[3]).toMatchObject({ cwd: '/home/khang/projects/proj' });
      expect(mockRaw).not.toHaveBeenCalled();
    });
  });
});
