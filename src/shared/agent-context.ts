import type { AgentAttachment, AgentMessage, AgentTurnUsage } from './agent-types';
import { messageToolCalls } from './agent-types';
import type { AgentToolCall } from './agent-tools';

/**
 * Context accounting and compaction: deciding how full a transcript is, when it
 * is too full, and which part of it gets folded into a summary.
 *
 * All of it is pure and lives in `shared` on purpose. Compaction is the part of
 * an agent that goes wrong quietly - it fires in a loop, or never fires, or
 * throws away the message the user was about to follow up on - and none of that
 * is observable by looking at the screen. Keeping the decisions as functions
 * over plain data is what makes them testable.
 */

/**
 * Rough token count for text we have no tokenizer for. Every provider counts
 * differently, and shipping a tokenizer per model to answer a threshold
 * question is not worth it: the real number arrives from the provider after
 * each turn, and this only stands in until then.
 *
 * 3.5 characters per token deliberately over-counts English prose. Erring high
 * means compacting slightly early, which costs one summary; erring low means
 * overflowing the window, which costs the turn.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3.5);
}

/** Roughly what the role framing around each message costs on the wire. */
const PER_MESSAGE_OVERHEAD = 4;

/**
 * What the transcript would cost to send. Reasoning is left out because Fleet
 * does not send it back - it is shown in the pane, not replayed to the model.
 *
 * Tool output is counted, and is usually most of it: two hundred numbered lines
 * of a file dwarf the sentence that asked for them, and they go back on the
 * wire with every subsequent turn.
 */
export function estimateTranscriptTokens(messages: AgentMessage[], systemPrompt = ''): number {
  return messages.reduce(
    (total, m) => total + estimatePartsTokens(m) + PER_MESSAGE_OVERHEAD,
    estimateTokens(systemPrompt)
  );
}

/**
 * What one image costs, flat.
 *
 * The real figure is a function of the picture's dimensions, and working it out
 * would mean decoding every attached image to count something that is only ever
 * an estimate here anyway. This is roughly what a 1920×1080 screenshot costs -
 * high for most images, which is the safe direction for the same reason the
 * characters-per-token figure above is.
 */
const IMAGE_TOKENS = 1600;

/** About what a `read` of a mentioned file returns, at its default window. */
const MENTION_TOKENS = 1300;

function estimatePartsTokens(message: AgentMessage): number {
  return message.parts.reduce((total, part) => {
    if (part.type === 'text') return total + estimateTokens(part.text);
    if (part.type === 'attachment') return total + estimateAttachmentTokens(part.attachment);
    // Counted like a local call, because on the wire it is one: the arguments
    // and the result are replayed as text on the assistant message, and the
    // model reads them at the same price whoever ran the tool.
    if (part.type === 'server_tool') {
      return (
        total +
        estimateTokens(part.call.args) +
        estimateTokens(part.call.result) +
        PER_MESSAGE_OVERHEAD
      );
    }
    const { call } = part;
    return (
      total +
      estimateTokens(call.args) +
      estimateTokens(call.result ?? call.error ?? '') +
      (call.image === null ? 0 : IMAGE_TOKENS) +
      PER_MESSAGE_OVERHEAD
    );
  }, 0);
}

function estimateAttachmentTokens(attachment: AgentAttachment): number {
  switch (attachment.kind) {
    case 'image':
      return IMAGE_TOKENS;
    case 'pdf':
      return estimateTokens(attachment.text);
    case 'mention':
      return MENTION_TOKENS;
  }
}

/**
 * How much of the window the next turn will start from. The provider's own
 * count wins whenever we have it: prompt plus completion is exactly what gets
 * resent. It runs a little high, since reasoning tokens are counted in the
 * completion but never sent back - again, the safe direction.
 *
 * The turn's *last* round, not its sum. A turn of twenty rounds resent the
 * conversation twenty times, and adding those up would answer a question
 * nobody asked - what the turn was billed for, which is `billed` and is not
 * this. Only the final prompt describes the transcript that now exists.
 */
export function contextUsed(usage: AgentTurnUsage | null, estimate: number): number {
  return usage?.contextTokens ?? estimate;
}

/**
 * Whether a transcript this full should be compacted before the next turn.
 *
 * Every unknown answers "no". Without a context limit from the catalog there is
 * nothing for a percentage to be a percentage of, and with no threshold the
 * user has said not to. Guessing either one would mean compacting healthy
 * conversations, which is worse than letting a rare overflow surface as the
 * provider's own error.
 */
export function shouldCompact(
  used: number,
  contextLimit: number | null,
  threshold: number | null
): boolean {
  if (threshold === null || contextLimit === null || contextLimit <= 0) return false;
  return used >= contextLimit * threshold;
}

/** Bounds for the setting. Below half the window compaction thrashes; above 95% there is no room left to summarize in. */
export const COMPACT_THRESHOLD_MIN = 0.5;
export const COMPACT_THRESHOLD_MAX = 0.95;

