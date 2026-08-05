import type { z } from 'zod';
import {
  BashArgs,
  EditArgs,
  GlobArgs,
  GrepArgs,
  ReadArgs,
  TerminalArgs,
  WriteArgs,
  type AgentToolContext,
  type AgentToolResult
} from '../../../shared/agent-tools';
import { runBash } from './bash';
import { runEdit } from './edit';
import { runGlob } from './glob';
import { runGrep } from './grep';
import { runRead } from './read';
import { runTerminal } from './terminal';
import { runWrite } from './write';

/**
 * Run one tool call.
 *
 * Everything that can go wrong here - a name that does not exist, arguments
 * that are not JSON, a path outside the folder, a regular expression that does
 * not compile - is a thing the model did, and the model is the one that can fix
 * it. So every failure throws with a sentence written for the model to read,
 * and the caller sends that sentence back as the result of the call rather than
 * ending the turn.
 */
export async function runAgentTool(
  name: string,
  rawArgs: string,
  ctx: AgentToolContext
): Promise<AgentToolResult> {
  const args = parseArgs(name, rawArgs);

  switch (name) {
    case 'read':
      return runRead(checked(ReadArgs, args, name), ctx);
    case 'glob':
      return runGlob(checked(GlobArgs, args, name), ctx);
    case 'grep':
      return runGrep(checked(GrepArgs, args, name), ctx);
    case 'edit':
      return runEdit(checked(EditArgs, args, name), ctx);
    case 'write':
      return runWrite(checked(WriteArgs, args, name), ctx);
    case 'bash':
      return runBash(checked(BashArgs, args, name), ctx);
    case 'terminal':
      return runTerminal(checked(TerminalArgs, args, name), ctx);
    default:
      throw new Error(`There is no tool called ${name}`);
  }
}

/**
 * Validate the arguments, and say what was wrong in a sentence rather than in
 * zod's own error shape - the reader is a model deciding what to call next.
 */
function checked<T>(schema: z.ZodType<T>, args: unknown, name: string): T {
  const result = schema.safeParse(args);
  if (result.success) return result.data;

  const detail = result.error.issues
    .map((issue) => `${issue.path.join('.') || 'arguments'}: ${issue.message}`)
    .join('; ');
  throw new Error(`Bad arguments for ${name} - ${detail}`);
}

/**
 * The arguments, as an object.
 *
 * They arrive as a JSON string assembled from stream fragments, so a truncated
 * or malformed one is a real possibility rather than a theoretical one. An
 * empty string is the model calling a tool with no arguments at all.
 */
function parseArgs(name: string, rawArgs: string): unknown {
  const trimmed = rawArgs.trim();
  if (trimmed === '') return {};
  try {
    return JSON.parse(trimmed);
  } catch {
    throw new Error(`The arguments for ${name} were not valid JSON: ${trimmed}`);
  }
}
