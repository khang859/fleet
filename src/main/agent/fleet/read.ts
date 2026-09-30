import {
  fence,
  FLEET_READ_DEFAULT_TURNS,
  FLEET_TOOL_PAGE_CHARS,
  ORCHESTRATOR_PREFIX,
  type FleetReadArgs,
  type FleetToolOutput
} from '../../../shared/fleet-tools';
import { oneLine, promptText, renderBrief, type BriefStatus } from '../../claude-sessions/brief';
import { hashPrompt, type NotedInput } from '../../claude-sessions/registry';
import type { SessionTranscript } from '../../claude-sessions/session-transcripts';
import {
  readTranscriptRange,
  toolInputPreview,
  type TranscriptEvent,
  type TurnEntry
} from '../../claude-sessions/transcript';
import { describePhase } from './format';
import type { FleetHost, FleetSession } from './host';
import { resolveSession } from './host';
import type { FleetCursor } from './ledger-store';

/** How far one conversation has read each session. A subagent's `set` does nothing. */
export type FleetCursors = {
  get(ref: string): FleetCursor | null;
  set(ref: string, cursor: FleetCursor): void;
};

/** The most a turns read returns; older turns are dropped first. */
const TURNS_MAX_CHARS = 16_000;
/** Tool calls one turn shows; the earliest are summarised by count. */
const TURN_TOOL_LINES = 40;
const TEXT_CHARS = 400;
const LAST_TEXT_CHARS = 2_000;
const PROMPT_CHARS = 1_500;

function status(session: FleetSession, now: number): BriefStatus {
  return {
    phase: describePhase(session, now),
    usage: session.usage,
    git: session.git,
    cwd: session.cwd
  };
}

/**
 * Whether the prompt was typed by the Orchestrator. The prefix alone proves
 * nothing, since anyone can type it: the text must also match a prompt Fleet
 * noted sending on the Orchestrator's behalf. `sendPrompt` notes exactly the
 * text it delivers, prefix included.
 */
export function sentByOrchestrator(text: string, inputs: readonly NotedInput[]): boolean {
  if (!text.trim().startsWith(ORCHESTRATOR_PREFIX)) return false;
  const hash = hashPrompt(text);
  return inputs.some((input) => input.origin === 'orchestrator' && input.hash === hash);
}

/** Who wrote a prompt the user or the Orchestrator could have sent, in words for the model. */
function promptAuthor(text: string, inputs: readonly NotedInput[]): string {
  return sentByOrchestrator(text, inputs) ? 'sent by you, the Orchestrator' : 'typed by the user';
}

/** The cursor as it stands for this session, or null when it no longer applies. */
function currentCursor(
  cursor: FleetCursor | null,
  session: FleetSession,
  transcript: SessionTranscript | null
): { cursor: FleetCursor | null; cleared: boolean } {
  if (cursor === null) return { cursor: null, cleared: false };
  const cleared =
    cursor.sessionId !== session.sessionId ||
    cursor.epoch !== session.epoch ||
    // The transcript was read again from scratch, so revisions and turns restarted.
    (transcript !== null &&
      (cursor.rev > transcript.brief.state.rev ||
        cursor.turn > (transcript.tail.turns.at(-1)?.n ?? 0)));
  return { cursor: cleared ? null : cursor, cleared };
}

const CLEARED =
  'The session was cleared since your last read, so what you knew about it no longer applies. This is the new conversation.';

/**
 * The last turn that has finished: the latest one is still going while the
 * session works, and while it waits on the user mid-turn - for an approval, or
 * for the answer to a question, after which the turn carries on.
 */
function lastFinishedTurn(session: FleetSession, turns: readonly TurnEntry[]): number {
  const latest = turns.at(-1)?.n ?? 0;
  const busy =
    session.phase === 'processing' ||
    session.phase === 'compacting' ||
    session.phase === 'starting' ||
    session.phase === 'waitingForApproval' ||
    (session.phase === 'waitingForInput' && session.waitingKind === 'question');
  return busy ? Math.max(0, latest - 1) : latest;
}

function advance(
  cursors: FleetCursors,
  session: FleetSession,
  previous: FleetCursor | null,
  change: Partial<Pick<FleetCursor, 'rev' | 'turn'>>
): void {
  cursors.set(session.ref, {
    sessionId: session.sessionId,
    epoch: session.epoch,
    rev: previous?.rev ?? 0,
    turn: previous?.turn ?? 0,
    ...change
  });
}

