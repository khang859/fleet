import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import type { PreferenceStore } from '../store/preference-store';
import { storeFixture } from './fixture';

let prefs: PreferenceStore;
let dbPath: string;
let cleanup: () => void;

beforeEach(() => {
  const fixture = storeFixture();
  prefs = fixture.store.preferences;
  dbPath = fixture.dbPath;
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

  it('keeps Meet you progress per layer, so a later run resumes', () => {
    expect(prefs.meetSeen('you')).toBeNull();
    prefs.markMeetSeen('you', []);
    expect(prefs.meetSeen('you')).toEqual([]);
    prefs.markMeetSeen('you', ['report']);
    prefs.markMeetSeen('you', ['report', 'never']);
    expect(prefs.meetSeen('you')).toEqual(['report', 'never']);
    expect(prefs.meetSeen('repo-a')).toBeNull();
  });

  it('drops a Meet you question no longer asked, and keeps the rest', () => {
    const db = new Database(dbPath);
    db.prepare(
      "INSERT INTO meet_progress (layer, seen_json, updated_at) VALUES ('repo-a', ?, 1)"
    ).run(JSON.stringify(['prs', 'checks', 'budget']));
    db.close();
    expect(prefs.meetSeen('repo-a')).toEqual(['prs', 'budget']);
  });
});
