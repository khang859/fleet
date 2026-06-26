import { DEFAULT_PERMISSION_RULES, type PermissionRules } from './chat-permissions';
import type { McpServersConfig } from './mcp-types';
import type { SkillsOverlay } from './skill-types';
import type { PromptTemplate } from './prompt-types';

export type ChatRole = 'user' | 'assistant' | 'system';

export type ChatImageRef = { ref: string; mimeType: string; kind: 'generated' | 'attachment' };

export type ChatMessage = {
  id: string;
  conversationId: string;
  role: ChatRole;
  content: string;
  createdAt: number;
  images?: ChatImageRef[];
  /** The message this one follows in the turn tree; null for the first turn. */
  parentId: string | null;
  /** Present only when this turn has sibling variants (regenerate / edit). */
  variants?: ChatVariantInfo;
  /** Token/cost accounting for an assistant turn; absent on user messages. */
  usage?: ChatMessageUsage;
};

/** Token counts + cost for one assistant turn (summed across tool rounds). */
export type ChatMessageUsage = {
  promptTokens: number;
  completionTokens: number;
  /** Input tokens served from the provider prompt cache (subset of promptTokens). */
  cachedTokens: number;
  /** Total cost in USD when OpenRouter accounting returns it; null otherwise. */
  cost: number | null;
};

/** Pager metadata for a turn that has multiple attempts. */
export type ChatVariantInfo = {
  /** 1-based position of this message among its siblings (oldest → newest). */
  index: number;
  total: number;
  /** Sibling message ids, oldest → newest (length === total). */
  ids: string[];
};

export type ChatConversation = {
  id: string;
  title: string;
  /** Per-conversation model override; null → use the default model. */
  model: string | null;
  /** A manual rename locks the title so background auto-naming never overwrites it. */
  titleLocked: boolean;
  /** Set when this conversation was forked from another; null otherwise. */
  parentConversationId: string | null;
  createdAt: number;
  updatedAt: number;
};

export type ChatModel = {
  id: string;
  name: string;
  contextLength: number;
  supportsTools: boolean;
  inputImage: boolean;
  outputImage: boolean;
};

export type ChatSettings = {
  provider: 'openrouter';
  defaultModel: string;
  imageModel: string | null;
  /**
   * Cheap model for background "task" calls (auto-naming, query gen), decoupled
   * from the chat model. null → fall back to the default model.
   */
  taskModel: string | null;
  /** Auto-name new conversations from the first exchange. */
  autoName: boolean;
  /** When to generate the title. */
  namingTiming: 'after-response' | 'immediate';
  /** Permission rules gating tool calls (Bash, MCP). See chat-permissions.ts. */
  permissions: PermissionRules;
  /** Bash / filesystem tool posture. */
  tools: ChatToolsConfig;
  /** Token/cost display + prompt caching. */
  usage: ChatUsageConfig;
  /** Attached MCP servers (standard `mcpServers` schema). */
  mcpServers: McpServersConfig;
  /** Per-skill state overrides (absent ⇒ `on`). See skill-types.ts. */
  skills: SkillsOverlay;
  /** Saved `/`-invokable prompt templates. See prompt-types.ts. */
  prompts: PromptTemplate[];
};

/** Posture for the bash/filesystem tools. */
export type ChatToolsMode = 'off' | 'read-only' | 'ask' | 'auto';

export type ChatToolsConfig = {
  /**
   * off → no fs/bash tools. read-only → read_file/glob/search only (no prompt).
   * ask → adds bash, gated through the permission engine. auto → bash runs
   * sandboxed without a prompt where allowed.
   */
  mode: ChatToolsMode;
  /** Default cwd / writable root for the tools; null → process cwd. */
  workspaceDir: string | null;
  /** Wrap bash in the OS sandbox (bubblewrap on Linux) when available. */
  sandbox: boolean;
  /** In auto mode, refuse bash when a required sandbox is unavailable. */
  failClosed: boolean;
  /** Max KB read per `@`-mentioned file before truncation. */
  mentionMaxKb: number;
};

