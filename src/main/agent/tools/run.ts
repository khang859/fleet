import type { z } from 'zod';
import {
  BashArgs,
  BashKillArgs,
  BashOutputArgs,
  EditArgs,
  GlobArgs,
  GrepArgs,
  ImageArgs,
  ReadArgs,
  ScheduleCancelArgs,
  ScheduleCreateArgs,
  TerminalArgs,
  TodoAddArgs,
  TaskArgs,
  TodoUpdateArgs,
  WebFetchArgs,
  WriteArgs,
  type AgentToolContext,
  type AgentToolResult
} from '../../../shared/agent-tools';
import { SkillArgs, SkillWriteArgs } from '../../../shared/agent-skills';
import { MemoryArgs, MemoryWriteArgs } from '../../../shared/agent-memory';
import { isMcpToolName } from '../../../shared/agent-mcp-names';
import type { McpToolOutput } from '../../../shared/agent-mcp';
import { runBash } from './bash';
import { killBackgroundCommand, readBackgroundCommand } from './background';
import { runEdit } from './edit';
import { runGlob } from './glob';
import { runGrep } from './grep';
import { runImage } from './image';
import { runRead } from './read';
import { runTerminal } from './terminal';
import { runTodoAdd, runTodoUpdate } from './todo';
import { runTask } from './task';
import { runScheduleCancel, runScheduleCreate, runScheduleList } from './schedule';
import { runSkill } from './skill';
import { runMemoryRead } from './memory';
import { writeMemoryEntry } from '../memory/write';
import { writeSkillBody } from '../skills/write';
import { runWebFetch } from './web-fetch';
import { runWrite } from './write';
import { AgentImageStore } from '../image-store';

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
/**
 * Where generated images are kept. A module-level instance rather than a
 * parameter threaded through every caller: it holds no state, and it is the
 * one folder there is.
 */
const images = new AgentImageStore();

export async function runAgentTool(
  name: string,
  rawArgs: string,
  ctx: AgentToolContext
): Promise<AgentToolResult> {
  // Ahead of the switch and ahead of the parse: a server's tool owns its own
  // arguments, and checking them here against a schema this file does not have
  // would only be a second opinion with nothing behind it.
  if (isMcpToolName(name)) {
    if (ctx.mcp === null) throw new Error(`There is no tool called ${name}`);
    return runMcp(await ctx.mcp(name, rawArgs), ctx);
  }

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
    case 'bash_output':
      return readBackgroundCommand(checked(BashOutputArgs, args, name), ctx);
    case 'bash_kill':
      return killBackgroundCommand(checked(BashKillArgs, args, name), ctx);
    case 'terminal':
      return runTerminal(checked(TerminalArgs, args, name), ctx);
    case 'image':
      return runImage(checked(ImageArgs, args, name), ctx, images);
    case 'web_fetch':
      return runWebFetch(checked(WebFetchArgs, args, name), ctx);
    case 'skill':
      return runSkill(checked(SkillArgs, args, name), ctx);
    case 'memory':
      return runMemoryRead(checked(MemoryArgs, args, name), ctx);
    // The two writes live beside the loaders that have to read them back rather
    // than in this folder, because the round trip through the reader's own
    // schema is the whole of what makes them safe, and it is easier to keep true
    // when the two halves sit next to each other.
    case 'memory_write':
      return writeMemoryEntry(checked(MemoryWriteArgs, args, name), ctx);
    case 'skill_write':
      return writeSkillBody(checked(SkillWriteArgs, args, name), ctx);
    case 'todo_add':
      return runTodoAdd(checked(TodoAddArgs, args, name), ctx);
    case 'todo_update':
      return runTodoUpdate(checked(TodoUpdateArgs, args, name), ctx);
    case 'task':
      return runTask(checked(TaskArgs, args, name), ctx);
    case 'schedule_create':
      return runScheduleCreate(checked(ScheduleCreateArgs, args, name), ctx);
    case 'schedule_list':
      // No arguments to check, so none are parsed. The schema exists for the
      // spec the model is sent, which does have to say "this takes nothing".
      return runScheduleList(ctx);
    case 'schedule_cancel':
      return runScheduleCancel(checked(ScheduleCancelArgs, args, name), ctx);
    default:
      throw new Error(`There is no tool called ${name}`);
  }
}

/**
 * What a server said, as a tool result.
 *
 * A failure throws, the way every other tool's does, so the caller turns it
 * into an error on the row and a sentence in the conversation. A picture is
 * written into the conversation's own image folder and handed on as a path:
 * that folder is one of the two places outside the working folder a picture may
 * be read from, so a screenshot from a browser server can be looked at without
 * the sandbox having to make an exception for whatever the server chose.
 */
function runMcp(output: McpToolOutput, ctx: AgentToolContext): AgentToolResult {
  if (output.isError) throw new Error(output.text);
  if (output.image === null) return { text: output.text, summary: summarize(output.text) };

  const bytes = Buffer.from(output.image.data, 'base64');
  const path = images.save(ctx.threadId, bytes, output.image.mimeType);
  return {
    text: output.text,
    summary: 'an image',
    image: { path, mimeType: output.image.mimeType }
  };
}

/** The one line the row shows for a server's answer. */
function summarize(text: string): string {
  if (text === '') return 'no output';
  const lines = text.split('\n').length;
  return lines === 1 ? `${text.length} character${text.length === 1 ? '' : 's'}` : `${lines} lines`;
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
