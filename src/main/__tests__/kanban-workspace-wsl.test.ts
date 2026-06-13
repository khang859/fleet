import { describe, it, expect, vi, beforeEach } from 'vitest';
import { join } from 'path';

// Route every git/gh/sh invocation through a single mock so no real distro,
// repo or filesystem is touched; fs ops are mocked too. path-platform stays
// real (its UNC↔POSIX transforms are what we're asserting).
const mockExec = vi.fn();
vi.mock('child_process', () => ({
  execFileSync: (file: string, argv: string[], opts: unknown) => mockExec(file, argv, opts)
}));

const mockMkdir = vi.fn();
const mockRm = vi.fn();
const mockExists = vi.fn();
vi.mock('fs', () => ({
  mkdirSync: (...a: unknown[]) => mockMkdir(...a),
  rmSync: (...a: unknown[]) => mockRm(...a),
  existsSync: (...a: unknown[]) => mockExists(...a)
}));

vi.mock('../wsl-service', () => ({ wslExePath: () => 'wsl.exe' }));

import { prepareWorkspace, removeWorktree } from '../kanban/workspace';

const DISTRO = 'Ubuntu-24.04';
const WSL_REPO = `\\\\wsl.localhost\\${DISTRO}\\home\\khang\\projects\\foo`;
const REPO_POSIX = '/home/khang/projects/foo';

// First mock call whose git subcommand includes `verb`. Native calls run `git`
// directly (verb in argv); WSL calls run `wsl.exe … --exec git <args>` (verb
// after the 'git' token).
function gitCall(verb: string): [string, string[], unknown] | undefined {
  return mockExec.mock.calls.find((c) => {
    const argv = c[1] as string[];
    const gi = argv.indexOf('git');
    const gitArgs = c[0] === 'wsl.exe' && gi >= 0 ? argv.slice(gi + 1) : argv;
    return gitArgs.includes(verb);
  }) as [string, string[], unknown] | undefined;
}

describe('kanban workspace WSL routing', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockExists.mockReturnValue(false);
    mockExec.mockImplementation((_file: string, argv: string[]) => {
      const s = argv.join(' ');
      if (s.includes('echo "$HOME"')) return '/home/khang\n';
      if (s.includes('rev-parse --abbrev-ref')) return 'main\n';
      if (s.includes('branch --list')) return '';
      return '';
    });
  });

  it('prepareWorkspace runs git inside the distro and bases the worktree on the distro fs', () => {
    const { path, branchName, baseBranch } = prepareWorkspace({
      kind: 'worktree',
      taskId: 'wsltask',
      workspacesRoot: 'C:\\ignored',
      worktreesRoot: 'C:\\ignored\\worktrees',
      repoPath: WSL_REPO
    });

    // Persisted/returned path is the Windows-accessible UNC on the distro home,
    // NOT the caller's C:\ worktreesRoot (a worktree must live on the repo's fs).
    expect(path).toBe(
      `\\\\wsl.localhost\\${DISTRO}\\home\\khang\\.fleet\\kanban\\worktrees\\wsltask`
    );
    expect(branchName).toBe('kanban/wsltask');
    expect(baseBranch).toBe('main');

    // git worktree add ran inside the distro against POSIX paths.
    const add = gitCall('worktree');
    expect(add?.[0]).toBe('wsl.exe');
    expect(add?.[1]).toEqual([
      '-d',
      DISTRO,
      '--exec',
      'git',
      '-C',
      REPO_POSIX,
      'worktree',
      'add',
      '/home/khang/.fleet/kanban/worktrees/wsltask',
      '-b',
      'kanban/wsltask'
    ]);

    // The worktree root was created over the UNC bridge (Windows-accessible).
    expect(mockMkdir).toHaveBeenCalledWith(
      `\\\\wsl.localhost\\${DISTRO}\\home\\khang\\.fleet\\kanban\\worktrees`,
      { recursive: true }
    );
  });

  it('removeWorktree force-removes inside the distro using the POSIX worktree path', () => {
    // is-ancestor succeeds → branch counts as merged → it gets deleted.
    mockExec.mockImplementation(() => '');
    const wsPath = `\\\\wsl.localhost\\${DISTRO}\\home\\khang\\.fleet\\kanban\\worktrees\\x`;

    removeWorktree({
      repoPath: WSL_REPO,
      workspacePath: wsPath,
      branchName: 'kanban/x',
      baseBranch: 'main'
    });

    const remove = gitCall('worktree');
    expect(remove?.[0]).toBe('wsl.exe');
    expect(remove?.[1]).toEqual([
      '-d',
      DISTRO,
      '--exec',
      'git',
      '-C',
      REPO_POSIX,
      'worktree',
      'remove',
      '--force',
      '/home/khang/.fleet/kanban/worktrees/x'
    ]);
  });

  it('a native repo path is unchanged: plain git, caller-supplied worktree root', () => {
    const WT = join('C:\\fleet', 'worktrees');
    const { path } = prepareWorkspace({
      kind: 'worktree',
      taskId: 't',
      workspacesRoot: 'C:\\fleet',
      worktreesRoot: WT,
      repoPath: 'C:\\repos\\bar'
    });

    expect(path).toBe(join(WT, 't'));
    // No call ever went through wsl.exe.
    expect(mockExec.mock.calls.every((c) => c[0] === 'git')).toBe(true);
    const add = gitCall('worktree');
    expect(add?.[0]).toBe('git');
    expect(add?.[1]).toEqual([
      '-C',
      'C:\\repos\\bar',
      'worktree',
      'add',
      join(WT, 't'),
      '-b',
      'kanban/t'
    ]);
  });
});
