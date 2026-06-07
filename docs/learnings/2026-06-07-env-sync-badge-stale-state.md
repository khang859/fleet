# Env Sync Toolbar Badge Stays Stale After a Fix

## Problem

The toolbar `EnvSyncBadge` ("env ✓/⚠") aggregates target statuses for the active
tab's repo. When a target errored (red ⚠) and the user fixed the cause via the
Env Sync modal (changed AWS auth/region, pushed/pulled, etc.), the badge stayed
red until a full app refresh (Cmd + R).

## Root Cause

`EnvSyncBadge` only fetched status inside a `useEffect` keyed on `cwd`. It had no
awareness of mutations performed elsewhere (the modal, the conflict dialog), so
nothing re-ran the aggregation. The state was correct on disk/S3 — only the
badge's cached `agg` was stale.

The modal compounded this: saving global passphrase/auth called `reloadSecrets`
only, which refreshed the redacted secrets but NOT the status table — so even the
modal's own rows didn't reflect an auth fix until reopened.

## Fix

Reused the existing `window` CustomEvent pattern (already used for
`env-sync:conflict`):

1. `EnvSyncBadge` now adds a `window.addEventListener('env-sync:changed', load)`
   listener and re-aggregates whenever it fires.
2. The modal dispatches `env-sync:changed` at the end of `reload()` (covers
   push/pull, config writes, bucket create, config create).
3. A new `onSecretsChanged` (= `reloadSecrets` + `reload`) is wired to the global
   and per-repo passphrase/auth controls, so a credential fix refreshes the
   status table AND the badge.
4. `EnvSyncConflictDialog` dispatches `env-sync:changed` on a successful resolve.

## Takeaway

Cross-component cache invalidation for env-sync flows goes through the
`env-sync:changed` window event. Any new code path that mutates env-sync state
(config, secrets, S3 objects) should dispatch it so the badge and other listeners
stay live without a refresh.
