import { z } from 'zod';
import type { AgentToolCall } from './agent-tools';
import { AGENT_TODO_INSTRUCTIONS, type AgentTodoItem } from './agent-todos';
import { DEFAULT_AGENT_PERMISSION_RULES, type AgentPermissionRules } from './agent-permissions';
import type { McpServersConfig } from './agent-mcp';

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

/** Sizes the images endpoint takes, as tiers rather than pixels. */
export const IMAGE_RESOLUTIONS = ['512', '1K', '2K', '4K'] as const;
export type ImageResolution = (typeof IMAGE_RESOLUTIONS)[number];

export const IMAGE_QUALITIES = ['low', 'medium', 'high'] as const;
export type ImageQuality = (typeof IMAGE_QUALITIES)[number];

/**
 * Settings for image generation. Not an `AgentModelConfig`: the images endpoint
 * shares none of a completion's parameters - no max tokens, no temperature, no
 * reasoning - and offering knobs the provider ignores is worse than offering
 * none. What it does take that a person should choose rather than a model is
 * here; the prompt, the references and the aspect ratio are the call's.
 *
 * `null` throughout ⇒ the parameter is left out and the provider's own default
 * applies, which is also the only honest thing to show for "we did not ask".
 */
export type AgentImageConfig = {
  /** `null` ⇒ image generation is off, and the tool is never offered. */
  model: string | null;
  resolution: ImageResolution | null;
  quality: ImageQuality | null;
  /**
   * Fixed seed for reproducible generations. `null` ⇒ a new one every call,
   * which is what someone asking for another go at the same prompt wants.
   */
  seed: number | null;
};

export type AgentSettings = {
  provider: 'openrouter';
  /** The model that writes code and drives tools. */
  coding: AgentModelConfig;
  /** The model behind image generation, and how it is asked. */
  image: AgentImageConfig;
  /** Replaces the built-in instructions. `null` ⇒ use the default below. */
  systemPrompt: string | null;
  /**
   * Fraction of the model's context window at which a transcript is compacted
   * automatically. `null` ⇒ only ever compact when the user asks.
   */
  compactThreshold: number | null;
  /**
   * How many rounds of tool calls one turn may take before it is stopped.
   * `null` ⇒ as many as it needs, up to `MAX_TOOL_ROUNDS_CEILING`.
   *
   * A cap is a guess at how long a job should take, made by someone who has not
   * seen the job. Set too low it ends real work halfway, which costs everything
   * spent getting there and leaves the folder half-changed - so the default is
   * to let a turn run, and this is here for someone who would rather be stopped
   * early than surprised by a bill.
   */
  maxToolRounds: number | null;
  /** Which shell commands run without stopping to ask. */
  permissions: AgentPermissionRules;
  /**
   * External MCP servers whose tools join the agent's own.
   *
   * App-wide rather than per folder, like everything else here: a pane is a
   * folder to work in, not a separate set of tools. Servers imported from a
   * project's config are still kept here, with a note of where they came from.
   */
  mcpServers: McpServersConfig;
  /**
   * The model that names a session once its first turn is done. `null` ⇒ the
   * coding model writes its own titles. A plain field rather than a whole
   * `AgentModelConfig`, because naming needs none of the other knobs.
   */
  titleModel: string | null;
};

export const EMPTY_AGENT_MODEL_CONFIG: AgentModelConfig = {
  model: null,
  maxTokens: null,
  temperature: null,
  reasoningEnabled: null,
  reasoningEffort: null,
  reasoningTokens: null
};

export const EMPTY_AGENT_IMAGE_CONFIG: AgentImageConfig = {
  model: null,
  resolution: null,
  quality: null,
  seed: null
};

export const DEFAULT_AGENT_SETTINGS: AgentSettings = {
  provider: 'openrouter',
  coding: { ...EMPTY_AGENT_MODEL_CONFIG, model: 'anthropic/claude-sonnet-4.5' },
  image: { ...EMPTY_AGENT_IMAGE_CONFIG },
  systemPrompt: null,
  compactThreshold: 0.8,
  maxToolRounds: null,
  permissions: DEFAULT_AGENT_PERMISSION_RULES,
  titleModel: null,
  mcpServers: {}
};

/**
 * The most rounds a turn may take, whatever the setting says.
 *
 * Not a policy, a backstop. Nothing a person asks for takes a thousand rounds,
 * so a turn that reaches this is a loop rather than a long job - and the one
 * thing worse than a turn that stops too early is one that never stops at all.
 */
export const MAX_TOOL_ROUNDS_CEILING = 1000;