/**
 * Messages kept verbatim. Two exchanges, so a follow-up that points at what was
 * just said - "and the other one?" - still has its referent in full rather than
 * in summary.
 */
export const COMPACT_KEEP_RECENT = 4;

/**
 * The least that has to be leaving for compaction to be worth a model call.
 * This is also the loop guard: once a transcript is nothing but a summary and
 * the recent tail, there is no longer anything to compact, so an auto-compact
 * that did not free enough space cannot fire again and again.
 */
export const COMPACT_MIN_OLDER = 2;

/**
 * Split a transcript into the part that gets summarized and the part that stays
 * verbatim. The cut is moved back to a user message so the kept tail opens with
 * a question rather than with an answer to one that is no longer there.
 *
 * A fired schedule counts as one of those. It is not something the user said,
 * but it is a question the turn after it answers, which is the only property the
 * cut point is about.
 */
export function splitForCompaction(
  messages: AgentMessage[],
  keepRecent = COMPACT_KEEP_RECENT
): { older: AgentMessage[]; recent: AgentMessage[] } {
  if (messages.length <= keepRecent) return { older: [], recent: [...messages] };

  let start = messages.length - keepRecent;
  while (start > 0 && !opensATurn(messages[start])) start -= 1;
  return { older: messages.slice(0, start), recent: messages.slice(start) };
}

/** Whether this message is something a turn was an answer to. */
function opensATurn(message: AgentMessage): boolean {
  return message.role === 'user' || message.role === 'scheduled';
}

/** Whether compacting this transcript would actually remove anything. */
export function canCompact(messages: AgentMessage[], keepRecent = COMPACT_KEEP_RECENT): boolean {
  return splitForCompaction(messages, keepRecent).older.length >= COMPACT_MIN_OLDER;
}

/*
 * Clearing old tool results.
 *
 * The cheaper half of context management, and the one that runs first. A
 * transcript is mostly not conversation: a read of two hundred lines dwarfs the
 * sentence that asked for it, and it goes back on the wire in full with every
 * round for the rest of the session. Anthropic measured their own research
 * agent at 96% tool output by the time it filled a window.
 *
 * Most of that is worth nothing by then. A file read forty rounds ago is either
 * still true - in which case reading it again costs one round - or has since
 * been edited, in which case what is being resent is wrong. So the result is
 * replaced with a line saying it was cleared, while the call itself stays: the
 * model still sees that it read the file, and can read it again if it matters.
 *
 * Unlike compaction this is not lossy, and so needs no model call, no summary,
 * and no permission. It also does not touch the transcript. The pane and the
 * session log keep every result in full - what shrinks is the request, which is
 * the only place the tokens were ever costing anything. The two are allowed to
 * disagree, and `clearedCallIds` is how the pane says so on the row.
 */

/**
 * Tools whose result can be had again just by asking for it again.
 *
 * Deliberately short. `bash` is absent because nothing about a command line
 * says whether running it twice is free: `git status` is, `npm install` is not,
 * and a test run that took four minutes is not either. `edit` and `write`
 * describe a change that happened once. `image` costs money to produce. Where
 * the answer is not obviously yes, the result stays.
 *
 * MCP tools are absent for the same reason - a server's tool does whatever the
 * server does - even though some of them advertise `readOnlyHint`. Believing
 * that here would make what the pane draws depend on which servers happen to be
 * connected, and a marker that means different things in different windows is
 * worse than a saving left on the table.
 */
const REPRODUCIBLE_TOOLS = new Set(['read', 'glob', 'grep']);

/**
 * Whether running this tool again would give the same answer for free.
 *
 * Exported because the rule is applied to two different shapes - the pane's
 * transcript and the array a running turn accumulates - and the two must never
 * come to different conclusions about the same call.
 */
export function isReproducibleTool(name: string): boolean {
  return REPRODUCIBLE_TOOLS.has(name);
}

/** What stands in for a result that is no longer being sent. */
export const CLEARED_RESULT_TEXT =
  '[Old tool result cleared to save context. Run the tool again if you still need what it returned.]';

/**
 * Calls at the end of the transcript kept whole, counted in calls rather than
 * in messages.
 *
 * Messages are the wrong unit here in a way they are not for compaction: one
 * assistant message holds every call of a turn, so a turn that ran forty rounds
 * is a single message, and keeping "the last four" of those would keep all
 * forty results or none.
 *
 * The number wants to be larger than it first appears, because clearing a
 * result the model still needs does not save anything - it makes the model read
 * the file again, which puts the same bytes back in the transcript and costs a
 * round on top. At five, a working rhythm of read, change, check was losing the
 * file it was working on within a single item: a session was observed re-reading
 * the same four files for twenty rounds, and because a re-read settles nothing,
 * the staleness nudge escalated on top of it. Twenty spans that rhythm several
 * times over. Nothing is cleared at all until there are CLEAR_MIN_TOKENS to be
 * won by it, so raising this costs a short session nothing.
 */
export const CLEAR_KEEP_RECENT = 20;

