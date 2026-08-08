import { z } from 'zod';
import { TODO_MAX_ITEMS, TODO_STATUSES, type AgentTodoItem } from './agent-todos';
import type { McpToolOutput } from './agent-mcp';
import type { SubagentDefinition } from './agent-subagents';
import type { SkillDefinition } from './agent-skills';

/**
 * The tools the agent can call, and the limits they answer within.
 *
 * Deliberately few: find files by name, find them by content, look at one,
 * change part of one, write a whole one, and run a command. The first five are
 * the whole of reading and writing code; the sixth is everything else. So a
 * shell command that only looks at a file or searches for text is a call that
 * should have been one of the other five, and `bash` says so when it happens -
 * a tool that overlaps another only gives the model a decision to get wrong.
 *
 * Every limit here is a promise about the size of a tool result, because a tool
 * result is context the user pays for and never sees. The rule they follow: cut
 * at a boundary, and say what was cut and how to ask for the rest. A truncated
 * result the model believes is complete is worse than no result at all.
 *
 * `terminal` and `image` sit outside that set. Neither is a way of working on
 * the code: one hands a command to the user because it needs a person, and the
 * other makes a picture. `image` is also the only tool here that is not always
 * offered - without an image model configured it is not advertised at all.
 *
 * The two todo tools sit outside it again, and are the only pair here that
 * breaks the one-word naming: they are two halves of one thing, and `add` and
 * `update` on their own would read as being about anything. They do not touch
 * the project at all - they write the plan the agent is working to, which the
 * pane shows and which is handed back to the model on every round. There is
 * deliberately no tool to read the list: the model is given it unasked, so a
 * tool for fetching it would only be a way of spending a round on something it
 * already has.
 */

/**
 * Every tool a subagent may be given: all of them but the one that starts
 * another subagent.
 *
 * Written first, and `task` appended below, so that a tool added here becomes
 * available to subagents without anyone remembering to come back for it - the
 * list that has to be maintained is the longer one. This is one of the two
 * halves of "no nesting"; the other is that a child's tool context has no
 * `dispatchTask` to call. Two halves that do not depend on each other, because
 * one of them being wrong should not be enough to get a subagent spawning
 * subagents.
 */
export const SUBAGENT_TOOL_NAMES = [
  'read',
  'glob',
  'grep',
  'edit',
  'write',
  'bash',
  'terminal',
  'image',
  'skill',
  'todo_add',
  'todo_update'
] as const;
export type SubagentToolName = (typeof SUBAGENT_TOOL_NAMES)[number];

export const AGENT_TOOL_NAMES = [...SUBAGENT_TOOL_NAMES, 'task'] as const;
export type AgentToolName = (typeof AGENT_TOOL_NAMES)[number];

/** Whether a name is one of the two tools that write the task list. */
export function isTodoTool(name: string): boolean {
  return name === 'todo_add' || name === 'todo_update';
}

/**
 * Lines a `read` returns when the model does not say. Small on purpose: most
 * reads are a look at one function, and the model can always ask for more,
 * whereas it cannot un-spend the context a whole file cost it.
 */
export const READ_DEFAULT_LIMIT = 200;

/** Ceiling for one `read`, however many lines it asks for. */
export const READ_MAX_LIMIT = 2000;

/** A line longer than this is cut; minified files are not worth a context window. */
export const READ_MAX_LINE_CHARS = 2000;

/** Paths one `glob` returns. */
export const GLOB_MAX_RESULTS = 100;

/** Matches one `grep` returns in content mode. */
export const GREP_MAX_MATCHES = 50;

/** Files one `grep` will open before it stops looking. */
export const GREP_MAX_FILES = 20_000;

/**
 * Largest file `edit` or `write` will touch. Editing means holding the whole
 * file in memory twice, and a file this size is generated, minified or data -
 * none of which a model should be rewriting through a string match.
 */
export const EDIT_MAX_FILE_BYTES = 2_000_000;

/** Lines of diff a change reports back. Past this the change is its own review. */
export const DIFF_MAX_LINES = 200;

/**
 * How long a command runs before it is killed, when the call does not say.
 * Long enough for a test suite or an install, short enough that a command
 * waiting for input nobody can give it does not hold the turn all afternoon.
 */
export const BASH_DEFAULT_TIMEOUT_MS = 120_000;

/** Ceiling for one command, however long it asks for. */
export const BASH_MAX_TIMEOUT_MS = 600_000;

/** Shortest timeout a call may ask for; below this it is a number in seconds. */
export const BASH_MIN_TIMEOUT_MS = 1_000;

