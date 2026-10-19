import { describe, expect, it } from 'vitest';
import {
  applyLesson,
  lessonOptions,
  lessonPick,
  lessonTopic,
  parseLesson,
  type CrewLesson
} from '../agency-lessons';

const ROLE = 'You are a Builder.\n\nRun the checks before you finish.\nKeep the change small.';

describe('applyLesson', () => {
  it('replaces text that is in the role once', () => {
    expect(applyLesson(ROLE, { replace: 'Run the checks', with: 'Run lint and the checks' })).toBe(
      'You are a Builder.\n\nRun lint and the checks before you finish.\nKeep the change small.'
    );
  });

  it('adds a paragraph when there is nothing to replace', () => {
    expect(applyLesson(`${ROLE}\n`, { replace: null, with: ' Open PRs as drafts. ' })).toBe(
      `${ROLE}\n\nOpen PRs as drafts.`
    );
  });

  it('refuses text that is not in the role, is there twice, or is empty', () => {
    expect(applyLesson(ROLE, { replace: 'Run the tests', with: 'x' })).toBeNull();
    expect(applyLesson(ROLE, { replace: 'the', with: 'x' })).toBeNull();
    expect(applyLesson(ROLE, { replace: '', with: 'x' })).toBeNull();
  });
});

describe('parseLesson', () => {
  const lesson = {
    role: 'builder',
    cue: 'When the project lints',
    lesson: 'Run lint before the PR.',
    evidence: 'Lint failed on both PRs.',
    replace: 'Run the checks',
    with: 'Run lint and the checks'
  };

  it('reads a lesson, with thinking and a fence around it', () => {
    const text = `<think>{"lesson": 1}</think>\n\`\`\`json\n${JSON.stringify({ lesson })}\n\`\`\``;
    expect(parseLesson(text)).toEqual({ ok: true, lesson });
  });

  it('reads no lesson', () => {
    expect(parseLesson('{"lesson": null, "why": "nothing repeated"}')).toEqual({
      ok: true,
      lesson: null
    });
  });

  it('says which field is wrong', () => {
    const out = parseLesson(JSON.stringify({ lesson: { ...lesson, evidence: '' } }));
    expect(out.ok).toBe(false);
    expect(!out.ok && out.reason).toContain('lesson.evidence');
  });

  it('refuses an answer that is not JSON', () => {
    expect(parseLesson('No lesson here.').ok).toBe(false);
  });
});

describe('lesson options', () => {
  const lesson = (source: CrewLesson['source']): CrewLesson => ({
    jobId: 1,
    role: 'builder',
    source,
    cue: 'c',
    lesson: 'l',
    evidence: 'e',
    replace: null,
    with: 'w'
  });

  it('offers a project role Change it or Not now', () => {
    expect(lessonOptions('project').map((o) => o.label)).toEqual(['Change it', 'Not now']);
    expect(lessonPick(lesson('project'), 0)).toBe('own');
    expect(lessonPick(lesson('project'), 1)).toBe('decline');
  });

  it('offers a bundled or user role a copy for the project or every project', () => {
    expect(lessonOptions('bundled').map((o) => o.label)).toEqual([
      'This project',
      'All projects',
      'Not now'
    ]);
    expect(lessonPick(lesson('user'), 1)).toBe('user');
    expect(lessonPick(lesson('bundled'), 3)).toBeNull();
    expect(lessonPick(lesson('bundled'), undefined)).toBeNull();
  });

  it('names a topic by role and cue, whatever the spacing or case', () => {
    expect(lessonTopic('builder', ' When  the Project lints ')).toBe(
      lessonTopic('builder', 'when the project lints')
    );
  });
});