async function readBrief(
  host: FleetHost,
  cursors: FleetCursors,
  session: FleetSession,
  since: 'last' | 'start',
  cap?: number
): Promise<FleetToolOutput> {
  const transcript = await host.transcript(session.sessionId);
  const st = status(session, host.now());
  if (transcript === null) {
    return {
      text: `${session.ref}: ${st.phase}. Fleet has not read this session's transcript yet; it will after the session's next hook event.`,
      summary: 'no transcript yet'
    };
  }
  const { cursor, cleared } = currentCursor(cursors.get(session.ref), session, transcript);
  const state = transcript.brief.state;
  const delta = since === 'last' && cursor !== null && cursor.rev > 0;
  const inputs = host.inputsFor(session.sessionId);
  const body = renderBrief(state, st, {
    ...(delta ? { since: cursor.rev } : {}),
    ...(cap === undefined ? {} : { cap }),
    promptBy: (text) =>
      text.startsWith('<task-notification>')
        ? 'a background task finished'
        : promptAuthor(text, inputs)
  });
  advance(cursors, session, cursor, { rev: state.rev });
  return {
    text: [cleared ? CLEARED : null, fence(session.ref, body)].filter(Boolean).join('\n'),
    summary: `${cleared ? 'cleared · ' : ''}${delta ? 'changes' : 'brief'} · rev ${state.rev}`
  };
}

/** Everything one turn did, a line per step. */
function renderTurn(
  turn: TurnEntry,
  events: TranscriptEvent[],
  inputs: NotedInput[],
  open: boolean
): string {
  const lines: string[] = [];
  const results = new Map<string, TranscriptEvent & { kind: 'tool_result' }>();
  for (const e of events) if (e.kind === 'tool_result') results.set(e.toolUseId, e);
  const texts = events.filter((e) => e.kind === 'assistant_text');
  const lastText = texts.at(-1);

  const when = turn.timestamp ? ` · ${turn.timestamp.slice(0, 16).replace('T', ' ')} UTC` : '';
  lines.push(`## Turn ${turn.n}${open ? ' (still going)' : ''}${when}`);

  const toolLines: string[] = [];
  for (const e of events) {
    switch (e.kind) {
      case 'user_prompt': {
        if (e.source === 'compact') {
          lines.push('[the conversation was compacted here]');
          break;
        }
        const who =
          e.source === 'task' ? 'a background task finished' : promptAuthor(e.text, inputs);
        lines.push(`Prompt (${who}):\n${oneLine(promptText(e.text), PROMPT_CHARS)}`);
        break;
      }
      case 'assistant_text':
        lines.push(`Claude: ${oneLine(e.text, e === lastText ? LAST_TEXT_CHARS : TEXT_CHARS)}`);
        break;
      case 'tool_use': {
        const result = results.get(e.id);
        const outcome =
          result === undefined
            ? 'no result yet'
            : result.rejected
              ? 'rejected by the user'
              : result.isError
                ? `error: ${oneLine(result.text, 160)}`
                : 'ok';
        const line = `- ${e.name} ${oneLine(toolInputPreview(e.name, e.input), 160)} → ${outcome} [${e.id}]`;
        toolLines.push(line);
        lines.push(line);
        break;
      }
      case 'interrupted':
        lines.push(
          e.forToolUse ? '[the user cancelled a permission request]' : '[the user interrupted]'
        );
        break;
      case 'queue':
        if (e.operation === 'enqueue') lines.push('[the user queued a prompt for after this turn]');
        break;
      case 'meta':
        if (e.subtype === 'compact_boundary') lines.push('[compaction started]');
        break;
      case 'thinking':
      case 'tool_result':
      case 'clear':
        break;
    }
  }
  // A long turn keeps its most recent tool calls; the rest are counted.
  const extra = toolLines.length - TURN_TOOL_LINES;
  if (extra <= 0) return lines.join('\n');
  const dropped = new Set(toolLines.slice(0, extra));
  const kept = lines.filter((l) => !dropped.has(l));
  kept.splice(2, 0, `[${extra} earlier tool calls in this turn not shown]`);
  return kept.join('\n');
}

