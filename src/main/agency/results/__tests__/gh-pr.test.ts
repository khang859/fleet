import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { githubRepo, parsePr, prAddress } from '../gh-pr';

/** `gh pr view --json` answers recorded from github.com/khang859/fleet. */
const recorded = (name: string): unknown =>
  JSON.parse(readFileSync(join(__dirname, 'fixtures', name), 'utf8'));

describe('parsePr', () => {
  it('reads a merged PR with its checks', () => {
    expect(parsePr(recorded('pr-654-merged.json'))).toEqual({
      number: 654,
      url: 'https://github.com/khang859/fleet/pull/654',
      title: 'feat(agency): Admiral pane - Phase 1',
      branch: 'feat/admiral-pane',
      base: 'main',
      headSha: 'a4f519b64476c230daad6df9b777b6c04bb08a06',
      state: 'merged',
      draft: false,
      additions: 15523,
      deletions: 331,
      changedFiles: 168,
      checks: { passed: 1, failed: 0, pending: 0 }
    });
  });

  it('reads a PR closed without merging', () => {
    expect(parsePr(recorded('pr-485-closed.json'))?.state).toBe('closed');
  });

  it('counts check runs and commit statuses, with no result yet as pending', () => {
    const pr = {
      ...(recorded('pr-654-merged.json') as object),
      state: 'OPEN',
      statusCheckRollup: [
        { __typename: 'CheckRun', status: 'COMPLETED', conclusion: 'SUCCESS' },
        { __typename: 'CheckRun', status: 'COMPLETED', conclusion: 'FAILURE' },
        { __typename: 'CheckRun', status: 'IN_PROGRESS', conclusion: '' },
        { __typename: 'StatusContext', state: 'PENDING' },
        { __typename: 'StatusContext', state: 'ERROR' }
      ]
    };
    expect(parsePr(pr)?.checks).toEqual({ passed: 1, failed: 2, pending: 2 });
  });

  it('is null for anything that is not a PR', () => {
    expect(parsePr({ message: 'Not Found' })).toBeNull();
    expect(parsePr(null)).toBeNull();
  });
});

describe('addresses', () => {
  it('reads a PR address', () => {
    expect(prAddress('https://github.com/Acme/App/pull/12')).toEqual({
      repo: 'acme/app',
      number: 12
    });
    expect(prAddress('https://github.com/acme/app/issues/12')).toBeNull();
    expect(prAddress('https://evil.example/acme/app/pull/12')).toBeNull();
  });

  it('reads the GitHub repository of an SSH or HTTPS remote', () => {
    expect(githubRepo('git@github.com:acme/app.git')).toBe('acme/app');
    expect(githubRepo('https://github.com/Acme/app')).toBe('acme/app');
    expect(githubRepo('git@gitlab.com:acme/app.git')).toBeNull();
    expect(githubRepo(null)).toBeNull();
  });
});
