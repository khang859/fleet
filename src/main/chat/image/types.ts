export type ChatImageGenRequest = {
  prompt: string;
  referenceImages?: string[];
  model: string;
};

export type ChatImageGenResult = {
  data: Buffer;
  mimeType: string;
  costUsd?: number;
};

export interface ChatImageProvider {
  readonly id: string;
  generate(req: ChatImageGenRequest, signal: AbortSignal): Promise<ChatImageGenResult>;
}
