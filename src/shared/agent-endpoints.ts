import { z } from 'zod';

/**
 * Local inference servers the Agent pane can talk to.
 *
 * These are the user's own machines rather than an account somewhere: a
 * `llama-server`, an Ollama, an LM Studio, a vLLM, anything that answers the
 * OpenAI chat-completions shape. An endpoint contributes every model it says it
 * is serving: Ollama and the routing proxies hand back a roster, while a plain
 * `llama-server` hands back the one model it was started with - so somebody
 * running two of those is running two servers on two ports, and the port is
 * what tells them apart.
 *
 * Configuration and reachability are kept firmly separate here, and that split
 * is the point of the file. What the user typed is settings, and persists. What
 * answered when we last asked is a status, and does not - with one exception,
 * `lastKnownModels`, which is explained where it is declared.
 */

/** A model an endpoint said it was serving, as little of it as needs keeping. */
export type LocalKnownModel = {
  /** Exactly what `/v1/models` called it. May be the path of a `.gguf` file. */
  wireId: string;
  /** Something to show a person: the server's alias, or the file's basename. */
  name: string;
};

export type LocalEndpointConfig = {
  /**
   * Generated on add and never changed afterwards.
   *
   * Every model chosen from this endpoint names it by this id, in settings, in
   * three separate model slots. Keying by the address instead would orphan all
   * of them the moment somebody edited the port - which is the ordinary thing
   * to do while getting a server running, not an edge case.
   */
  id: string;
  /** Origin only, no path, no trailing slash. See `normalizeEndpointUrl`. */
  baseUrl: string;
  /** What the user called it, or `null` to be known by its address alone. */
  name: string | null;
  /** A kept endpoint that contributes no models until it is switched back on. */
  enabled: boolean;
  /**
   * The roster from the last probe that succeeded.
   *
   * Persisted, unlike every other piece of status, and for a reason worth
   * stating: a local server is a process on the user's own machine, so it is
   * off as often as it is on. Without this, quitting Fleet with the server down
   * and reopening it would lose the model out of the picker entirely - and the
   * user would be looking for a setting they had already made, with nothing on
   * screen to say where it went. Replaced wholesale on every success rather
   * than merged, so a model that is genuinely gone eventually stops being
   * offered.
   */
  lastKnownModels: LocalKnownModel[];
};

/** Which flavour of server answered, and so how much it can be asked. */
export type EndpointFingerprint = 'llamacpp' | 'generic';

/**
 * Why an endpoint did not answer usefully.
 *
 * Separate cases rather than one failure, because each of them has a different
 * thing for the user to go and do, and a single "could not connect" would be
 * the same sentence for a server that is off, a server that is still loading a
 * 30GB file, and an address that belongs to something else entirely.
 */
export type EndpointProbeFailure =
  | 'refused'
  | 'timeout'
  | 'not-openai'
  | 'no-models'
  | 'auth-required'
  | 'loading';

/** One model an endpoint is serving, with whatever it would tell us about it. */
export type LocalCatalogEntry = {
  wireId: string;
  name: string;
  /**
   * What the server *allocated*, never what the model was trained for.
   *
   * llama.cpp publishes both and they routinely differ by more than an order of
   * magnitude - a model trained at 262144 served at 16384 is an ordinary way to
   * run one on a single card. Budgeting a conversation against the trained
   * figure would overflow the window sixteen times over and the failure would
   * arrive mid-turn, so the allocated number is the only one worth having.
   */
  contextLimit: number | null;
  supportsTools: boolean;
  inputImage: boolean;
  /** Quantisation, build string - shown as provenance, never acted on. */
  detail: string | null;
};

export type EndpointProbeResult =
  | { ok: true; fingerprint: EndpointFingerprint; models: LocalCatalogEntry[]; sleeping: boolean }
  | { ok: false; reason: EndpointProbeFailure; detail: string | null };

/**
 * Where an endpoint stands right now. Lives in memory in main, is pushed to the
 * renderer, and is never written to disk.
 */
export type LocalEndpointState =
  | 'unchecked'
  | 'checking'
  | 'ready'
  /** Reachable, and idling until something asks it for a token. Not a fault. */
  | 'sleeping'
  | 'unreachable'
  | 'disabled';

export type LocalEndpointStatus = {
  id: string;
  state: LocalEndpointState;
  fingerprint: EndpointFingerprint | null;
  modelCount: number;
  /** Set only when `state` is `unreachable`; names which failure it was. */
  reason: EndpointProbeFailure | null;
  detail: string | null;
};

/** One address a scan found something at, and what it found. */
export type LocalEndpointScanHit = {
  baseUrl: string;
  fingerprint: EndpointFingerprint;
  models: LocalCatalogEntry[];
};

/**
 * Ports worth trying when the user asks Fleet to look around.
 *
 * The defaults of the four servers this supports, and a short run above
 * Ollama's for the case this feature was built for: somebody running several
 * `llama-server`s at once numbers them upwards from somewhere. Deliberately a
 * fixed, short list on loopback only - it is a convenience for the common
 * setup, not a port scanner, and a person on an unusual port has the Add field.
 */
export const COMMON_LOCAL_PORTS = [
  8080, 8000, 1234, 11434, 11435, 11436, 11437, 11438, 11439, 5000
] as const;

/** How long a single probe may take before it is called a timeout. */
export const PROBE_TIMEOUT_MS = 5_000;

/**
 * The same, for a scan. Shorter because ten of them run at once and every dead
 * port costs the full wait: at the probe timeout a scan of this list would sit
 * there for five seconds to tell somebody nothing was found.
 */
export const SCAN_TIMEOUT_MS = 1_500;

const knownModelSchema = z.object({ wireId: z.string(), name: z.string() });

/**
 * The shape main checks before it acts on one of these.
 *
 * The renderer is not an attacker, but it is a place bugs live, and a settings
 * file is a text file somebody can edit. `baseUrl` from here becomes the
 * address a turn is sent to, so it is checked where main reads the list rather
 * than assumed from the type. Per entry rather than over the whole array, so
 * one malformed row cannot take the working servers down with it.
 */
export const LocalEndpointConfigSchema = z.object({
  id: z.string().min(1),
  baseUrl: z.string().min(1),
  name: z.string().nullable(),
  enabled: z.boolean(),
  lastKnownModels: z.array(knownModelSchema)
});

/** The label a row, a badge and a picker group all use for one endpoint. */
export function endpointLabel(
  endpoint: Pick<LocalEndpointConfig, 'name'>,
  hostPort: string
): string {
  return endpoint.name === null || endpoint.name.trim() === '' ? hostPort : endpoint.name;
}
