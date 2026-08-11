import { z } from 'zod';
import type { AgentToolCall } from '../../../../shared/agent-tools';
import { readMcpToolName } from '../../../../shared/agent-mcp-names';

/**
 * What a tool call says about itself on one line.
 *
 * Every product that shows tool use has landed on the same shape - a verb and
 * the one thing the call was about, with the detail behind a disclosure. The
 * verb is not the tool's name: "Read" and "Search" are what happened, while
 * `glob` and `grep` are how it was done, and the how is only interesting when
 * something went wrong.
 */
export type ToolLabel = { verb: string; target: string };

export type ToolStatus = 'running' | 'done' | 'failed';

/**
 * Arguments as they exist on screen: whatever the model streamed, which may be
 * half a JSON document while the call is still arriving. Every field is
 * optional because a row has to render before the arguments are complete.
 */
const LabelArgs = z.object({
  name: z.string().optional(),
  file: z.string().optional(),
  path: z.string().optional(),
  pattern: z.string().optional(),
  glob: z.string().optional(),
  command: z.string().optional(),
  prompt: z.string().optional(),
  references: z.array(z.string()).optional(),
  cron: z.string().optional(),
  id: z.string().optional(),
  url: z.string().optional()
});

export function toolStatus(call: AgentToolCall): ToolStatus {
  if (call.error !== null) return 'failed';
  return call.result === null ? 'running' : 'done';
}

export function toolLabel(call: AgentToolCall): ToolLabel {
  const args = parseArgs(call.args);

  switch (call.name) {
    case 'read':
      return { verb: 'Read', target: args.path ?? '' };
    case 'glob':
      return { verb: 'Find', target: joinScope(args.pattern ?? '', args.path) };
    case 'grep':
      return { verb: 'Search', target: joinScope(args.pattern ?? '', args.glob ?? args.path) };
    case 'edit':
      return { verb: 'Edit', target: args.path ?? '' };
    case 'write':
      return { verb: 'Write', target: args.path ?? '' };
    // The command itself, not a gloss of it: it is the one thing the user needs
    // to see before it runs, and a newline in it would break the row's line.
    case 'bash':
      return { verb: 'Run', target: (args.command ?? '').replace(/\s*\n\s*/g, ' ') };
    // Not "Run": the command has not run, and the difference is the whole
    // point of the row - it is sitting in a terminal waiting for the user.
    case 'terminal':
      return { verb: 'Hand over', target: args.command ?? '' };
    // The skill's name is what the call is about, so it belongs beside the verb
    // like every other target - and a bundled file narrows it the way a path
    // narrows a read. "Load skill" rather than "Load" because the name alone
    // does not say what kind of thing it is, and rather than "Skill" because
    // the first word of a row is a verb everywhere else on this list.
    case 'skill': {
      const file = args.file ?? '';
      const name = args.name ?? '';
      return { verb: 'Load skill', target: file === '' ? name : `${name}/${file}` };
    }
    // Memory rows say what happened to the note, and the name is the note. Two
    // different verbs rather than one because reading and writing are not the
    // same event to a person scanning a transcript: "Remember" is the row worth
    // stopping on, since it is the only place a write becomes visible before it
    // turns up in Settings or in `git status`.
    case 'memory':
      return { verb: 'Recall', target: args.name ?? '' };
    case 'memory_write':
      return { verb: 'Remember', target: args.name ?? '' };
    case 'skill_write':
      return { verb: 'Write skill', target: args.name ?? '' };
    // The prompt, because it is the only description of a picture that does not
    // exist yet - and once it does, the picture is on the row underneath and
    // the prompt is the caption. Editing says so: the same row would otherwise
    // read as though the reference images had been ignored.
    case 'image':
      return {
        verb: (args.references?.length ?? 0) > 0 ? 'Edit image' : 'Generate',
        target: (args.prompt ?? '').replace(/\s*\n\s*/g, ' ')
      };
    // The address without its scheme, which is how a person says a URL and how
    // every browser has shown one for a decade. Kept whole otherwise: the path
    // is what distinguishes one page of a documentation site from the next, so
    // shortening to the host would make every row on a research turn identical.
    case 'web_fetch':
      return { verb: 'Fetch', target: shortenUrl(args.url ?? '') };
    // When rather than what: the note is a paragraph written for a turn that
    // has not happened yet, and the expression is both short enough for a row
    // and the thing the user would check if the check-in arrived on the wrong
    // day. What it is about is on the card in the column, and in full behind
    // the row's own disclosure.
    case 'schedule_create':
      return { verb: 'Schedule', target: args.cron ?? '' };
    case 'schedule_list':
      return { verb: 'List schedules', target: '' };
    case 'schedule_cancel':
      return { verb: 'Cancel schedule', target: args.id ?? '' };
    default:
      return mcpLabel(call.name) ?? { verb: call.name, target: '' };
  }
}

/**
 * A call to a server's tool, said in the same shape as Fleet's own.
 *
 * The wire name is `mcp__context7__query_docs`, which is addressing rather than
 * language: it tells the model where to send the call and tells a person
 * nothing. Split back apart it reads "Query docs" from a server called
 * "context7", which is exactly the verb-and-subject every other row uses.
 */
function mcpLabel(name: string): ToolLabel | null {
  const parsed = readMcpToolName(name);
  if (parsed === null) return null;
  const words = parsed.tool.replace(/[_-]+/g, ' ').trim();
  const verb = words === '' ? parsed.tool : words[0].toUpperCase() + words.slice(1);
  return { verb, target: parsed.server };
}

function parseArgs(raw: string): z.infer<typeof LabelArgs> {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return {};
  }
  const parsed = LabelArgs.safeParse(json);
  return parsed.success ? parsed.data : {};
}

/**
 * A URL as a person would read it: no scheme, no `www.`, no trailing slash.
 *
 * Left alone if it does not parse, because the row has to draw while the model
 * is still streaming the argument and half a URL is not a URL yet.
 */
function shortenUrl(raw: string): string {
  try {
    const url = new URL(raw);
    const host = url.host.replace(/^www\./, '');
    const path = url.pathname === '/' ? '' : url.pathname.replace(/\/$/, '');
    return `${host}${path}${url.search}`;
  } catch {
    return raw;
  }
}

/** "*.ts in src" - the second half only when the call narrowed the search. */
function joinScope(subject: string, scope: string | undefined): string {
  if (scope === undefined || scope === '') return subject;
  return `${subject} in ${scope}`;
}
