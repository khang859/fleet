import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { AppliedCrewLesson } from '../../../../../shared/agency-lessons';
import { LessonList } from '../../settings/CrewLessons';
import { LessonChange } from '../LessonChange';

/** A crew lesson's change: the role's text struck out and the text that replaces it. */

const LESSON = {
  role: 'builder',
  replace: "Run the project's checks before you finish.",
  with: "Run the project's checks and lint before you finish."
};

const change = (lesson: typeof LESSON | { role: string; replace: null; with: string }): string =>
  renderToStaticMarkup(createElement(LessonChange, { lesson }));

describe('LessonChange', () => {
  it('shows the replaced text struck out above the new text', () => {
    const html = change(LESSON);
    expect(html).toContain('aria-label="Changes to the builder role"');
    expect(html).toMatch(/line-through[^>]*>Run the project&#x27;s checks before you finish\./);
    expect(html).toContain('Run the project&#x27;s checks and lint before you finish.');
    expect(html.indexOf('aria-label="Remove"')).toBeLessThan(html.indexOf('aria-label="Add"'));
  });

  it('shows only the new paragraph when the lesson adds one', () => {
    const html = change({ ...LESSON, replace: null });
    expect(html).not.toContain('aria-label="Remove"');
    expect(html).toContain('aria-label="Add"');
  });
});

describe('LessonList', () => {
  const applied = (over: Partial<AppliedCrewLesson> = {}): AppliedCrewLesson => ({
    id: 1,
    jobId: 7,
    cue: 'When the project has a lint step',
    lesson: 'Run lint before you finish.',
    ...LESSON,
    appliedAt: 1,
    undoneAt: null,
    ...over
  });
  const list = (lessons: AppliedCrewLesson[], error: string | null = null): string =>
    renderToStaticMarkup(
      createElement(LessonList, { lessons, error, busy: false, onUndo: () => {} })
    );

  it('shows each lesson with its role, cue, job, change and Undo', () => {
    const html = list([applied()]);
    expect(html).toContain('Crew lessons');
    expect(html).toContain('Run lint before you finish.');
    expect(html).toContain('builder role · When the project has a lint step · Learned on j7');
    expect(html).toContain('aria-label="Changes to the builder role"');
    expect(html).toContain('>Undo<');
  });

  it('marks an undone lesson, without its change or Undo', () => {
    const html = list([applied({ undoneAt: 2 })], 'The role changed since.');
    expect(html).toContain('>Undone<');
    expect(html).not.toContain('>Undo<');
    expect(html).not.toContain('aria-label="Changes to the builder role"');
    expect(html).toContain('The role changed since.');
  });
});
