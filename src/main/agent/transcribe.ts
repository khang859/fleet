import { z } from 'zod';
import {
  AGENT_VOICE_MODELS,
  VOICE_MAX_BYTES,
  formatFromMime,
  type AgentTranscribeRequest,
  type AgentTranscribeResult
} from '../../shared/agent-voice';
import { APP_HEADERS } from './openrouter';
import { createLogger } from '../logger';

const log = createLogger('agent:transcribe');

/** OpenRouter's dedicated speech-to-text endpoint. */
const TRANSCRIBE_URL = 'https://openrouter.ai/api/v1/audio/transcriptions';

/** The answer is `{ text, usage }`, and the text is all the composer needs. */
const responseSchema = z.object({ text: z.string() });

/** OpenRouter's error body; some providers leave `message` out. */
const errorSchema = z.object({ error: z.object({ message: z.string() }).nullish() });

/**
 * The fixed vocabulary the hints are spent on, on top of the project folder
 * name and the git branch. Tuned the way Claude Code tunes for coding terms -
 * words Whisper hears as something ordinary because they are not words it was
 * trained on enough.
 */
const CODING_VOCABULARY = [
  'regex',
  'OAuth',
  'JSON',
  'localhost',
  'async',
  'await',
  'commit',
  'branch',
  'merge',
  'pull request'
];

/**
 * The recognition-hint sentence for a clip.
 *
 * Groq is the only provider OpenRouter documents as accepting a biasing prompt,
 * via provider passthrough, so this is only ever sent when the chosen model
 * declares `hints` support - see `AGENT_VOICE_MODELS`. The hint budget is the
 * caller's: folder name, branch, and the fixed list above, which is what makes
 * "refactor the AgentThread composer" come back as those words.
 */
export function buildHints(cwd: string, branch: string | null): string {
  const folder = cwd.split(/[/\\]/).filter(Boolean).pop();
  const terms = [folder, branch, ...CODING_VOCABULARY].filter(
    (term): term is string => typeof term === 'string' && term.trim() !== ''
  );
  return `Expected vocabulary: ${terms.join(', ')}.`;
}

/** Map an HTTP status to the sentence that explains what it means. */
function statusMessage(status: number, body: string | null): string {
  switch (status) {
    case 401:
      return 'The OpenRouter key is not valid any more. Check it in Agent settings.';
    case 402:
      return 'There are no OpenRouter credits left. Top up to transcribe again.';
    case 429:
      return 'OpenRouter is rate limiting transcription. Wait a moment and retry.';
    default:
      return body ?? `OpenRouter responded ${status}`;
  }
}

/**
 * Transcribe one clip.
 *
 * Never throws, and never returns text it did not get: a failure arrives as a
 * result with an `error` sentence, which is what the renderer shows beside the
 * composer and offers a retry against. The audio is kept by the caller, so a
 * request that fails costs nothing but a moment - what was said is never lost
 * to a dropped connection.
 */
export async function transcribe(
  apiKey: string,
  model: string,
  req: AgentTranscribeRequest
): Promise<AgentTranscribeResult> {
  // The request is base64 JSON today; a future switch to multipart is a change
  // here, and the size guard still needs to happen either way. Refused as data
  // rather than a throw, matching what the composer does with a too-large file.
  if (req.audioBase64.length * (3 / 4) > VOICE_MAX_BYTES) {
    return { ok: false, error: 'That recording is too large to transcribe.' };
  }
  const format = formatFromMime(req.mimeType);
  if (format === '') {
    return { ok: false, error: 'That audio format cannot be transcribed.' };
  }

  const chosen = AGENT_VOICE_MODELS.find((m) => m.id === model);
  // Hints only apply to a model that declares them; a fallback that does not
  // simply degrades in accuracy. It is logged and told to the settings pane,
  // because the one thing worse than dropped hints is dropped hints nobody
  // knows about.
  const prompt = chosen?.hints === true ? buildHints(req.cwd, req.branch) : null;
  if (chosen?.hints === false) {
    log.info('recognition hints dropped', { model });
  }

  let res: Response;
  try {
    res = await fetch(TRANSCRIBE_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        ...APP_HEADERS
      },
      body: JSON.stringify({
        model,
        input_audio: { data: req.audioBase64, format },
        ...(prompt === null ? {} : { provider: { options: { groq: { prompt } } } })
      })
    });
  } catch {
    return {
      ok: false,
      error: 'Could not reach OpenRouter. The recording is kept - try again.'
    };
  }

  if (!res.ok) {
    let body: string | null = null;
    try {
      const parsed = errorSchema.safeParse(await res.json());
      if (parsed.success) body = parsed.data.error?.message ?? null;
    } catch {
      // Fall through to the status line.
    }
    return { ok: false, error: statusMessage(res.status, body) };
  }

  const parsed = responseSchema.safeParse(await res.json());
  if (!parsed.success) {
    return { ok: false, error: 'OpenRouter returned an unreadable transcription.' };
  }
  return { ok: true, text: parsed.data.text.trim() };
}
