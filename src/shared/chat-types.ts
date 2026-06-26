import { DEFAULT_PERMISSION_RULES, type PermissionRules } from './chat-permissions';
import type { McpServersConfig } from './mcp-types';
import type { SkillsOverlay } from './skill-types';

export type ChatRole = 'user' | 'assistant' | 'system';

export type ChatImageRef = { ref: string; mimeType: string; kind: 'generated' | 'attachment' };

export type ChatMessage = {
  id: string;
  conversationId: string;
  role: ChatRole;
  content: string;
  createdAt: number;
  images?: ChatImageRef[];
};

export type ChatConversation = {
  id: string;
  title: string;
  /** Per-conversation model override; null → use the default model. */
  model: string | null;
  /** A manual rename locks the title so background auto-naming never overwrites it. */
  titleLocked: boolean;
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
  /** Attached MCP servers (standard `mcpServers` schema). */
  mcpServers: McpServersConfig;
  /** Per-skill state overrides (absent ⇒ `on`). See skill-types.ts. */
  skills: SkillsOverlay;
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
};

export const DEFAULT_CHAT_TOOLS: ChatToolsConfig = {
  mode: 'read-only',
  workspaceDir: null,
  sandbox: true,
  failClosed: false
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
  mcpServers: {},
  skills: {}
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
};
export type ChatSendResponse = { streamId: string; userMessage: ChatMessage };

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
