/**
 * The starter questions the Admiral asks once a project is set up, so it does
 * not have to ask them on every job. Each answer becomes one client file line.
 * The Admiral's pick is always the first choice.
 */

export type StarterChoice = { label: string; line: string };

export type StarterChoiceQuestion = {
  id: 'prs' | 'delivery' | 'notify';
  question: string;
  choices: StarterChoice[];
};

export const STARTER_CHOICE_QUESTIONS: readonly StarterChoiceQuestion[] = [
  {
    id: 'prs',
    question: 'How should crew open PRs?',
    choices: [
      { label: 'As drafts', line: 'Open PRs as drafts.' },
      { label: 'Ready for review', line: 'Open PRs ready for review.' }
    ]
  },
  {
    id: 'delivery',
    question: 'What does a job need before you see it?',
    choices: [
      {
        label: 'Checks, review and QA',
        line: 'Show me a job only after checks, review and QA pass.'
      },
      { label: 'Checks only', line: 'Show me a job once its checks pass.' }
    ]
  },
  {
    id: 'notify',
    question: 'When should I notify you?',
    choices: [
      { label: 'Questions and results only', line: 'Notify me for questions and results only.' },
      { label: 'Every step', line: 'Notify me at every step of a job.' }
    ]
  }
];

/** Dollar presets for the default job budget; the second is the Admiral's pick. */
export const BUDGET_USD_PRESETS = [5, 10, 25, 50] as const;
/** Presets for the share of the weekly Claude limit a job may use, in percent. */
export const BUDGET_SHARE_PRESETS = [5, 10, 25, 50] as const;

export type StarterAnswers = {
  prs: number;
  delivery: number;
  notify: number;
  budgetUsd: number;
  /** Percent of the weekly Claude Code limit. */
  budgetShare: number;
};

export const RECOMMENDED_STARTER: StarterAnswers = {
  prs: 0,
  delivery: 0,
  notify: 0,
  budgetUsd: 10,
  budgetShare: 10
};

function choiceLine(id: StarterChoiceQuestion['id'], index: number): string {
  const q = STARTER_CHOICE_QUESTIONS.find((s) => s.id === id);
  return (q?.choices[index] ?? q?.choices[0])?.line ?? '';
}

/** The client file lines the answers stand for, in the order the questions are asked. */
export function starterLines(a: StarterAnswers): string[] {
  return [
    choiceLine('prs', a.prs),
    choiceLine('delivery', a.delivery),
    `Default job budget: $${a.budgetUsd} and ${a.budgetShare}% of my weekly Claude limit.`,
    choiceLine('notify', a.notify)
  ];
}
