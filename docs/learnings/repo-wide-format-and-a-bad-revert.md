# A repo-wide format, then a revert that took my own edits with it

## What happened

I ran `npm run format` to format the files of one change.
It runs Prettier on the whole repository, so it rewrote about 93 files the change never touched.

I then tried to restore only those other files with `git checkout`.
The filter that was meant to skip my own files did not match them, so all 105 modified files went back to HEAD.
Every edit to an existing file was lost.
Only the new, untracked files survived.

## The fix

I applied the lost edits again, one by one, from the notes I had.

## How to avoid it

- Never run `npm run format` for one change.
  Format only the files you changed:

  ```bash
  (git diff --name-only; git ls-files --others --exclude-standard) \
    | grep -E '\.(ts|tsx|md)$' | xargs npx prettier --write
  ```

- Before a `git checkout` of many files, print the list it will restore and check that your files are not in it.
- Better still, run `git stash` or commit work in progress before any command that rewrites many files.
