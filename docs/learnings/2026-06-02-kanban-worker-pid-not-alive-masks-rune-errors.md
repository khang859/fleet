# Kanban "worker pid not alive" masked the real rune failure

## Symptom

Kanban Decompose (and work runs) kept failing with a cryptic **"worker pid not
alive"** reclaim, looping through the retry budget and then giving up with
`gave-up: worker pid not alive`. No indication of the actual cause.

## Root cause

The dispatcher only knew the worker's PID was gone — it never looked at *why*.
The real cause was in the per-run worker log (`~/.fleet/kanban/logs/<runToken>.log`):

- codex OAuth refresh failures: `auth refresh failed: token endpoint 401 …
  refresh_token_reused / refresh_token_invalidated` (a rotated/invalidated refresh
  token that was never written back to `~/.rune/auth.json` — every subsequent
  worker reused the stale token and got 401'd). Fix on the user side: re-auth the
  provider (`rune login`).
- non-auth provider errors too, e.g. `status 400: Missing required parameter`.

`rune` writes these as a `[error: …]` marker right before exiting. The dispatcher
threw the information away and surfaced the generic liveness reason instead.

## Fix

Classify the cause of death at exit time, where the log path is still in scope
(`index.ts` `onExit` callback), and route it through the dispatcher:

- `spawn-worker.ts`: `detectAuthFailure()` (provider-agnostic auth regex),
  `extractRuneError()` (pulls the last `[error: …]` headline + `"message"`),
  `lastLogLine()`.
- `WorkerExit` gained `fatalReason` (the real cause) and `blockNow` (deterministic,
  retry-proof → block immediately).
- `reclaim()`: a `blockNow` exit blocks the task with `fatalReason` (no retry);
  otherwise `fatalReason` is preferred over "worker pid not alive" so even a
  retried-then-given-up task carries the real cause.
- Auth failures and crashes within a 10s startup window are treated as
  deterministic (`blockNow`); other provider errors still use the retry budget but
  now with the real reason attached.

## Takeaways

- This mirrors the existing exit-3 → review-required branch: when a worker dies,
  prefer a definitive, actionable classification over a generic liveness reclaim.
- Don't hardcode one provider. rune supports codex/groq/ollama/runpod/openrouter;
  the auth regex and surfaced error are provider-agnostic, and the remediation hint
  is generic (`e.g. \`rune login\``) rather than codex-specific.
- The worker log is the source of truth for *why* a detached child died — the
  exit code/signal alone isn't enough.
