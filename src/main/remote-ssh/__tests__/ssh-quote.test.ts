import { describe, it, expect } from 'vitest';
import {
  posixShellQuote,
  sftpQuote,
  remoteJoin,
  remoteDirname,
  remoteBasename
} from '../ssh-quote';

describe('posixShellQuote', () => {
  it('wraps a plain value in single quotes', () => {
    expect(posixShellQuote('file.txt')).toBe(`'file.txt'`);
  });

  it('neutralises command substitution and separators', () => {
    expect(posixShellQuote('a;rm -rf /')).toBe(`'a;rm -rf /'`);
    expect(posixShellQuote('$(whoami)')).toBe(`'$(whoami)'`);
    expect(posixShellQuote('`id`')).toBe("'`id`'");
    expect(posixShellQuote('a|b&c')).toBe(`'a|b&c'`);
    expect(posixShellQuote('*')).toBe(`'*'`);
  });

  it('escapes embedded single quotes by close-escape-reopen', () => {
    expect(posixShellQuote("it's")).toBe(`'it'\\''s'`);
  });

  it('handles a quote-based escape attempt', () => {
    // A naive implementation would let this break out of the quoting.
    expect(posixShellQuote("'; rm -rf ~; echo '")).toBe(`''\\''; rm -rf ~; echo '\\'''`);
  });

  it('preserves newlines and leading dashes verbatim', () => {
    expect(posixShellQuote('new\nline')).toBe(`'new\nline'`);
    expect(posixShellQuote('--exec')).toBe(`'--exec'`);
  });

  it('handles the empty string', () => {
    expect(posixShellQuote('')).toBe(`''`);
  });
});

describe('sftpQuote', () => {
  it('wraps a plain path in double quotes', () => {
    expect(sftpQuote('/home/k/a.txt')).toBe('"/home/k/a.txt"');
  });

  it('escapes double quotes and backslashes', () => {
    expect(sftpQuote('a"b')).toBe('"a\\"b"');
    expect(sftpQuote('a\\b')).toBe('"a\\\\b"');
  });

  it('leaves shell metacharacters alone - sftp has no shell', () => {
    expect(sftpQuote('a;rm -rf /')).toBe('"a;rm -rf /"');
    expect(sftpQuote('$(id)')).toBe('"$(id)"');
  });

  it('refuses newlines rather than encoding them', () => {
    expect(() => sftpQuote('new\nline.txt')).toThrow(/newline/);
    expect(() => sftpQuote('carriage\rreturn.txt')).toThrow(/newline/);
  });

  it('refuses NUL bytes', () => {
    expect(() => sftpQuote('a\0b')).toThrow(/NUL/);
  });
});

describe('remoteJoin', () => {
  it('joins a directory and a name', () => {
    expect(remoteJoin('/home/k', 'a.txt')).toBe('/home/k/a.txt');
  });

  it('does not double the separator', () => {
    expect(remoteJoin('/home/k/', 'a.txt')).toBe('/home/k/a.txt');
  });

  it('handles root', () => {
    expect(remoteJoin('/', 'etc')).toBe('/etc');
  });

  it('passes an absolute name through unchanged', () => {
    expect(remoteJoin('/home/k', '/etc/hosts')).toBe('/etc/hosts');
  });
});

describe('remoteDirname / remoteBasename', () => {
  it('splits a normal path', () => {
    expect(remoteDirname('/home/k/a.txt')).toBe('/home/k');
    expect(remoteBasename('/home/k/a.txt')).toBe('a.txt');
  });

  it('treats root as its own parent', () => {
    expect(remoteDirname('/')).toBe('/');
    expect(remoteDirname('/etc')).toBe('/');
    expect(remoteBasename('/')).toBe('/');
  });

  it('ignores trailing slashes', () => {
    expect(remoteDirname('/home/k/sub/')).toBe('/home/k');
    expect(remoteBasename('/home/k/sub/')).toBe('sub');
  });

  it('keeps names containing spaces and quotes intact', () => {
    expect(remoteBasename("/home/k/it's a file.txt")).toBe("it's a file.txt");
  });
});
