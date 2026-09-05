# Release workflow in the managed sandbox

## What happened

The first release attempt was based on a stale local checkout, while `origin/main` had already advanced through v2.113.0 and contained the next unreleased feature. The sandbox also blocked `tsx`'s IPC socket, Git's `.git/index.lock`, and the local sockets used by the integration tests.

## Fix

Fetch and compare `origin/main` before selecting the version, rebase unpublished release work onto the current base, and use minimal elevated execution for release-note extraction, Git metadata operations, and tests that need local sockets. Preserve unrelated untracked files throughout.
