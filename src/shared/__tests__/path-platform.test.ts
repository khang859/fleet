import { describe, it, expect } from 'vitest';
import {
  isWindowsPath,
  isWslPath,
  basename,
  join,
  displayPath,
  winToWslMountPath,
  wslMountToWinPath,
  toWslUncPath,
  parseWslUncPath,
  toWindowsAccessiblePath,
  pathForPaneContext,
  toFleetImageUrl,
  toFleetPdfUrl
} from '../path-platform';

const wsl = { kind: 'wsl', distro: 'Ubuntu-24.04' } as const;

describe('isWindowsPath', () => {
  it('matches drive-letter paths with backslash', () => {
    expect(isWindowsPath('C:\\Users\\khang')).toBe(true);
  });
  it('matches drive-letter paths with forward slash', () => {
    expect(isWindowsPath('D:/projects/foo')).toBe(true);
  });
  it('matches lowercase drive letter', () => {
    expect(isWindowsPath('c:\\temp')).toBe(true);
  });
  it('rejects POSIX paths', () => {
    expect(isWindowsPath('/home/khang')).toBe(false);
  });
  it('rejects relative paths', () => {
    expect(isWindowsPath('./foo')).toBe(false);
  });
  it('rejects empty string', () => {
    expect(isWindowsPath('')).toBe(false);
  });
});

describe('isWslPath', () => {
  it('matches absolute POSIX paths', () => {
    expect(isWslPath('/home/khang')).toBe(true);
    expect(isWslPath('/mnt/c/Users/khang')).toBe(true);
  });
  it('rejects Windows paths', () => {
    expect(isWslPath('C:\\Users')).toBe(false);
  });
  it('rejects relative paths', () => {
    expect(isWslPath('home/khang')).toBe(false);
  });
});

describe('basename', () => {
  it('returns last segment of POSIX path', () => {
    expect(basename('/home/khang/dev/fleet', 'posix')).toBe('fleet');
  });
  it('returns last segment of Windows path with backslashes', () => {
    expect(basename('C:\\Users\\khang\\dev', 'win32')).toBe('dev');
  });
  it('returns last segment of Windows path with forward slashes', () => {
    expect(basename('C:/Users/khang/dev', 'win32')).toBe('dev');
  });
  it('returns last segment for WSL context (POSIX semantics)', () => {
    expect(basename('/home/khang/dev', { kind: 'wsl', distro: 'Ubuntu' })).toBe('dev');
  });
  it('strips trailing slashes', () => {
    expect(basename('/home/khang/', 'posix')).toBe('khang');
    expect(basename('C:\\Users\\', 'win32')).toBe('Users');
  });
  it('returns "Shell" for empty or root-only paths', () => {
    expect(basename('/', 'posix')).toBe('Shell');
    expect(basename('', 'posix')).toBe('Shell');
    expect(basename('C:\\', 'win32')).toBe('Shell');
  });
});

describe('join', () => {
  it('joins POSIX with forward slash', () => {
    expect(join('posix', '/home', 'khang', 'dev')).toBe('/home/khang/dev');
  });
  it('joins Windows with backslash', () => {
    expect(join('win32', 'C:\\', 'Users', 'khang')).toBe('C:\\Users\\khang');
  });
  it('joins WSL with forward slash', () => {
    expect(join({ kind: 'wsl', distro: 'Ubuntu' }, '/home', 'khang')).toBe('/home/khang');
  });
  it('collapses doubled separators', () => {
    expect(join('posix', '/home/', '/khang/', 'dev')).toBe('/home/khang/dev');
    expect(join('win32', 'C:\\Users\\', '\\khang')).toBe('C:\\Users\\khang');
  });
  it('ignores empty segments', () => {
    expect(join('posix', '/home', '', 'khang')).toBe('/home/khang');
  });
});

