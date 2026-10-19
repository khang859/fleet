import { z } from 'zod';
import { oneLine } from './agency-client-file';

/**
 * Read your work: the sources the client may tick, what each one reads, and
 * the lines the Admiral's model proposes from them. Fleet collects the text
 * of the ticked sources only, masks secrets in it, and sends it once to the
 * Admiral's model; the client keeps or drops each line it proposes.
 */

export const READ_SOURCE_IDS = ['instructions', 'commits', 'reviews', 'prs', 'jobs'] as const;

export type ReadSourceId = (typeof READ_SOURCE_IDS)[number];

/** What a source is, as the Read your work list shows it. */
export const READ_SOURCE_COPY: Record<ReadSourceId, { label: string; hint: string }> = {
  instructions: {
    label: 'CLAUDE.md and AGENTS.md',
    hint: 'The rules you wrote for agents.'
  },
  commits: { label: 'Your last 100 commits', hint: 'The messages only. Not the code.' },
  reviews: {
    label: 'Your review comments on GitHub',
    hint: 'What you ask others to change. Through the GitHub CLI.'
  },
  prs: { label: 'Your pull request descriptions', hint: 'How you explain a change.' },
  jobs: { label: 'Past Admiral jobs here', hint: 'What you changed in plans, and what you said.' }
};

/** A source for one project: whether it can be read, and what it holds or why not. */
export type ReadSource = {
  id: ReadSourceId;
  available: boolean;
  /** What it holds, like "CLAUDE.md and your ~/.claude/CLAUDE.md", or why it cannot be read. */
  detail: string;
};

/**
 * Where a proposed line was read, as its tag says it: `(from your commits, …)`.
 * The project's instruction files keep their own names.
 */
export const READ_TAGS = [
  'CLAUDE.md',
  'AGENTS.md',
  'your CLAUDE.md',
  'your commits',
  'your review comments',
  'your PR descriptions',
  'past jobs'
] as const;

export type ReadTag = (typeof READ_TAGS)[number];

/** The project files whose rules a proposed line can clash with. */
export const RULE_FILES = ['CLAUDE.md', 'AGENTS.md'] as const;

export type RuleFile = (typeof RULE_FILES)[number];

/** The most lines one read proposes. */
export const READ_MAX_LINES = 12;
/** The most a proposed line says. */
export const READ_LINE_MAX = 200;
/** The most its evidence says. */
export const READ_EVIDENCE_MAX = 240;

/** One line the Admiral's model proposes, with where it read it and why. */
export type ReadProposal = {
  text: string;
  layer: 'you' | 'project';
  source: ReadTag;
  /** What in the source the line rests on, like "94 of your 100 commits use a scope". */
  evidence: string;
  /** The project rule the line goes against, for the client to pick a winner. */
  clash: { source: RuleFile; rule: string } | null;
};

export type ReadResult = { ok: true; lines: ReadProposal[] } | { ok: false; reason: string };

/** What the model must send back. Lines that do not fit are dropped, not the whole answer. */
const ExtractionLine = z.object({
  text: z.string(),
  layer: z.enum(['you', 'project']),
  source: z.enum(READ_TAGS),
  evidence: z.string(),
  clashesWith: z.object({ source: z.enum(RULE_FILES), rule: z.string() }).nullish()
});

const Extraction = z.object({ lines: z.array(z.unknown()) });

/** A local model's thinking, which some servers leave in the answer. */
const THINKING = /<(think|thinking)>[\s\S]*?<\/\1>/g;

/** The JSON object in the answer: the one that starts with "lines" when there is one. */
function answerJson(text: string): unknown {
  const answer = text.replace(THINKING, '');
  const end = answer.lastIndexOf('}');
  const starts = [answer.search(/\{\s*"lines"\s*:/), answer.indexOf('{')];
  for (const start of starts) {
    if (start < 0 || end < start) continue;
    try {
      return JSON.parse(answer.slice(start, end + 1));
    } catch {
      // The next start, if any.
    }
  }
  return null;
}

/**
 * The lines in the model's answer, or null when it is not the JSON asked for.
 * Thinking, a fence or words around the object are allowed; a line that does
 * not fit the shape is left out, and every line is made one line and cut to size.
 */
export function parseExtraction(text: string): ReadProposal[] | null {
  const parsed = Extraction.safeParse(answerJson(text));
  if (!parsed.success) return null;
  return parsed.data.lines.flatMap((raw) => {
    const line = ExtractionLine.safeParse(raw);
    if (!line.success) return [];
    const { clashesWith, ...l } = line.data;
    const proposal: ReadProposal = {
      ...l,
      text: oneLine(l.text).slice(0, READ_LINE_MAX),
      evidence: oneLine(l.evidence).slice(0, READ_EVIDENCE_MAX),
      clash:
        clashesWith === null || clashesWith === undefined
          ? null
          : { source: clashesWith.source, rule: oneLine(clashesWith.rule) }
    };
    return proposal.text === '' ? [] : [proposal];
  });
}
