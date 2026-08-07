# A bundled-resource path must be counted from the bundle, not from the source file

**Date:** 2026-08-07
**Area:** `src/main/agent/subagents/definitions.ts`, subagent definitions

## What happened

The subagent loader resolved the folder of definitions that ship with the app like this:

```ts
join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', 'resources', 'agents');
```

Four hops, counted from `src/main/agent/subagents/definitions.ts`, which does land on the repo root.
A unit test asserted that the shipped definitions load and it passed.

In the running app it resolved to `/Users/<me>/resources/agents`, which does not exist, so `readdir` threw, `loadSubagents` returned `[]`, `buildTaskSpec` returned `null`, and the `task` tool was never offered.
The agent answered "I can't launch the explore subagent because no task tool is available in this session."

## Why

electron-vite bundles main into a single file at `out/main/index.mjs`.
`import.meta.url` at runtime is that path, not the source path - so the distance to the repo root is **two** hops, not four.
Under vitest there is no bundling, so `import.meta.url` *is* the source path and four hops is right.

The test could not have caught this. It was asserting the source-tree arithmetic, which is not the arithmetic the app does.

## Fix

Count from the bundle, the same two hops `src/main/index.ts` already uses for `resources/`:

```ts
join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'resources', 'agents');
```

And stop having the test resolve the path through the production function.
It now reads the repo's own `resources/agents` from a URL relative to the test file, so it asserts the thing it can actually assert - that the definitions we ship parse and stay read-only - and leaves "where does the app find them" to the app.

## How to avoid it

- When a main-process file walks up to `resources/`, copy the hop count from `src/main/index.ts`. Do not recount it from where the source file happens to sit.
- A test that calls a path-resolving function from a bundled module is testing the unbundled layout. It is worth writing, but it is not evidence the app can find the file - only launching the app is.
- Symptom to recognise: a feature that silently degrades to "not available" rather than erroring. Anything gated on a `readdir` that returns `[]` on failure will do this.

See also `docs/learnings/2026-06-28-chat-skills-missing-from-packaged-app.md`, which is the packaged-build version of the same class of bug.
