import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import {
  READ_DEFAULT_LIMIT,
  READ_MAX_LINE_CHARS,
  type AgentToolContext,
  type AgentToolResult,
  type ReadArgs
} from '../../../shared/agent-tools';
import { ATTACHMENT_MAX_IMAGE_BYTES } from '../../../shared/agent-types';
import { formatSize, imageMimeFor } from '../image-kinds';
import { displayPath, resolveInsideCwd } from './paths';
import { remember } from './freshness';

/**
 * Read a window of a file, with line numbers.
 *
 * A window rather than a file: most reads are a look at one function, and the
 * model can always ask for the next window, whereas the context a whole file
 * cost it is gone. The lines are numbered because everything the agent does
 * next - quoting a line, editing one later - is easier when the numbers on
 * screen, in the tool result and in the file are the same numbers.
 *
 * Read a line at a time rather than in one gulp so that a range near the top of
 * an enormous file costs what that range costs, and a file too big to hold in
 * memory is still readable a window at a time.
 *
 * An image is the one file this does not read as text. It comes back as a
 * picture instead, which is a screenshot the agent can actually look at rather
 * than the "that is a binary file" it used to get - and the reason the user can
 * point it at one at all.
 */
export async function runRead(args: ReadArgs, ctx: AgentToolContext): Promise<AgentToolResult> {
  const abs = resolveInsideCwd(args.path, ctx.cwd);
  const shown = displayPath(abs, ctx.cwd);

  const info = await stat(abs).catch(() => null);
  if (info === null) throw new Error(`${shown} does not exist`);
  if (info.isDirectory()) throw new Error(`${shown} is a folder - use glob to list what is in it`);

  const mimeType = imageMimeFor(abs);
  if (mimeType !== null) {
    if (info.size > ATTACHMENT_MAX_IMAGE_BYTES) {
      throw new Error(`${shown} is ${formatSize(info.size)}, too large to look at`);
    }
    // No `remember` here: freshness is what licenses an `edit`, and nothing
    // edits a png through a string match.
    return {
      text: `${shown} is an image. It is shown below.`,
      summary: formatSize(info.size),
      image: { path: abs, mimeType }
    };
  }

  const from = args.offset ?? 1;
  const limit = args.limit ?? READ_DEFAULT_LIMIT;
  const lines: string[] = [];
  let lineNumber = 0;
  let more = false;

  const input = createReadStream(abs, { encoding: 'utf8' });
  try {
    for await (const line of createInterface({ input, crlfDelay: Infinity })) {
      if (line.includes('\u0000')) throw new Error(`${shown} is a binary file`);
      lineNumber++;
      if (lineNumber < from) continue;
      if (lines.length === limit) {
        // One line past the window, read only to find out whether it exists.
        more = true;
        break;
      }
      lines.push(clip(line));
    }
  } finally {
    input.destroy();
  }

  // What the file looked like when it was read, so a later edit in this
  // conversation can tell whether it is still editing the file the model saw.
  remember(ctx.threadId, abs, info);

  if (lineNumber === 0) return { text: `${shown} is empty`, summary: 'empty file' };
  if (lines.length === 0) {
    return {
      text: `${shown} has ${lineNumber} lines; there is nothing at line ${from}.`,
      summary: `no line ${from}`
    };
  }

  const last = from + lines.length - 1;
  const width = String(last).length;
  const body = lines.map((line, i) => `${String(from + i).padStart(width)}\t${line}`).join('\n');
  const footer = more
    ? `\n\n… more lines below. Read on with offset=${last + 1}.`
    : `\n\n(end of ${shown})`;

  return {
    text: `${shown} lines ${from}-${last}\n${body}${footer}`,
    summary: `${lines.length} line${lines.length === 1 ? '' : 's'}`
  };
}

/** Long lines are cut, with what was cut said out loud rather than implied. */
function clip(line: string): string {
  if (line.length <= READ_MAX_LINE_CHARS) return line;
  const dropped = line.length - READ_MAX_LINE_CHARS;
  return `${line.slice(0, READ_MAX_LINE_CHARS)}… +${dropped} more characters on this line`;
}