/**
 * Characters of output one command reports back. A build prints far more than
 * this and says everything that matters in the first few lines and the last
 * few, which is what gets kept.
 */
export const BASH_MAX_OUTPUT_CHARS = 30_000;

/**
 * The line between what a tool says about a command and the command's own
 * output.
 *
 * The pane shows only what follows the first one. Everything above it is the
 * tool talking to the model - how the command ended, and any reminder attached
 * to it - and an instruction addressed to the model has no business appearing
 * in the user's transcript as though it were addressed to them. Ours is always
 * first, so a separator the command happens to print in its own output cannot
 * be mistaken for it.
 */
export const OUTPUT_SEPARATOR = '--- output ---';

export const ReadArgs = z.object({
  path: z.string().min(1),
  /** 1-indexed, like every editor and like the output this returns. */
  offset: z.number().int().positive().optional(),
  limit: z.number().int().positive().max(READ_MAX_LIMIT).optional()
});

export const GlobArgs = z.object({
  pattern: z.string().min(1),
  path: z.string().optional()
});

export const GrepArgs = z.object({
  pattern: z.string().min(1),
  path: z.string().optional(),
  /** Restricts the search to files whose path matches this glob. */
  glob: z.string().optional(),
  ignoreCase: z.boolean().optional(),
  /**
   * `content` (the default) answers the question in one call; `files` answers
   * "where does this live" without spending context on the lines themselves.
   */
  mode: z.enum(['content', 'files']).optional()
});

export const EditArgs = z.object({
  path: z.string().min(1),
  /** Text to find, exactly as it appears in the file. */
  oldString: z.string().min(1),
  newString: z.string(),
  /** Change every occurrence instead of refusing an ambiguous one. */
  replaceAll: z.boolean().optional()
});

export const WriteArgs = z.object({
  path: z.string().min(1),
  content: z.string()
});

export const BashArgs = z.object({
  command: z.string().min(1),
  /**
   * Named for its unit: a bare `timeout` invites a number of seconds, and a
   * command killed after 30ms looks like a command that failed.
   */
  timeoutMs: z.number().int().min(BASH_MIN_TIMEOUT_MS).max(BASH_MAX_TIMEOUT_MS).optional()
});

/**
 * A character a terminal acts on rather than shows. Written as a comparison
 * rather than a character class because the class would be a regex full of
 * literal control characters, which is its own kind of unreadable.
 */
function isControlChar(c: string): boolean {
  return c < ' ' || c === '\u007f';
}

/**
 * Aspect ratios the images endpoint normalizes. A closed list rather than a
 * free string: a model that invents `1920:1080` gets an error from the provider
 * halfway through a paid call, where a rejected argument costs nothing.
 */
export const IMAGE_ASPECT_RATIOS = [
  '1:1',
  '16:9',
  '9:16',
  '4:3',
  '3:4',
  '3:2',
  '2:3',
  '21:9'
] as const;

/**
 * Reference images one edit may cite. Each one is uploaded with the request, so
 * the ceiling is about what the call costs and what providers accept rather
 * than about anything Fleet cannot do.
 */
export const IMAGE_MAX_REFERENCES = 4;

export const ImageArgs = z.object({
  prompt: z.string().min(1),
  /**
   * Images to work from, turning generation into editing. Paths, not bytes:
   * the pixels never travel through the model's arguments.
   */
  references: z.array(z.string().min(1)).max(IMAGE_MAX_REFERENCES).optional(),
  aspectRatio: z.enum(IMAGE_ASPECT_RATIOS).optional()
});

export const TerminalArgs = z.object({
  command: z
    .string()
    .min(1)
    // Every control character, not just the newline. What is typed into a
    // terminal is not read by the terminal - a carriage return is the Enter
    // key to the tty's line discipline, and the promise this tool makes is
    // that the user presses that themselves.
    .refine((command) => ![...command].some(isControlChar), {
      message: 'has to be one line of plain text - it is typed into a terminal for someone to run'
    })
});

/**
 * One item as the model writes it. `activeForm` is optional because a model
 * that gives one line instead of two should still get its item, and the pane
 * falls back to `content` for the line it would have shown.
 */
const TodoDraft = z.object({
  content: z.string().min(1).max(200),
  activeForm: z.string().min(1).max(200).optional()
});

export const TodoAddArgs = z.object({
  /**
   * Several at once, because a plan is written in one sitting. The alternative
   * costs a round per item and lets a turn end with half a plan on screen.
   */
  items: z.array(TodoDraft).min(1).max(TODO_MAX_ITEMS)
});

