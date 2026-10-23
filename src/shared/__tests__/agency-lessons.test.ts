import { describe, expect, it } from 'vitest';
import { applyLesson, parseLesson, undoLesson } from '../agency-lessons';

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

describe('undoLesson', () => {
  it('puts the replaced text back', () => {
    const edit = { replace: 'Run the checks', with: 'Run lint and the checks' };
    const applied = applyLesson(ROLE, edit);
    expect(applied).not.toBeNull();
    expect(undoLesson(applied ?? '', edit)).toBe(ROLE);
  });

  it('takes out an added paragraph', () => {
    const edit = { replace: null, with: 'Open PRs as drafts.' };
    expect(undoLesson(applyLesson(ROLE, edit) ?? '', edit)).toBe(ROLE);
  });

  it('refuses once the written text is gone', () => {
    expect(undoLesson(ROLE, { replace: 'Run the checks', with: 'Run lint first' })).toBeNull();
    expect(undoLesson(ROLE, { replace: null, with: 'Open PRs as drafts.' })).toBeNull();
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
