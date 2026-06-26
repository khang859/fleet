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
};

/** Capability-namespaced AI settings. Future: image, video slot in here additively. */
export type AiSettings = {
  chat: ChatSettings;
};

export const DEFAULT_CHAT_SETTINGS: ChatSettings = {
  provider: 'openrouter',
  defaultModel: 'deepseek/deepseek-v4-flash',
  imageModel: null
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
