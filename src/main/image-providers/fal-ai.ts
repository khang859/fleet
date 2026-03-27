import { fal } from '@fal-ai/client';
import type { ImageProvider, GenerateOpts, EditOpts, PollResult, GenerationResult } from './types';
import type { ImageActionConfig } from './action-types';
import type { ImageActionSettings } from '../../shared/types';

function isEditOpts(opts: GenerateOpts | EditOpts): opts is EditOpts {
  return 'imageUrls' in opts && Array.isArray(opts.imageUrls);
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return v != null && typeof v === 'object' && !Array.isArray(v);
}

function parseActionSettings(raw: unknown): Record<string, ImageActionSettings> {
  if (!isRecord(raw)) return {};
  const result: Record<string, ImageActionSettings> = {};
  for (const [key, val] of Object.entries(raw)) {
    if (isRecord(val) && typeof val.model === 'string') {
      result[key] = { model: val.model };
    }
  }
  return result;
}

export class FalAiProvider implements ImageProvider {
  id = 'fal-ai';
  name = 'fal.ai';
  private currentModel = 'fal-ai/nano-banana-2';
  private actionOverrides: Record<string, ImageActionSettings> = {};

  configure(settings: Record<string, unknown>): void {
    this.actionOverrides = parseActionSettings(settings.actions);
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

  private getActionModel(actionType: string): string | null {
    if (!(actionType in this.actionOverrides)) return null;
    return this.actionOverrides[actionType].model ?? null;
  }

  getActions(): ImageActionConfig[] {
    const rbModel = this.getActionModel('remove-background');
    const rbEndpoint = rbModel
      ? `https://fal.run/${rbModel}`
      : 'https://fal.run/fal-ai/bria/background/remove';

    return [
      {
        id: 'fal-ai:remove-background',
        actionType: 'remove-background',
        provider: 'fal-ai',
        name: 'Remove Background',
        description: rbModel
          ? `Remove the background from an image (${rbModel})`
          : 'Remove the background from an image (BRIA RMBG 2.0)',
        endpoint: rbEndpoint,
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
