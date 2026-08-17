import { describe, expect, it } from 'vitest';
import { isLocalModelId, localModelId, parseModelId } from '../agent-model-id';

/**
 * Model ids from two places in one field, without a migration.
 *
 * Every model the app has ever saved is an OpenRouter id, and those ids have to
 * come back out of this byte for byte - a settings file written before local
 * servers existed has to keep working, and the way that is guaranteed is that
 * nothing touches an id that does not carry the prefix.
 */
describe('parseModelId', () => {
  it('leaves an OpenRouter id exactly as it was saved', () => {
    for (const id of ['anthropic/claude-sonnet-4.5', 'openai/gpt-5.6', 'openrouter/auto']) {
      expect(parseModelId(id)).toEqual({ kind: 'openrouter', id });
    }
  });

  it('reads back the endpoint and the wire id it was built from', () => {
    expect(parseModelId(localModelId('ep_1', 'qwen3-coder'))).toEqual({
      kind: 'local',
      endpointId: 'ep_1',
      wireId: 'qwen3-coder'
    });
  });

  /*
   * A `llama-server` started without `--alias` names the model after the file
   * it loaded, which is a path: several slashes, and often a leading one. The
   * split is at the *first* slash for exactly this, and the rest of the string
   * is the id whatever is in it.
   */
  it('keeps a model named after the file it was loaded from', () => {
    const wireId = '/models/gguf/Qwen3-Coder-30B-Q4_K_M.gguf';
    const parsed = parseModelId(localModelId('ep_1', wireId));
    expect(parsed).toEqual({ kind: 'local', endpointId: 'ep_1', wireId });
  });

  /*
   * Not a local id, whatever it looks like. Reading it as one would produce an
   * endpoint id or a wire id that is empty, and the failure would arrive later
   * as a call to nowhere rather than here as a model that is simply unknown.
   */
  it('treats a malformed local id as an ordinary one rather than half-parsing it', () => {
    for (const id of ['local:', 'local:ep_1', 'local:/wire', 'local:ep_1/']) {
      expect(parseModelId(id)).toEqual({ kind: 'openrouter', id });
    }
  });
});

describe('isLocalModelId', () => {
  it('answers for the two cases the UI branches on', () => {
    expect(isLocalModelId(localModelId('ep_1', 'qwen3-coder'))).toBe(true);
    expect(isLocalModelId('anthropic/claude-sonnet-4.5')).toBe(false);
  });
});
