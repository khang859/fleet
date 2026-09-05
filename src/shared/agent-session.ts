import { z } from 'zod';
import { AGENT_TASK_STATUSES } from './agent-tools';
import { ServerToolCallSchema } from './agent-server-tools';
import { TODO_STATUSES, type AgentTodoItem } from './agent-todos';
import { EMPTY_SESSION_SPEND, type AgentSessionSpend } from './agent-spend';
import { messageText, type AgentMessage, type AgentTurnUsage } from './agent-types';

/**
 * A session on disk: one append-only JSONL file per agent thread.
 *
 * An event log rather than a snapshot of the transcript, because the two things
 * that happen to a transcript are not the same shape. Turns are appended, and
 * an append-only file survives a crash with everything up to the last complete
 * line intact. Compaction *replaces* what came before, which a snapshot would
 * record by silently overwriting the old turns - here it is one more line
 * saying what replaced what, and the turns it folded up are still in the file.
 *
 * Rewriting is never necessary, so the writer only ever opens the file to
 * append, and a reader that stops early is left with a valid earlier state
 * rather than half of a JSON document.
 */

/**
 * What wrote the file, stamped in the header when it is created.
 *
 * Informational: a file opened today and appended to tomorrow has lines from
 * two versions in it, and the header still names the first. So every line
 * carries its own shape and the reader accepts the older ones (see
 * `LegacyMessage`) rather than branching on this number.
 */
export const SESSION_LOG_VERSION = 7;

const ToolImageSchema = z.object({ path: z.string(), mimeType: z.string() });

/**
 * A dispatched subagent, on the call that dispatched it.
 *
 * Written down rather than reconstructed, unlike `todos`, because there is
 * nowhere else for it to live: a subagent outlives the turn that started it, so
 * the only thing tying a report that arrives ten minutes later back to the row
 * that asked for it is this id, and the only thing that knows the row exists at
 * all after a reload is this line.
 */
const ToolTaskSchema = z.object({
  id: z.string(),
  agent: z.string(),
  prompt: z.string(),
  status: z.enum(AGENT_TASK_STATUSES),
  summary: z.string().nullable()
});

const ToolCallSchema = z.object({
  id: z.string(),
  name: z.string(),
  args: z.string(),
  result: z.string().nullable(),
  error: z.string().nullable(),
  summary: z.string().nullable(),
  // Written since version 5, so every earlier line has no key here at all.
  // Nullish rather than nullable for that reason, and normalised to `null` so
  // nothing downstream has to know which version it is holding.
  image: ToolImageSchema.nullish().transform((v) => v ?? null),
  /** Written since version 6; absent on every earlier line, same as `image`. */
  task: ToolTaskSchema.nullish().transform((v) => v ?? null),
  /**
   * Never written, and always read back as `null`.
   *
   * The todo tools put the whole list on their call so that the event the pane
   * already listens to can carry it, but that is a way of telling the pane
   * something, not a fact about the call. The list belongs to the session, and
   * has its own event below - keeping a copy on every call that touched it
   * would put two answers to the same question in one file, one of which is a
   * snapshot from an hour ago.
   *
   * Optional, and not because anything writes it absent: `z.unknown()` accepts
   * an explicit `undefined` but a `.transform()` on top of it makes the key
   * itself required, so a line from before the field existed - which is every
   * line in a session older than the task list - failed to parse and had its
   * tool calls dropped on replay.
   */
  todos: z
    .unknown()
    .optional()
    .transform((): AgentTodoItem[] | null => null)
});

/** What rode along with a user message. New in version 5. */
const AttachmentSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('image'),
    path: z.string(),
    mimeType: z.string(),
    name: z.string()
  }),
  z.object({
    kind: z.literal('pdf'),
    name: z.string(),
    text: z.string(),
    pages: z.number(),
    scanned: z.boolean()
  }),
  z.object({ kind: z.literal('mention'), path: z.string() })
]);

const PartSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), text: z.string() }),
  z.object({ type: z.literal('tool'), call: ToolCallSchema }),
  /**
   * Remote work, new in version 7.
   *
   * Written whole and read back whole. This is the record OpenRouter needs
   * handed back to it for an advisor to recall an earlier consultation, so
   * unlike a tool result it is never cleared to save context and never
   * reconstructed - a re-encoded copy is not the same bytes, and the same bytes
   * are what the replay contract asks for.
   */
  z.object({ type: z.literal('server_tool'), call: ServerToolCallSchema }),
  z.object({ type: z.literal('attachment'), attachment: AttachmentSchema })
]);

const CommonMessageFields = {
  id: z.string(),
  role: z.enum(['user', 'assistant', 'summary', 'scheduled']),
  reasoning: z.string(),
  reasoningMs: z.number().nullable()
};

const CurrentMessage = z.object({ ...CommonMessageFields, parts: z.array(PartSchema) });

/**
 * How messages were written before they had parts: one text field, and (in
 * version 2) a separate list of calls that came after it. Read as the same
 * thing an old pane would have shown, which is text first and calls after.
 */
const LegacyMessage = z
  .object({
    ...CommonMessageFields,
    content: z.string(),
    toolCalls: z.array(ToolCallSchema).default([])
  })
  .transform(
    ({ content, toolCalls, ...rest }): z.infer<typeof CurrentMessage> => ({
      ...rest,
      parts: [
        ...(content === '' ? [] : [{ type: 'text' as const, text: content }]),
        ...toolCalls.map((call) => ({ type: 'tool' as const, call }))
      ]
    })
  );

const MessageSchema = z.union([CurrentMessage, LegacyMessage]);

/**
 * One task. `activeForm` is nullish rather than nullable for the same reason
 * `image` is: it may be absent from a line whichever version wrote it, since
 * the model is free to leave it out.
 */
const TodoItemSchema = z.object({
  id: z.string(),
  content: z.string(),
  activeForm: z
    .string()
    .nullish()
    .transform((v) => v ?? null),
  status: z.enum(TODO_STATUSES)
});

/**
 * A session's running total, as it is written down.
 *
 * Every field is required, because this line is written whole every time and
 * has no older shape to be read back from. `costUsd` is nullable rather than
 * optional for the reason it is nullable everywhere else: a session nobody has
 * ever quoted a price for is not a session that cost nothing.
 */
const SpendSchema = z.object({
  costUsd: z.number().nullable(),
  promptTokens: z.number(),
  cachedTokens: z.number(),
  cacheWriteTokens: z.number(),
  completionTokens: z.number(),
  reasoningTokens: z.number(),
  calls: z.number()
}) satisfies z.ZodType<AgentSessionSpend>;

const EventSchema = z.discriminatedUnion('t', [
  /** Always the first line: what this session is, and what wrote it. */
  z.object({
    t: z.literal('session'),
    version: z.number(),
    id: z.string(),
    cwd: z.string(),
    createdAt: z.string()
  }),
  /** One completed message, appended when it stops changing. */
  z.object({ t: z.literal('message'), message: MessageSchema }),
  /**
   * Compaction: everything before is replaced by `summary`, except the
   * messages named in `keep`. Named by id rather than by count so replay
   * cannot drift from what the pane actually did.
   */
  z.object({ t: z.literal('compact'), summary: MessageSchema, keep: z.array(z.string()) }),
  /** What the provider said the context costs now. Last one wins. */
  z.object({ t: z.literal('context'), tokens: z.number() }),
  /**
   * The task list as the last turn left it. Last one wins.
   *
   * A line of its own rather than something read back out of the tool calls
   * that wrote it, because those do not survive: compaction folds older
   * messages into a summary that keeps their text and drops everything else,
   * so a list reconstructed from calls would vanish exactly when a long piece
   * of work most needs it. Here it is a fact about the session rather than a
   * detail of a message, and the `compact` event only ever rewrites messages.
   */
  z.object({ t: z.literal('todos'), items: z.array(TodoItemSchema) }),
  /**
   * The model's own name for the session, written once after the turn that
   * makes it a real conversation. Last one wins, the same rule as `context`,
   * though in practice nothing ever writes a second one.
   */
  z.object({ t: z.literal('title'), title: z.string() }),
  /**
   * What the session has spent so far. Last one wins.
   *
   * A running total rather than one line per turn, for two reasons. The
   * listing reads a fixed window from the end of the file to find this, which
   * only works if the last one is the whole answer; and compaction folds
   * messages away, so a total assembled by adding up per-turn lines would
   * survive only as long as the messages did. Money already spent does not
   * stop having been spent because the transcript that spent it was summarized.
   */
  z.object({ t: z.literal('spend'), total: SpendSchema }),
  /**
   * How a dispatched subagent ended, written when it does.
   *
   * The one event that reaches back into a message already on disk, because a
   * subagent is the one thing that outlives the turn that started it: the row
   * was written while the child was still running, and by the time there is
   * anything to say about it the turn is minutes gone. Appending the ending is
   * still append-only - `apply` folds it into the row on the way past, the same
   * as `compact` folds messages, and the file keeps both halves of the story.
   *
   * `report` becomes the call's result, which is also how the model hears about
   * it: the next turn serializes the row it is patched into and the report goes
   * out as that call's answer, with no separate delivery path to get wrong.
   */
  z.object({
    t: z.literal('task'),
    id: z.string(),
    status: z.enum(AGENT_TASK_STATUSES),
    report: z.string().nullable(),
    summary: z.string().nullable()
  })
]);

