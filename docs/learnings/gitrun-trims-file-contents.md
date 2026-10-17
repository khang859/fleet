# GitRun trims stdout, so it cannot read a file

## What happened

Admiral setup imports crew files from a repository's default branch by reading them out of git's object store.
The first version read them with the shared `GitRun` helper (`git show <ref>:<path>`).
"Share with team" then copied the imported file back into `.fleet/`, and `git status` showed `M .fleet/crew/roles/qa.md` on a file nobody had edited.

`GitRun` trims its stdout, which is right for `rev-parse` and `remote get-url` and wrong for file contents.
The imported copy had lost its trailing newline, so it differed from the committed file by one byte.

## The fix

File contents go through their own reader, `readBlob` in `src/main/agency/projects/repo-reader.ts`, which runs `git -c core.fsmonitor=false cat-file blob <ref>:<path>` and returns stdout untouched.
`GitRun` stays for one-line answers.
The share test asserts `git status --porcelain` lists only the new setup file, which catches a changed byte in any copied file.

## Also: a read-only scan must turn fsmonitor off

`core.fsmonitor` in a repository's own config names a program that git runs on `git status` and friends.
A scan that promises to run no repository code passes `-c core.fsmonitor=false` on every git call.
The no-side-effects test plants an fsmonitor trap and proves it is live, and its own `git status` checks need the same flag or they spring the trap themselves.
