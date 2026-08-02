import { describe, it, expect } from 'vitest';
import { remoteChildPath, validateRemoteName } from '../remote-names';

describe('remoteChildPath', () => {
  it('joins a directory and a name', () => {
    expect(remoteChildPath('/home/knguyen', 'a.txt')).toBe('/home/knguyen/a.txt');
  });

  it('does not double the separator at the root', () => {
    expect(remoteChildPath('/', 'etc')).toBe('/etc');
  });

  it('tolerates a trailing slash on the directory', () => {
    expect(remoteChildPath('/home/knguyen/', 'a.txt')).toBe('/home/knguyen/a.txt');
  });
});

describe('validateRemoteName', () => {
  it('accepts ordinary names, including spaces and dots', () => {
    for (const name of ['a.txt', 'my file.txt', '.hidden', 'a.b.c', "it's fine"]) {
      expect(validateRemoteName(name)).toBeNull();
    }
  });

  it('rejects empty and whitespace-only names', () => {
    expect(validateRemoteName('')).toBe('Enter a name.');
    expect(validateRemoteName('   ')).toBe('Enter a name.');
  });

  it('rejects the directory entries that would rename the wrong thing', () => {
    expect(validateRemoteName('.')).toMatch(/reserved/);
    expect(validateRemoteName('..')).toMatch(/reserved/);
  });

  it('rejects a separator rather than silently moving the file', () => {
    expect(validateRemoteName('sub/name.txt')).toMatch(/cannot contain/);
    expect(validateRemoteName('/etc/passwd')).toMatch(/cannot contain/);
  });

  it('rejects bytes SFTP batch mode cannot express', () => {
    expect(validateRemoteName('two\nlines')).toMatch(/line breaks/);
    expect(validateRemoteName('carriage\rreturn')).toMatch(/line breaks/);
    expect(validateRemoteName('nul\0byte')).toMatch(/null byte/);
  });
});
