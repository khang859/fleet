import { fal } from '@fal-ai/client';
import type { ImageProvider, GenerateOpts, EditOpts, PollResult, GenerationResult } from './types';
import type { ImageActionConfig } from './action-types';

function isEditOpts(opts: GenerateOpts | EditOpts): opts is EditOpts {
  return 'imageUrls' in opts && Array.isArray(opts.imageUrls);
}

export class FalAiProvider implements ImageProvider {
  id = 'fal-ai';
  name = 'fal.ai';
  private currentModel = 'fal-ai/nano-banana-2';

  configure(settings: Record<string, unknown>): void {
    const apiKey = typeof settings.apiKey === 'string' ? settings.apiKey : '';
    if (apiKey) {
      fal.config({ credentials: apiKey });
    }
  }

  async submit(opts: GenerateOpts | EditOpts): Promise<{ requestId: string }> {
    const model = opts.model || this.currentModel;
    const isEdit = isEditOpts(opts);
    const endpoint = isEdit && !model.endsWith('/edit') ? `${model}/edit` : model;

    const input: Record<string, unknown> = {
      prompt: opts.prompt
    };
    if (opts.resolution) input.resolution = opts.resolution;
    if (opts.aspectRatio) input.aspect_ratio = opts.aspectRatio;
    if (opts.outputFormat) input.output_format = opts.outputFormat;
    if (opts.numImages) input.num_images = opts.numImages;
    if (isEdit) input.image_urls = opts.imageUrls;

    const result = await fal.queue.submit(endpoint, { input });
    return { requestId: result.request_id };
  }

  async poll(requestId: string): Promise<PollResult> {
    const status = await fal.queue.status(this.currentModel, {
      requestId,
      logs: false
    });

    switch (status.status) {
      case 'IN_QUEUE':
        return { status: 'queued' };
      case 'IN_PROGRESS':
        return { status: 'processing' };
      case 'COMPLETED':
        return { status: 'completed' };
      default:
        return {
          status: 'failed',
          error: `Unknown status: ${String((status as { status: string }).status)}`
        };
    }
  }

  async getResult(requestId: string): Promise<GenerationResult> {
    const result = await fal.queue.result(this.currentModel, { requestId });
    const raw: unknown = result.data;
    const data: Record<string, unknown> =
      raw != null && typeof raw === 'object' && !Array.isArray(raw) ? { ...raw } : {};
    const rawImages = Array.isArray(data.images) ? data.images : [];

    const images = rawImages
      .filter((img): img is Record<string, unknown> => img != null && typeof img === 'object')
      .map((img) => ({
        url: typeof img.url === 'string' ? img.url : '',
        width: typeof img.width === 'number' ? img.width : 0,
        height: typeof img.height === 'number' ? img.height : 0
      }));

    return {
      images,
      description: typeof data.description === 'string' ? data.description : undefined
    };
  }

  async cancel(requestId: string): Promise<void> {
    await fal.queue.cancel(this.currentModel, { requestId });
  }

  getActions(): ImageActionConfig[] {
    return [
      {
        id: 'fal-ai:remove-background',
        actionType: 'remove-background',
        provider: 'fal-ai',
        name: 'Remove Background',
        description: 'Remove the background from an image (BRIA RMBG 2.0)',
        endpoint: 'https://fal.run/fal-ai/bria/background/remove',
        inputMapping: (url: string) => ({ image_url: url, sync_mode: true }),
        outputMapping: (response: unknown) => {
          const data = response != null && typeof response === 'object' ? response : {};
          const img =
            'image' in data && data.image != null && typeof data.image === 'object'
              ? data.image
              : {};
          return {
            url: 'url' in img && typeof img.url === 'string' ? img.url : '',
            width: 'width' in img && typeof img.width === 'number' ? img.width : 0,
            height: 'height' in img && typeof img.height === 'number' ? img.height : 0
          };
        },
        outputFormat: 'png'
      }
    ];
  }
}