export const DEFAULT_CHAT_TOOLS: ChatToolsConfig = {
  mode: 'read-only',
  workspaceDir: null,
  sandbox: true,
  failClosed: false,
  mentionMaxKb: 64
};

/** Token/cost surfacing + prompt-cache posture. */
export type ChatUsageConfig = {
  /** Show the per-conversation cost meter and per-message usage captions. */
  showMeter: boolean;
  /** Add a provider prompt-cache breakpoint to the stable system prefix. */
  promptCaching: boolean;
  /** Warn once a conversation's spend exceeds this many USD; null disables. */
  budgetWarnUsd: number | null;
};

export const DEFAULT_CHAT_USAGE: ChatUsageConfig = {
  showMeter: true,
  promptCaching: true,
  budgetWarnUsd: null
};

/**
 * Audit ledger of every gated/tool action the agent took on the local machine.
 * Independent of conversation lifecycle (survives conversation deletion) so it
 * stays useful for post-incident review.
 */
export type ChatAuditDecision =
  | 'allowed' // read tool — never gated
  | 'approved' // user approved a prompt, or an allow-rule matched
  | 'auto' // ran without a prompt (auto mode: sandboxed or rule-allowed)
  | 'denied' // user denied the prompt
  | 'blocked' // a deny rule, circuit-breaker, or fail-closed refused it
  | 'error'; // the tool threw

export type ChatAuditStatus = 'ok' | 'denied' | 'error';

export type ChatAuditEntry = {
  id: string;
  conversationId: string;
  /** Tool name: read_file, glob, search, bash, write_file, edit_file, or an MCP tool. */
  tool: string;
  /** The salient argument: command, path, regex, or MCP tool name. */
  detail: string;
  cwd: string;
  decision: ChatAuditDecision;
  status: ChatAuditStatus;
  /** Truncated result/output or denial reason. */
  result: string;
  createdAt: number;
};

/** Capability-namespaced AI settings. Future: image, video slot in here additively. */
export type AiSettings = {
  chat: ChatSettings;
};

export const DEFAULT_CHAT_SETTINGS: ChatSettings = {
  provider: 'openrouter',
  defaultModel: 'deepseek/deepseek-v4-flash',
  imageModel: null,
  taskModel: null,
  autoName: true,
  namingTiming: 'after-response',
  permissions: DEFAULT_PERMISSION_RULES,
  tools: DEFAULT_CHAT_TOOLS,
  usage: DEFAULT_CHAT_USAGE,
  mcpServers: {},
  skills: {},
  prompts: []
};

export const DEFAULT_AI_SETTINGS: AiSettings = {
  chat: DEFAULT_CHAT_SETTINGS
};

/** One message in an OpenRouter chat-completions request. */
export type ChatCompletionMessage = { role: ChatRole; content: string };

export type ChatSendRequest = {
  conversationId: string;
  text: string;
  model: string;
  attachments?: string[];
  supportsTools?: boolean;
  /** Workspace-relative paths `@`-mentioned in the composer to pin into context. */
  contextPaths?: string[];
};

/** One `@`-mention autocomplete result. */
export type ChatMentionItem = { path: string; type: 'file' | 'dir' };
export type ChatSendResponse = { streamId: string; userMessage: ChatMessage };

export type ChatRegenerateRequest = {
  conversationId: string;
  messageId: string;
  model: string;
  supportsTools?: boolean;
};
export type ChatEditRequest = {
  conversationId: string;
  messageId: string;
  text: string;
  model: string;
  supportsTools?: boolean;
};

export type ChatStreamChunkPayload = { streamId: string; delta: string };
export type ChatStreamDonePayload = { streamId: string; message: ChatMessage };
export type ChatStreamErrorPayload = { streamId: string; message: string; partial: string };

export type ChatToolStatusPayload = {
  streamId: string;
  state: 'generating' | 'done' | 'error';
  label: string;
  error?: string;
};

/** Emitted when a conversation's title changes out-of-band (background auto-naming). */
export type ChatConversationRenamedPayload = { id: string; title: string };
