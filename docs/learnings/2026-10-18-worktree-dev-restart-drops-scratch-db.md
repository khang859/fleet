# A worktree dev restart drops the scratch database and migrates the real one

## What happened

During the Admiral "understands you" work, the feature worktree ran `npm run dev` against a scratch database:
`FLEET_AGENCY_DB_PATH=$S/agency.db FLEET_AGENCY_HOME=$S/home npm run drive -- up`.
Later calls used `npm run drive -- restart`, and a few used a plain `npm run drive -- up`.
Neither carries those variables, so the branch's code opened the real `~/.fleet/agency.db` and migrated it one schema ahead of `main`.
It also registered the scratch test repositories (`shop`, `blog`, `notes`) as real projects.

The main checkout's dev app was on an older `main` commit.
On its next start it threw "agency.db is at schema 12, newer than this Fleet understands (11)".
`AgencyService` failed to construct, so none of its IPC handlers were registered.
The renderer showed "The Admiral could not start: Error: Error invoking remote method 'agency:claim': Error: No handler registered for 'agency:claim'".

## Fix

Fast-forward the main checkout to `origin/main`, whose schema is at or ahead of the database, then restart its dev app.
Never move a database schema back by hand.

## Lesson

- In a worktree whose branch adds a migration, never use `drive -- restart` or a plain `drive -- up`.
  Stop it, then start it again with both `FLEET_AGENCY_DB_PATH` and `FLEET_AGENCY_HOME` set, every time.
- Keep the main checkout at `origin/main` after each merge, since a merged migration reaches the real database as soon as any newer build opens it.
- "No handler registered for 'agency:…'" means `AgencyService` threw at startup. Read `.fleet-drive/dev.log` for the first `unhandledRejection`.