export const TodoUpdateArgs = z.object({
  id: z.string().min(1),
  status: z.enum(TODO_STATUSES),
  /** Rewriting the item, for when the work turned out to be something else. */
  content: z.string().min(1).max(200).optional(),
  activeForm: z.string().min(1).max(200).optional()
});

/**
 * Handing a job to a subagent.
 *
 * `prompt` is the whole of what crosses over: a subagent starts from nothing and
 * cannot see this conversation, so a prompt that refers to "the file we were
 * looking at" is a prompt about a file the child has never heard of. The tool's
 * description says so in as many words, because this is the one thing every
 * product that has shipped subagents reports people getting wrong.
 *
 * `tools` and `model` are the caller's to set per errand rather than the
 * definition's to fix, because the parent is the one that knows what this
 * particular job needs. Both fall back to the definition when absent.
 */
export const TaskArgs = z.object({
  agent: z.string().min(1),
  prompt: z.string().min(1),
  tools: z.array(z.enum(SUBAGENT_TOOL_NAMES)).min(1).optional()
});

export type ReadArgs = z.infer<typeof ReadArgs>;
export type GlobArgs = z.infer<typeof GlobArgs>;
export type GrepArgs = z.infer<typeof GrepArgs>;
export type EditArgs = z.infer<typeof EditArgs>;
export type WriteArgs = z.infer<typeof WriteArgs>;
export type BashArgs = z.infer<typeof BashArgs>;
export type TerminalArgs = z.infer<typeof TerminalArgs>;
export type ImageArgs = z.infer<typeof ImageArgs>;
export type TodoAddArgs = z.infer<typeof TodoAddArgs>;
export type TodoUpdateArgs = z.infer<typeof TodoUpdateArgs>;
export type TaskArgs = z.infer<typeof TaskArgs>;

/** The JSON Schema for one tool, as the completions API wants it. */
export type AgentToolSpec = {
  type: 'function';
  function: {
    name: AgentToolName;
    description: string;
    parameters: Record<string, unknown>;
  };
};

/**
 * The same, for a tool the agent does not own.
 *
 * An MCP server names its own tools and writes its own schemas, so the name is
 * a string rather than one of ours and the parameters are whatever the server
 * said. Separate from `AgentToolSpec` so that the agent's own tools keep the
 * closed set - a typo in one of those should still be a compile error.
 */
export type ExternalToolSpec = {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
};

/** Anything a turn may offer: the agent's own tools, and connected servers'. */
export type ToolSpec = AgentToolSpec | ExternalToolSpec;

const READ_DESCRIPTION = [
  `Read a file, ${READ_DEFAULT_LIMIT} lines at a time by default.`,
  'Output is the file with line numbers, so a line number you quote back is the real one.',
  'Pass `offset` and `limit` to read further in - the footer of a truncated read tells you the next offset to ask for.',
  'A png, jpg, webp or gif comes back as the picture itself rather than as text, so use this to look at a screenshot, a mockup or an image you generated.',
  'Paths may be absolute or relative to the working folder, and must stay inside it.'
].join(' ');

const GLOB_DESCRIPTION = [
  'Find files by path pattern, newest first.',
  'Supports `*`, `**`, `?`, `{a,b}` and `[a-z]`; `*` does not cross a `/` but `**` does.',
  'Use this when you know something about the name or location of a file, and `grep` when you know something about what is inside it.'
].join(' ');

const GREP_DESCRIPTION = [
  'Search file contents with a regular expression.',
  'Returns matching lines with their file and line number, or just the file paths in `files` mode.',
  'Narrow with `glob` (e.g. `**/*.ts`) or `path` rather than searching everything twice.',
  'Files ignored by git and anything under `.git` are never searched.'
].join(' ');

const EDIT_DESCRIPTION = [
  'Change part of a file by replacing exact text.',
  'Read the file first and copy `oldString` out of what `read` returned, without the line numbers.',
  'It must match the file character for character, including indentation, and must appear exactly once - include the lines around it to pin down which occurrence you mean, or set `replaceAll` to change every one.',
  'Returns a diff of what changed.'
].join(' ');

const WRITE_DESCRIPTION = [
  'Create a file, or replace everything in one that already exists.',
  'Use `edit` for a change to an existing file: a rewrite silently drops whatever you did not repeat.',
  'Overwriting requires having read the file first. Missing parent folders are created.'
].join(' ');

