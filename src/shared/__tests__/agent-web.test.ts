import { describe, expect, it } from 'vitest';
import { addressKind, checkUrl, hostKind, mappedIpv4 } from '../agent-web';

/**
 * What the agent may reach.
 *
 * This is the file where a mistake is a vulnerability rather than a bug, so the
 * cases below are written as a matrix of addresses rather than as a few happy
 * paths. Several of them are shipped CVEs in other people's fetch tools, marked
 * where that is so.
 */

describe('hostKind', () => {
  it('calls ordinary names and public addresses public', () => {
    expect(hostKind('example.com')).toBe('public');
    expect(hostKind('docs.python.org')).toBe('public');
    expect(hostKind('8.8.8.8')).toBe('public');
    expect(hostKind('[2606:4700:4700::1111]')).toBe('public');
  });

  it('calls this machine and this network local', () => {
    expect(hostKind('localhost')).toBe('local');
    expect(hostKind('api.localhost')).toBe('local');
    expect(hostKind('127.0.0.1')).toBe('local');
    expect(hostKind('127.1.2.3')).toBe('local');
    expect(hostKind('0.0.0.0')).toBe('local');
    expect(hostKind('10.1.2.3')).toBe('local');
    expect(hostKind('192.168.1.1')).toBe('local');
    expect(hostKind('172.16.0.1')).toBe('local');
    expect(hostKind('172.31.255.254')).toBe('local');
    expect(hostKind('[::1]')).toBe('local');
    expect(hostKind('[::]')).toBe('local');
    expect(hostKind('[fc00::1]')).toBe('local');
    expect(hostKind('[fd12:3456::1]')).toBe('local');
  });

  it('leaves the ranges either side of private space alone', () => {
    expect(hostKind('172.15.0.1')).toBe('public');
    expect(hostKind('172.32.0.1')).toBe('public');
    expect(hostKind('11.0.0.1')).toBe('public');
    expect(hostKind('192.169.1.1')).toBe('public');
  });

  it('singles out the metadata addresses, which are never a dev server', () => {
    expect(hostKind('169.254.169.254')).toBe('metadata');
    expect(hostKind('169.254.0.1')).toBe('metadata');
    expect(hostKind('metadata.google.internal')).toBe('metadata');
    expect(hostKind('[fd00:ec2::254]')).toBe('metadata');
    expect(hostKind('[fe80::1]')).toBe('metadata');
  });

  it('is not fooled by a trailing dot or by capitals', () => {
    expect(hostKind('LOCALHOST')).toBe('local');
    expect(hostKind('localhost.')).toBe('local');
    expect(hostKind('METADATA.GOOGLE.INTERNAL.')).toBe('metadata');
  });

  it('does not let a look-alike name inherit a suffix it only resembles', () => {
    expect(hostKind('notlocalhost')).toBe('public');
    expect(hostKind('localhost.evil.com')).toBe('public');
  });
});

/*
 * CVE-2026-49857, in `auth-fetch-mcp`, and the same shape as CVE-2025-65513 in
 * the reference MCP fetch server. `new URL()` rewrites `::ffff:127.0.0.1` into
 * `::ffff:7f00:1`, so a guard that only knows the dotted spelling is checking a
 * string the parser already changed out from under it.
 */
describe('IPv4-mapped IPv6, in both spellings', () => {
  it('reads the hex form back to dotted quad', () => {
    expect(mappedIpv4('::ffff:7f00:1')).toBe('127.0.0.1');
    expect(mappedIpv4('::ffff:a9fe:a9fe')).toBe('169.254.169.254');
    expect(mappedIpv4('::ffff:127.0.0.1')).toBe('127.0.0.1');
    expect(mappedIpv4('::1')).toBeNull();
  });

  it('blocks a mapped loopback however it is written', () => {
    expect(hostKind('[::ffff:127.0.0.1]')).toBe('local');
    expect(hostKind('[::ffff:7f00:1]')).toBe('local');
    expect(hostKind('[::FFFF:7F00:1]')).toBe('local');
  });

  it('blocks a mapped metadata address however it is written', () => {
    expect(hostKind('[::ffff:169.254.169.254]')).toBe('metadata');
    expect(hostKind('[::ffff:a9fe:a9fe]')).toBe('metadata');
  });

  it('still lets a mapped public address through', () => {
    expect(hostKind('[::ffff:8.8.8.8]')).toBe('public');
  });
});

