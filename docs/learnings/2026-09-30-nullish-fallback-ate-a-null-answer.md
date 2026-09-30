# A `??` fallback turned "no objection" into a refusal

## What happened

In the Phase 4 E2E, every `fleet_send` failed with "Session tracking is not running." while the sidebar showed the session tracked and waiting for a prompt.

Main wired the prompter through the lazily created `ClaudeSessionsService`:

```ts
refusal: (sessionId) =>
  claudeSessions?.sendRefusal(sessionId) ?? 'Session tracking is not running.',
```

`sendRefusal` returns `null` when the send may go ahead.
`??` cannot tell that `null` from the `undefined` that `?.` gives when the service is missing, so a clean answer became the not-running refusal.
The unit tests of `fleet_send` used a stand-in prompter and never went through this wiring, so they passed.

## Fix

The wiring moved into `lazyPrompter` in `src/main/agent/fleet/send.ts`, which checks for the missing service explicitly, and it has its own tests for both cases.

## Lesson

`a?.f() ?? fallback` is only safe when `f` never returns `null` or `undefined` on its own.
When `null` is a meaningful answer, test for the missing object instead, and keep wiring like this out of `main/index.ts` so a test can reach it.
