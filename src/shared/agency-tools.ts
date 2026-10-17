import { z } from 'zod';
import type { AgentToolSpec } from './agent-tools';
import { DELIVERABLE_KINDS, PLAN_MAX_STEPS, PlanSchema } from './agency-plan';
import { offeredToolSpecs } from './capability-tools';

/**
 * The tools only an Admiral turn has: putting a question to the client,
 * opening a job from the lobby, listing the repository's jobs, and in a job's
 * own thread proposing its plan and moving its steps.
 *
 * Like the fleet tools they sit behind a nullable capability (`ctx.agency`),
 * so a turn that is not an Admiral's has nothing behind them, and a member is
 * null where the tool does not apply: `job_open` exists only in the lobby,
 * because a change to a job happens only in that job's conversation, and
 * `job_plan` and `job_update` exist only in a job's thread.
 *
 * None of them waits on the client. `ask_client` and `job_plan` return the
 * moment the card is up, and the answer comes back later as a wakeup, so the
 * client can always chat and a quit never leaves a call without a result.
 */

export const AGENCY_TOOL_NAMES = [
  'ask_client',
  'job_open',
  'job_list',
  'job_plan',
  'job_update'
] as const;
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
/** Longest progress note on a step. */
export const STEP_NOTE_MAX_CHARS = 2_000;

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

/** The whole plan, every time; Fleet works out what changed. */
export const JobPlanArgs = PlanSchema;

export const JobUpdateArgs = z
  .object({
    step: z.string().trim().min(1).max(40),
    status: z.enum(['running', 'blocked', 'done']).optional(),
    note: z.string().trim().min(1).max(STEP_NOTE_MAX_CHARS).optional()
  })
  .refine((a) => a.status !== undefined || a.note !== undefined, {
    message: 'give a status, a note, or both'
  });

export type AskClientArgs = z.infer<typeof AskClientArgs>;
export type JobOpenArgs = z.infer<typeof JobOpenArgs>;
export type JobListArgs = z.infer<typeof JobListArgs>;
export type JobPlanArgs = z.output<typeof JobPlanArgs>;
export type JobUpdateArgs = z.infer<typeof JobUpdateArgs>;

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
  /** Null in the lobby: a plan is always one job's. */
  jobPlan: Run<JobPlanArgs> | null;
  /** Null in the lobby. */
  jobUpdate: Run<JobUpdateArgs> | null;
};

/** The capability member behind each tool. */
export const AGENCY_TOOL_MEMBER = {
  ask_client: 'askClient',
  job_open: 'jobOpen',
  job_list: 'jobList',
  job_plan: 'jobPlan',
  job_update: 'jobUpdate'
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

const PLAN_DESCRIPTION = [
  "Propose this job's plan as a card for the client: the playbook, a short summary, the steps, the budget and what you will ask before doing.",
  'Always send the whole plan. To change an approved plan, send it again with the change: keep the ids of steps that stay, so Fleet can show the client what changes. A step that is done, or already delivered something, cannot change or go.',
  'Returns at once. The client approves, edits or rejects it, and that arrives as a wakeup. Nothing starts before the client approves, and only the newest version can be approved, so a new call replaces one still waiting.'
].join('\n\n');

const UPDATE_DESCRIPTION = [
  'Move a step of the approved plan, or add a progress note to it, or both.',
  '`running` starts a step whose `after` steps are done; `blocked` says it cannot go on; `done` finishes it, withdraws its open questions, and delivers the job once every step is done and handed back what it listed.',
  'A note is one or two sentences the client sees in the job sheet.'
].join('\n\n');

const stringList = (description: string): Record<string, unknown> => ({
  type: 'array',
  items: { type: 'string' },
  description
});

const stepSchema = {
  type: 'object',
  properties: {
    id: {
      type: 'string',
      pattern: '^[a-z0-9][a-z0-9-]{0,39}$',
      description: 'Stable across versions, like builder-1: the same id is the same step.'
    },
    role: { type: 'string', description: 'The crew role that does the step, like builder.' },
    title: { type: 'string', description: 'What the step does, in a few words.' },
    runtime: { type: 'string', enum: ['claude', 'eva'] },
    model: { type: 'string' },
    after: stringList('Ids of the steps that must be done before this one starts.'),
    changes: stringList('Project members the step changes; empty for every member.'),
    reads: stringList('Project members the step only reads.'),
    paths: stringList('Paths the step expects to touch, as member/dir.'),
    deliverables: {
      type: 'array',
      description: 'What the step hands back: a kind, or {kind, label}.',
      items: {
        anyOf: [
          { type: 'string', enum: [...DELIVERABLE_KINDS] },
          {
            type: 'object',
            properties: {
              kind: { type: 'string', enum: [...DELIVERABLE_KINDS] },
              label: { type: 'string' }
            },
            required: ['kind'],
            additionalProperties: false
          }
        ]
      }
    }
  },
  required: ['id', 'role', 'title'],
  additionalProperties: false
};

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
  },
  {
    type: 'function',
    function: {
      name: 'job_plan',
      description: PLAN_DESCRIPTION,
      parameters: {
        type: 'object',
        properties: {
          playbook: { type: 'string', description: 'The playbook the plan follows, like feature.' },
          summary: { type: 'string', description: 'What the job will do, for the client.' },
          steps: { type: 'array', items: stepSchema, minItems: 1, maxItems: PLAN_MAX_STEPS },
          budget: {
            type: 'object',
            properties: {
              usd: { type: 'number', description: 'The most the job may spend, in dollars.' },
              weekPct: {
                type: 'number',
                description: "The most of the week's plan use, in percent."
              }
            },
            required: ['usd'],
            additionalProperties: false
          },
          queueBehind: {
            type: ['integer', 'null'],
            description: 'A job number to run after, rather than next to it.'
          },
          asksFirst: stringList(
            'What you check with the client before doing it: merge, deploy, deletes.'
          )
        },
        required: ['playbook', 'summary', 'steps', 'budget'],
        additionalProperties: false
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'job_update',
      description: UPDATE_DESCRIPTION,
      parameters: {
        type: 'object',
        properties: {
          step: { type: 'string', description: 'The step id.' },
          status: { type: 'string', enum: ['running', 'blocked', 'done'] },
          note: { type: 'string', maxLength: STEP_NOTE_MAX_CHARS }
        },
        required: ['step'],
        additionalProperties: false
      }
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
