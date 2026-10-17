# An Agency tool name needs a dispatch case, not only a spec

## What happened

`job_deliver` was added to `AGENCY_TOOL_NAMES`, given a spec, a capability member and tests that called the member directly.
The model saw the tool and called it.
`runAgentTool` in `src/main/agent/tools/run.ts` had no `case 'job_deliver'`, so the call failed with "There is no tool called job_deliver".
Every unit test passed, because no test went through the dispatch switch.

## Fix

Added the missing case, and `src/main/agent/tools/__tests__/agency-dispatch.test.ts`.
That test sends every name in `AGENCY_TOOL_NAMES` through `runAgentTool` and fails on "There is no tool called".
A new Agency tool now fails CI until it is routed.

## Two smaller traps from the same change

`renderToStaticMarkup` reads a zustand store's server snapshot, which is the initial state.
`useAgencyStore.setState` in an SSR test has no effect on what renders.
Pass the value as a prop from the parent that already reads the store, and test the child with the prop.

`npm run format` formats the whole repo, so it also rewrote many unrelated Markdown files in `docs/`.
Run Prettier on the changed files only, or revert the files you did not change before you commit.
