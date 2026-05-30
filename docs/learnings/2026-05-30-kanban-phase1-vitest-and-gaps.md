# Kanban Phase 1: vitest/better-sqlite3 ABI, zod v4 `z.record`, and deferred gaps

Captured while implementing the headless Kanban core (`src/main/kanban/**`, plan `docs/superpowers/plans/2026-05-30-kanban-phase1-core.md`).

## 1. `better-sqlite3` native addon: Electron ABI vs system Node for vitest

### What happened
`better-sqlite3`'s prebuilt `.node` addon is compiled for **Electron's** Node ABI (MODULE_VERSION 140) by the `postinstall`/`electron-builder` rebuild. vitest runs under the **system** Node (e.g. v24, MODULE_VERSION 137), so any test that opens a `KanbanStore` (which `require`s `better-sqlite3`) throws `NODE_MODULE_VERSION` mismatch.

### Fix / workaround
Run `npm rebuild better-sqlite3` before invoking vitest. This recompiles the addon against system Node and persists **until the next `npm install`/postinstall**, which re-targets Electron. So:

- For local test runs: `npm rebuild better-sqlite3 >/dev/null 2>&1; npx vitest run ...`
- Do **not** run `npm install` mid-session and expect tests to keep working — it silently flips the addon back to the Electron ABI.

### Takeaway
Any future main-process test that touches `better-sqlite3` (or another native addon) needs the rebuild dance. A more durable fix (deferred): a vitest setup step or a separate test that runs under Electron's Node, or a CI step that rebuilds for the test runner before `npm test` and rebuilds for Electron before packaging. Today `npm test` passes only because the rebuild was applied in-session.

## 2. zod v4 changed `z.record` to require an explicit key schema

### What happened
The plan specified `z.object({ summary: z.string(), metadata: z.record(z.unknown()).optional() })` for the MCP `kanban_complete` args. With the installed **zod v4.3.6**, the single-argument `z.record(z.unknown())` throws at runtime (`Cannot read properties of undefined (reading '_zod')`).

### Fix
Use the two-argument form: `z.record(z.string(), z.unknown())` (explicit key type + value type). This yields `Record<string, unknown>`, matching `finishRun`'s `metadata?` param.

### Takeaway
On zod v4, always pass both key and value schemas to `z.record`. Training-era snippets using the one-arg form are wrong here.

## 3. Phase 1 deferred gaps (intentional — for Phase 2/3/5 implementers)

These were reviewed and consciously deferred; they are NOT bugs to "discover" later:

- **MCP token cleanup on crash/reclaim path.** `kanban_complete`/`kanban_block` now call `unregisterRun(token)`, but a worker that crashes (reclaimed by the dispatcher) leaves its token registered — the dispatcher has no reference to `KanbanMcpServer`. Bounded by `failureLimit` retries per task, but still grows over a long session. Phase 2: give the dispatcher a hook to unregister tokens for reclaimed runs (e.g. map runId→token, or an `onRunFinished` callback).
- **`maxRetries` (per-task) is inert.** Stored in the schema and accepted in `CreateTaskInput`, but the dispatcher's give-up decision uses only the global `config.failureLimit` (default 2). Wire `task.maxRetries` into `reclaim()`'s limit check in Phase 3, or treat the field as a placeholder until then.
- **`maxRuntimeSeconds` / `timed_out` not enforced.** Schema + `RunOutcome` include them; nothing checks wall-clock against `maxRuntimeSeconds`. Phase 3/5.
- **Claim auto-extend for alive workers not implemented.** Spec says the dispatcher should auto-extend a claim while the PID is alive and the run log is growing, so a healthy-but-quiet worker isn't reclaimed mid-turn. Today reclaim fires purely on `claimExpires <= now` (or dead PID past grace). With `claimTtlMs`/heartbeat both 15 min, a worker that never heartbeats is reclaimed at 15 min. Workers must heartbeat, or implement auto-extend in Phase 2/3.
- **`rune --profile <assignee>` is passed unconditionally** (`spawn-worker.ts`). Safe only once rune#12 (profiles) lands; if Rune rejects unknown flags, every dispatched worker fails at startup. Guard or gate in Phase 3.
- **Dispatcher is always-on.** It starts on app launch and ticks every 5 s; any `ready` task with an assignee triggers a real `rune` spawn. Without Rune on PATH (rune#10/#11 pending) spawns fail and are recorded as `spawn_failed`. Add a settings gate in a later phase if needed.
- **`FLEET_KANBAN_BOARD` env var** (multi-board scoping) not set by `spawn-worker.ts` — Phase 5.
