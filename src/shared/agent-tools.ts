import { z } from 'zod';

/**
 * The tools the agent can call, and the limits they answer within.
 *
 * Deliberately few: find files by name, find them by content, look at one,
 * change part of one, write a whole one. Everything an agent does is some
 * composition of those, and a sixth tool that overlaps the other five only
 * gives the model a decision to get wrong.
 *
 * Every limit here is a promise about the size of a tool result, because a tool
 * result is context the user pays for and never sees. The rule they follow: cut
 * at a boundary, and say what was cut and how to ask for the rest. A truncated
 * result the model believes is complete is worse than no result at all.
 */

export const AGENT_TOOL_NAMES = ['read', 'glob', 'grep', 'edit', 'write'] as const;
export type AgentToolName = (typeof AGENT_TOOL_NAMES)[number];

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

export type ReadArgs = z.infer<typeof ReadArgs>;
export type GlobArgs = z.infer<typeof GlobArgs>;
export type GrepArgs = z.infer<typeof GrepArgs>;
export type EditArgs = z.infer<typeof EditArgs>;
export type WriteArgs = z.infer<typeof WriteArgs>;

/** The JSON Schema for one tool, as the completions API wants it. */
export type AgentToolSpec = {
  type: 'function';
  function: {
    name: AgentToolName;
    description: string;
    parameters: Record<string, unknown>;
  };
};

const READ_DESCRIPTION = [
  `Read a file, ${READ_DEFAULT_LIMIT} lines at a time by default.`,
  'Output is the file with line numbers, so a line number you quote back is the real one.',
  'Pass `offset` and `limit` to read further in - the footer of a truncated read tells you the next offset to ask for.',
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

/**
 * What the model is told it can call. Kept next to the zod schemas above so the
 * shape advertised and the shape enforced cannot drift apart.
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
  }
];

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
};

/** A finished tool run: what goes to the model, and what the pane shows. */
export type AgentToolResult = {
  /** The tool's output, already truncated to its limits. */
  text: string;
  /** One line describing the outcome, for the row in the transcript. */
  summary: string;
};
