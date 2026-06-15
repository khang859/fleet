# Learnings: Board PM stuck on "Thinking" (2026-06-15)

## Symptom

The kanban Board PM chat panel showed "Thinking…" indefinitely and never recovered. No
`rune` process was running, so the LLM turn was long over — yet the UI stayed stuck and
the input stayed disabled. `reset()` also refused to help (it throws while in-flight).

## Root cause

`PmChatService.sendMessage` (`src/main/kanban/pm-chat-service.ts`) set `c.inFlight = true`
and emitted `status: 'thinking'`, then ran ~30 lines of **unguarded synchronous setup**
(`mcp.registerRun`, `mkdirSync`, `writeFileSync`, `spawn`) **before** wiring the child
`'error'`/`'exit'` handlers. There was no `try`/`finally`.

`inFlight` was only ever reset to `false` inside `finish()`, and `finish()` is reachable
**only** from the child's `'error'`/`'exit'` events (or the timeout's `kill`, which needs a
child). So if any setup step threw (FS error like EACCES/ENOSPC, or `spawn` throwing
synchronously on EMFILE / bad options), `inFlight` latched `true` forever with no child to
ever fire `finish()`. The renderer faithfully renders `inFlight` as "Thinking" and only
re-reads the authoritative flag on panel mount / board switch, so the phantom persisted
until app restart (restart rehydrates `inFlight: false`).

A red herring to avoid: an earlier theory blamed the un-`.catch()`'d
`readMessages().then()` in `finish()`. That's **not** it — `readRuneSession`
(`src/main/sessions/rune-source.ts`) catches everything internally and returns `null`, so
`readMessages` can never reject. Verified by reading the code + 3 adversarial sub-reviews.

Secondary latent gap: the per-turn timeout sent a single `SIGTERM` with **no SIGKILL
escalation**, so a rune that traps SIGTERM would also hang `inFlight` forever (different
trigger, same latch).

## Fix

Restructured `sendMessage` so **every** exit path funnels through a single null-safe
`finish()`:

- Hoisted `finish` (and `token`/`child`/`timeout`/`killTimer`/`sessionId`) above the setup,
  guarding `clearTimeout`/`inFlightChildren.delete` for the case where the child was never
  created.
- Wrapped the setup + spawn + handler wiring in `try { … } catch (err) { finish(msg); throw err }`
  so a synchronous setup failure clears `inFlight`, emits a terminal `error` status, and
  still surfaces the error to the caller.
- Added SIGKILL escalation: after the timeout's SIGTERM, a `PM_TURN_SIGKILL_GRACE_MS` (5s)
  timer sends SIGKILL if the child hasn't exited.
- Defensive `.catch()` on the transcript read-back, with the status transition moved to
  `.finally()` so a future throw there can't strand the turn on "Thinking" either.

## Takeaways

- Any flag set to a "busy" value must have a `try`/`finally` (or single funnel) guaranteeing
  it is reset on **every** path, including synchronous setup throws — not just the happy
  async completion.
- `spawn` can throw **synchronously**; handlers attached after `spawn` won't catch that. Set
  up your reset path before/around `spawn`, not only on its events.
- A process-killing timeout needs SIGKILL escalation; SIGTERM alone is a request, not a
  guarantee.
- The renderer trusted live push events with re-sync only on mount/board-switch; the durable
  fix lives in main (guaranteed terminal status), but a periodic/self-healing re-sync in the
  renderer would add defense in depth (not done here — kept the change surgical).

Tests: `src/main/kanban/__tests__/pm-chat-service.test.ts` — reproduces the latched-flag case
(setup throw → `inFlight` returns to `false`, terminal `error` emitted) and the
SIGTERM→SIGKILL escalation.
