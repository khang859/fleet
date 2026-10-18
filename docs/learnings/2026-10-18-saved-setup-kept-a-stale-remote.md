# A saved setup kept a stale remote

Date: 2026-10-18
Found while: task 3.27 of `add-admiral-agency` (the end-to-end run with linked PRs)

## What happened

The fixture workspace was set up before its repositories had a remote on GitHub.
Later, `origin` was added to the umbrella and to each member.
"Set up journey again" still showed every member as not on GitHub.
`projects.scan()` let the saved setup win for each member it already had, and the saved member held `remote: null`.
So the Admiral would plan local branches, not pull requests.

## Fix

`scan()` still takes the saved member, but always takes `remote` from the fresh findings.
A test adds `origin` after the setup is saved and checks that the next scan shows it.

## Rule

A saved setup holds the client's choices.
Facts that the repository owns, such as its remote, are read fresh each time and are never saved over.
