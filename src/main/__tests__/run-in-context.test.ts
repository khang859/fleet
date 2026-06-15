import { describe, it, expect } from 'vitest';
import { buildContextArgv } from '../run-in-context';

const wsl = { kind: 'wsl', distro: 'Ubuntu-24.04' } as const;

describe('buildContextArgv', () => {
  describe('native contexts', () => {
    it('passes the command and args through unchanged for win32', () => {
      expect(buildContextArgv('win32', 'git', ['status'], 'C:\\repo')).toEqual({
        file: 'git',
        argv: ['status']
      });
    });

    it('passes through for posix and ignores cwd (applied via spawn options)', () => {
      expect(buildContextArgv('posix', 'rg', ['-n', 'foo', '/home/k'], '/home/k')).toEqual({
        file: 'rg',
        argv: ['-n', 'foo', '/home/k']
      });
    });
  });

  describe('wsl context', () => {
    it('wraps the command in wsl.exe with --cd and --exec', () => {
      const { file, argv } = buildContextArgv(wsl, 'git', ['status'], '/home/khang/repo');
      // wslExePath resolves to System32\wsl.exe; assert the basename, not the prefix.
      expect(file.replace(/\\/g, '/').endsWith('System32/wsl.exe')).toBe(true);
      expect(argv).toEqual([
        '-d',
        'Ubuntu-24.04',
        '--cd',
        '/home/khang/repo',
        '--exec',
        'git',
        'status'
      ]);
    });

    it('omits --cd when no cwd is given', () => {
      const { argv } = buildContextArgv(wsl, 'rg', ['-n', 'foo']);
      expect(argv).toEqual(['-d', 'Ubuntu-24.04', '--exec', 'rg', '-n', 'foo']);
    });

    it('preserves argv verbatim (no shell interpolation)', () => {
      const { argv } = buildContextArgv(wsl, 'git', ['diff', '--no-index', '/dev/null', 'a b.txt']);
      expect(argv).toEqual([
        '-d',
        'Ubuntu-24.04',
        '--exec',
        'git',
        'diff',
        '--no-index',
        '/dev/null',
        'a b.txt'
      ]);
    });
  });
});
