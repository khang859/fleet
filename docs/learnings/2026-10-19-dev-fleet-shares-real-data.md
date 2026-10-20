# A dev Fleet shares the real app's data folder

Date: 2026-10-19
Found while: job j30, checking the crew permission mode controls with fleet-drive

## What happened

1. A crew member started `electron-vite dev` itself (to pick its own ports), not through `npm run dev`.
   That skipped `predev`, so `better-sqlite3` was still built for Node from `npm test`.
   The agency failed to open `agency.db` (`NODE_MODULE_VERSION` mismatch), no `agency:*` IPC handler was registered, and Settings > Agency > Crew > Runtimes stayed empty.
2. The dev app ran with `--user-data-dir ~/Library/Application Support/Fleet`, the real app's folder.
   It restored the client's saved panes and started shells in other jobs' worktrees.
   Fleet restarted during the run, and the crew member lost its turn.
3. The dev app ignored SIGTERM (it waits on the "Close Fleet?" dialog) and needed SIGKILL.

## Fix

- Start the dev app only through `npm run dev` or `npm run drive -- up`, so `predev` rebuilds `better-sqlite3` for Electron.
- A crew member must not start a dev Fleet while the real Fleet runs agency jobs: it reads and writes the same settings, `agency.db` and saved panes.
  Check UI with a `renderToStaticMarkup` test instead (see `settings/crew/__tests__/permission-mode.test.ts`), and leave the live check to the client.
- A zustand store under `renderToStaticMarkup` reads its first state, not one set with `setState`, so mock the store hook with `vi.mock` for such a test.

## Rule

Before starting a dev Fleet, ask: does anything else use `~/Library/Application Support/Fleet` right now?
If Fleet runs jobs, do not start one.
