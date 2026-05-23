import { describe, it, expect } from 'vitest';
import { parseListVerbose } from '../wsl-service';

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
