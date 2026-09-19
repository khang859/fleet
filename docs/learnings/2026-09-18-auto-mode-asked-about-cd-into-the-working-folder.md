# Auto mode kept asking about commands that stayed in the working folder

## Symptom

With auto mode on and Jev as the check model, the agent still stopped on permission cards.
The card said "Runs somewhere other than the working folder".
The command was `cd /Users/khangnguyen/Development/fleet && …`, which is the working folder itself.

## Cause

`alwaysAskReason` flagged a `cd` to any absolute path as leaving the folder.
It had no `cwd`, so it could not tell the working folder from `/`.
An always-ask reason never reaches the auto-mode model, so the user's note ("fine to run somewhere else") could not help.

The same `cd` part also blocked allow rules: `cd <folder> && gh pr diff` never matched the `gh pr` rule, because no rule matched the `cd` part.

A real hole was next to it: a bare `cd`, `cd -` and `cd $VAR` counted as staying, so `cd && rm -rf src` (which runs in home) was not flagged.

Jev itself was fine.
Live calls took 0.2-0.9s and returned sensible choices with probabilities.
The three 20s timeouts in the log were a short outage on the endpoint.

## Fix

- `decideCommand` and `alwaysAskReason` take the `cwd`, and `isOutside` counts the folder and paths inside it as inside. A `..` anywhere still counts as leaving.
- A `cd` part that stays inside the folder is dropped before allow rules are matched.
- A `cd` with no target, `-`, or a variable counts as leaving.

## How it was found

- The session log showed the model prefixing five commands with `cd <cwd> &&`.
- The permission reason string pointed at the one rule that produces it.
- A direct call to the Decisions endpoint with the user's settings ruled out Jev.

## Lesson

A rule about "outside the folder" has to know where the folder is.
Check what reaches the auto-mode model before blaming the model: an always-ask rule answers first.
