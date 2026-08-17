# Pointing the Agent pane at local servers (2026-08-17)

Three bugs found while adding local OpenAI-compatible endpoints (llama.cpp, Ollama, LM Studio, vLLM) to the Agent pane.
All three were found by running against a real `llama-server`, not by reading its docs.

## llama.cpp silently ignores OpenRouter's `reasoning` parameter

**Problem:** `completeOnce` against `http://127.0.0.1:11437` returned `text: ""` with all 24 completion tokens spent on reasoning.
Fleet asks for reasoning off with OpenRouter's `reasoning: { enabled: false }` body field.
llama.cpp does not know that field, does not reject it, and thinks anyway.

The failure is silent and downstream: session titles come back empty, and every auto-mode command classification falls through to asking the user.
Nothing errors, so nothing points at the cause.

**Fix:** `CompletionsTarget` gained a `reasoningDialect` discriminator, and `reasoningBody()` in `src/main/agent/completions.ts` translates:

```ts
function reasoningBody(
  reasoning: ReasoningParam | null,
  dialect: CompletionsTarget['reasoningDialect']
): Record<string, unknown> {
  if (reasoning === null) return {};
  if (dialect === 'reasoning-param') return { reasoning };          // OpenRouter
  if (!('enabled' in reasoning)) return {};
  return { chat_template_kwargs: { enable_thinking: reasoning.enabled } };  // llama.cpp
}
```

Verified by curl first (`enable_thinking: false` returned `"OK"` in 2 tokens), then end to end.

**Lesson:** "OpenAI-compatible" covers the endpoint shape, not the vendor extensions layered on it.
Every non-standard body field needs a per-target dialect, and an ignored field fails silently rather than loudly.
The same split applies on the way back: llama.cpp streams `delta.reasoning_content`, OpenRouter streams `delta.reasoning`.

## `n_ctx` versus `n_ctx_train`

llama.cpp publishes both an allocated context window and the window the model was trained for, and on this machine they differ 16x - 16384 served, 262144 trained.
Budgeting a conversation against the trained figure would overflow the real window sixteen times over, mid-turn.

`resolveContextLimit()` in `src/main/agent/endpoints/probe.ts` prefers the allocated figure from every source it knows (`props.n_ctx`, `meta.n_ctx`, `loaded_context_length`, `max_model_len`, `max_context_length`) and only falls back to `n_ctx_train` last.

A second bug in the same function: it was a `??` chain, which only steps past `null` and `undefined`.
A server with no model loaded reports `n_ctx: 0` rather than omitting the field - and a multi-model router listing its whole roster does it for every model it has not loaded yet - so the chain stopped on the zero and handed the app a context window of nothing.
It now takes the first *positive* candidate.
Zero is the absence of an answer, not an answer of nothing.

## A settings write is two IPC round trips, so the prop is stale for all of it

**Problem:** the scan dialog found two servers; clicking Add on both added one.

`updateSettings` awaits `settings.set` then `settings.get` before the store updates, so the `endpoints` prop still holds the old list for the whole trip.
Both handlers came from the same render, so both composed `[...endpoints, one]` against the same array and the second write won.

**Fix:** `LocalEndpointsSection` keeps the list it last sent in a ref, drops it once the prop matches, and - critically - reads that ref *at the moment of the change* rather than through a value captured at render:

```ts
const current = (): LocalEndpointConfig[] => pending.current ?? endpoints;
```

The first attempt kept the ref but still let the handlers close over a render-time `const list`, which fixed nothing: two clicks before a re-render share one closure.
Only reading through a function at call time works.

This is the same family as `2026-06-04-settings-patch-stale-overwrite.md` and `2026-08-12-settings-array-read-modify-write-race.md`.
Any settings-backed list edited by more than one control in a row has it.

## Smaller things the same session turned up

- **A price of zero is not a price.** The role summary line rendered `$0.00 / $0.00 per 1M` for a model on the user's own GPU, which reads as a price that failed to load. Local models now show no price at all. Same rule the picker row already followed.
- **A scan that hides what it found reads as an empty machine.** The scan first filtered out already-configured addresses, so a machine running two servers, both added, reported "Nothing found." It now returns everything and the dialog marks the configured ones "Added" - a disabled button that says why beats an enabled one that does nothing.
- **A schema that is never called is worse than no schema.** `LocalEndpointConfigSchema` was written with a comment saying the shape is "checked before it is written to settings", and then nothing imported it - `localEndpoints` went through the generic unvalidated `SETTINGS_SET` channel, unlike `mcpServers`, which has its own validating handler. The comment made the gap invisible. It is now applied per entry where main reads the list, which is the actual trust boundary.
- **`supportsTools` must default optimistically.** The coding picker filters on it, so a local server that cannot prove tool support would be invisible with no explanation. It defaults to `true`, including for the remembered rows shown while a server is down.
