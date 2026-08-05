# Learnings: all-or-nothing zod parsing of a third-party feed (2026-08-05)

## Symptom

The agent settings tab showed "Could not reach models.dev (Unexpected response shape from models.dev)" even though the request succeeded.

## Root cause

The models.dev catalog was validated with one schema over the whole payload:

```ts
const catalogResponseSchema = z.object({
  openrouter: z.object({ models: z.record(z.string(), modelSchema) })
});
```

`modelSchema` required `min` and `max` on a `budget_tokens` reasoning option.
Eight of the 337 OpenRouter entries name the option with no bounds at all (`{ "type": "budget_tokens" }`), so those entries failed - and because they were parsed as part of one big record, **all 337 models were rejected**.
The feed is a community catalog: fields are optional in practice regardless of what the common case looks like.

## Fix

Two changes, both in `src/main/agent/models-catalog.ts`:

1. **Parse entries individually.** The outer schema only asserts `openrouter.models` is a record of unknowns; each entry runs through `modelSchema.safeParse` in a loop and a failure skips that model. One odd entry costs one model, not the catalog. An empty result is still treated as an error so the UI does not silently show nothing.
2. **Make optional what the feed treats as optional,** then normalize. `min`/`max` are optional in the schema and filled in afterwards (`min` defaults to 1024, `max` falls back to the model's own output limit); an option that still cannot be described is dropped rather than rendered as a slider with no range.

## Rule of thumb

When validating an external feed you do not control, validate per item, not per document.
Reserve whole-document strictness for payloads produced by code you own.
Sanity-check a schema against the real payload before shipping - the 3.3MB file parses in a second:

```bash
curl -s https://models.dev/api.json -o /tmp/models-dev.json
# then run the parser over it and print the count
```
