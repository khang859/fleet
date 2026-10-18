import { oneLine } from './agency-client-file';
import type { TrustLevel } from './agency-projects';

/**
 * Meet you: the questions the Admiral asks before the first job, so it need
 * not ask them on every job. The You questions are asked once for every
 * project; the project questions once per project. A pick writes its line to
 * the question's layer, except the last question's, which sets the project's
 * trust level. The recommended pick is always the first. No model is used.
 */

export const MEET_QUESTION_IDS = [
  'report',
  'never',
  'prs',
  'delivery',
  'tests',
  'budget',
  'checks'
] as const;

export type MeetQuestionId = (typeof MEET_QUESTION_IDS)[number];

export type MeetPick = {
  label: string;
  /** A few words under the label. */
  hint?: string;
  /** The line the pick writes. */
  line?: string;
  /** The trust level the pick sets, for the last question. */
  trust?: TrustLevel;
};

export type MeetQuestion = {
  id: MeetQuestionId;
  layer: 'you' | 'project';
  question: string;
  /** Several picks may be kept at once. */
  multi?: boolean;
  /** Answered with the budget pickers rather than picks. */
  budget?: true;
  picks: MeetPick[];
  /** Said under the picks. */
  note?: string;
};

export const MEET_QUESTIONS: readonly MeetQuestion[] = [
  {
    id: 'report',
    layer: 'you',
    question: 'How should I report to you?',
    picks: [
      {
        label: 'Short',
        hint: 'Only questions and results.',
        line: 'Keep updates short: come back only with questions and results.'
      },
      {
        label: 'Explain your reasoning',
        hint: 'Say why, not only what.',
        line: 'Explain your reasoning when you report.'
      },
      {
        label: 'Step by step',
        hint: 'A note as each step ends.',
        line: 'Report each step of a job as it ends.'
      }
    ]
  },
  {
    id: 'never',
    layer: 'you',
    question: 'What must crew never do?',
    multi: true,
    picks: [
      {
        label: 'Push to the default branch',
        line: 'Never push to the default branch: always a branch and a PR.'
      },
      {
        label: 'Edit CHANGELOG.md or generated files',
        line: 'Never edit CHANGELOG.md or generated files by hand.'
      },
      {
        label: 'Add a dependency without asking',
        line: 'Never add a dependency without asking first.'
      },
      { label: 'Force push', line: 'Never force push.' }
    ],
    note: 'Pick any. These hold for every project.'
  },
  {
    id: 'prs',
    layer: 'project',
    question: 'How should crew open pull requests?',
    picks: [
      { label: 'As drafts', hint: 'So you can look first.', line: 'Open PRs as drafts.' },
      { label: 'Ready for review', line: 'Open PRs ready for review.' }
    ]
  },
  {
    id: 'delivery',
    layer: 'project',
    question: 'What does a job need before you see it?',
    picks: [
      {
        label: 'Checks, review and QA',
        line: 'Show me a job only after checks, review and QA pass.'
      },
      { label: 'Checks only', line: 'Show me a job once its checks pass.' }
    ]
  },
  {
    id: 'tests',
    layer: 'project',
    question: 'What tests should a change come with?',
    picks: [
      { label: 'Unit tests with every change', line: 'Add unit tests with every change.' },
      {
        label: 'Unit, plus end-to-end for UI changes',
        line: 'Add unit tests with every change, and end-to-end tests for UI changes.'
      },
      {
        label: 'My call per job',
        hint: 'Ask in the plan.',
        line: 'Ask me in the plan which tests a job needs.'
      }
    ]
  },
  {
    id: 'budget',
    layer: 'project',
    question: 'What is the default budget for a job?',
    budget: true,
    picks: [],
    note: 'Money pays for the Admiral’s model, eva and API crew. Claude sub is a share of your weekly Claude Code limit. Cloud costs, such as Neon, Vercel or AWS, are not counted.'
  },
  {
    id: 'checks',
    layer: 'project',
    question: 'When a job is done and its checks pass, what should I do?',
    picks: [
      {
        label: 'Show me the PR, I merge',
        hint: 'Small plans start on their own. You see one card per job.',
        trust: 'pr'
      },
      {
        label: 'Merge it for me',
        hint: 'Small plans start and merge on their own. You get a report after.',
        trust: 'ship'
      },
      { label: 'Ask me each time', hint: 'You approve each plan and result.', trust: 'ask' }
    ],
    note: 'You can change this per project later.'
  }
];

/** The recommended default budget for a job: dollars, and percent of the weekly Claude limit. */
export const MEET_BUDGET = { usd: 10, weekPct: 10 } as const;

export const meetQuestion = (id: MeetQuestionId): MeetQuestion =>
  MEET_QUESTIONS.find((q) => q.id === id) ?? MEET_QUESTIONS[0];

/** The line a budget answer writes. */
export const budgetLine = (usd: number, weekPct: number): string =>
  `Default job budget: $${usd} and ${weekPct}% of my weekly Claude limit.`;

/** One answer: picks by index, words of the client's own, a budget, or a skip. */
export type MeetAnswer =
  | { kind: 'picks'; picks: number[] }
  | { kind: 'text'; text: string }
  | { kind: 'budget'; usd: number; weekPct: number }
  | { kind: 'skip' };

/** The most a typed answer may say. */
export const MEET_TEXT_MAX = 500;

/**
 * What an answer saves: the lines for the question's layer, and for the last
 * question the trust level its pick sets. A typed answer is saved as typed,
 * made one line; a skip saves nothing.
 */
export function meetAnswerResult(
  question: MeetQuestion,
  answer: MeetAnswer
): { lines: string[]; trust: TrustLevel | null } {
  if (answer.kind === 'text') {
    const text = oneLine(answer.text).slice(0, MEET_TEXT_MAX);
    return { lines: text === '' ? [] : [text], trust: null };
  }
  if (answer.kind === 'budget')
    return { lines: [budgetLine(answer.usd, answer.weekPct)], trust: null };
  if (answer.kind === 'skip') return { lines: [], trust: null };
  const picks = [...new Set(answer.picks)]
    .map((i) => question.picks.at(i))
    .filter((p): p is MeetPick => p !== undefined)
    .slice(0, question.multi === true ? undefined : 1);
  return {
    lines: picks.flatMap((p) => (p.line === undefined ? [] : [p.line])),
    trust: picks.find((p) => p.trust !== undefined)?.trust ?? null
  };
}

/**
 * The questions a project still has to go through, in order: the You ones
 * the client has not been through on any project, and the project's own. A
 * project that finished the earlier starter questions has answered its own.
 */
export function meetLeft(input: {
  youSeen: readonly MeetQuestionId[] | null;
  projectSeen: readonly MeetQuestionId[] | null;
  starterDone: boolean;
}): MeetQuestionId[] {
  const projectSeen = input.projectSeen ?? (input.starterDone ? null : []);
  return MEET_QUESTIONS.filter((q) =>
    q.layer === 'you'
      ? !(input.youSeen ?? []).includes(q.id)
      : projectSeen !== null && !projectSeen.includes(q.id)
  ).map((q) => q.id);
}
