# Bumping SCHEMA_VERSION breaks the existing kanban-store suite

**Date:** 2026-06-12
**Area:** kanban store / test maintenance / subagent-driven dev process

## What happened

While implementing the verify-gates feature (#231), Task 2 bumped
`SCHEMA_VERSION` 13 → 14 (migration 14 adds `projects.verify_commands` and
`tasks.verify_attempts`). The task's verification step only ran the *new*
test file (`kanban-verify-store.test.ts`) plus `npm run typecheck`, both of
which were green. It did **not** run the pre-existing `kanban-store.test.ts`
suite.

That suite hardcodes the schema version in ~10 places
(`expect(store.schemaVersion()).toBe(13)` plus migration-upgrade tests that
expect a fresh/migrated db to land on the current version, and a couple of
`v13` test titles/comments). After the bump they all failed with
`expected 14 to be 13`. The breakage was invisible until a later task
(Task 4) happened to run the broader suite and surfaced it.

## Fix

Update the assertions and the now-stale `v13` labels to `14`:
`schemaVersion()).toBe(13)` → `...toBe(14)` (replace-all), and the few
"created at v13" titles/comments. All 97 store tests pass again. Committed
separately as `test(kanban): update store schema-version assertions to v14`.

## Lessons

1. **Any change that bumps `SCHEMA_VERSION` must run the full
   `kanban-store.test.ts` suite in its verification step**, not just the new
   test + typecheck. The store suite pins the version number and the
   migration ladder's terminal version, so it *will* fail on every bump and
   the assertions must be updated in the same change. Add this to the
   per-task verification when a migration is involved.

2. **typecheck + the new test passing is not sufficient** for store/schema
   changes — version assertions are runtime, not type-level, so the compiler
   never catches them.

## Process note: subagent `git commit --amend` races the controller

During review fix-ups, a fresh review-fix dispatched to the Task 4 implementer
ran `git commit --amend` to fold in a one-line change. But the controller had
committed an unrelated fix (the store-test update above) on top of the Task 4
commit in the meantime, so `--amend` rewrote the *wrong* tip — mashing the
Task 4 follow-up into the store-test commit.

It was recoverable on a local/unpushed branch (`git reset --soft <task-commit>`,
unstage the unrelated file, `--amend`, then recommit the unrelated file), but
the rule is: **don't commit controller-side changes onto a branch while a
subagent might `--amend` its own task commit.** Either (a) keep controller
fixes off the branch until the subagent's amend lands, or (b) have the
controller make such fixes itself as a normal commit *after* the amend, or
(c) tell the subagent to make a new commit instead of amending. Sequence the
amend before any controller commit on top.
