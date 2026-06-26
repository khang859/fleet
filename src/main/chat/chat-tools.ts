import { z } from 'zod';
import type { ChatImageRef } from '../../shared/chat-types';
import type { ChatImageProvider } from './image/types';
import type { ChatImageStorage } from './image/image-storage';

export const GENERATE_IMAGE_TOOL = {
  type: 'function',
  function: {
    name: 'generate_image',
    description:
      'Generate a new image from a text description, or edit an existing image. Call this whenever the user asks for a picture, drawing, illustration, logo, or an edit/variation of an image in the conversation.',
    parameters: {
      type: 'object',
      properties: {
        prompt: {
          type: 'string',
          description:
            'A detailed description of the image to generate, or the change to make when editing.'
        },
        edit: {
          type: 'boolean',
          description:
            "Set true to edit an existing image (the user's attached image, or the most recent image generated in this conversation). Set false to create a brand-new image."
        }
      },
      required: ['prompt']
    }
  }
} as const;

const ARGS_SCHEMA = z.object({ prompt: z.string().min(1), edit: z.boolean().default(false) });

export function parseGenerateImageArgs(args: string): { prompt: string; edit: boolean } {
  return ARGS_SCHEMA.parse(JSON.parse(args));
}

export async function runGenerateImage(
  deps: { provider: ChatImageProvider; storage: ChatImageStorage },
  opts: {
    conversationId: string;
    prompt: string;
    referenceImages?: string[];
    model: string;
    signal: AbortSignal;
  }
): Promise<ChatImageRef> {
  const result = await deps.provider.generate(
    { prompt: opts.prompt, referenceImages: opts.referenceImages, model: opts.model },
    opts.signal
  );
  const saved = deps.storage.save(opts.conversationId, result.data, result.mimeType);
  return { ref: saved.ref, mimeType: saved.mimeType, kind: 'generated' };
}
