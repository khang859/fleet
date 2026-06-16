# Don't put an index on a migration-added column into SCHEMA_SQL

**Date:** 2026-06-16
**Area:** kanban — KanbanStore schema/migrations

## What happened

While adding the standup digest (#233), a reviewer flagged that
`listBoardEventsSince` filters `tasks.board_id` with no index, and suggested adding
`CREATE INDEX IF NOT EXISTS idx_tasks_board ON tasks(board_id)` to `SCHEMA_SQL`.
That was done — and it broke the pre-v5 DB upgrade path:

```
SqliteError: no such column: board_id
    at KanbanStore.migrate (kanban-store.ts: this.db.exec(SCHEMA_SQL))
```

## Root cause

`migrate()` runs `this.db.exec(SCHEMA_SQL)` **first**, before the versioned
migration blocks. For a fresh DB, `SCHEMA_SQL`'s `CREATE TABLE tasks` includes
`board_id`, so the index builds fine. But for an **existing pre-v5 DB**, the `tasks`
table already exists without `board_id` (`CREATE TABLE IF NOT EXISTS` is a no-op),
and `board_id` is only added later by the `if (current < 5)` migration block. So a
`CREATE INDEX ... ON tasks(board_id)` sitting in `SCHEMA_SQL` runs against the old
table before the column exists → crash on open.

The index was also **redundant**: it was already created in the v5 migration block
(`kanban-store.ts`, with a comment explaining exactly this), which runs for every
DB including fresh ones (fresh DB starts at `user_version` 0 < 5). The "missing
index" the reviewer saw in `schema.ts` existed all along — in the migration, not
in `SCHEMA_SQL`.

## Fix

Removed the duplicate line from `SCHEMA_SQL`. The index lives only in the v5
migration block, which runs after `board_id` is guaranteed to exist.

## Takeaways

- `SCHEMA_SQL` runs **before** migrations and against pre-existing tables. Only put
  indexes/constraints there for columns present in the base `CREATE TABLE` for
  **every** historical DB. Index a migration-added column **inside the migration
  block that adds it** (`IF NOT EXISTS`), never in `SCHEMA_SQL`. There are existing
  comments in `kanban-store.ts` (`idx_tasks_board`, `idx_tasks_feature`) saying
  exactly this — read them before touching indexes.
- Before "adding a missing index," grep the whole store (`migrate()` included), not
  just `schema.ts` — the index may already be created in a migration.
- Bumping `SCHEMA_VERSION` breaks every hardcoded version assertion in the tests.
  Grep `__tests__` for the old number (e.g. `toBe(15)`) across **all** store test
  files, not just the obvious one — `kanban-review-store.test.ts` was missed and
  only surfaced in the final full-suite run.
