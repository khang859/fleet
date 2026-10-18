import { describe, expect, it } from 'vitest';
import { ENV_MASK, maskCredentials, Redactor, stripAnsi } from '../redactor';

describe('Redactor', () => {
  it('masks every value, longest first, so a value holding another is masked whole', () => {
    const r = new Redactor(['secret1', 'secret12345']);
    expect(r.redact('a secret12345 b secret1')).toBe(`a ${ENV_MASK} b ${ENV_MASK}`);
  });

  it('leaves values under six characters alone, so a short one hides no text', () => {
    const r = new Redactor(['42', 'abcde']);
    expect(r.empty).toBe(true);
    expect(r.redact('pin 42 abcde')).toBe('pin 42 abcde');
  });

  it('strips escape sequences first, so a color code inside a value cannot hide it', () => {
    const r = new Redactor(['sk_live_123456']);
    expect(r.redact('key \x1b[31msk_live_\x1b[0m123456 \x1b]0;title\x07done')).toBe(
      `key ${ENV_MASK} done`
    );
  });

  it('masks every string in a value, keys and structure kept', () => {
    const r = new Redactor(['sk_live_123456']);
    const out = r.redactDeep({
      n: 1,
      list: ['x sk_live_123456'],
      err: new Error('sk_live_123456')
    });
    expect(out.n).toBe(1);
    expect(out.list).toEqual([`x ${ENV_MASK}`]);
    expect(out.err.message).toBe(ENV_MASK);
  });
});

describe('stripAnsi', () => {
  it('drops CSI, OSC and two-byte escapes', () => {
    expect(stripAnsi('\x1b[1;32mok\x1b[0m \x1b]8;;https://x\x1b\\link\x1b]8;;\x1b\\ \x1bMup')).toBe(
      'ok link up'
    );
  });
});

describe('maskCredentials', () => {
  it('masks GitHub, Slack, provider and AWS keys, bearer tokens and private keys', () => {
    const text = [
      `rotate ghp_${'a'.repeat(36)} and github_pat_${'B'.repeat(30)}`,
      'slack xoxb-1234567890-abcdef',
      'key sk-ant-abcdefghijk',
      'aws AKIAABCDEFGHIJKLMNOP',
      'curl -H "Authorization: Bearer abc.def"',
      '-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaA\n-----END OPENSSH PRIVATE KEY-----'
    ].join('\n');
    expect(maskCredentials(text)).toBe(
      [
        'rotate [REDACTED_GITHUB_TOKEN] and [REDACTED_GITHUB_TOKEN]',
        'slack [REDACTED_SLACK_TOKEN]',
        'key sk-[REDACTED]',
        'aws [REDACTED_AWS_KEY]',
        'curl -H "Authorization: [REDACTED] [REDACTED]"',
        '[REDACTED_PRIVATE_KEY]'
      ].join('\n')
    );
  });

  it('leaves words about tokens alone', () => {
    expect(maskCredentials('fix(auth): refresh the token on 401')).toBe(
      'fix(auth): refresh the token on 401'
    );
  });
});
