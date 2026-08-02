import { describe, it, expect } from 'vitest';
import { parseSshArgv } from '../ssh-host-detect';

describe('parseSshArgv', () => {
  it('parses a bare destination', () => {
    expect(parseSshArgv(['ssh', 'khang-linux'])).toMatchObject({
      destination: 'khang-linux',
      host: 'khang-linux'
    });
  });

  it('parses user@host, as used against the real test target', () => {
    expect(parseSshArgv(['ssh', 'knguyen@khang-linux.tailf93b2b.ts.net'])).toMatchObject({
      user: 'knguyen',
      host: 'khang-linux.tailf93b2b.ts.net'
    });
  });

  it('resolves an absolute ssh binary path', () => {
    expect(parseSshArgv(['/usr/bin/ssh', 'host'])).toMatchObject({ host: 'host' });
  });

  it('skips flags that consume the next argument', () => {
    expect(
      parseSshArgv(['ssh', '-p', '2222', '-i', '/home/k/.ssh/id_ed25519', 'u@h'])
    ).toMatchObject({ user: 'u', host: 'h', port: 2222, identityFile: '/home/k/.ssh/id_ed25519' });
  });

  it('handles combined short forms', () => {
    expect(parseSshArgv(['ssh', '-p2222', '-i/key', 'h'])).toMatchObject({
      host: 'h',
      port: 2222,
      identityFile: '/key'
    });
  });

  it('does not mistake a ProxyJump target for the destination', () => {
    expect(parseSshArgv(['ssh', '-J', 'bastion.example.com', 'inner'])).toMatchObject({
      host: 'inner'
    });
  });

  it('does not mistake an -o value for the destination', () => {
    expect(parseSshArgv(['ssh', '-o', 'StrictHostKeyChecking=yes', 'real-host'])).toMatchObject({
      host: 'real-host'
    });
  });

  it('takes -l as the user when there is no user@', () => {
    expect(parseSshArgv(['ssh', '-l', 'knguyen', 'khang-linux'])).toMatchObject({
      user: 'knguyen',
      host: 'khang-linux'
    });
  });

  it('ignores boolean flags and flag bundles', () => {
    expect(parseSshArgv(['ssh', '-tv', '-A', 'host'])).toMatchObject({ host: 'host' });
  });

  it('ignores a trailing remote command', () => {
    expect(parseSshArgv(['ssh', 'host', 'ls', '-la', '/tmp'])).toMatchObject({ host: 'host' });
  });

  it('strips an ssh:// scheme', () => {
    expect(parseSshArgv(['ssh', 'ssh://user@host'])).toMatchObject({ user: 'user', host: 'host' });
  });

  it('handles bracketed IPv6 with a port', () => {
    expect(parseSshArgv(['ssh', '[2001:db8::1]:2222'])).toMatchObject({
      host: '2001:db8::1',
      port: 2222
    });
  });

  it('prefers user@ over -l when both are present', () => {
    expect(parseSshArgv(['ssh', '-l', 'ignored', 'real@host'])).toMatchObject({
      user: 'real',
      host: 'host'
    });
  });

  it('accepts autossh', () => {
    expect(parseSshArgv(['autossh', 'u@h'])).toMatchObject({ host: 'h' });
  });

  it('returns null for a non-ssh process', () => {
    expect(parseSshArgv(['bash', '-c', 'ssh host'])).toBeNull();
  });

  it('returns null when there is no destination', () => {
    expect(parseSshArgv(['ssh', '-V'])).toBeNull();
    expect(parseSshArgv([])).toBeNull();
  });
});
