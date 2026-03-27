# Learnings: Release Tag Race (2026-03-21)

## Parallel `git commit` and `git tag` can mis-tag a release

**Problem:** While preparing the `v2.3.2` release, the release commit and tag were created in parallel. The tag landed on the previous `HEAD` commit instead of the new version-bump commit, which would cause the release workflow's version check to fail.

**Root cause:** `git tag v2.3.2` resolved `HEAD` before `git commit` finished. Running those commands concurrently introduced a race on which commit `HEAD` pointed to at tag creation time.

**Fix:** Run release git steps sequentially:

1. Commit the version bump
2. Verify `HEAD`
3. Create the tag on that exact commit
4. Push branch and tag

If the tag is already wrong, delete and recreate it locally on the correct commit, then force-push the corrected tag.

**Lesson:** Do not parallelize dependent git release operations. Tags that are meant to trigger CI/CD should always be created only after the target commit exists and has been verified.