export type AgentSessionEvent = z.infer<typeof EventSchema>;

/**
 * One event on its way to disk. `cwd` rides along because it is what the
 * header records, and the header is only written when the file is created.
 */
export type AgentSessionAppend = {
  sessionId: string;
  cwd: string;
  event: AgentSessionEvent;
};

/**
 * What a turn spent, for a session that has to add it up itself.
 *
 * A usage rather than a total, unlike the event it becomes: the total is the
 * one thing the caller cannot work out, because it is only ever the sum of
 * what is already in the file.
 */
export type AgentSessionAddSpend = {
  sessionId: string;
  cwd: string;
  usage: AgentTurnUsage;
};

export type AgentSessionReplay = {
  messages: AgentMessage[];
  /** `null` when the log never recorded one, same as a thread that has not run a turn. */
  contextTokens: number | null;
  cwd: string | null;
  /** The task list, empty for a session that never made one. */
  todos: AgentTodoItem[];
  /**
   * What the session has spent. All zeroes for one written before any of this
   * existed, which `hasSpend` is how the UI tells apart from a real zero.
   */
  spend: AgentSessionSpend;
  /**
   * `null` for a session written before titles existed, and for one whose
   * first turn has not finished yet. Either way the list falls back to what
   * the user opened with rather than showing a name nothing chose.
   */
  title: string | null;
  /**
   * The session's opening line, kept as it is read rather than taken from
   * `messages` at the end. Compaction *replaces* the messages it folds, so by
   * the time a long session finishes replaying its first words are gone - and
   * they are exactly what a session with no title has to show instead.
   */
  firstUserText: string;
  /**
   * Lines that were not valid events. Expected to be 0 or 1: a crash during an
   * append truncates the line it was writing, and nothing else can produce one.
   * Anything higher means the file is not what we think it is.
   */
  skipped: number;
};

/**
 * A thread that has nothing in it, which is also what an unreadable log gives.
 *
 * A function rather than a shared constant because `messages` is an array a
 * replay fills in place - one constant spread into two replays would hand them
 * both the same array, and the second session would open holding the first
 * one's transcript.
 */
export function emptyReplay(): AgentSessionReplay {
  return {
    messages: [],
    contextTokens: null,
    cwd: null,
    todos: [],
    spend: { ...EMPTY_SESSION_SPEND },
    title: null,
    firstUserText: '',
    skipped: 0
  };
}

export function sessionHeader(id: string, cwd: string, createdAt: string): AgentSessionEvent {
  return { t: 'session', version: SESSION_LOG_VERSION, id, cwd, createdAt };
}

/** One event as the line that goes in the file. */
export function encodeEvent(event: AgentSessionEvent): string {
  return `${JSON.stringify(event)}\n`;
}