/**
 * The least a pass has to free to be worth doing.
 *
 * This is a cache guard rather than a tidiness threshold. Every provider that
 * caches prompts matches on an exact prefix, so rewriting a result in the
 * middle of the transcript throws away the cached prefix behind it - which is
 * charged at full rate to rebuild. Below this the rewrite costs more than the
 * tokens it saves, so nothing happens at all and short sessions never pay for a
 * feature they had no use for.
 */
export const CLEAR_MIN_TOKENS = 20_000;

/**
 * Which calls would have their results left off the next request.
 *
 * The same answer for the pane as for the wire, from the same transcript, so a
 * row marked as cleared is one the model is genuinely no longer being told
 * about. An empty set means this transcript is not worth a pass yet.
 */
export function clearedCallIds(
  messages: AgentMessage[],
  keepRecent = CLEAR_KEEP_RECENT
): Set<string> {
  const calls = messages.flatMap(messageToolCalls);
  const older = calls.slice(0, Math.max(0, calls.length - keepRecent));
  const clearable = older.filter(isClearable);

  // What the pass would actually save: the results go, but each leaves the
  // sentence saying so behind, and an image read is carrying a picture the
  // placeholder replaces as well.
  const freed = clearable.reduce(
    (total, call) =>
      total +
      estimateTokens(call.result ?? '') +
      (call.image === null ? 0 : IMAGE_TOKENS) -
      estimateTokens(CLEARED_RESULT_TEXT),
    0
  );
  if (freed < CLEAR_MIN_TOKENS) return new Set();
  return new Set(clearable.map((call) => call.id));
}

/**
 * A call worth clearing: one that succeeded, that can be run again, and that is
 * not already cleared. A failure stays because what it says is usually short
 * and is the reason the next few rounds went the way they did.
 */
function isClearable(call: AgentToolCall): boolean {
  return (
    isReproducibleTool(call.name) && call.result !== null && call.result !== CLEARED_RESULT_TEXT
  );
}

/**
 * The transcript as the next request should carry it.
 *
 * A copy, and only when there is something to do - an untouched transcript is
 * returned as itself so the common case allocates nothing. The picture a `read`
 * handed over goes with the result it came from, since re-running the read is
 * what brings both back.
 */
export function withClearedResults(
  messages: AgentMessage[],
  keepRecent = CLEAR_KEEP_RECENT
): AgentMessage[] {
  const ids = clearedCallIds(messages, keepRecent);
  if (ids.size === 0) return messages;

  return messages.map((message) => ({
    ...message,
    parts: message.parts.map((part) =>
      part.type === 'tool' && ids.has(part.call.id)
        ? { ...part, call: { ...part.call, result: CLEARED_RESULT_TEXT, image: null } }
        : part
    )
  }));
}

/**
 * How a summary is introduced when the transcript goes back on the wire. It
 * rides as a user message rather than a system one: mid-conversation system
 * messages are handled inconsistently across providers, and labelling it in the
 * text is enough for the model to treat it as background rather than as an
 * instruction from the user.
 */
export const SUMMARY_WIRE_PREFIX =
  'Summary of the earlier part of this conversation, which has been removed to save context:';

/**
 * Instructions for the summarizing call. Written for a reader who will have
 * nothing else: the point is not a readable recap but a briefing complete
 * enough that the next turn does not have to ask the developer to repeat
 * themselves.
 *
 * The section list follows where Claude Code, Codex CLI and opencode have all
 * independently landed - intent, constraints, decisions, specifics, state -
 * with their shared lesson made explicit: what the developer actually said is
 * quoted rather than paraphrased. A summary that rewrites the request in the
 * model's own words is how an agent ends up confidently solving the wrong
 * problem, and it is the failure that survives compaction the longest.
 */
export const COMPACT_SYSTEM_PROMPT = [
  'You are compacting a conversation between a developer and a coding agent so the work can continue in a smaller context window.',
  '',
  'Write a briefing for the agent that will pick this up knowing nothing else. Use these sections, in this order, and skip any the conversation has nothing for:',
  '',
  '1. Request. What the developer is trying to accomplish. Quote their own wording for anything they were specific about, rather than restating it.',
  '2. Constraints. Rules they gave about how to work - what to avoid, what to always do, how they want things written, anything about credentials or files not to touch. Reproduce these word for word: they still apply after this summary replaces the conversation.',
  '3. Decisions. What was settled, and the reasoning given at the time. Include options that were considered and rejected, so they are not proposed again.',
  '4. Specifics. Files, paths, identifiers, commands, versions, error messages. Copy these exactly - an exact path is worth more than a sentence describing one.',
  '5. State. What is finished, what is half-done, and what is left. Say plainly if something the developer asked for has not been addressed.',
  '6. Current work. What was being worked on in the last few turns, in enough detail to resume mid-thought.',
  '',
  'Be terse and specific: short bullets, no preamble, no closing summary of the summary. Do not address the developer - these are notes for another agent, not a reply. Do not infer, embellish, or record anything that was not actually said.'
].join('\n');
