# Env Editor: stale cwd after folder rename → cryptic ENOENT on save

## Symptom

Editing a `.env` via the Env Editor failed with:

```
Error invoking remote method 'env-editor:write':
Error: ENOENT: no such file or directory, open
'/Users/.../rune-v2/.env.fleet-tmp-40629-1781649467771-10'
```

Trigger: the user renamed the folder they were `cd`'d into, then tried to save.

## Root cause

Fleet caches each pane's cwd in `cwd-store` (renderer), populated two ways by
`src/main/cwd-poller.ts`:

1. OSC 7 escape sequences the shell emits on `cd`.
2. A PID poller (`pidCwd` / `/proc/<pid>/cwd`).

**The poller permanently stops once an OSC 7 is seen** (`osc7Seen` set), and OSC 7
only fires on `cd`. Renaming the *current* folder runs no `cd`, so neither path
updates → the store keeps the **old** path.

The Env Editor used that stale path as its `root`. On save, `writeEnvFile`
(`env-editor-fs.ts`) writes a temp file `${absPath}.fleet-tmp-...` next to the
target. When the parent directory no longer exists, `writeFileSync` throws a raw
`ENOENT` naming the temp file — confusing, and with no recovery.

Key insight: `pidCwd(pid)` resolves the process's **live** path via inode on
macOS, so it returns the *new* folder name on demand — the data was recoverable;
the poller just wasn't running anymore.

## Fix

Two layers (commit on branch `fleet-rare-cove-dune`):

1. **Resolve live cwd on demand.** Added `CwdPoller.resolveNow(paneId,
   pathContext)` which re-reads the live cwd, emits `cwd-changed` if it differs
   (so the whole app re-syncs), and returns it (null for WSL / no-pid). Exposed
   via `pty:resolve-cwd` IPC + `window.fleet.pty.resolveCwd`. The Env Editor
   calls it on open and uses the result as `root`, so it follows the renamed
   folder.
2. **Graceful backstop.** `writeEnvFile` now returns `{ ok: false, missingDir:
   true }` when the parent dir is gone instead of throwing; the modal shows a
   clear toast ("This folder no longer exists — run `cd` to refresh") and stays
   open.

## Takeaways

- A "current dir" cached from OSC 7 goes stale on rename/move because no `cd`
  fires. When you need an authoritative cwd, resolve it on demand from the pid
  rather than trusting the cached value.
- Atomic temp+rename writes surface ENOENT against the *temp* path, which hides
  that the real problem is a missing parent directory. Check the dir explicitly
  and return a meaningful result.
