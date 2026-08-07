import { z } from 'zod';
import type { AgentImageConfig } from '../../shared/agent-types';
import type {
  AgentImageBytes,
  AgentImageRequest,
  AgentImageResponse
} from '../../shared/agent-tools';
import { APP_HEADERS } from './openrouter';
import { sseData, sseLines } from './sse';

/**
 * OpenRouter's image endpoint, streamed.
 *
 * Always streamed, even though only the last event is needed to answer: a
 * generation takes tens of seconds, and the partial renders that arrive on the
 * way are the only thing that makes the wait legible. A provider that sends
 * none still sends the finished one, so there is a single code path rather than
 * a streaming one and a fallback that is only exercised by accident.
 *
 * The exception is a provider that will not stream at all and answers with a
 * plain JSON body. That is recognised by what came back rather than guessed at
 * in advance, and read as the one-shot shape.
 */

const IMAGES_URL = 'https://openrouter.ai/api/v1/images';

/** A render on the way to the finished image. */
const partialEvent = z.object({
  type: z.literal('image_generation.partial_image'),
  b64_json: z.string(),
  media_type: z.string().nullish()
});

/** The finished image, with what the whole generation cost. */
const completedEvent = z.object({
  type: z.literal('image_generation.completed'),
  b64_json: z.string(),
  media_type: z.string().nullish(),
  usage: z.object({ cost: z.number().nullish() }).nullish()
});

/** A generation that failed after the response had already started. */
const errorEvent = z.object({
  type: z.literal('error'),
  error: z.object({ message: z.string() })
});

const streamEvent = z.union([partialEvent, completedEvent, errorEvent]);

/** The body a provider that refused to stream sends instead. */
const oneShotBody = z.object({
  data: z.array(z.object({ b64_json: z.string(), media_type: z.string().nullish() })).min(1),
  usage: z.object({ cost: z.number().nullish() }).nullish()
});

/** The error body OpenRouter returns on a non-2xx, or a bare status line. */
const errorBody = z.object({ error: z.object({ message: z.string() }) });

export type ImageCallRequest = AgentImageRequest & {
  apiKey: string;
  model: string;
  /** The user's own choices, which the call itself has no say over. */
  config: AgentImageConfig;
  /**
   * Renders on the way to the finished image. Fired zero or more times before
   * this resolves and never after. Nothing depends on any arriving: a provider
   * that sends none is one whose images simply appear all at once.
   */
  onPartial: (image: AgentImageBytes) => void;
};

/**
 * The request body. Every setting is omitted when unset rather than sent as a
 * default of ours, so an untouched control means "whatever the model does".
 */
export function toImageBody(req: ImageCallRequest): Record<string, unknown> {
  return {
    model: req.model,
    prompt: req.prompt,
    // One image, always. A model that wants a variation calls again, which
    // keeps one call to one row to one picture all the way through.
    n: 1,
    stream: true,
    ...(req.aspectRatio === null ? {} : { aspect_ratio: req.aspectRatio }),
    ...(req.config.resolution === null ? {} : { resolution: req.config.resolution }),
    ...(req.config.quality === null ? {} : { quality: req.config.quality }),
    ...(req.config.seed === null ? {} : { seed: req.config.seed }),
    ...(req.references.length === 0
      ? {}
      : {
          input_references: req.references.map((url) => ({
            type: 'image_url',
            image_url: { url }
          }))
        })
  };
}

/** What the media type says, or PNG - what every provider here returns. */
function mimeOf(mediaType: string | null | undefined): string {
  return mediaType == null || mediaType === '' ? 'image/png' : mediaType;
}

export async function generateImage(
  req: ImageCallRequest,
  signal: AbortSignal,
  fetchImpl: typeof fetch = fetch
): Promise<AgentImageResponse> {
  const res = await fetchImpl(IMAGES_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${req.apiKey}`,
      'Content-Type': 'application/json',
      ...APP_HEADERS
    },
    body: JSON.stringify(toImageBody(req)),
    signal
  });

  if (!res.ok) throw new Error(await errorMessage(res));
  if (!res.body) throw new Error('OpenRouter returned an empty response');

  // A provider that ignored `stream` answers with the one-shot body. Read it as
  // one, rather than reading a JSON document as though it were events and
  // reporting that nothing arrived.
  if (!(res.headers.get('content-type') ?? '').includes('event-stream')) {
    return readOneShot(await res.json());
  }

  const finished: { image: AgentImageResponse | null } = { image: null };
  for await (const line of sseLines(res.body)) {
    const data = sseData(line);
    if (data === null) continue;
    const parsed = streamEvent.safeParse(data);
    if (!parsed.success) continue;
    const event = parsed.data;

    if (event.type === 'error') throw new Error(event.error.message);
    if (event.type === 'image_generation.partial_image') {
      req.onPartial({
        data: Buffer.from(event.b64_json, 'base64'),
        mimeType: mimeOf(event.media_type)
      });
      continue;
    }
    finished.image = {
      data: Buffer.from(event.b64_json, 'base64'),
      mimeType: mimeOf(event.media_type),
      costUsd: event.usage?.cost ?? null
    };
    // The finished image is the last thing worth reading, but the stream may
    // have a `[DONE]` line after it - which nothing here needs.
    break;
  }

  // A stream that ended with partials and no completion produced nothing that
  // can be saved. Saying so beats saving the last half-drawn render as though
  // it were the answer.
  if (finished.image === null) throw new Error('The image stream ended before an image arrived');
  return finished.image;
}

function readOneShot(json: unknown): AgentImageResponse {
  const parsed = oneShotBody.safeParse(json);
  if (!parsed.success) throw new Error('OpenRouter returned an unreadable image response');
  const first = parsed.data.data[0];
  return {
    data: Buffer.from(first.b64_json, 'base64'),
    mimeType: mimeOf(first.media_type),
    costUsd: parsed.data.usage?.cost ?? null
  };
}

async function errorMessage(res: Response): Promise<string> {
  try {
    const parsed = errorBody.safeParse(await res.json());
    if (parsed.success) return parsed.data.error.message;
  } catch {
    // Fall through to the status line.
  }
  return `OpenRouter responded ${res.status}`;
}