const BASH_DESCRIPTION = [
  'Run a shell command in the working folder.',
  'This is the last tool to reach for, not the first: `read`, `glob`, `grep`, `edit` and `write` do everything they cover better than `cat`, `find`, `grep` and `sed` do here, and they keep their output small enough to be worth reading.',
  'Use the shell for what only the shell can do - running tests, builds, linters, git, package managers and scripts.',
  'Each command runs on its own, so a `cd` or an exported variable is gone by the next call; chain with `&&` in one command when that matters.',
  `Nothing can be typed into it, so avoid anything interactive. Output is cut at ${BASH_MAX_OUTPUT_CHARS.toLocaleString('en-US')} characters and the command is killed after ${BASH_DEFAULT_TIMEOUT_MS / 1000} seconds unless \`timeoutMs\` says otherwise.`
].join(' ');

const TERMINAL_DESCRIPTION = [
  'Hand a command to the user to run in a terminal, for the ones you cannot run yourself.',
  'Use it when a command needs a person at a real terminal: a login, a password or passphrase prompt, an interactive picker, a confirmation you cannot answer. Use it too for something the user should watch rather than wait on, like a dev server.',
  'The command is typed into a terminal beside this pane and left unrun, so they read it before it happens and press Enter themselves.',
  'Nothing comes back here. Say what the command is for and what they will be asked, and check the outcome yourself with `bash` once they say it is done.',
  'Never work around a prompt instead: no piping a password into `sudo -S`, and no secret on a command line.'
].join(' ');

const IMAGE_DESCRIPTION = [
  'Generate an image from a description, or edit existing ones by naming them in `references`.',
  'One image per call - call it again for a variation rather than expecting several from one.',
  'Write `prompt` as a description of the finished picture: subject, composition, style, colours. When editing, describe the result you want, not the change as an instruction.',
  'References are paths to images in the working folder, or to images you generated earlier in this conversation.',
  'The file is saved outside the working folder and its path comes back to you; copy it in with `bash` if it belongs in the project. The user is shown the image, so do not describe it back to them.'
].join(' ');

const TODO_ADD_DESCRIPTION = [
  'Add tasks to the list you are working through, which the user can see.',
  'Use it at the start of anything with several steps, and again whenever the work turns up something the list does not mention - a plan that stops describing what you are doing is worse than none.',
  'Skip it for a question or a single edit.',
  'Each item gets a number, returned to you here, which is what `todo_update` takes.',
  'You are given the whole list back on every round, so there is nothing to fetch and no reason to add an item twice.'
].join(' ');

const TODO_UPDATE_DESCRIPTION = [
  'Change one task on your list: mark it `in_progress` when you start it, `completed` the moment it is genuinely done, or `cancelled` if it turned out not to be needed.',
  'One item per call, by its number.',
  'Only one task may be `in_progress` at a time.',
  'Do not save up completions for the end - the user is watching this while you work, and a list that all turns green at once told them nothing on the way.'
].join(' ');

/**
 * What the model is told it can call. Kept next to the zod schemas above so the
 * shape advertised and the shape enforced cannot drift apart.
 *
 * Everything here is offered on every turn except `image` - see `toolSpecsFor`,
 * which is what a turn should actually send.
 */
