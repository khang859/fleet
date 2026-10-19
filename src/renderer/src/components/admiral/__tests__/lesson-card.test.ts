import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { AgencyQuestion } from '../../../../../shared/agency';
import { agencyQuestion } from '../../../../../shared/__tests__/agency-fixtures';
import type { CrewLesson } from '../../../../../shared/agency-lessons';
import { QuestionCard } from '../QuestionCard';

/** A crew lesson card: the role's text struck out and the text that replaces it. */

const LESSON: CrewLesson = {
  jobId: 7,
  role: 'builder',
  source: 'bundled',
  cue: 'When the project has a lint step',
  lesson: 'Run lint before you finish.',
  evidence: 'The review sent back lint errors on both PRs.',
  replace: "Run the project's checks before you finish.",
  with: "Run the project's checks and lint before you finish."
};

const lessonCard = (lesson: CrewLesson, layout: 'card' | 'reader' = 'card'): string =>
  renderToStaticMarkup(
    createElement(QuestionCard, {
      question: agencyQuestion({
        kind: 'crew_lesson',
        question: 'Teach the builder role?',
        context: `${lesson.lesson}\n\n**When:** ${lesson.cue}. **Seen on j7:** ${lesson.evidence}`,
        options: [{ label: 'This project' }, { label: 'All projects' }, { label: 'Not now' }],
        lesson
      }) satisfies AgencyQuestion,
      onAnswer: async () => Promise.resolve(true),
      onOpenSettings: () => {},
      layout
    })
  );

describe('crew lesson card', () => {
  it('shows the replaced text struck out above the new text, and the options', () => {
    const html = lessonCard(LESSON);
    expect(html).toContain('aria-label="Changes to the builder role"');
    expect(html).toMatch(/line-through[^>]*>Run the project&#x27;s checks before you finish\./);
    expect(html).toContain('Run the project&#x27;s checks and lint before you finish.');
    expect(html.indexOf('aria-label="Remove"')).toBeLessThan(html.indexOf('aria-label="Add"'));
    expect(html).toContain('All projects');
    expect(html).toContain('The review sent back lint errors on both PRs.');
    expect(html).not.toContain('Or answer in your own words');
  });

  it('shows only the new paragraph when the lesson adds one', () => {
    const html = lessonCard({ ...LESSON, replace: null });
    expect(html).not.toContain('aria-label="Remove"');
    expect(html).toContain('aria-label="Add"');
  });

  it('shows the change in the reader', () => {
    const html = lessonCard(LESSON, 'reader');
    expect(html).toContain('THE CHANGE');
    expect(html).toContain('WHY FLEET ASKS');
    expect(html).toContain('aria-label="Changes to the builder role"');
    expect(html).not.toContain('In your own words');
  });
});
