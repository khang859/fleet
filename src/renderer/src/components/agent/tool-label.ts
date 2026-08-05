import { z } from 'zod';
import type { AgentToolCall } from '../../../../shared/agent-tools';

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
  path: z.string().optional(),
  pattern: z.string().optional(),
  glob: z.string().optional(),
  command: z.string().optional()
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
    default:
      return { verb: call.name, target: '' };
  }
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

/** "*.ts in src" - the second half only when the call narrowed the search. */
function joinScope(subject: string, scope: string | undefined): string {
  if (scope === undefined || scope === '') return subject;
  return `${subject} in ${scope}`;
}
