import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { PreferenceStore } from '../store/preference-store';
import { storeFixture } from './fixture';

let prefs: PreferenceStore;
let cleanup: () => void;

beforeEach(() => {
  const fixture = storeFixture();
  prefs = fixture.store.preferences;
  cleanup = fixture.cleanup;
});
afterEach(() => cleanup());

describe('PreferenceStore', () => {
  it('counts a line once per job, by its normal form', () => {
    prefs.recordUse('you', 'Draft PRs.', 1);
    prefs.recordUse('you', 'draft prs', 1);
    prefs.recordUse('you', 'Draft PRs.', 2);
    prefs.recordUse('repo-a', 'Draft PRs.', 3);
    expect(prefs.useCounts('you')).toEqual(new Map([['draft prs', 2]]));
  });

  it('moves the uses to an edited line, merging with uses it already had', () => {
    prefs.recordUse('you', 'Draft PRs.', 1);
    prefs.recordUse('you', 'Draft PRs.', 2);
    prefs.recordUse('you', 'Open PRs as drafts.', 2);
    prefs.moveUses('you', 'Draft PRs.', 'Open PRs as drafts.');
    expect(prefs.useCounts('you')).toEqual(new Map([['open prs as drafts', 2]]));
  });

  it('keeps a conflict until the rule wins, and settles it only once', () => {
    const id = prefs.openConflict({
      layer: 'repo-a',
      text: 'Skip docs unless asked.',
      ruleSource: 'CLAUDE.md',
      ruleText: 'Update docs with every user-facing change.'
    });
    expect(prefs.conflicts('repo-a')).toMatchObject([
      { id, normText: 'skip docs unless asked', status: 'open' }
    ]);
    expect(prefs.settleConflict(id, 'line')).toBe(true);
    expect(prefs.settleConflict(id, 'rule')).toBe(false);
    expect(prefs.conflicts('repo-a')).toMatchObject([{ id, status: 'line' }]);

    const other = prefs.openConflict({
      layer: 'repo-a',
      text: 'x',
      ruleSource: 'AGENTS.md',
      ruleText: 'y'
    });
    prefs.settleConflict(other, 'rule');
    expect(prefs.conflicts('repo-a').map((c) => c.id)).toEqual([id]);
  });

  it('remembers a declined topic per project', () => {
    prefs.declineTopic('p1', 'e2e tests');
    prefs.declineTopic('p1', 'e2e tests');
    expect(prefs.topicDeclined('p1', 'e2e tests')).toBe(true);
    expect(prefs.topicDeclined('p2', 'e2e tests')).toBe(false);
  });

  it('starts every project at Ask me, and keeps the level the client picks', () => {
    expect(prefs.trust('p1')).toEqual({ level: 'ask', autoStartUsd: null });
    prefs.setTrust('p1', { level: 'pr', autoStartUsd: 10 });
    prefs.setTrust('p1', { level: 'ship', autoStartUsd: null });
    expect(prefs.trust('p1')).toEqual({ level: 'ship', autoStartUsd: null });
  });
});
