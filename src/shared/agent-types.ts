import type { AgentToolCall } from './agent-tools';

/**
 * Settings for the native Agent panes. One configuration, shared by every agent
 * pane in the app - a pane is a workspace on a folder, not a separate account.
 *
 * Models come from the models.dev catalog (openrouter provider), which carries
 * the per-model limits and capabilities the settings UI needs to offer only the
 * controls a model actually supports, merged with the defaults OpenRouter
 * publishes for its own models. The OpenRouter API key itself is the same key
 * Chat stores (see ChatSecrets) - one key per install.
 */

/** How a model exposes its reasoning budget, straight from models.dev. */
export type AgentReasoningOption =
  | { type: 'toggle' }
  | { type: 'effort'; values: string[] }
  | { type: 'budget_tokens'; min: number; max: number };

/** One selectable model, distilled from models.dev's much larger record. */
export type AgentCatalogModel = {
  /** OpenRouter model id, e.g. "anthropic/claude-sonnet-4.5". */
  id: string;
  name: string;
  description: string | null;
  /** Total context window in tokens, when the catalog knows it. */
  contextLimit: number | null;
  /** Ceiling for max output tokens, used to clamp the maxTokens field. */
  outputLimit: number | null;
  supportsTools: boolean;
  supportsTemperature: boolean;
  inputImage: boolean;
  outputImage: boolean;
  /** Empty ⇒ the model has no reasoning controls to offer. */
  reasoning: AgentReasoningOption[];
  /** USD per million tokens. */
  cost: { input: number; output: number } | null;
  releaseDate: string | null;
  /**
   * What OpenRouter says it applies when we omit the parameter. Published for
   * only some models, so `null` is common and means "the provider decides".
   */
  defaultTemperature: number | null;
  defaultReasoningEnabled: boolean | null;
  defaultReasoningEffort: string | null;
};

export type AgentRole = 'coding' | 'image';

/**
 * Inference settings for one agent. `null` ⇒ the parameter is left out of the
 * request, so the model's own default applies (see the fallbacks below).
 */
export type AgentModelConfig = {
  model: string | null;
  maxTokens: number | null;
  temperature: number | null;
  /** For models whose reasoning is a plain on/off switch. */
  reasoningEnabled: boolean | null;
  /** For models that take a named effort level ("low", "high", …). */
  reasoningEffort: string | null;
  /** For models that take an explicit thinking budget in tokens. */
  reasoningTokens: number | null;
};

export type AgentSettings = {
  provider: 'openrouter';
  /** The model that writes code and drives tools. */
  coding: AgentModelConfig;
  /** The model behind image generation. `model: null` ⇒ image generation off. */
  image: AgentModelConfig;
  /** Replaces the built-in instructions. `null` ⇒ use the default below. */
  systemPrompt: string | null;
  /**
   * Fraction of the model's context window at which a transcript is compacted
   * automatically. `null` ⇒ only ever compact when the user asks.
   */
  compactThreshold: number | null;
};

export const EMPTY_AGENT_MODEL_CONFIG: AgentModelConfig = {
  model: null,
  maxTokens: null,
  temperature: null,
  reasoningEnabled: null,
  reasoningEffort: null,
  reasoningTokens: null
};

export const DEFAULT_AGENT_SETTINGS: AgentSettings = {
  provider: 'openrouter',
  coding: { ...EMPTY_AGENT_MODEL_CONFIG, model: 'anthropic/claude-sonnet-4.5' },
  image: { ...EMPTY_AGENT_MODEL_CONFIG },
  systemPrompt: null,
  compactThreshold: 0.8
};

/**
 * The instructions the agent runs with unless the user replaces them. The
 * Markdown paragraph is not decoration: the transcript renders Markdown, so a
 * model answering in plain prose is the one that looks wrong.
 */
export const DEFAULT_AGENT_SYSTEM_PROMPT = [
  "You are Fleet's coding agent.",
  '',
  'You can look at the code in the working folder: `grep` searches file contents, `glob` finds files by path, and `read` returns a numbered window of one file. Use them. An answer that guesses at what the code says, when the code was there to be read, is worth nothing. Search before you read - one `grep` usually settles what three reads would only suggest - and follow what you find rather than stopping at the first plausible hit.',
  '',
  'You cannot change anything yet: there is no writing, editing or shell. When the answer is a change, say exactly what you would change and where, quoting the lines you read.',
  '',
  'Write your replies in GitHub-flavoured Markdown. Put code in fenced blocks tagged with their language, wrap file paths and identifiers in backticks, and reach for a short list or table wherever it reads better than a paragraph.'
].join('\n');

/**
 * The system message for a turn. The working folder is appended by Fleet rather
 * than left to the prompt text, so a custom prompt cannot accidentally drop the
 * one fact the agent has no other way to learn.
 */
export function buildSystemPrompt(cwd: string, override: string | null): string {
  const custom = override?.trim() ?? '';
  const base = custom === '' ? DEFAULT_AGENT_SYSTEM_PROMPT : custom;
  return `${base}\n\nWorking folder: ${cwd}`;
}

