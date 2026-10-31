import { describe, expect, it, vi } from 'vitest';
import {
  fetchPr,
  ghStatus,
  isTeamPr,
  itemMarker,
  listOpenPrs,
  parsePrInput,
  repoRoot,
  type Exec,
  type PrWire
} from '../pr';

function wirePr(fields: Partial<PrWire> = {}): PrWire {
  return {
    number: 12,
    title: 'Fix it',
    html_url: 'https://github.com/acme/app/pull/12',
    state: 'open',
    draft: false,
    merged_at: null,
    author_association: 'MEMBER',
    user: { login: 'someone', type: 'User' },
    head: { sha: 'abc', repo: { full_name: 'acme/app' } },
    base: { repo: { full_name: 'acme/app' } },
    ...fields
  };
}

describe('parsePrInput', () => {
  it('reads a number', () => {
    expect(parsePrInput('123')).toEqual({ number: 123, repo: null });
    expect(parsePrInput(' #123 ')).toEqual({ number: 123, repo: null });
  });

  it('reads a link and its repo', () => {
    expect(parsePrInput('https://github.com/acme/app/pull/45/files')).toEqual({
      number: 45,
      repo: 'acme/app'
    });
  });

  it('refuses junk', () => {
    expect(parsePrInput('')).toBeNull();
    expect(parsePrInput('12a')).toBeNull();
    expect(parsePrInput('https://github.com/acme/app/issues/45')).toBeNull();
  });
});

describe('isTeamPr', () => {
  it('takes a member with a branch in the repo', () => {
    expect(isTeamPr(wirePr())).toBe(true);
    expect(isTeamPr(wirePr({ author_association: 'OWNER' }))).toBe(true);
  });

  it('refuses a fork, even from a member', () => {
    const head = { sha: 'abc', repo: { full_name: 'someone/app' } };

    expect(isTeamPr(wirePr({ head }))).toBe(false);
  });

  it('refuses a deleted fork', () => {
    expect(isTeamPr(wirePr({ head: { sha: 'abc', repo: null } }))).toBe(false);
  });

  it('refuses a stranger', () => {
    expect(isTeamPr(wirePr({ author_association: 'CONTRIBUTOR' }))).toBe(false);
  });
});

describe('fetchPr', () => {
  it('asks gh for the PR and reads the answer', async () => {
    const exec = vi.fn<Exec>(async () => Promise.resolve(JSON.stringify(wirePr())));

    const info = await fetchPr(exec, '/repo', 12);

    expect(exec).toHaveBeenCalledWith('gh', ['api', 'repos/{owner}/{repo}/pulls/12'], '/repo');
    expect(info).toEqual({
      number: 12,
      title: 'Fix it',
      url: 'https://github.com/acme/app/pull/12',
      state: 'open',
      headSha: 'abc',
      team: true
    });
  });

  it('calls a merged PR merged', async () => {
    const merged = wirePr({ state: 'closed', merged_at: '2026-01-01T00:00:00Z' });
    const exec: Exec = async () => Promise.resolve(JSON.stringify(merged));

    expect((await fetchPr(exec, '/repo', 12)).state).toBe('merged');
  });

  it('rejects an answer of the wrong shape', async () => {
    const exec: Exec = async () => Promise.resolve('{}');

    await expect(fetchPr(exec, '/repo', 12)).rejects.toThrow();
  });
});

describe('listOpenPrs', () => {
  it('flags drafts, bots and strangers', async () => {
    const bot = wirePr({ number: 2, draft: true, user: { login: 'dep', type: 'Bot' } });
    const stranger = wirePr({ number: 3, author_association: 'NONE' });
    const exec: Exec = async () => Promise.resolve(JSON.stringify([wirePr(), bot, stranger]));

    expect(await listOpenPrs(exec, '/repo')).toEqual([
      { number: 12, team: true, draft: false, bot: false },
      { number: 2, team: true, draft: true, bot: true },
      { number: 3, team: false, draft: false, bot: false }
    ]);
  });
});

describe('small helpers', () => {
  it('falls back to the folder outside a repo', async () => {
    const fails: Exec = async () => Promise.reject(new Error('no repo'));

    expect(await repoRoot(fails, '/folder')).toBe('/folder');
  });

  it('says why gh is not ready', async () => {
    const fails: Exec = async () => Promise.reject(new Error('not signed in'));

    expect(await ghStatus(fails, '/repo')).toEqual({ ok: false, detail: 'not signed in' });
  });

  it('makes a hidden mark per item', () => {
    expect(itemMarker('run-1', '4')).toBe('<!-- fleet:item:run-1:4 -->');
  });
});