async function readTurns(
  host: FleetHost,
  cursors: FleetCursors,
  session: FleetSession,
  since: 'last' | 'start',
  count: number,
  before: number | undefined
): Promise<FleetToolOutput> {
  const transcript = await host.transcript(session.sessionId);
  if (transcript === null) {
    return {
      text: `${session.ref}: Fleet has not read this session's transcript yet; it will after the session's next hook event.`,
      summary: 'no transcript yet'
    };
  }
  const { cursor, cleared } = currentCursor(cursors.get(session.ref), session, transcript);
  const all = transcript.tail.turns;
  // Paging back is a look at older turns, not a read of what is new, so it
  // neither starts from the cursor nor moves it.
  const back = before !== undefined;
  const after = !back && since === 'last' && cursor !== null ? cursor.turn : 0;
  const fresh = all.filter((t) => t.n > after && (!back || t.n < before));
  const shown = fresh.slice(-count);
  const finished = lastFinishedTurn(session, all);
  const header = [
    cleared ? CLEARED : null,
    `${session.ref}: ${describePhase(session, host.now())}. ${all.length} turn${all.length === 1 ? '' : 's'} so far.`
  ];

  if (shown.length === 0) {
    if (back) {
      return {
        text: [...header, `No turns before turn ${before}.`].filter(Boolean).join('\n'),
        summary: 'nothing earlier'
      };
    }
    advance(cursors, session, cursor, { turn: Math.max(after, finished) });
    return {
      text: [...header, 'No turns since your last read.'].filter(Boolean).join('\n'),
      summary: 'nothing new'
    };
  }

  const inputs = host.inputsFor(session.sessionId);
  const end = transcript.tail.lineEnd;
  const rendered: string[] = [];
  for (const turn of shown) {
    const lines = await readTranscriptRange(transcript.path, {
      start: turn.start,
      end: turn.end ?? end
    });
    const events = lines.flatMap((l) => l.events);
    rendered.push(renderTurn(turn, events, inputs, turn.end === null && turn.n > finished));
  }
  // Oldest go first when it is too long: the latest turn is what matters most.
  let skipped = fresh.length - shown.length;
  let oldest = shown[0].n;
  while (rendered.length > 1 && rendered.join('\n\n').length > TURNS_MAX_CHARS) {
    rendered.shift();
    skipped++;
    oldest++;
  }
  let body = rendered.join('\n\n');
  if (body.length > TURNS_MAX_CHARS) body = `${body.slice(0, TURNS_MAX_CHARS)}\n[cut to fit]`;
  if (skipped > 0) {
    header.push(
      `${skipped} earlier turn${skipped === 1 ? '' : 's'}${after > 0 ? ' since your last read' : ''} not shown. Read them with \`before: ${oldest}\`, or dispatch fleet-analyst for a long history.`
    );
  }
  if (!back) {
    advance(cursors, session, cursor, {
      turn: Math.max(after, Math.min(finished, shown.at(-1)?.n ?? 0))
    });
  }
  return {
    text: [...header, fence(session.ref, body)].filter(Boolean).join('\n'),
    summary: `${rendered.length} turn${rendered.length === 1 ? '' : 's'}`
  };
}

async function readTool(
  host: FleetHost,
  session: FleetSession,
  toolUseId: string | undefined,
  page: number
): Promise<FleetToolOutput> {
  if (toolUseId === undefined) {
    throw new Error(
      'A tool read needs `tool_use_id`: take it from the [brackets] of a turns read.'
    );
  }
  const transcript = await host.transcript(session.sessionId);
  const entry = transcript?.tail.tool(toolUseId);
  if (transcript == null || entry === undefined) {
    throw new Error(
      `${session.ref} has no tool call ${toolUseId} in its current conversation. Take ids from a fresh turns read.`
    );
  }
  const events = [
    ...(await readTranscriptRange(transcript.path, entry.use)),
    ...(entry.result ? await readTranscriptRange(transcript.path, entry.result) : [])
  ].flatMap((l) => l.events);
  const use = events.find((e) => e.kind === 'tool_use' && e.id === toolUseId);
  const result = events.find((e) => e.kind === 'tool_result' && e.toolUseId === toolUseId);
  const input = use?.kind === 'tool_use' ? JSON.stringify(use.input, null, 2) : '(not found)';
  const outcome =
    result?.kind !== 'tool_result'
      ? 'Result: none yet.'
      : `Result${result.rejected ? ' (rejected by the user)' : result.isError ? ' (error)' : ''}:\n${result.text}`;
  const whole = `${entry.name} input:\n${input}\n\n${outcome}`;
  const pages = Math.max(1, Math.ceil(whole.length / FLEET_TOOL_PAGE_CHARS));
  if (page > pages) throw new Error(`${toolUseId} has ${pages} page${pages === 1 ? '' : 's'}.`);
  const body = whole.slice((page - 1) * FLEET_TOOL_PAGE_CHARS, page * FLEET_TOOL_PAGE_CHARS);
  const footer =
    page < pages
      ? `Page ${page} of ${pages}. Read on with page: ${page + 1}.`
      : pages > 1
        ? `Page ${page} of ${pages}, the last.`
        : null;
  return {
    text: [fence(session.ref, body), footer].filter(Boolean).join('\n'),
    summary: `${entry.name} · page ${page}/${pages}`
  };
}

/**
 * What changed in a session since the Orchestrator last read it, in at most
 * `cap` characters: a `fleet_read` at `brief` done for a wakeup digest, which
 * moves the cursor the same way.
 */
export async function readBriefDelta(
  host: FleetHost,
  cursors: FleetCursors,
  session: FleetSession,
  cap: number
): Promise<string> {
  return (await readBrief(host, cursors, session, 'last', cap)).text;
}

/** `fleet_read`. */
export async function readSession(
  host: FleetHost,
  cursors: FleetCursors,
  args: FleetReadArgs
): Promise<FleetToolOutput> {
  const session = resolveSession(host, args.session);
  const since = args.since ?? 'last';
  switch (args.level) {
    case 'brief':
      return readBrief(host, cursors, session, since);
    case 'turns':
      return readTurns(
        host,
        cursors,
        session,
        since,
        args.turns ?? FLEET_READ_DEFAULT_TURNS,
        args.before
      );
    case 'tool':
      return readTool(host, session, args.tool_use_id, args.page ?? 1);
  }
}
