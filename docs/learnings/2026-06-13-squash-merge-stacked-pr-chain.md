# Learnings: Landing a Squash-Merged Stacked PR Chain (2026-06-13)

Context: landing the three-PR WSL path-handling stack — #248 (phase 0/2) → #249
(3a) → #250 (3b), each branch based on the one below it, into a `main` that
**squash-merges**.

## Symptom 1 — `--delete-branch` on the base PR *closes* the child PR

**Problem:** Merging #248 with `gh pr merge 248 --squash --admin --delete-branch`
left #249 (whose base was #248's branch) **CLOSED**, with its base still pointing
at the now-deleted `fix/wsl-windows-path-handling`.

**Root cause:** GitHub only auto-retargets a child PR to the merged PR's base
**on merge**. When the head branch is *deleted* before that retarget settles, the
child's base branch vanishes and GitHub closes the child instead. Deleting the
branch as part of the same merge call raced the retarget. (Oddly, the very next
merge — #249 → #250 — *did* auto-retarget cleanly, so the race is timing-sensitive,
not deterministic.)

**Recovery (chicken-and-egg):** A closed PR can't be reopened while its base
branch is missing, and its base can't be changed while it's closed. Break the
loop by recreating the base branch, then reopen, then retarget:

```bash
git push origin origin/main:refs/heads/fix/wsl-windows-path-handling  # recreate base at main
gh pr reopen 249
gh api -X PATCH repos/<owner>/fleet/pulls/249 -f base=main            # REST, see note
git push origin --delete fix/wsl-windows-path-handling                # now safe to drop
```

Note: `gh pr edit 249 --base main` (GraphQL) repeatedly returned
"Something went wrong while executing your query". The **REST** form
(`gh api -X PATCH .../pulls/249 -f base=main`) succeeded immediately. When the
GraphQL retarget flakes, fall back to REST.

## Symptom 2 — after a squash merge the child PR re-shows the parent's diff + conflicts

**Problem:** Once #249 was retargeted to `main`, it showed **40 files / +1767/-202
across 2 commits** and `mergeable: CONFLICTING` — i.e. the phase-0/2 diff plus the
3a diff, not just 3a.

**Root cause:** A squash merge creates a brand-new commit on `main` and discards
the merge-base relationship to the original feature commits. The child branch
still carries its parent's *original* commits (different SHAs, same content), so
git's merge base falls back to before the parent's work and the diff doubles up,
conflicting against the squashed copy now in `main`.

**Fix:** Rebase each child onto the new `main`, dropping the commits that were
squashed away, before pushing:

```bash
git fetch origin
# replay ONLY commits after <old-parent-tip> onto the new main:
git rebase --onto origin/main <old-parent-commit> <child-branch>
git push --force-with-lease origin <child-branch>
```

`<old-parent-commit>` is the child's original parent (the tip of the branch that
was just squashed). After the rebase the PR diff collapses to exactly that phase's
changes (e.g. #249 → 21 files / +953/-155), and a force-push fires the
`synchronize` event so CI actually runs (a base-only retarget does **not** trigger
CI — the workflow's default `pull_request` types are `opened/synchronize/reopened`,
not `edited`).

## Side notes

- **Stashing across the rebase:** an uncommitted working-tree change (here, two
  intentionally-unstaged files) blocks `git rebase`/`git checkout`. Stash *just
  those paths* (`git stash push -- <paths>`), rebase, `git stash pop` to preserve
  them through every branch switch.
- **`gh pr merge` post-merge checkout error is harmless:** "failed to run git:
  Your local changes would be overwritten by checkout" comes from gh trying to
  switch the local branch *after* the merge already completed server-side
  (`mergedAt` is set). The merge succeeded; only the local convenience checkout
  was skipped.

## Lesson

When landing a stacked PR chain into a squash-merging repo: merge bottom-up, and
after each parent lands, **rebase the next child onto the new `main` with
`--onto`** to drop the squashed commits, then force-push to re-run CI. Don't rely
on `--delete-branch` to retarget children — delete base branches as a separate
step once the child's base is already `main`. Prefer the REST API for retargets
when the GraphQL path flakes.
