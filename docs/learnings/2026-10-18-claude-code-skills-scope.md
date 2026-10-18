# Which skills a crew member loads depends on where it starts

## What happened

The Admiral could tell crew to use a repo's skills, but we did not know which skills a crew member actually sees.
A workspace project has member repos, and each crew member starts in one folder.

We tested Claude Code 2.1.302 by hand in Fleet panes:

- It loads `.claude/skills` from its start folder and each folder above it, up to the repo root.
- It stops at a nested repo boundary. A worktree inside another repo got none of the outer repo's skills.
- It loads `.claude/skills` in folders below the start folder only after the session works on files there. A name clash then shows as `<dir>:<name>`.
- Starting in a submodule shows the folder trust prompt, even when the umbrella folder is trusted.

eva's source shows the same rule: it reads `.eva/skills` and `.agents/skills` from the working folder up to the nearest folder that holds `.git` (a `.git` file counts), then its home `skills` folder.

The plan checks only checked trust for the project root, so a step that starts in an untrusted submodule passed the check and then stopped at the trust prompt.

## Fix

The Admiral's crew note lists each member's root-level skills, per runtime, read at the default branch tip.
A plan step names the skills it uses, and the plan check warns when the step's start repo and runtime do not have that skill.
The trust check now gives one issue per untrusted folder a Claude step starts in, members included, each with its own "Open Claude Code" button.

## Rule

Never assume a crew member sees skills from a parent repo or from a sibling member.
Check skill and trust facts against the one folder the crew member starts in.
Test tool loading rules by hand before building on them, since the docs do not cover nested repos.
