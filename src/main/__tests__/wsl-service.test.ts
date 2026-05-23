import { describe, it, expect, vi } from 'vitest';
import { parseListVerbose, WslService } from '../wsl-service';

describe('parseListVerbose', () => {
  it('parses a real-world wsl --list --verbose output (UTF-16LE)', () => {
    // Simulated output: '  NAME            STATE           VERSION\n* Ubuntu-22.04    Running         2\n  Debian          Stopped         2\n'
    const utf8 =
      '  NAME            STATE           VERSION\r\n' +
      '* Ubuntu-22.04    Running         2\r\n' +
      '  Debian          Stopped         2\r\n';
    // Encode to UTF-16LE with BOM to match wsl.exe output
    const bom = Buffer.from([0xff, 0xfe]);
    const body = Buffer.from(utf8, 'utf16le');
    const utf16le = Buffer.concat([bom, body]);

    const distros = parseListVerbose(utf16le);

    expect(distros).toEqual([
      { name: 'Ubuntu-22.04', version: 2, isDefault: true, state: 'running' },
      { name: 'Debian', version: 2, isDefault: false, state: 'stopped' }
    ]);
  });

  it('handles output with no default distro asterisk', () => {
    const utf8 = '  NAME      STATE     VERSION\r\n  Alpine    Running   2\r\n';
    const utf16le = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(utf8, 'utf16le')]);
    const distros = parseListVerbose(utf16le);
    expect(distros).toEqual([{ name: 'Alpine', version: 2, isDefault: false, state: 'running' }]);
  });

  it('returns empty array when no distros are listed', () => {
    const utf8 = 'Windows Subsystem for Linux has no installed distributions.\r\n';
    const utf16le = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(utf8, 'utf16le')]);
    expect(parseListVerbose(utf16le)).toEqual([]);
  });

  it('maps Installing state', () => {
    const utf8 = '  NAME      STATE        VERSION\r\n  Ubuntu    Installing   2\r\n';
    const utf16le = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(utf8, 'utf16le')]);
    const distros = parseListVerbose(utf16le);
    expect(distros[0].state).toBe('installing');
  });
});

describe('WslService.listDistros', () => {
  it('invokes wsl.exe --list --verbose and parses output', async () => {
    const utf8 = '  NAME      STATE     VERSION\r\n* Ubuntu    Running   2\r\n';
    const utf16le = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(utf8, 'utf16le')]);

    const exec = vi.fn().mockResolvedValue({ stdout: utf16le, stderr: Buffer.alloc(0) });
    const svc = new WslService({ exec });

    const distros = await svc.listDistros();

    expect(exec).toHaveBeenCalledWith('wsl.exe', ['--list', '--verbose'], expect.anything());
    expect(distros).toEqual([{ name: 'Ubuntu', version: 2, isDefault: true, state: 'running' }]);
  });

  it('returns empty array when wsl.exe exits non-zero', async () => {
    const exec = vi.fn().mockRejectedValue(new Error('wsl not installed'));
    const svc = new WslService({ exec });
    expect(await svc.listDistros()).toEqual([]);
  });
});

describe('WslService.homeDir', () => {
  it('runs sh -c "echo $HOME" inside the distro and caches', async () => {
    const exec = vi.fn().mockResolvedValueOnce({
      stdout: Buffer.from('/home/khang\n', 'utf-8'),
      stderr: Buffer.alloc(0)
    });
    const svc = new WslService({ exec });

    expect(await svc.homeDir('Ubuntu')).toBe('/home/khang');
    expect(await svc.homeDir('Ubuntu')).toBe('/home/khang'); // cached, no second exec

    expect(exec).toHaveBeenCalledTimes(1);
    expect(exec).toHaveBeenCalledWith(
      'wsl.exe',
      ['-d', 'Ubuntu', '--exec', 'sh', '-c', 'printf %s "$HOME"'],
      expect.anything()
    );
  });
});

