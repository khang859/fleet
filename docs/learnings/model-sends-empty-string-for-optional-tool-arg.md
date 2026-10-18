# A model sends `""` for an optional tool argument

## Symptom

In the Phase 5 E2E run, the Admiral's first `client_file_propose` call failed.
The call had `{ "text": "...", "replaces": "" }` for a new line.
The schema read `replaces: ""` as "replace the line whose text is empty".
No line matched, so Fleet refused the call, and the chat showed a "failed" tool row.
The Admiral then sent the call again without `replaces`, and that one worked.

## Cause

The JSON schema marks `replaces` as optional.
Some models fill every field in the schema, and they send an empty string when they have nothing to say.
Zod's `.optional()` handles only `undefined`, so `""` went through as a real value.

## Fix

`replacedLine` in `src/shared/agency-tools.ts` trims the string and turns `''` into `undefined`.
A test in `agency-client-file.test.ts` sends `replaces: ''` and expects a new line.

## Rule

For each optional string argument of a model-facing tool, read `""` (and whitespace) as "not given".
Do this in the zod schema, so every caller gets the same rule.
