import { z } from 'zod';
import {
  PROBE_TIMEOUT_MS,
  type EndpointProbeResult,
  type LocalCatalogEntry
} from '../../../shared/agent-endpoints';

/**
 * Asking a local server what it is and what it is serving.
 *
 * Two questions, in order, and the second is optional. `/v1/models` is the one
 * every OpenAI-compatible server answers, so it decides both "is this the right
 * kind of thing" and "what is loaded". `/props` is llama.cpp's alone and is
 * asked afterwards, because the one number that matters most - how much context
 * was actually allocated - is the one number `/v1/models` is least reliable
 * about.
 *
 * Nothing here is asked during a turn. A probe runs when the app starts, when
 * the user presses Test, and when an endpoint is saved; a conversation uses
 * whatever the last one found.
 */

/**
 * A model as `/v1/models` states it. Everything past `id` is optional because
 * the four servers this supports disagree about all of it, and each of them is
 * within its rights: the OpenAI shape promises `id` and little else.
 */
const listedModelSchema = z.object({
  id: z.string(),
  owned_by: z.string().nullish(),
  /** llama.cpp's extension. `n_ctx` on recent builds, `n_ctx_train` on all. */
  meta: z
    .object({
      n_ctx: z.number().nullish(),
      n_ctx_train: z.number().nullish(),
      ftype: z.string().nullish()
    })
    .nullish(),
  /** vLLM states the real serving window right here, and nowhere else. */
  max_model_len: z.number().nullish(),
  /** LM Studio, which is the most forthcoming of the four. */
  max_context_length: z.number().nullish(),
  loaded_context_length: z.number().nullish()
});

const modelsResponseSchema = z.object({ data: z.array(z.unknown()) });

const propsSchema = z.object({
  model_alias: z.string().nullish(),
  model_path: z.string().nullish(),
  default_generation_settings: z.object({ n_ctx: z.number().nullish() }).nullish(),
  modalities: z.object({ vision: z.boolean().nullish() }).nullish(),
  chat_template_caps: z.object({ supports_tools: z.boolean().nullish() }).nullish(),
  build_info: z.string().nullish(),
  is_sleeping: z.boolean().nullish()
});

type Listed = z.infer<typeof listedModelSchema>;
type Props = z.infer<typeof propsSchema>;

/**
 * Something to call a model that named itself after a file.
 *
 * A `llama-server` started without `--alias` reports the path of the `.gguf` it
 * loaded, which is both enormous and mostly the same for every model a person
 * has. The basename without its extension is what they call it themselves.
 */
export function displayName(wireId: string): string {
  const base = wireId.split(/[/\\]/).pop() ?? wireId;
  return base.replace(/\.gguf$/i, '') || wireId;
}

/**
 * How big the window actually is.
 *
 * The order is the whole point. `/props` is llama.cpp reporting what it
 * allocated when it started; `meta.n_ctx` is the same number on builds that
 * publish it; `max_model_len` and `loaded_context_length` are vLLM's and LM
 * Studio's versions of it. `n_ctx_train` is *none of those* - it is what the
 * model was trained at, and it is read last and only because a number that is
 * too large is still better than no meter at all.
 *
 * On the machine this was built against those two differ by sixteen times:
 * trained at 262144, served at 16384. Reading the wrong one would let a
 * conversation grow past the window and fail in the middle of a turn, having
 * already been paid for - which is the exact failure the context meter exists
 * to prevent.
 */
export function resolveContextLimit(listed: Listed, props: Props | null): number | null {
  /*
   * Zero is the absence of an answer, not an answer of nothing. A server with
   * no model loaded reports `n_ctx: 0` rather than omitting the field, and a
   * router listing its whole roster does it for every entry it has not loaded
   * yet - so a `??` chain, which only steps past null and undefined, would stop
   * on the zero and hand the app a window it could not fit a word in.
   */
  const candidates = [
    props?.default_generation_settings?.n_ctx,
    listed.meta?.n_ctx,
    listed.loaded_context_length,
    listed.max_model_len,
    listed.max_context_length,
    listed.meta?.n_ctx_train
  ];
  return candidates.find((n): n is number => typeof n === 'number' && n > 0) ?? null;
}

/** Quantisation and build, when the server volunteers them. Shown, never read. */
function detailOf(listed: Listed, props: Props | null): string | null {
  const parts = [listed.meta?.ftype, props?.build_info].filter(
    (part): part is string => typeof part === 'string' && part !== ''
  );
  return parts.length === 0 ? null : parts.join(' · ');
}