export const AGENT_TOOL_SPECS: AgentToolSpec[] = [
  {
    type: 'function',
    function: {
      name: 'read',
      description: READ_DESCRIPTION,
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File to read.' },
          offset: { type: 'integer', description: 'First line to return, 1-indexed.' },
          limit: {
            type: 'integer',
            description: `Lines to return. Defaults to ${READ_DEFAULT_LIMIT}, at most ${READ_MAX_LIMIT}.`
          }
        },
        required: ['path'],
        additionalProperties: false
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'glob',
      description: GLOB_DESCRIPTION,
      parameters: {
        type: 'object',
        properties: {
          pattern: {
            type: 'string',
            description: 'Glob to match against paths, e.g. `src/**/*.ts`.'
          },
          path: {
            type: 'string',
            description: 'Folder to search in. Defaults to the working folder.'
          }
        },
        required: ['pattern'],
        additionalProperties: false
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'grep',
      description: GREP_DESCRIPTION,
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'Regular expression to search for.' },
          path: {
            type: 'string',
            description: 'File or folder to search. Defaults to the working folder.'
          },
          glob: { type: 'string', description: 'Only search files whose path matches this glob.' },
          ignoreCase: { type: 'boolean', description: 'Match case-insensitively.' },
          mode: {
            type: 'string',
            enum: ['content', 'files'],
            description:
              '`content` returns matching lines (default); `files` returns only the paths.'
          }
        },
        required: ['pattern'],
        additionalProperties: false
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'edit',
      description: EDIT_DESCRIPTION,
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File to change.' },
          oldString: { type: 'string', description: 'Text to replace, exactly as it appears.' },
          newString: { type: 'string', description: 'What to put in its place. May be empty.' },
          replaceAll: {
            type: 'boolean',
            description: 'Replace every occurrence rather than requiring exactly one.'
          }
        },
        required: ['path', 'oldString', 'newString'],
        additionalProperties: false
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'write',
      description: WRITE_DESCRIPTION,
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File to create or replace.' },
          content: { type: 'string', description: 'The complete contents of the file.' }
        },
        required: ['path', 'content'],
        additionalProperties: false
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'bash',
      description: BASH_DESCRIPTION,
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'The command line to run.' },
          timeoutMs: {
            type: 'integer',
            description: `How long to let it run, in milliseconds. Defaults to ${BASH_DEFAULT_TIMEOUT_MS}, at most ${BASH_MAX_TIMEOUT_MS}.`
          }
        },
        required: ['command'],
        additionalProperties: false
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'terminal',
      description: TERMINAL_DESCRIPTION,
      parameters: {
        type: 'object',
        properties: {
          command: {
            type: 'string',
            description: 'The command line to put in front of the user. One line.'
          }
        },
        required: ['command'],
        additionalProperties: false
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'image',
      description: IMAGE_DESCRIPTION,
      parameters: {
        type: 'object',
        properties: {
          prompt: { type: 'string', description: 'A description of the finished image.' },
          references: {
            type: 'array',
            items: { type: 'string' },
            maxItems: IMAGE_MAX_REFERENCES,
            description:
              'Paths of images to work from. Present means editing rather than generating.'
          },
          aspectRatio: {
            type: 'string',
            enum: [...IMAGE_ASPECT_RATIOS],
            description: "Shape of the image. Defaults to the model's own."
          }
        },
        required: ['prompt'],
        additionalProperties: false
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'todo_add',
      description: TODO_ADD_DESCRIPTION,
      parameters: {
        type: 'object',
        properties: {
          items: {
            type: 'array',
            minItems: 1,
            maxItems: TODO_MAX_ITEMS,
            items: {
              type: 'object',
              properties: {
                content: {
                  type: 'string',
                  description: 'What is to be done, as an outcome. E.g. `Move the parser to zod`.'
                },
                activeForm: {
                  type: 'string',
                  description:
                    'The same thing while it is happening, shown as the status. E.g. `Moving the parser to zod`.'
                }
              },
              required: ['content'],
              additionalProperties: false
            },
            description: 'The tasks to add, in the order you mean to do them.'
          }
        },
        required: ['items'],
        additionalProperties: false
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'todo_update',
      description: TODO_UPDATE_DESCRIPTION,
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'The number of the task, as shown in your list.' },
          status: {
            type: 'string',
            enum: [...TODO_STATUSES],
            description:
              '`in_progress` when you start it, `completed` when it is done, `cancelled` when it turned out not to be needed.'
          },
          content: { type: 'string', description: 'Rewrites the task, if it was not quite right.' },
          activeForm: { type: 'string', description: 'Rewrites the present-continuous form.' }
        },
        required: ['id', 'status'],
        additionalProperties: false
      }
    }
  }
];

/**
 * What `task` says about itself, given the subagents this folder actually has.
 *
 * Built per turn rather than sitting in `AGENT_TOOL_SPECS`, for the reason a
 * server's tools are: the choices are not known until someone looks. The names
 * go in an `enum` rather than being described in prose, because a name the
 * schema will not accept is a name the model cannot spend a round guessing
 * wrong, and the descriptions go beside them because that is the only thing the
 * model reads when deciding which one this job is for.
 *
 * `null` when there are none, so a folder with no definitions is never offered a
 * tool whose every call would come back an apology - the same rule `image`
 * follows when there is no model behind it.
 */
