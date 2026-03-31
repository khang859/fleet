import type { ImageActionConfig } from './action-types';

export type GenerateOpts = {
  model: string;
  prompt: string;
  resolution?: string;
  aspectRatio?: string;
  outputFormat?: string;
  numImages?: number;
};

export type EditOpts = {
  model: string;
  prompt: string;
  imageUrls: string[];
  resolution?: string;
  aspectRatio?: string;
  outputFormat?: string;
  numImages?: number;
};

export type PollResult =
  | { status: 'queued' }
  | { status: 'processing'; progress?: number }
  | { status: 'completed' }
  | { status: 'failed'; error: string };

export type GenerationResult = {
  images: Array<{ url: string; width: number; height: number }>;
  description?: string;
};

export interface ImageProvider {
  id: string;
  name: string;
  configure(settings: Record<string, unknown>): void;
  submit(opts: GenerateOpts | EditOpts): Promise<{ requestId: string }>;
  poll(requestId: string): Promise<PollResult>;
  getResult(requestId: string): Promise<GenerationResult>;
  cancel(requestId: string): Promise<void>;
  getActions(): ImageActionConfig[];
  /** Re-associate a request ID with its endpoint (used when resuming interrupted polls). */
  registerRequest?(requestId: string, model: string, mode: string): void;
}
