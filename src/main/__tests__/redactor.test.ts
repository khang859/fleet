import { describe, expect, it } from 'vitest';
import { maskCredentials } from '../redactor';

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