describe('displayPath', () => {
  const homes = { homeDir: 'C:\\Users\\khang', wslHomeByDistro: { Ubuntu: '/home/khang' } };

  it('collapses Windows home to ~', () => {
    expect(displayPath('C:\\Users\\khang\\dev', 'win32', homes)).toBe('~\\dev');
  });
  it('collapses POSIX home to ~', () => {
    expect(
      displayPath('/Users/khang/dev', 'posix', { homeDir: '/Users/khang', wslHomeByDistro: {} })
    ).toBe('~/dev');
  });
  it('collapses WSL home to ~ when distro home is known', () => {
    expect(displayPath('/home/khang/dev', { kind: 'wsl', distro: 'Ubuntu' }, homes)).toBe('~/dev');
  });
  it('collapses /mnt/c/Users/khang/... to ~/... when win-home is C:\\Users\\khang', () => {
    expect(displayPath('/mnt/c/Users/khang/dev', { kind: 'wsl', distro: 'Ubuntu' }, homes)).toBe(
      '~/dev'
    );
  });
  it('leaves /mnt/c/... uncollapsed when not under win-home', () => {
    expect(displayPath('/mnt/c/Program Files', { kind: 'wsl', distro: 'Ubuntu' }, homes)).toBe(
      '/mnt/c/Program Files'
    );
  });
  it('returns path unchanged when no rule matches', () => {
    expect(displayPath('D:\\Other', 'win32', homes)).toBe('D:\\Other');
    expect(displayPath('/etc/hosts', { kind: 'wsl', distro: 'Ubuntu' }, homes)).toBe('/etc/hosts');
  });
  it('handles exact home (no trailing path)', () => {
    expect(displayPath('C:\\Users\\khang', 'win32', homes)).toBe('~');
    expect(displayPath('/home/khang', { kind: 'wsl', distro: 'Ubuntu' }, homes)).toBe('~');
  });
});

describe('wslMountToWinPath', () => {
  it('maps a single-drive automount path to a drive path', () => {
    expect(wslMountToWinPath('/mnt/c/Users/khang')).toBe('C:\\Users\\khang');
    expect(wslMountToWinPath('/mnt/d/projects/foo bar')).toBe('D:\\projects\\foo bar');
  });
  it('maps a bare drive mount to the drive root', () => {
    expect(wslMountToWinPath('/mnt/d')).toBe('D:\\');
    expect(wslMountToWinPath('/mnt/c/')).toBe('C:\\');
  });
  it('rejects multi-char automount entries (wsl, wslg)', () => {
    expect(wslMountToWinPath('/mnt/wsl/foo')).toBeNull();
    expect(wslMountToWinPath('/mnt/wslg')).toBeNull();
  });
  it('rejects non-mount POSIX paths', () => {
    expect(wslMountToWinPath('/home/khang')).toBeNull();
  });
  it('round-trips with winToWslMountPath', () => {
    expect(winToWslMountPath('C:\\Users\\khang')).toBe('/mnt/c/Users/khang');
    expect(wslMountToWinPath('/mnt/c/Users/khang')).toBe('C:\\Users\\khang');
  });
});

describe('toWslUncPath', () => {
  it('builds a modern UNC path', () => {
    expect(toWslUncPath('Ubuntu-24.04', '/home/khang/pic.png')).toBe(
      '\\\\wsl.localhost\\Ubuntu-24.04\\home\\khang\\pic.png'
    );
  });
  it('handles the distro root', () => {
    expect(toWslUncPath('Ubuntu', '/')).toBe('\\\\wsl.localhost\\Ubuntu\\');
  });
});

describe('parseWslUncPath', () => {
  it('parses modern UNC with backslashes', () => {
    expect(parseWslUncPath('\\\\wsl.localhost\\Ubuntu-24.04\\home\\khang')).toEqual({
      distro: 'Ubuntu-24.04',
      posixPath: '/home/khang'
    });
  });
  it('parses legacy wsl$ form with forward slashes', () => {
    expect(parseWslUncPath('//wsl$/Ubuntu/home/khang')).toEqual({
      distro: 'Ubuntu',
      posixPath: '/home/khang'
    });
  });
  it('returns root for a bare distro path', () => {
    expect(parseWslUncPath('\\\\wsl.localhost\\Ubuntu')).toEqual({
      distro: 'Ubuntu',
      posixPath: '/'
    });
  });
  it('rejects non-WSL paths', () => {
    expect(parseWslUncPath('C:\\Users')).toBeNull();
    expect(parseWslUncPath('\\\\someserver\\share')).toBeNull();
    expect(parseWslUncPath('/home/khang')).toBeNull();
  });
  it('round-trips with toWslUncPath', () => {
    const unc = toWslUncPath('Ubuntu-24.04', '/home/khang/a b.png');
    expect(parseWslUncPath(unc)).toEqual({
      distro: 'Ubuntu-24.04',
      posixPath: '/home/khang/a b.png'
    });
  });
});

