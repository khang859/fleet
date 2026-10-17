import { z } from 'zod';
import type { AgentToolSpec } from './agent-tools';
import { offeredToolSpecs } from './capability-tools';

/**
 * The tools only an Admiral turn has: putting a question to the client,
 * opening a job from the lobby, and listing the repository's jobs.
 *
 * Like the fleet tools they sit behind a nullable capability (`ctx.agency`),
 * so a turn that is not an Admiral's has nothing behind them, and a member is
 * null where the tool does not apply: `job_open` exists only in the lobby,
 * because a change to a job happens only in that job's conversation.
 *
 * None of them waits on the client. `ask_client` returns the moment the card
 * is up, and the answer comes back later as a wakeup, so the client can always
 * chat and a quit never leaves a call without a result.
 */

export const AGENCY_TOOL_NAMES = ['ask_client', 'job_open', 'job_list'] as const;
export type AgencyToolName = (typeof AGENCY_TOOL_NAMES)[number];

/** Longest question a card shows. */
export const ASK_QUESTION_MAX_CHARS = 300;
/** Longest context paragraph under a question. */
export const ASK_CONTEXT_MAX_CHARS = 1_500;
/** Longest option label, which is a button. */
export const ASK_OPTION_LABEL_MAX_CHARS = 80;
/** Longest line of detail under an option. */
export const ASK_OPTION_DETAIL_MAX_CHARS = 300;
/** Longest job title, which is a tab. */
export const JOB_TITLE_MAX_CHARS = 80;
/** Longest brief a job opens with. */
export const JOB_BRIEF_MAX_CHARS = 4_000;

const option = z.object({
  label: z.string().trim().min(1).max(ASK_OPTION_LABEL_MAX_CHARS),
  detail: z.string().trim().min(1).max(ASK_OPTION_DETAIL_MAX_CHARS).optional()
});

/**
 * Option numbers are 1-based here, as the card and the wakeup text number
 * them, and turned into indexes where the store is called.
 */
export const AskClientArgs = z.object({
  question: z.string().trim().min(1).max(ASK_QUESTION_MAX_CHARS),
  context: z.string().trim().max(ASK_CONTEXT_MAX_CHARS).optional(),
  options: z.array(option).min(2).max(4),
  recommended: z.number().int().min(1).max(4).optional(),
  depends_on: z
    .object({ question: z.number().int().min(1), option: z.number().int().min(1).max(4) })
    .optional(),
  step: z.string().trim().min(1).max(80).optional()
});

export const JobOpenArgs = z.object({
  title: z.string().trim().min(1).max(JOB_TITLE_MAX_CHARS),
  brief: z.string().trim().min(1).max(JOB_BRIEF_MAX_CHARS)
});

export const JobListArgs = z.object({});

export type AskClientArgs = z.infer<typeof AskClientArgs>;
export type JobOpenArgs = z.infer<typeof JobOpenArgs>;
export type JobListArgs = z.infer<typeof JobListArgs>;

/** What an agency tool hands back: the text for the model, and the row in the transcript. */
export type AgencyToolOutput = { text: string; summary: string };

type Run<A> = (args: A) => Promise<AgencyToolOutput>;

/**
 * What the agency tools are given, for one Admiral thread: its repository and
 * either one job or the lobby. Every member writes only within that scope, so
 * a job thread cannot ask in another job's name and the lobby cannot change a
 * job.
 */
export type AgentAgencyCapability = {
  askClient: Run<AskClientArgs>;
  /** Null outside the lobby. */
  jobOpen: Run<JobOpenArgs> | null;
  jobList: Run<JobListArgs>;
};

/** The capability member behind each tool. */
export const AGENCY_TOOL_MEMBER = {
  ask_client: 'askClient',
  job_open: 'jobOpen',
  job_list: 'jobList'
} as const satisfies Record<AgencyToolName, keyof AgentAgencyCapability>;

const ASK_DESCRIPTION = [
  'Put a question to the client as a card in the job sheet and the conversation.',
  'Give the context they need to answer without scrolling back, two to four options, and the option you recommend. The client can pick one or type their own answer.',
  'Returns at once with the question id. The answer arrives later as a wakeup, so carry on with work that does not depend on it; do not wait or ask again.',
  'Ask everything you need for the next step in one go, as several cards in the same turn, rather than one question per turn. Never ask what the client file or an earlier answer already settles.',
  'Use `depends_on` for a question that only matters if an earlier one is answered a certain way: it stays hidden until then, and is withdrawn if the client picks another option.'
].join('\n\n');

const OPEN_DESCRIPTION = [
  'Open a new job from the lobby, once the client has asked for a piece of work and you know enough to name it.',
  'The job gets its own tab and conversation, which carries this lobby conversation over. Everything about the job happens there from then on.',
  'The title is a few words for the tab; the brief says what the client wants, in their terms, with what you agreed so far.'
].join('\n\n');

const LIST_DESCRIPTION =
  "List this repository's open jobs with their state and how many questions each has waiting on the client.";

const optionSchema = {
  type: 'object',
  properties: {
    label: { type: 'string', maxLength: ASK_OPTION_LABEL_MAX_CHARS },
    detail: { type: 'string', maxLength: ASK_OPTION_DETAIL_MAX_CHARS }
  },
  required: ['label'],
  additionalProperties: false
};

export const AGENCY_TOOL_SPECS: AgentToolSpec[] = [
  {
    type: 'function',
    function: {
      name: 'ask_client',
      description: ASK_DESCRIPTION,
      parameters: {
        type: 'object',
        properties: {
          question: { type: 'string', maxLength: ASK_QUESTION_MAX_CHARS },
          context: {
            type: 'string',
            maxLength: ASK_CONTEXT_MAX_CHARS,
            description: 'What the client needs to know to answer.'
          },
          options: { type: 'array', items: optionSchema, minItems: 2, maxItems: 4 },
          recommended: {
            type: 'integer',
            minimum: 1,
            maximum: 4,
            description: 'The number of the option you recommend, 1 for the first.'
          },
          depends_on: {
            type: 'object',
            description:
              'Show this question only once question `question` is answered with option `option`.',
            properties: {
              question: { type: 'integer', minimum: 1, description: 'The question id, 7 for q7.' },
              option: { type: 'integer', minimum: 1, maximum: 4 }
            },
            required: ['question', 'option'],
            additionalProperties: false
          },
          step: { type: 'string', description: 'The plan step this question is about, if any.' }
        },
        required: ['question', 'options'],
        additionalProperties: false
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'job_open',
      description: OPEN_DESCRIPTION,
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', maxLength: JOB_TITLE_MAX_CHARS },
          brief: { type: 'string', maxLength: JOB_BRIEF_MAX_CHARS }
        },
        required: ['title', 'brief'],
        additionalProperties: false
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'job_list',
      description: LIST_DESCRIPTION,
      parameters: { type: 'object', properties: {}, additionalProperties: false }
    }
  }
];

/**
 * The agency tools a turn offers: none without a capability, and of the rest
 * only those with something behind them.
 */
export function agencyToolSpecs(agency: AgentAgencyCapability | null): AgentToolSpec[] {
  return offeredToolSpecs(agency, AGENCY_TOOL_SPECS, AGENCY_TOOL_MEMBER);
}
