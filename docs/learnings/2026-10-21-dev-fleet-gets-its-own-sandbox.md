# A dev Fleet interrupted the installed app's Admiral jobs

Date: 2026-10-21

## What happened

The installed Fleet ran Admiral jobs 32 and 35-38 for the fleet repo.
A dev Fleet started at 06:46 and opened the same `~/.fleet/agency.db`.
Its `reconcileAtStartup` could not see the installed app's crew panes, so it decided "Fleet restarted" and interrupted all five jobs.
Resume was then picked in the dev app, so the new crew started in dev panes.
The user closed those panes, and the installed app never heard of it.
Its database still said `running` for every job, with live crew that no longer existed.

The dev build shared almost everything with the installed app:

- the Electron data folder (`~/Library/Application Support/Fleet`): settings, saved panes, secrets
- every folder under `~/.fleet`: `agency.db`, agency jobs, notes, logs, worktrees, learnings
- the `fleet` CLI in `~/.fleet/bin`, which the dev build overwrote with its own
- the Claude Code hook binary in `~/.claude/hooks`, which the dev build overwrote with its own, and the `fleet-learnings` entry in `~/.claude.json`

The `-dev` socket suffix kept dev apart from the installed app, but not one dev worktree from another.
The Vite port (5173) was shared too, so a second dev app could load the first one's renderer.

## Fix

- `src/shared/fleet-home.ts` gives a dev build its own `FLEET_HOME`, `~/.fleet/dev/<sha1(checkout)[0:12]>/`.
  The checkout is found from the code's own path, not the working directory or an env var, so nothing inherited can point a dev app at another checkout's sandbox.
  The app's state, the sockets and the Electron data folder (`dev-sandbox.ts`) live under it.
- Some paths stay shared on purpose, as they hold what the user wrote or caches, not app state:
  `~/.fleet/crew`, `~/.fleet/scratch` (the renderer names it too), `~/.fleet/ssh-control` (socket paths must stay short) and `~/.fleet/learnings/models`.
- A dev build started from a pane in another Fleet drops that pane's `FLEET_*` variables at start.
  Otherwise what it runs outside its own panes, such as the learnings `claude -p`, would report to the other Fleet.
- A new sandbox copies the installed app's settings and secret files once, and nothing else.
- A dev build never writes `~/.claude` hooks, `~/.claude.json`, shell profiles, opencode config or `~/.fleet/bin`.
- Every pane gets `FLEET_COPILOT_SOCKET`; a dev pane also gets `FLEET_HOOK_BIN` and `FLEET_CLI`.
  The installed hook binary and `fleet` wrapper hand off to those, so a dev pane runs the checkout's own hook and CLI against its own sockets.
- The renderer and debug ports are per checkout, below the 41000+ crew port blocks, with `strictPort`.
- The single-instance lock is on in dev too: it is per data folder, so it now stops only a second app on the same sandbox.

## Gotchas found on the way

- `fleet-cli.ts` must import only Node built-ins.
  The release copy lives in `~/.fleet/lib` with no `node_modules`, so importing `shared/constants` (which pulls in `zod`) broke it.
  It imports `shared/fleet-home` instead.
- A dev build runs its checkout's `out/main/fleet-cli.mjs` in place, not a copy, so the CLI finds its checkout from where its code lives.
- The hook hand-off uses `exec`, not a child process: the hook finds Claude Code as its parent pid, and a child would see the installed hook instead.
- `FLEET_HOME` is fixed when its module loads, so a test that sets `process.env.HOME` later no longer moves it.
  `worktree-start-point.test.ts` did that and wrote worktrees into the real `~/.fleet/worktrees`.
  A test that needs its own Fleet folder mocks `shared/fleet-home` with a `FLEET_HOME` getter instead.
- `mcp-dispatch.test.ts` wrote a picture into the real `~/.fleet/agent/images` and left its empty folder behind on every run.
  It now removes the folder too.

## Rule

- The hand-off only works once the installed app has it, so hooks in dev panes report nowhere until the installed app updates past this change.
- A stale sandbox is safe to delete: `cat ~/.fleet/dev/*/checkout` names each one's checkout.