describe('toWindowsAccessiblePath', () => {
  it('passes through win32 and posix contexts untouched', () => {
    expect(toWindowsAccessiblePath('/home/khang', 'posix')).toBe('/home/khang');
    expect(toWindowsAccessiblePath('C:\\x', 'win32')).toBe('C:\\x');
  });
  it('maps WSL /mnt/<drive> to a drive path', () => {
    expect(toWindowsAccessiblePath('/mnt/c/Users/khang/pic.png', wsl)).toBe(
      'C:\\Users\\khang\\pic.png'
    );
  });
  it('bridges other WSL POSIX paths to UNC', () => {
    expect(toWindowsAccessiblePath('/home/khang/pic.png', wsl)).toBe(
      '\\\\wsl.localhost\\Ubuntu-24.04\\home\\khang\\pic.png'
    );
  });
  it('falls through /mnt/wsl to UNC (not a drive)', () => {
    expect(toWindowsAccessiblePath('/mnt/wslg/foo.png', wsl)).toBe(
      '\\\\wsl.localhost\\Ubuntu-24.04\\mnt\\wslg\\foo.png'
    );
  });
  it('passes through paths already in Windows/UNC form', () => {
    expect(toWindowsAccessiblePath('D:\\img.png', wsl)).toBe('D:\\img.png');
    expect(toWindowsAccessiblePath('\\\\wsl.localhost\\Ubuntu\\x', wsl)).toBe(
      '\\\\wsl.localhost\\Ubuntu\\x'
    );
  });
});

describe('pathForPaneContext', () => {
  it('passes through for win32 and posix panes', () => {
    expect(pathForPaneContext('C:\\x', 'win32')).toBe('C:\\x');
    expect(pathForPaneContext('/home/k', 'posix')).toBe('/home/k');
  });
  it('converts a Windows drive path to /mnt for a WSL pane', () => {
    expect(pathForPaneContext('C:\\Users\\khang\\f.txt', wsl)).toBe('/mnt/c/Users/khang/f.txt');
  });
  it('converts a same-distro UNC path to POSIX for a WSL pane', () => {
    expect(pathForPaneContext('\\\\wsl.localhost\\Ubuntu-24.04\\home\\khang', wsl)).toBe(
      '/home/khang'
    );
  });
  it('leaves an other-distro UNC path alone', () => {
    expect(pathForPaneContext('\\\\wsl.localhost\\Debian\\home\\k', wsl)).toBe(
      '\\\\wsl.localhost\\Debian\\home\\k'
    );
  });
  it('leaves an already-POSIX path alone for a WSL pane', () => {
    expect(pathForPaneContext('/home/khang/f.txt', wsl)).toBe('/home/khang/f.txt');
  });
});

describe('toFleetImageUrl / toFleetPdfUrl', () => {
  it('encodes a drive path with empty authority', () => {
    expect(toFleetImageUrl('C:\\Users\\khang\\My Pic.png')).toBe(
      'fleet-image:///C%3A/Users/khang/My%20Pic.png'
    );
  });
  it('encodes a UNC path with the quad-slash form', () => {
    expect(toFleetImageUrl('\\\\wsl.localhost\\Ubuntu-24.04\\home\\khang\\pic.png')).toBe(
      'fleet-image:////wsl.localhost/Ubuntu-24.04/home/khang/pic.png'
    );
  });
  it('encodes a POSIX path', () => {
    expect(toFleetImageUrl('/home/khang/pic.png')).toBe('fleet-image:///home/khang/pic.png');
  });
  it('encodes Unicode, # and ? safely', () => {
    expect(toFleetImageUrl('C:\\a\\rés#?.png')).toBe('fleet-image:///C%3A/a/r%C3%A9s%23%3F.png');
  });
  it('uses the fleet-pdf scheme for pdfs', () => {
    expect(toFleetPdfUrl('C:\\docs\\a.pdf')).toBe('fleet-pdf:///C%3A/docs/a.pdf');
  });
});