/*
 * Fallbacks for the models that publish no default of their own. Every value
 * below is OpenRouter's documented behaviour for an omitted parameter, not a
 * Fleet preference: an absent sampling parameter is left out of the upstream
 * request entirely, and the provider applies its own default.
 * See https://openrouter.ai/docs/api-reference/parameters and
 * https://openrouter.ai/docs/use-cases/reasoning-tokens.
 */

/** Temperature OpenRouter documents for an omitted `temperature`. */
export const FALLBACK_TEMPERATURE = 1;

/** Effort applied when reasoning is on and no budget or effort is given. */
export const FALLBACK_REASONING_EFFORT = 'medium';

/**
 * Thinking budget that "medium" effort works out to: half the output budget,
 * bounded the way OpenRouter bounds it for Anthropic models.
 */
export function defaultThinkingBudget(maxTokens: number): number {
  return Math.max(Math.min(Math.round(maxTokens * 0.5), 128_000), 1024);
}

export type AgentCatalog = {
  models: AgentCatalogModel[];
  /** Epoch ms the catalog was downloaded; 0 when nothing has ever been fetched. */
  fetchedAt: number;
  /** Where these models came from, so the UI can say "offline copy". */
  source: 'network' | 'cache' | 'none';
  /** Set when the refresh failed; models may still be present from cache. */
  error: string | null;
};

/*
 * The transcript. It lives in the renderer for now and is sent whole with each
 * turn, which keeps main stateless: sessions on disk are their own step, and a
 * half-built store here would be in the way of designing one properly.
 */

/**
 * A piece of a message, in the order it happened.
 *
 * A turn is not one thing the model said - it is prose, then a look at the
 * code, then more prose in light of what it found. Holding the text in one
 * field and the calls in another loses the only thing that makes the turn
 * readable: which came first. "Let me check the value" belongs above the
 * search, not below it, and the same is true of the copy that goes back to the
 * model on the next turn.
 */
export type AgentPart = { type: 'text'; text: string } | { type: 'tool'; call: AgentToolCall };

export type AgentMessage = {
  id: string;
  /**
   * `summary` is what compaction leaves behind: one message standing in for the
   * turns it replaced. It is a distinct role because it is neither side of the
   * conversation, and rendering it as the assistant's own words would be a lie.
   */
  role: 'user' | 'assistant' | 'summary';
  /** What the message is made of, oldest first. One turn, however many rounds. */
  parts: AgentPart[];
  /** Assistant only: the reasoning channel, when the model streams one. */
  reasoning: string;
  /**
   * How long the wait for the answer lasted, stamped when the first answer
   * token lands. It is what the collapsed reasoning block has to say for
   * itself, so `null` (no reasoning, or none that ever gave way to an answer)
   * means there is no duration to show rather than a duration of zero.
   */
  reasoningMs: number | null;
};

/** A message that is only words: what the user typed, or a summary. */
export function textMessage(id: string, role: AgentMessage['role'], text: string): AgentMessage {
  return { id, role, parts: [{ type: 'text', text }], reasoning: '', reasoningMs: null };
}

/** Everything the message said, with what it looked at left out. */
export function messageText(message: AgentMessage): string {
  return message.parts
    .filter((part) => part.type === 'text')
    .map((part) => part.text)
    .join('');
}

/** The calls the message made, in the order it made them. */
export function messageToolCalls(message: AgentMessage): AgentToolCall[] {
  return message.parts.filter((part) => part.type === 'tool').map((part) => part.call);
}

/**
 * What a turn cost, counted by the model's own tokenizer and reported by
 * OpenRouter in the last message of the stream. Absent when a provider does not
 * send it, which is why nothing here may depend on having it.
 */
export type AgentUsage = {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
};

export type AgentSendRequest = {
  /**
   * Minted by the renderer, not main: the pane has to be ready to route deltas
   * before the first one can arrive, and it cannot be if it is still waiting to
   * be told the id.
   */
  streamId: string;
  /** The folder the pane was opened on. The agent's working directory. */
  cwd: string;
  /** Prior turns, oldest first. The new user message is `text`, not part of it. */
  history: AgentMessage[];
  text: string;
};

/**
 * Ask the model to fold `messages` into one summary. Compaction runs through
 * the same client as a turn, but nothing is streamed to the pane: a summary
 * appearing word by word is noise, so only the finished text comes back.
 */
export type AgentCompactRequest = {
  streamId: string;
  cwd: string;
  /** The older messages being replaced. The tail kept verbatim stays in the pane. */
  messages: AgentMessage[];
};

export type AgentCompactDone = { streamId: string; summary: string; usage: AgentUsage | null };

/**
 * A tool call starting, and the same call finished. Both carry the whole call
 * rather than a patch, so a pane that missed one event is not left holding a
 * half-updated row.
 */
export type AgentToolEvent = { streamId: string; call: AgentToolCall };

/** Every stream event carries its request's id, so panes can tell theirs apart. */
export type AgentStreamDelta = { streamId: string; delta: string };
export type AgentStreamDone = { streamId: string; usage: AgentUsage | null };
export type AgentStreamError = { streamId: string; message: string };