/**
 * What one server said, in the shape the catalog wants.
 *
 * `supportsTools` defaults to `true`, and that is a decision rather than an
 * oversight. The coding-model picker lists only models that call tools, so a
 * pessimistic default would hide the user's own server from the one role they
 * added it for, with nothing on screen to explain the absence. Guessing
 * wrongly the other way costs one round against a model that ignores the
 * tools - visible, recoverable, and self-explanatory. llama.cpp is asked
 * outright and answers, so the guess only ever applies to servers that keep
 * quiet about it.
 */
export function toCatalogEntries(raw: unknown[], props: Props | null): LocalCatalogEntry[] {
  const entries: LocalCatalogEntry[] = [];
  for (const item of raw) {
    // One at a time, as the OpenRouter catalog does: an odd entry costs us that
    // model rather than the whole endpoint.
    const parsed = listedModelSchema.safeParse(item);
    if (!parsed.success) continue;
    const listed = parsed.data;
    entries.push({
      wireId: listed.id,
      name: props?.model_alias ?? displayName(listed.id),
      contextLimit: resolveContextLimit(listed, props),
      supportsTools: props?.chat_template_caps?.supports_tools ?? true,
      inputImage: props?.modalities?.vision ?? false,
      detail: detailOf(listed, props)
    });
  }
  return entries;
}

/** A fetch that failed, read as one of the causes a person can act on. */
export function classifyFetchError(err: unknown): 'timeout' | 'refused' {
  const name = err instanceof Error ? err.name : '';
  return name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'refused';
}

async function getJson(
  url: string,
  fetchImpl: typeof fetch,
  timeoutMs: number
): Promise<{ status: number; body: unknown }> {
  const res = await fetchImpl(url, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(timeoutMs)
  });
  if (!res.ok) return { status: res.status, body: null };
  try {
    return { status: res.status, body: await res.json() };
  } catch {
    // Answered, but not with JSON. Something is listening on this port; it is
    // just not the kind of thing we came looking for.
    return { status: res.status, body: null };
  }
}

/**
 * What is at this address, or why nothing useful is.
 *
 * Never throws. Every ending is a value the settings row can render, because
 * every one of them is an ordinary state of somebody's laptop rather than a
 * fault - the server is off, or still loading a very large file, or is a
 * completely different program that happens to hold that port.
 */
export async function probeEndpoint(
  baseUrl: string,
  opts: { fetchImpl?: typeof fetch; timeoutMs?: number } = {}
): Promise<EndpointProbeResult> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? PROBE_TIMEOUT_MS;

  let listed: { status: number; body: unknown };
  try {
    listed = await getJson(`${baseUrl}/v1/models`, fetchImpl, timeoutMs);
  } catch (err) {
    return { ok: false, reason: classifyFetchError(err), detail: null };
  }

  if (listed.status === 401 || listed.status === 403) {
    return { ok: false, reason: 'auth-required', detail: null };
  }
  // llama.cpp answers 503 with "Loading model" while it reads the file in, and
  // a 30GB model takes long enough that a person will press Test during it.
  // Telling them it is unreachable would send them looking for a fault that
  // resolves itself.
  if (listed.status === 503) return { ok: false, reason: 'loading', detail: null };
  if (listed.status !== 200) {
    return { ok: false, reason: 'not-openai', detail: `responded ${listed.status}` };
  }

  const parsed = modelsResponseSchema.safeParse(listed.body);
  if (!parsed.success) return { ok: false, reason: 'not-openai', detail: null };
  if (parsed.data.data.length === 0) return { ok: false, reason: 'no-models', detail: null };

  // Best effort, and deliberately after the check above: a server that is not
  // llama.cpp answers this with a 404 and is none the worse for it.
  let props: Props | null = null;
  try {
    const raw = await getJson(`${baseUrl}/props`, fetchImpl, timeoutMs);
    if (raw.status === 200) {
      const propsParsed = propsSchema.safeParse(raw.body);
      if (propsParsed.success) props = propsParsed.data;
    }
  } catch {
    // Offline between the two calls, or no such endpoint. The models list
    // already succeeded, so this costs detail rather than the whole probe.
  }

  const models = toCatalogEntries(parsed.data.data, props);
  if (models.length === 0) return { ok: false, reason: 'no-models', detail: null };

  return {
    ok: true,
    fingerprint: props === null ? 'generic' : 'llamacpp',
    models,
    // Idling with the weights unloaded, and it will wake on the first request.
    // Reported so the row can say so, and pointedly not treated as a fault.
    sleeping: props?.is_sleeping === true
  };
}
