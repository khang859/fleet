# Removing a feature: code that looks like it is the feature's may not be

The Admiral removal touched about 52k lines.
Most of the mistakes came from guessing what belonged to the Admiral.

## What went wrong

- `withRoundNote` read as Admiral code, but the todo, schedule and fleet ledger reminders use it too.
  The compiler caught it after I deleted it.
- An explorer said to delete `quit-work.ts` and `quit-confirm.ts`.
  They also serve background commands and subagents, so only the job rows went.
- An explorer said the worktree `startPoint` was dead.
  `ipc-handlers.ts` still reads it from the request.
- I called `withoutAgent` on every restored tab to handle a split that held an Admiral pane.
  That turned saved agent tabs without a `paneType` into terminal tabs, and a scratch tab test failed.
  The fix calls it only when pruning removed a pane.
- `npm run format` rewrites the whole repo, not only your diff, so it changed 79 unrelated docs and resources.
  Run `npx prettier --write` on your own files instead.
- An exact-string cut that ended at `"  });\n"` also matched `"    });\n"`, so it stopped inside a test.

## What to do

- Check every caller before deleting a helper, with `ripwire . --callers=SYM` or `git grep -w`.
  Treat an explorer's "this is dead" as a claim to verify, not as a fact.
- After the removal, look for what it orphaned.
  An option that only the feature set, such as `exitOnComplete` or `renotify`, is dead even though it still compiles.
- `ripwire . --quality-delta` found the orphaned `pr-review.ts` and `use-now.ts`, which the compiler cannot see.
- Keep what another feature depends on out of the cut.
  The copilot needs `addPermissionAnswerer` and the fleet-bridge mod needs the bridge server, so neither moved.
