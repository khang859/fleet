# agent-store tests mock workspace-store with only three exports

## What happened

The Admiral needed `agent-store` and `agent-schedule` to tell an Admiral thread from an Agent pane's thread.
The obvious move was to import a new helper from `workspace-store` into them.
`src/renderer/src/store/__tests__/agent-fleet.test.ts` mocks `workspace-store` with only `isOrchestratorPane`, `registerPaneDisposer` and `useWorkspaceStore`.
Any other import from it comes back undefined in that test, and the store breaks there while every other test passes.

## Fix

The Admiral's turn mode is read off the thread key instead (`store/admiral-thread.ts`), so the agent store imports nothing new from `workspace-store`.

## Lesson

Before importing something new from `workspace-store` into the agent store or its schedule, check the `vi.mock('../workspace-store', ...)` factories in the agent store tests.
Either derive what you need without the workspace store, or add the export to those mocks in the same change.
