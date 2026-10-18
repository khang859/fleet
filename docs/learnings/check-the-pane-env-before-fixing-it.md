# Check the pane env before you "fix" it

## What happened

While building `fleet agency done`, I thought a dev crew pane lacked `FLEET_DEV`, so its `fleet` CLI would reach the release app's socket.
I added a `FLEET_SOCKET` variable to every pane env and made the CLI read it.

That was wrong.
A crew pane gets `{ ...process.env, ...extraEnv }` (`ipc-handlers.ts`), so it inherits `FLEET_DEV=1` from the dev app.
The CLI already picks `fleet-dev.sock` when `FLEET_DEV` is set.
`echo $FLEET_DEV` in a dev pane printed `1`.

## Fix

I took `FLEET_SOCKET` out again before the PR.

## Rule

Before you add env to a pane, run `echo $VAR` in a real pane with `npm run drive -- term-send`.
A guess about inherited env is not a reason to add a new variable.