/** Narrowest cap the setting will accept. Below this it stops honest work. */
export const MAX_TOOL_ROUNDS_MIN = 5;

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
  'You can change the code too: `edit` replaces exact text in a file, and `write` creates a file or replaces one whole. Read a file before you change it, and prefer `edit` - a rewrite quietly drops everything you did not repeat.',
  '',
  '`bash` runs a command in the working folder, and it is the last tool to reach for rather than the first. Use it for what only a shell can do: running tests, builds, linters, git, package managers, scripts. Do not use it to look at code - `read`, `glob` and `grep` do that better than `cat`, `find` and `grep` do there, and they keep the output to a size worth reading. Each command runs on its own, so a `cd` is gone by the next call; chain with `&&` when it matters.',
  '',
  'Nothing can be typed into that shell, so a command that needs a person - a login, a password, an interactive picker, a dev server they should watch - goes to `terminal` instead. It types the command into a terminal beside you and leaves it for the user to run. Never try to answer a prompt yourself, and never put a secret on a command line.',
  '',
  'A change is written to disk the moment you make it, and most commands run the moment you call them - some stop for the user to approve first. One they turn down is a decision rather than an obstacle: say what you were trying to do and leave it with them, instead of looking for another way to do the same thing. Nothing else asks, so do what was asked and no more, and stop to ask when the request has more than one reasonable reading.',
  '',
  'Every change is shown to the user as a diff, so do not paste the new code back into your reply. Say what you changed and why.',
  '',
  'Write your replies in GitHub-flavoured Markdown. Put code in fenced blocks tagged with their language, wrap file paths and identifiers in backticks, and reach for a short list or table wherever it reads better than a paragraph.'
].join('\n');

/**
 * What the agent is told about `image`, when there is an image model to run it.
 *
 * Kept out of the prompt above because the tool is only offered when one is
 * configured, and instructions for a tool that is not there are instructions to
 * hallucinate a call. It says where the file lands, since that is the one thing
 * about this tool that is not obvious: everything else the agent writes goes
 * into the working folder, and this does not.
 */
export const AGENT_IMAGE_INSTRUCTIONS = [
  '`image` generates a picture from a description, and edits one when you name reference images. Write the prompt as a description of the finished image - subject, composition, style, colours - rather than as an instruction to a person.',
  '',
  'One image per call. Ask for another if you want a variation, rather than expecting several from one.',
  '',
  'The file is saved outside the working folder, and the path comes back to you. It is not part of the project until you put it there: copy it in with `bash` when it belongs in the repo, and leave it where it is when it was only something to look at. The user is shown the image itself, so describe what you made only insofar as it answers what they asked - do not narrate the picture back to them.'
].join('\n');

/**
 * The system message for a turn. The working folder is appended by Fleet rather
 * than left to the prompt text, so a custom prompt cannot accidentally drop the
 * one fact the agent has no other way to learn. Whether image generation is on
 * is the same kind of fact, and is appended the same way.
 *
 * The task list is appended unconditionally, because unlike `image` its two
 * tools are always offered. A user who replaces the prompt is replacing how the
 * agent works, not switching off a pane of the UI they can still see.
 */