export function buildTaskSpec(definitions: SubagentDefinition[]): AgentToolSpec | null {
  if (definitions.length === 0) return null;
  const roster = definitions.map((d) => `- \`${d.name}\`: ${d.description}`).join('\n');
  return {
    type: 'function',
    function: {
      name: 'task',
      description: [
        'Hand a self-contained job to a subagent and get its findings back later.',
        '',
        'Worth it when answering something would cost you many tool calls but only',
        'a paragraph of the answer matters - searching an unfamiliar part of the',
        'repo, reading a long file to settle one question, reviewing a change. The',
        'subagent spends that reading in its own context rather than yours.',
        '',
        'Not worth it for anything you can answer in a call or two, and a poor way',
        'to write code: two subagents editing one project cannot see each other and',
        'come back with work that does not fit together. Make the changes yourself.',
        '',
        'It runs in the background. This call returns a receipt straight away, not',
        'an answer, and the report arrives on a later turn - so finish or wind up',
        'what you are doing rather than waiting, and never call `task` again just',
        'to check on one.',
        '',
        'The subagent cannot see this conversation. It starts from nothing and gets',
        'only what you write in `prompt`, so name the files, the paths, the errors',
        'and the decisions in full. "The file we were looking at" means nothing to',
        'it. Say what you want back, too: you will be shown only its final answer.',
        '',
        'The subagents available here:',
        roster
      ].join('\n'),
      parameters: {
        type: 'object',
        properties: {
          agent: {
            type: 'string',
            enum: definitions.map((d) => d.name),
            description: 'Which subagent to hand this to.'
          },
          prompt: {
            type: 'string',
            description:
              'The whole job, written for someone who has not seen this conversation. Include every path, name and error it needs, and say what you want reported back.'
          },
          tools: {
            type: 'array',
            items: { type: 'string', enum: [...SUBAGENT_TOOL_NAMES] },
            description:
              'The tools it may use. Omit to take the subagent’s own default, which is usually right. Narrow it when the job genuinely only needs reading.'
          }
        },
        required: ['agent', 'prompt'],
        additionalProperties: false
      }
    }
  };
}

/**
 * The tools one turn offers.
 *
 * `image` is advertised only when there is a model to run it. A tool named in
 * the request but backed by nothing is worse than a missing tool: the model
 * spends a round calling it, and the only thing that comes back is an apology.
 * `task` follows the same rule and is absent twice over - when the folder has no
 * subagents, and when this turn *is* one.
 *
 * `skill` follows the first half of that rule and not the second: a folder with
 * no skills does not get the tool, but a subagent does. A child doing the work
 * needs the house rules for it as much as the parent does, and it has no
 * conversation to have been told them in.
 *
 * `only` is how a subagent gets the narrower set its dispatch asked for. It
 * filters rather than selects, so a name that no longer exists quietly falls out
 * instead of producing a spec for a tool nothing can run.
 *
 * Connected servers' tools go last, so the agent's own keep the front of the
 * list no matter how many servers the user has switched on.
 */
export function toolSpecsFor(options: {
  image: boolean;
  mcp?: ExternalToolSpec[];
  task?: AgentToolSpec | null;
  skill?: AgentToolSpec | null;
  only?: readonly AgentToolName[];
}): ToolSpec[] {
  const allowed = (name: AgentToolName): boolean =>
    options.only === undefined || options.only.includes(name);
  const own = AGENT_TOOL_SPECS.filter(
    (spec) =>
      (options.image || spec.function.name !== 'image') && allowed(spec.function.name)
  );
  // Both are built per turn rather than living in `AGENT_TOOL_SPECS`, so both
  // are filtered here rather than by the loop above.
  const task = options.task ?? null;
  const skill = allowed('skill') ? (options.skill ?? null) : null;
  return [
    ...own,
    ...(skill === null ? [] : [skill]),
    ...(task === null ? [] : [task]),
    ...(options.mcp ?? [])
  ];
}

/**
 * One call the model made, and what came back.
 *
 * `args` stays as the raw JSON string the model wrote: it arrives in fragments
 * and can be malformed, and keeping the text means a failed parse can be shown
 * and replayed exactly as it happened rather than guessed at.
 */
export type AgentToolCall = {
  /** The provider's tool_call_id. What a result is addressed to. */
  id: string;
  name: string;
  args: string;
  /** What was sent back to the model. `null` while the tool is still running. */
  result: string | null;
  /** Set instead of a result when the tool refused or failed. */
  error: string | null;
  /** The one line the pane shows for this call, e.g. `42 matches in 7 files`. */
  summary: string | null;
  /**
   * A picture this call is handing over, on top of its text. `null` for every
   * call but a `read` of an image file, which is nearly all of them.
   *
   * A path rather than the bytes, for the same reason an attachment is one: the
   * file is read again each time the turn is built, so nothing base64 ever ends
   * up in the session log.
   */
  image: AgentToolImage | null;
  /**
   * The whole task list as this call left it, set only by the todo tools.
   *
   * The whole list rather than what changed, so the event that carries it can
   * be missed without leaving the pane showing something that never existed -
   * the next call puts it right, because every one of them is the truth in
   * full. It rides here rather than on a channel of its own for the same
   * reason `image` does: the pane already learns about finished calls, and a
   * second way of learning the same thing is a second way for the two to
   * disagree.
   */
  todos: AgentTodoItem[] | null;
  /**
   * The subagent this call started, set only by `task`.
   *
   * Here for the reason `todos` and `image` are here, and for one more of its
   * own. A dispatched subagent outlives the turn that dispatched it, so this
   * field is the only thing that still points at it once the turn is over - the
   * row in the transcript is where the parent's memory of the errand lives.
   *
   * It is also what makes the report arrive without a mechanism for reports.
   * When the child finishes, its answer is written into this call's `result`,
   * and the next turn's wire history serialises that call the way it serialises
   * every other one. Nothing has to inject anything: a field the pane already
   * persists simply says something different than it did an hour ago.
   */
  task: AgentTaskInfo | null;
};

