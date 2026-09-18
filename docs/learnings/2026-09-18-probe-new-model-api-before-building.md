# Probe a new model API with a real key before building on it

## What happened

We added TypeSafe's Jev (`typesafe/jev-1.13`) as an auto-approval model.
Jev is not a chat model.
It answers on OpenRouter's alpha Decisions endpoint, `POST https://openrouter.ai/api/alpha/decisions`.
The wrapper was built from OpenRouter's OpenAPI spec and a probe without a key.
No real call with a key was made first, because the dev environment had no OpenRouter key.

## Gotchas found

- The docs list the server as `https://openrouter.ai/api/v1`, but `/api/v1/alpha/decisions` returns 404.
  The live path is `/api/alpha/decisions`.
- Decision models are missing from `GET /api/v1/models`, so the Fleet catalog never lists them.
  They are listed by hand in `src/shared/agent-decision-models.ts`.
- `choice` answers carry `confidence` and `probabilities`, but the spec marks both optional.
- A TypeScript type guard like `(id: string | null): id is string` is wrong when a `false` result can still be a string.
  The `else` branch narrows to `null`, and lint flags later `??` checks as unnecessary.

## Rule

Before building on a new or alpha model API, make one real call with a key and save the raw response.
If no key is available, ask the user to run the call first.

## Verified afterwards

A real call later matched the spec, and OpenRouter also returned `id`, `provider` and `usage.cost`.
`confidence` is not the chance of the chosen option.
One real answer had `probabilities.safe` 0.99 and `confidence` 0.97, so the gate uses `probabilities.safe` with a 0.9 bar.
