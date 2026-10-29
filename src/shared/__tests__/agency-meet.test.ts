import { describe, expect, it } from 'vitest';
import {
  MEET_QUESTION_IDS,
  MEET_QUESTIONS,
  meetAnswerLines,
  meetLeft,
  meetQuestion
} from '../agency-meet';

describe('Meet you', () => {
  it('has every question once, the You ones first, and every pick saves something', () => {
    expect(MEET_QUESTIONS.map((q) => q.id)).toEqual([...MEET_QUESTION_IDS]);
    expect(MEET_QUESTIONS.map((q) => q.layer)).toEqual([
      'you',
      'you',
      'project',
      'project',
      'project',
      'project'
    ]);
    for (const q of MEET_QUESTIONS) {
      expect(q.budget === true ? q.picks.length === 0 : q.picks.length >= 2).toBe(true);
      for (const pick of q.picks) expect(pick.line).not.toBe('');
    }
  });

  it('turns an answer into lines', () => {
    expect(meetAnswerLines(meetQuestion('prs'), { kind: 'picks', picks: [1, 0] })).toEqual([
      'Open PRs ready for review.'
    ]);
    expect(meetAnswerLines(meetQuestion('never'), { kind: 'picks', picks: [3, 3, 9] })).toEqual([
      'Never force push.'
    ]);
    expect(
      meetAnswerLines(meetQuestion('tests'), { kind: 'text', text: ' e2e only\n\nfor UI ' })
    ).toEqual(['e2e only for UI']);
    expect(
      meetAnswerLines(meetQuestion('budget'), { kind: 'budget', usd: 10, weekPct: 10 })
    ).toEqual(['Default job budget: $10 and 10% of my weekly Claude limit.']);
    expect(meetAnswerLines(meetQuestion('report'), { kind: 'skip' })).toEqual([]);
  });

  it('leaves out what was gone through, and the project questions of a starter project', () => {
    expect(meetLeft({ youSeen: null, projectSeen: null, starterDone: false })).toEqual([
      ...MEET_QUESTION_IDS
    ]);
    expect(
      meetLeft({ youSeen: ['report', 'never'], projectSeen: ['prs'], starterDone: true })
    ).toEqual(['delivery', 'tests', 'budget']);
    expect(meetLeft({ youSeen: null, projectSeen: null, starterDone: true })).toEqual([
      'report',
      'never'
    ]);
  });
});
