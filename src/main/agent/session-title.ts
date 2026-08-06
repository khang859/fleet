import type { completeOnce, AgentWireMessage } from './openrouter';
import type { AgentTitleResult, AgentTurnUsage, AgentUsage } from '../../shared/agent-types';
import { createLogger } from '../logger';

const log = createLogger('agent:title');

/**
 * Naming a session from the exchange that started it.
 *
 * Its own module rather than a method on `AgentService`, because none of what
 * a turn needs applies here: no streaming, no tools, no rounds, and nothing to
 * abort. A title is one short completion whose answer the renderer decides
 * what to do with, so main computes the text and returns it without ever
 * touching a session file.
 */

const SYSTEM_PROMPT = [
  'You write the title for a coding session, from the exchange that opened it.',
  'Reply with the title alone: at most six words, no quotes, no markdown, no closing period.',
  'Name the work, not the tools it used.'
].join(' ');

/** How many words a title may run to before it stops being a label. */
const MAX_TITLE_WORDS = 6;

/**
 * A model's answer, reduced to the title it was asked for.
 *
 * Small models wrap their answer in quotes, or in a "Title:" prefix, or end it
 * with a full stop, whatever the prompt said. Cheaper to take that off here
 * than to keep asking the model to stop doing it.
 */
export function sanitizeTitle(raw: string): string {
  const withoutPrefix = raw.trim().replace(/^title\s*:\s*/i, '');
  const unwrapped = withoutPrefix.replace(/^["'`*_#\s]+/, '').replace(/["'`*_\s]+$/, '');
  const collapsed = unwrapped
    .replace(/\s+/g, ' ')
    .replace(/[.!?,;:]+$/, '')
    .trim();
  if (collapsed === '') return '';
  return collapsed.split(' ').slice(0, MAX_TITLE_WORDS).join(' ');
}

export type TitleInput = {
  apiKey: string;
  model: string;
  firstUser: string;
  firstAssistant: string;
};

/**
 * How much of the opening exchange the title is written from.
 *
 * A first message can be a pasted stack trace or a whole file, and none of it
 * past the opening lines changes what six words the session should be called.
 */
const MAX_EXCERPT_CHARS = 1000;

function excerpt(text: string): string {
  return text.length <= MAX_EXCERPT_CHARS ? text : `${text.slice(0, MAX_EXCERPT_CHARS)}...`;
}

/** The two messages the title is written from. */
export function toTitleMessages(input: TitleInput): AgentWireMessage[] {
  const exchange =
    input.firstAssistant === ''
      ? `User: ${excerpt(input.firstUser)}`
      : `User: ${excerpt(input.firstUser)}\n\nAssistant: ${excerpt(input.firstAssistant)}`;
  return [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: exchange }
  ];
}

/**
 * A title for this session, and what asking for it cost.
 *
 * Never throws, and never invents a placeholder. A session with no title shows
 * the words the user opened it with, which is a better label than anything
 * that could be made up here, so a failure needs no fallback of its own.
 *
 * The cost is reported even when the title is `null`, because a model that
 * answered with something unusable was still paid for answering. Only a call
 * that never happened - or one that failed on the way out - has nothing to
 * report.
 */
export async function resolveTitle(
  complete: typeof completeOnce,
  input: TitleInput
): Promise<AgentTitleResult> {
  try {
    const answer = await complete({
      apiKey: input.apiKey,
      model: input.model,
      messages: toTitleMessages(input),
      maxTokens: 24,
      temperature: 0.3
    });
    const title = sanitizeTitle(answer.text) || null;
    if (title === null) log.warn('model returned no usable title', { model: input.model });
    return { title, usage: toTurnUsage(answer.usage, input.model) };
  } catch (err) {
    // Logged rather than raised: a session keeps the words it opened with, so
    // there is nothing for the pane to do about this - but a title that never
    // appears is otherwise invisible from the outside.
    log.warn('title failed', { model: input.model, error: String(err) });
    return { title: null, usage: null };
  }
}

/** One un-streamed call, in the shape a session's total adds up. */
function toTurnUsage(usage: AgentUsage | null, model: string): AgentTurnUsage | null {
  if (usage === null) return null;
  return {
    billed: usage,
    // Its prompt is two excerpts, not the transcript, so it says nothing about
    // how full the window is. The pane's own figure stands.
    contextTokens: null,
    calls: 1,
    model,
    provider: null
  };
}