export function buildSystemPrompt(
  cwd: string,
  override: string | null,
  options: { image: boolean } = { image: false }
): string {
  const custom = override?.trim() ?? '';
  const base = custom === '' ? DEFAULT_AGENT_SYSTEM_PROMPT : custom;
  const image = options.image ? `\n\n${AGENT_IMAGE_INSTRUCTIONS}` : '';
  return `${base}${image}\n\n${AGENT_TODO_INSTRUCTIONS}\n\nWorking folder: ${cwd}`;
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
/**
 * Something the user handed over with a message: a picture, a document, or a
 * file in the working folder they pointed at.
 *
 * None of these hold bytes. An image is a path re-read when the turn is built,
 * and a mention is re-read the same way - so the model always sees the file as
 * it is now rather than as it was when it was attached, and the session log
 * stays a log rather than a store of base64. A PDF is the exception and holds
 * its text, because the text was extracted from bytes that will never change
 * again: re-parsing the same document on every turn would buy nothing.
 */
export type AgentAttachment =
  | {
      kind: 'image';
      /** Absolute path. Read fresh at every wire build, never cached as bytes. */
      path: string;
      mimeType: string;
      /** What to call it. Display only - it is never resolved back to a file. */
      name: string;
    }
  | {
      kind: 'pdf';
      name: string;
      /** Extracted once, when it was attached. */
      text: string;
      pages: number;
      /** No text layer at all: a scan Fleet has no way to read. */
      scanned: boolean;
    }
  | {
      kind: 'mention';
      /** A file in the working folder, re-read through `read` on every turn. */
      path: string;
    };

/** Biggest image Fleet will attach. */
export const ATTACHMENT_MAX_IMAGE_BYTES = 8_000_000;

/**
 * What the picker offers, which is exactly what `resolveAttachment` accepts.
 * Here rather than in main because the file input is the one place the user is
 * told what may be attached, and being told wrong is a dialog that greys out
 * the file they wanted.
 */
export const ATTACHMENT_ACCEPT = 'image/png,image/jpeg,image/webp,image/gif,application/pdf';

/** Biggest PDF Fleet will open. Past this it is a book, not an attachment. */
export const ATTACHMENT_MAX_PDF_BYTES = 20_000_000;

/**
 * Characters of PDF text one attachment contributes. Twice what a shell command
 * may return: this is a document the user chose to hand over rather than output
 * that happened on the way to something else.
 */
export const ATTACHMENT_MAX_PDF_TEXT_CHARS = 60_000;

/** Pages one PDF is read from, whatever else is in it. */
export const ATTACHMENT_MAX_PDF_PAGES = 300;

export type AgentPart =
  | { type: 'text'; text: string }
  | { type: 'tool'; call: AgentToolCall }
  | { type: 'attachment'; attachment: AgentAttachment };

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

/** What was attached to the message, in the order it was attached. */
export function messageAttachments(message: AgentMessage): AgentAttachment[] {
  return message.parts.filter((part) => part.type === 'attachment').map((part) => part.attachment);
}

/**
 * What the user sent: their words, and whatever rode along with them.
 *
 * The attachments belong to *their* message rather than to a turn of the
 * agent's own, because that is whose they are. Nothing here is addressed to the
 * model as though the agent had gone and fetched it.
 */
export function userMessageWithAttachments(
  id: string,
  text: string,
  attachments: AgentAttachment[]
): AgentMessage {
  return {
    id,
    role: 'user',
    parts: [
      ...(text === '' ? [] : [{ type: 'text' as const, text }]),
      ...attachments.map((attachment) => ({ type: 'attachment' as const, attachment }))
    ],
    reasoning: '',
    reasoningMs: null
  };
}

/**
 * What one call to the model cost, counted by the model's own tokenizer and
 * reported by OpenRouter in the last message of the stream. Absent when a
 * provider does not send it, which is why nothing here may depend on having it.
 *
 * `cachedTokens` is part of `promptTokens` rather than on top of it, and the
 * same is true of `reasoningTokens` inside `completionTokens` - they say how
 * that total was made up, not that there was more of it. Which matters because
 * they are what explains the money: the same prompt costs a tenth as much when
 * most of it was read from the cache.
 */
export type AgentUsage = {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  /** Read from the provider's cache, and billed at a fraction of the rate. */
  cachedTokens: number;
  /** Written to the cache this call, which is what the first turn pays for. */
  cacheWriteTokens: number;
  /** Thinking tokens. Billed as output whether or not they are shown. */
  reasoningTokens: number;
  /** USD OpenRouter charged. `null` when the provider did not say. */
  costUsd: number | null;
};

export const EMPTY_AGENT_USAGE: AgentUsage = {
  promptTokens: 0,
  completionTokens: 0,
  totalTokens: 0,
  cachedTokens: 0,
  cacheWriteTokens: 0,
  reasoningTokens: 0,
  costUsd: null
};

/**
 * What a whole turn did, which is two different sums over the same rounds.
 *
 * A turn is one model call per round, and the two questions asked of it pull in
 * opposite directions. *What does the conversation cost to send* is answered by
 * the last round alone, whose prompt is the whole transcript - adding the
 * earlier rounds would count the same conversation once per round. *What did
 * this turn spend* is answered by adding every round up, because every one of
 * them was billed. One field cannot be both, so there are two.
 */
export type AgentTurnUsage = {
  /** Every round added together: what was billed, including the image tool. */
  billed: AgentUsage;
  /**
   * The last round's total, which is what the next turn's prompt will cost to
   * send. `null` when no round reported usage at all.
   */
  contextTokens: number | null;
  /** How many billed calls it took, images included. */
  calls: number;
  /** The model that actually served it, which `:auto` and fallbacks can change. */
  model: string | null;
  /** The upstream that served it - Anthropic, Bedrock, Vertex, and so on. */
  provider: string | null;
};

export type AgentSendRequest = {
  /**
   * Minted by the renderer, not main: the pane has to be ready to route deltas
   * before the first one can arrive, and it cannot be if it is still waiting to
   * be told the id.
   */
  streamId: string;
  /**
   * The conversation this turn belongs to, stable across its turns. Tools that
   * remember something between calls - which files have been read - key on this
   * rather than on the pane or the process, so what one conversation has seen
   * never stands in for what another one has.
   */
  threadId: string;
  /** The folder the pane was opened on. The agent's working directory. */
  cwd: string;
  /** Prior turns, oldest first. The new user message is `text`, not part of it. */
  history: AgentMessage[];
  text: string;
  /** What rode along with this turn's own message. Empty when nothing did. */
  attachments: AgentAttachment[];
  /**
   * The task list as it stands, sent whole the way `history` is.
   *
   * The pane owns it, so main holds nothing between turns and has nothing to
   * keep in step. What the turn does to it comes back on the tool calls it
   * makes, and the pane writes the result to its own log - the same round trip
   * the transcript already takes.
   */
  todos: AgentTodoItem[];
};

/**
 * Something on its way to becoming an attachment.
 *
 * Two sources, because two things are being asked for. Bytes arrive from a
 * paste, a drop or the file picker and have no home of their own, so Fleet
 * copies them somewhere durable. A path is an `@`-mention of a file in the
 * working folder, which already has one - and is left exactly where it is.
 */
export type AgentAttachRequest = {
  threadId: string;
  cwd: string;
  source:
    | { kind: 'bytes'; name: string; mimeType: string; bytes: ArrayBuffer }
    | { kind: 'path'; path: string };
};

/**
 * Whether it worked, as data rather than as a rejection: a file too large or a
 * type Fleet cannot read is an ordinary thing for a person to try, and it wants
 * a sentence next to the composer rather than an exception.
 */
export type AgentAttachResult =
  | { ok: true; attachment: AgentAttachment }
  | { ok: false; error: string };

/** One row of the composer's `@` menu. */
export type AgentMentionMatch = {
  /** Absolute path, which is what attaching it asks for. */
  path: string;
  /** Relative to the working folder, which is what the row shows. */
  rel: string;
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

export type AgentCompactDone = {
  streamId: string;
  summary: string;
  usage: AgentTurnUsage | null;
};

/**
 * Ask for a name for a session, from the exchange that opened it.
 *
 * It carries the words and nothing else - no session id, no folder. Which
 * session the answer belongs to is the caller's to remember, and by the time
 * one arrives the pane may well be showing a different conversation.
 */
export type AgentTitleRequest = { firstUser: string; firstAssistant: string };

/**
 * The name, and what asking for it cost.
 *
 * The cost comes back even when the title does not. A call that produced
 * nothing usable was still billed, and a total that quietly omits the failures
 * is a total that disagrees with the invoice in the direction that flatters us.
 */
export type AgentTitleResult = { title: string | null; usage: AgentTurnUsage | null };

/**
 * A tool call starting, and the same call finished. Both carry the whole call
 * rather than a patch, so a pane that missed one event is not left holding a
 * half-updated row.
 */
export type AgentToolEvent = { streamId: string; call: AgentToolCall };

/**
 * A render on the way to a finished image.
 *
 * Carries a data URL rather than a path: a partial is never written to disk, so
 * there is no file to point at, and the pane only has to hold the latest one
 * until the call ends. It names the call as well as the turn, because the row
 * it belongs to is the one that asked for the picture.
 */
export type AgentImagePartial = { streamId: string; callId: string; image: string };

/**
 * A command for the user to run, on its way to a terminal pane.
 *
 * It carries the turn rather than the pane: main knows which stream asked, and
 * the renderer is the only side that knows which pane that stream belongs to.
 */
export type AgentHandOff = { streamId: string; command: string };

/**
 * A command waiting on the user before it runs.
 *
 * Like the hand-off, it carries the turn rather than the pane, and the call it
 * belongs to so the question is asked on that row rather than somewhere general.
 */
export type AgentPermissionAsk = {
  streamId: string;
  /** What a decision is sent back against. */
  requestId: string;
  callId: string;
  command: string;
  /** Why this one is being asked about, when there is something to say. */
  reason: string | null;
  /** The rule "always allow" would leave behind. `null` ⇒ do not offer it. */
  rule: string | null;
};

/** `once` runs it, `always` runs it and remembers the rule, `no` refuses. */
export const AgentPermissionOutcome = z.enum(['once', 'always', 'no']);
export type AgentPermissionOutcome = z.infer<typeof AgentPermissionOutcome>;

/**
 * A click, on its way back to the gate that asked.
 *
 * Parsed rather than trusted on arrival: this is the one message whose whole
 * job is to say whether something dangerous may run, so a malformed one has to
 * be recognisable as malformed rather than land somewhere by default.
 */
export const AgentPermissionDecision = z.object({
  requestId: z.string().min(1),
  outcome: AgentPermissionOutcome
});
export type AgentPermissionDecision = z.infer<typeof AgentPermissionDecision>;

/** Every stream event carries its request's id, so panes can tell theirs apart. */
export type AgentStreamDelta = { streamId: string; delta: string };
export type AgentStreamDone = { streamId: string; usage: AgentTurnUsage | null };
/*
 * A failed turn carries what it spent for the same reason a finished one does:
 * the rounds before the failure were billed, and the provider does not refund a
 * conversation for ending badly.
 */
export type AgentStreamError = {
  streamId: string;
  message: string;
  usage: AgentTurnUsage | null;
};