describe('a zone id cannot smuggle an address past the check', () => {
  it('strips it before judging', () => {
    expect(hostKind('[fe80::1%25eth0]')).toBe('metadata');
    expect(hostKind('[::1%25lo0]')).toBe('local');
  });
});

describe('addressKind', () => {
  it('judges what a resolver returned, which has no brackets', () => {
    expect(addressKind('93.184.216.34')).toBe('public');
    expect(addressKind('127.0.0.1')).toBe('local');
    expect(addressKind('169.254.169.254')).toBe('metadata');
    expect(addressKind('::1')).toBe('local');
    expect(addressKind('fd00:ec2::254')).toBe('metadata');
    expect(addressKind('2606:4700:4700::1111')).toBe('public');
  });
});

describe('checkUrl', () => {
  it('accepts a public page and reports it as public', () => {
    const verdict = checkUrl('https://example.com/docs', false);
    expect(verdict).toMatchObject({ ok: true, kind: 'public' });
  });

  it('refuses a scheme that is not http', () => {
    for (const url of ['file:///etc/passwd', 'mailto:a@b.com', 'ftp://example.com', 'data:,hi']) {
      expect(checkUrl(url, true).ok).toBe(false);
    }
  });

  it('refuses anything that is not a URL at all', () => {
    expect(checkUrl('not a url', true).ok).toBe(false);
    expect(checkUrl('', true).ok).toBe(false);
    expect(checkUrl('example.com/docs', true).ok).toBe(false);
  });

  it('refuses a URL longer than the cap without trying to parse it', () => {
    const verdict = checkUrl(`https://example.com/${'a'.repeat(3000)}`, true);
    expect(verdict.ok).toBe(false);
  });

  it('refuses metadata whatever the local setting says', () => {
    for (const allowLocal of [true, false]) {
      const verdict = checkUrl('http://169.254.169.254/latest/meta-data/', allowLocal);
      expect(verdict.ok).toBe(false);
      if (!verdict.ok) expect(verdict.reason).toContain('metadata');
    }
  });

  it('lets a dev server through only when local addresses are allowed', () => {
    expect(checkUrl('http://localhost:3000/api', true).ok).toBe(true);
    expect(checkUrl('http://localhost:3000/api', false).ok).toBe(false);
  });

  it('strips credentials, so a password never reaches the transcript', () => {
    const verdict = checkUrl('https://user:hunter2@example.com/x', false);
    expect(verdict).toMatchObject({ ok: true });
    if (verdict.ok) {
      expect(verdict.url).not.toContain('hunter2');
      expect(verdict.url).toBe('https://example.com/x');
    }
  });

  /*
   * `https://evil.com@internal/` is a URL whose host is `internal` and whose
   * userinfo is `evil.com`. The host is what is judged, which is the whole
   * point of judging the parsed URL rather than the string.
   */
  it('judges the real host of a credential-shaped look-alike', () => {
    expect(checkUrl('https://example.com@169.254.169.254/', true).ok).toBe(false);
    expect(checkUrl('https://example.com@127.0.0.1/', false).ok).toBe(false);
  });

  it('drops the fragment, which is never sent anywhere', () => {
    const verdict = checkUrl('https://example.com/docs#install', false);
    if (verdict.ok) expect(verdict.url).toBe('https://example.com/docs');
  });

  it('upgrades a public page to https, and leaves a dev server alone', () => {
    const publicUrl = checkUrl('http://example.com/x', true);
    if (publicUrl.ok) expect(publicUrl.url).toBe('https://example.com/x');

    const local = checkUrl('http://localhost:3000/x', true);
    if (local.ok) expect(local.url).toBe('http://localhost:3000/x');
  });
});
