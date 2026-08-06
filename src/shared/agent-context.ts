import type { AgentAttachment, AgentMessage, AgentUsage } from './agent-types';

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
 */
export function contextUsed(usage: AgentUsage | null, estimate: number): number {
  return usage === null ? estimate : usage.totalTokens;
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
 */
export function splitForCompaction(
  messages: AgentMessage[],
  keepRecent = COMPACT_KEEP_RECENT
): { older: AgentMessage[]; recent: AgentMessage[] } {
  if (messages.length <= keepRecent) return { older: [], recent: [...messages] };

  let start = messages.length - keepRecent;
  while (start > 0 && messages[start].role !== 'user') start -= 1;
  return { older: messages.slice(0, start), recent: messages.slice(start) };
}

/** Whether compacting this transcript would actually remove anything. */
export function canCompact(messages: AgentMessage[], keepRecent = COMPACT_KEEP_RECENT): boolean {
  return splitForCompaction(messages, keepRecent).older.length >= COMPACT_MIN_OLDER;
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