/** An image a tool is handing to the model, as a file rather than as bytes. */
export type AgentToolImage = { path: string; mimeType: string };

export const AGENT_TASK_STATUSES = [
  'running',
  'done',
  'failed',
  'cancelled',
  'interrupted'
] as const;
export type AgentTaskStatus = (typeof AGENT_TASK_STATUSES)[number];

/**
 * A dispatched subagent, as the row that started it knows about it.
 *
 * `interrupted` is not a way a subagent ends, it is a way one is found: the app
 * was quit or crashed while it was running, and nothing is coming. It exists so
 * a card reopened afterwards can say what happened, rather than shimmer forever
 * waiting on a process that no longer exists.
 */
export type AgentTaskInfo = {
  /** The child's own id. It is its stream, its thread, and its session file. */
  id: string;
  /** Which definition ran. Held here rather than looked up on replay: the file
   * can be edited or deleted afterwards, and the transcript should still say
   * what actually ran rather than what a file of that name says today. */
  agent: string;
  /** What the parent asked for - the whole of what crossed into the child. */
  prompt: string;
  status: AgentTaskStatus;
  /** One line for the collapsed row, once there is one. `null` while running. */
  summary: string | null;
};

/**
 * What a tool runs against.
 *
 * `threadId` is here because "has this file been read" is a question about one
 * conversation, not about the app: a file another pane read is not a file this
 * model has seen, and letting one pane's reading license another pane's edits
 * would make the guarantee weaker than it sounds.
 */
export type AgentToolContext = {
  /** The folder the pane was opened on. Everything a tool touches lives inside it. */
  cwd: string;
  /** The conversation this call belongs to, stable across its turns. */
  threadId: string;
  /**
   * Aborted when the user stops the turn. A tool that only reads a file is over
   * before this can matter; a command that runs for ten minutes is not, and
   * "stop" has to mean the command stops rather than that the pane looks away.
   */
  signal: AbortSignal;
  /**
   * Put a command in front of the user, in a terminal beside the pane.
   *
   * The way out of every command the agent's own shell cannot finish - a login,
   * a password, a picker - because the pane it runs in has no terminal and
   * nobody to answer. One way only: what happens there is between the command
   * and the user, and the model finds out by asking afterwards.
   */
  handOff: (command: string) => void;
  /**
   * Whether a shell command may run.
   *
   * Only `bash` asks, because it is the only tool that can reach outside the
   * working folder. Most calls come back true without anyone being disturbed -
   * the user's rules answer them - and the rest wait here until the user does.
   */
  approve: (command: string) => Promise<boolean>;
  /**
   * Whether this turn has already been told no about a command.
   *
   * A refusal is about the command rather than the tool that offered it, so it
   * has to hold for the tool that does not ask. Otherwise the shortest way past
   * a "don't run" is to hand the same line to the user's own terminal.
   */
  wasRefused: (command: string) => boolean;
  /**
   * Make a picture, or `null` when no image model is configured.
   *
   * A capability rather than a key and a model on the context, so the tool
   * never holds a credential and settings stay in one place. `null` rather than
   * a function that always fails, because the difference decides whether the
   * tool is offered at all - and a call that arrives anyway (an older
   * transcript, an invented name) can then be told plainly what is off.
   */
  generateImage: AgentImageGenerator | null;
  /**
   * The task list as it stands, and a way to replace it.
   *
   * Turn-local: the pane owns the list and sends it with the request, this is
   * seeded from that, and it is thrown away when the turn ends. Main keeps no
   * copy, so nothing here has to be reconciled with what the pane thinks or
   * written anywhere - the pane already persists its own transcript, and a
   * second store of the same list would be the same problem solved twice.
   *
   * Reading through a function rather than holding the array means two calls in
   * one round see each other's work, which is what makes a plan of five items
   * added one after another come out with five different numbers.
   */
  todos: {
    list: () => AgentTodoItem[];
    save: (items: AgentTodoItem[]) => void;
  };
  /**
   * Run a tool one of the connected MCP servers offers, or `null` when there
   * are none - which is also when none was offered.
   *
   * A capability rather than the manager itself, for the reason `generateImage`
   * is one: what a tool needs is a way to make the call, not the connections,
   * the credentials, or the ability to reconfigure them. The permission gate is
   * already inside it by the time it gets here.
   */
  mcp: AgentMcpCaller | null;
  /**
   * Start a subagent, or `null` when there is no subagent to start.
   *
   * `null` in exactly two cases, and they mean the same thing to the model: no
   * definitions were found for this folder, and this *is* a subagent. The second
   * is how "no nesting" is enforced where it counts - not by checking a depth
   * counter at dispatch, but by never giving a child the thing it would need. A
   * capability that was never handed over cannot be called by mistake.
   *
   * Returns the moment the child is registered rather than when it finishes.
   * That is the whole point of it: the turn that dispatched a subagent must be
   * free to end, and the API needs this call answered before the next thing the
   * model says. What comes back here is a receipt, not a result.
   */
  dispatchTask: AgentTaskDispatcher | null;
  /**
   * The definitions this folder offers, for turning a name into a subagent.
   *
   * Separate from `dispatchTask` so the tool can say "there is no subagent
   * called X, here are the ones there are" in the same voice every other tool
   * reports a bad argument in, rather than the dispatcher needing an error
   * channel it has no other use for.
   */
  findSubagent: ((name: string) => SubagentDefinition | null) | null;
  /**
   * The skills this folder offers, for turning a name into instructions.
   *
   * `null` when there are none, which is also when the tool was not offered -
   * the same shape `generateImage` and `dispatchTask` use, and for the same
   * reason: a call that arrives anyway, from an older transcript or an invented
   * name, can then be told plainly that there is nothing here rather than
   * getting an empty answer that reads like a skill with nothing in it.
   *
   * Unlike `dispatchTask`, a subagent gets this one. Nothing about a skill is a
   * capability - it is text - and a child sent to do a job needs the written
   * procedure for that job at least as much as the parent that sent it.
   */
  findSkill: ((name: string) => SkillDefinition | null) | null;
};

