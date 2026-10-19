import { describe, expect, it } from 'vitest';
import type { CrewRole } from '../../../../shared/agency-crew';
import { LESSON_GROWTH_MAX_CHARS, lessonTopic } from '../../../../shared/agency-lessons';
import { checkLesson, lessonRequest, retryRequest, reviewOutcome } from '../review';

const builder: CrewRole = {
  name: 'builder',
  description: 'Builds',
  runtime: 'claude',
  stack: false,
  source: 'bundled',
  path: '/crew/roles/builder.md',
  prompt: 'You are a Builder.\n\nRun the checks before you finish.'
};

const LESSON = {
  role: 'builder',
  cue: 'When the project lints',
  lesson: 'Run lint before the PR.',
  evidence: 'Lint failed on both PRs.',
  replace: 'Run the checks',
  with: 'Run lint and the checks'
};

const checks = (declined: string[] = []): Parameters<typeof checkLesson>[1] => ({
  ran: ['builder'],
  roles: [builder],
  declined: (topic) => declined.includes(topic)
});

describe('checkLesson', () => {
  it('keeps a lesson that replaces role text once', () => {
    const out = checkLesson(LESSON, checks());
    expect(out.ok && out.checked.instructions).toBe(
      'You are a Builder.\n\nRun lint and the checks before you finish.'
    );
  });

  it('refuses a role the job did not run, or one that is gone', () => {
    const other = checkLesson({ ...LESSON, role: 'qa' }, checks());
    expect(!other.ok && other.reason).toContain('Pick one of: builder');
    const gone = checkLesson(LESSON, { ...checks(), roles: [] });
    expect(!gone.ok && gone.reason).toContain('gone');
  });

  it('refuses text that is not in the role word for word', () => {
    const out = checkLesson({ ...LESSON, replace: 'Run the tests' }, checks());
    expect(!out.ok && out.reason).toContain('word for word');
  });

  it('refuses a change that leaves the role as it is', () => {
    expect(checkLesson({ ...LESSON, with: 'Run the checks' }, checks()).ok).toBe(false);
  });

  it('refuses a role that grows too much', () => {
    const out = checkLesson(
      { ...LESSON, replace: null, with: 'x'.repeat(LESSON_GROWTH_MAX_CHARS) },
      checks()
    );
    expect(!out.ok && out.reason).toContain('Replace text rather than add it');
  });

  it('refuses a lesson the client turned down', () => {
    const out = checkLesson(LESSON, checks([lessonTopic('builder', 'when the project lints')]));
    expect(!out.ok && out.reason).toContain('turned this lesson down');
  });
});

describe('reviewOutcome', () => {
  it('is none, keep or refused', () => {
    expect(reviewOutcome('{"lesson": null}', checks()).kind).toBe('none');
    expect(reviewOutcome(JSON.stringify({ lesson: LESSON }), checks()).kind).toBe('keep');
    expect(reviewOutcome('nothing', checks())).toEqual({
      kind: 'refused',
      reason: 'the answer is not the JSON asked for.'
    });
  });
});

describe('lessonRequest', () => {
  it('shows a role as it ran and as it is now when it changed', () => {
    const text = lessonRequest({
      roles: [{ name: 'builder', ran: 'Old text.', now: 'New text.' }],
      declined: ['builder:when it lints'],
      record: '# J1: Fix'
    });
    expect(text).toContain('<<<role: builder, as the crew ran it>>>\nOld text.');
    expect(text).toContain('"replace" must quote this text>>>\nNew text.');
    expect(text).toContain('- builder:when it lints');
    expect(text).toContain('<<<record>>>\n# J1: Fix\n<<<end>>>');
  });

  it('sends the refused answer back once with the reason', () => {
    expect(retryRequest('REQ', '{"lesson": 1}', 'no.')).toBe(
      'REQ\n\nYour last answer was:\n<<<answer>>>\n{"lesson": 1}\n<<<end>>>\nIt was refused: no. Answer again, or answer {"lesson": null}.'
    );
  });
});