/**
 * Rebuild a thread from its log.
 *
 * Unreadable lines are skipped rather than fatal. A session whose last write
 * was interrupted is still worth every turn before it, and refusing to open it
 * would lose the whole conversation to protect the part that was never written.
 */
export function replaySession(contents: string): AgentSessionReplay {
  const replay = emptyReplay();

  for (const line of contents.split('\n')) {
    if (line.trim() === '') continue;
    const event = parseLine(line);
    if (event === null) {
      replay.skipped += 1;
      continue;
    }
    apply(replay, event);
  }
  return replay;
}

function parseLine(line: string): AgentSessionEvent | null {
  let json: unknown;
  try {
    json = JSON.parse(line);
  } catch {
    return null;
  }
  const parsed = EventSchema.safeParse(json);
  return parsed.success ? parsed.data : null;
}

function apply(replay: AgentSessionReplay, event: AgentSessionEvent): void {
  switch (event.t) {
    case 'session':
      replay.cwd = event.cwd;
      return;
    case 'message':
      if (replay.firstUserText === '' && event.message.role === 'user') {
        replay.firstUserText = messageText(event.message);
      }
      replay.messages.push(event.message);
      return;
    case 'compact': {
      const keep = new Set(event.keep);
      replay.messages = [event.summary, ...replay.messages.filter((m) => keep.has(m.id))];
      return;
    }
    case 'context':
      replay.contextTokens = event.tokens;
      return;
    case 'todos':
      replay.todos = event.items;
      return;
    case 'spend':
      replay.spend = event.total;
      return;
    case 'title':
      replay.title = event.title;
      return;
    case 'task': {
      // Backwards: the row is almost always the most recent one that dispatched
      // anything, and a session that ran a hundred subagents should not walk a
      // hundred messages to find each ending.
      for (let i = replay.messages.length - 1; i >= 0; i -= 1) {
        for (const part of replay.messages[i].parts) {
          if (part.type !== 'tool' || part.call.task?.id !== event.id) continue;
          part.call.task = { ...part.call.task, status: event.status, summary: event.summary };
          if (event.report !== null) part.call.result = event.report;
          part.call.summary = event.summary;
          return;
        }
      }
      // Nothing found: the turn that dispatched it was compacted away while the
      // child was still running. The report has nowhere to go, and the model
      // will not be told about a call it can no longer see either.
      return;
    }
  }
}

/**
 * The last spend total in a slice of a log, or `null` if there is none in it.
 *
 * For the listing, which reads the end of a file it has no intention of
 * replaying: the slice usually begins mid-line and mid-conversation, so every
 * other event in it is a fragment of a story this is not being told. Only the
 * running total means the same thing out of context as in it, which is the
 * whole reason it is written as a total.
 */
export function lastSpendIn(contents: string): AgentSessionSpend | null {
  let found: AgentSessionSpend | null = null;
  for (const line of contents.split('\n')) {
    if (line.trim() === '') continue;
    const event = parseLine(line);
    if (event?.t === 'spend') found = event.total;
  }
  return found;
}

/**
 * A session id, as anything outside this process is allowed to state one.
 *
 * Every real id is minted by `crypto.randomUUID()` where a session begins, so
 * a uuid is the whole shape - and checking it is what keeps a `..` out of the
 * one operation that turns an id straight into a file that gets deleted.
 */
export const AgentSessionId = z.string().uuid();

/** What a session is, for a list of them: enough to name it and place it. */
export type AgentSessionListItem = {
  id: string;
  cwd: string;
  /** The model's name for it, once it has one. */
  title: string | null;
  /** The words it was opened with, for a session that has no title yet. */
  firstUserText: string;
  /** Epoch ms of the last append, which is what "last used" means here. */
  updatedAt: number;
  /**
   * What it spent, or `null` for a session written before spend was recorded -
   * which the row shows as a dash rather than as nothing, since "we did not
   * keep count" and "it cost nothing" are different things to have been told.
   */
  spend: AgentSessionSpend | null;
};