/**
 * Start one subagent and get back its receipt.
 *
 * Asynchronous only because registering it touches the disk. It never waits for
 * the child to do any work, and a change that made it do so would quietly turn
 * every dispatch back into a blocking call.
 */
export type AgentTaskDispatcher = (req: {
  agent: string;
  prompt: string;
  /** The call's own list, or `null` to take the definition's. */
  tools: SubagentToolName[] | null;
}) => Promise<AgentTaskInfo>;

/**
 * Run one MCP tool by the name it was offered under.
 *
 * Returns what the server said rather than a finished tool result: turning an
 * answer into a result is the dispatcher's job for every other tool, and a
 * picture in particular has to be written somewhere before it can be handed on.
 */
export type AgentMcpCaller = (name: string, rawArgs: string) => Promise<McpToolOutput>;

/**
 * What the image tool asks for, once its arguments have been checked.
 *
 * Nothing here is about showing anything. The renders that arrive on the way to
 * the finished image are the pane's business and the service's to forward, so
 * the tool never learns that they exist.
 */
export type AgentImageRequest = {
  prompt: string;
  /** Reference images, already read off disk and inlined as data URLs. */
  references: string[];
  aspectRatio: string | null;
};

export type AgentImageBytes = { data: Uint8Array; mimeType: string };

/** The finished image, and what it cost when the provider says. */
export type AgentImageResponse = AgentImageBytes & { costUsd: number | null };

export type AgentImageGenerator = (
  req: AgentImageRequest,
  signal: AbortSignal
) => Promise<AgentImageResponse>;

/** A finished tool run: what goes to the model, and what the pane shows. */
export type AgentToolResult = {
  /** The tool's output, already truncated to its limits. */
  text: string;
  /** One line describing the outcome, for the row in the transcript. */
  summary: string;
  /**
   * A picture the model should see as well as read about. Set only by `read`,
   * on an image file; every other tool leaves it out.
   */
  image?: AgentToolImage;
  /** The task list as this call left it. Set only by the todo tools. */
  todos?: AgentTodoItem[];
  /**
   * What running this tool cost, in USD. Set only by `image`, which buys its
   * result from an endpoint that prices the whole picture rather than tokens -
   * every other tool runs on this machine and is free.
   *
   * Absent and `null` mean the same thing here as everywhere else: nobody said,
   * which is not the same as nothing.
   */
  costUsd?: number | null;
  /** The subagent this call started. Set only by `task`. */
  task?: AgentTaskInfo;
};
