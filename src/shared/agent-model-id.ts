/**
 * Which model a slot names, and where that model is served from.
 *
 * Every model in Fleet is a plain string in settings - `coding.model`,
 * `titleModel`, `classifierModel` are each one - and they were all OpenRouter
 * ids until local servers arrived. Rather than widen those three fields into a
 * tagged union and touch every place that reads them, a local model states its
 * endpoint inside the id itself. An OpenRouter id is left exactly as it was,
 * which is why no installed copy of Fleet needs its settings migrated: the ids
 * already on disk are still the ids this parses.
 *
 * This is the only file that knows what the prefix looks like. Everything
 * downstream of `parseModelId` deals in a bare wire id and a place to send it.
 */

/**
 * Safe as a prefix because an OpenRouter id never contains a colon: they are
 * `vendor/slug`, optionally with a `:variant` suffix that follows the slug
 * rather than leading it. Nothing OpenRouter serves can be mistaken for one of
 * ours by looking at the first character.
 */
export const LOCAL_MODEL_PREFIX = 'local:';

/**
 * The id a local model is stored under.
 *
 * The endpoint is named by its generated id rather than its address, because
 * the address is the thing the user edits - moving a model to a different port
 * is the ordinary case during setup, and a settings field naming
 * `local:127.0.0.1:11437/...` would be orphaned by every such edit.
 */
export function localModelId(endpointId: string, wireId: string): string {
  return `${LOCAL_MODEL_PREFIX}${endpointId}/${wireId}`;
}

export type ParsedModelId =
  | { kind: 'openrouter'; id: string }
  | { kind: 'local'; endpointId: string; wireId: string };

/**
 * Split an id into where it goes and what to call it there.
 *
 * The separator is the *first* slash after the prefix, and that matters: a
 * llama-server started without `--alias` names its model by the path of the
 * file it loaded, so the wire id routinely contains slashes of its own and may
 * well begin with one. The endpoint id never does - it is generated - so the
 * first slash is unambiguous where a last slash would not be.
 *
 * Anything shaped wrongly reads as an OpenRouter id rather than throwing. It
 * will not resolve to a model, which is the same ending a deleted OpenRouter
 * model already has, and one that the picker and the turn both handle.
 */
export function parseModelId(id: string): ParsedModelId {
  if (!id.startsWith(LOCAL_MODEL_PREFIX)) return { kind: 'openrouter', id };
  const rest = id.slice(LOCAL_MODEL_PREFIX.length);
  const slash = rest.indexOf('/');
  if (slash <= 0 || slash === rest.length - 1) return { kind: 'openrouter', id };
  return { kind: 'local', endpointId: rest.slice(0, slash), wireId: rest.slice(slash + 1) };
}

/** Whether an id names a model on one of the user's own servers. */
export function isLocalModelId(id: string): boolean {
  return parseModelId(id).kind === 'local';
}
