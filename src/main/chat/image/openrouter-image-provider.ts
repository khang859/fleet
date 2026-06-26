import { z } from 'zod';
import type { ChatImageProvider, ChatImageGenRequest, ChatImageGenResult } from './types';

const BASE = 'https://openrouter.ai/api/v1';
const APP_HEADERS = { 'HTTP-Referer': 'https://github.com/khang859/fleet', 'X-Title': 'Fleet' };

const IMAGE_RESPONSE_SCHEMA = z.object({
  data: z.array(z.object({ b64_json: z.string() })).min(1),
  usage: z.object({ cost: z.number().optional() }).optional()
});

export class OpenRouterImageProvider implements ChatImageProvider {
  readonly id = 'openrouter';
  private readonly getKey: () => string | null;
  private readonly fetchImpl: typeof fetch;

  constructor(getKey: () => string | null, fetchImpl: typeof fetch = fetch) {
    this.getKey = getKey;
    this.fetchImpl = fetchImpl;
  }

  async generate(req: ChatImageGenRequest, signal: AbortSignal): Promise<ChatImageGenResult> {
    const apiKey = this.getKey();
    if (!apiKey) throw new Error('No OpenRouter API key configured');

    const body: Record<string, unknown> = { model: req.model, prompt: req.prompt };
    if (req.referenceImages?.length) {
      body.input_references = req.referenceImages.map((url) => ({
        type: 'image_url',
        image_url: { url }
      }));
    }

    const res = await this.fetchImpl(`${BASE}/images`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        ...APP_HEADERS
      },
      body: JSON.stringify(body),
      signal
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`OpenRouter image request failed: ${res.status} ${detail}`.trim());
    }
    const json = IMAGE_RESPONSE_SCHEMA.parse(await res.json());
    return {
      data: Buffer.from(json.data[0].b64_json, 'base64'),
      mimeType: 'image/png',
      costUsd: json.usage?.cost
    };
  }
}