describe('WslService path translation', () => {
  it('toWslPath shells out to wslpath -u and caches', async () => {
    const exec = vi.fn().mockResolvedValueOnce({
      stdout: Buffer.from('/mnt/c/Users/khang\n', 'utf-8'),
      stderr: Buffer.alloc(0)
    });
    const svc = new WslService({ exec });

    expect(await svc.toWslPath('Ubuntu', 'C:\\Users\\khang')).toBe('/mnt/c/Users/khang');
    expect(await svc.toWslPath('Ubuntu', 'C:\\Users\\khang')).toBe('/mnt/c/Users/khang');

    expect(exec).toHaveBeenCalledTimes(1);
    expect(exec).toHaveBeenCalledWith(
      'wsl.exe',
      ['-d', 'Ubuntu', '--exec', 'wslpath', '-u', 'C:\\Users\\khang'],
      expect.anything()
    );
  });

  it('toWinPath shells out to wslpath -w', async () => {
    const exec = vi.fn().mockResolvedValueOnce({
      stdout: Buffer.from('C:\\Users\\khang\r\n', 'utf-8'),
      stderr: Buffer.alloc(0)
    });
    const svc = new WslService({ exec });

    expect(await svc.toWinPath('Ubuntu', '/mnt/c/Users/khang')).toBe('C:\\Users\\khang');
    expect(exec).toHaveBeenCalledWith(
      'wsl.exe',
      ['-d', 'Ubuntu', '--exec', 'wslpath', '-w', '/mnt/c/Users/khang'],
      expect.anything()
    );
  });

  it('throws on wslpath failure (caller decides what to do)', async () => {
    const exec = vi.fn().mockRejectedValue(new Error('wslpath: ENOENT'));
    const svc = new WslService({ exec });
    await expect(svc.toWslPath('Ubuntu', 'C:\\nope')).rejects.toThrow('wslpath');
  });
});

describe('WslService.status', () => {
  it('returns running when distro is in --list --running output', async () => {
    const utf8 = '  NAME      STATE     VERSION\r\n* Ubuntu    Running   2\r\n';
    const utf16le = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(utf8, 'utf16le')]);
    const exec = vi.fn().mockResolvedValue({ stdout: utf16le, stderr: Buffer.alloc(0) });
    const svc = new WslService({ exec });

    expect(await svc.status('Ubuntu')).toBe('running');
    expect(exec).toHaveBeenCalledWith(
      'wsl.exe',
      ['--list', '--running', '--verbose'],
      expect.anything()
    );
  });

  it('returns stopped when distro is not in running list but is registered', async () => {
    const runningOut = Buffer.concat([
      Buffer.from([0xff, 0xfe]),
      Buffer.from('There are no running distributions.\r\n', 'utf16le')
    ]);
    const verboseOut = Buffer.concat([
      Buffer.from([0xff, 0xfe]),
      Buffer.from('  NAME    STATE     VERSION\r\n  Ubuntu  Stopped   2\r\n', 'utf16le')
    ]);

    const exec = vi.fn().mockImplementation(async (_cmd: string, args: string[]) => {
      if (args.includes('--running'))
        return Promise.resolve({ stdout: runningOut, stderr: Buffer.alloc(0) });
      return Promise.resolve({ stdout: verboseOut, stderr: Buffer.alloc(0) });
    });
    const svc = new WslService({ exec });

    expect(await svc.status('Ubuntu')).toBe('stopped');
  });

  it('returns error when wsl.exe fails', async () => {
    const exec = vi.fn().mockRejectedValue(new Error('service down'));
    const svc = new WslService({ exec });
    expect(await svc.status('Ubuntu')).toBe('error');
  });
});

describe('WslService.warmUp', () => {
  it('spawns wsl -d <distro> --exec true and swallows errors', async () => {
    const exec = vi.fn().mockResolvedValue({ stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) });
    const svc = new WslService({ exec });

    svc.warmUp('Ubuntu');
    // Allow microtask queue to drain
    await Promise.resolve();
    await Promise.resolve();

    expect(exec).toHaveBeenCalledWith(
      'wsl.exe',
      ['-d', 'Ubuntu', '--exec', 'true'],
      expect.anything()
    );
  });

  it('does not throw when exec rejects', async () => {
    const exec = vi.fn().mockRejectedValue(new Error('cold start failed'));
    const svc = new WslService({ exec });

    expect(() => svc.warmUp('Ubuntu')).not.toThrow();
    await Promise.resolve();
  });
});
