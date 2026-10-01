# The cwd poller must keep running after OSC 7

## What happened

A tab opened in the home folder kept the name `knguyen`, and its pane header kept `~`, while `cd ~/Development/fleet && claude` was running in it.
The name only caught up after Claude exited.

## Why

A pane learns its shell's folder two ways: OSC 7 from the shell, and `CwdPoller` reading the shell process's folder every 5 seconds.
The poller stopped itself for good the first time it saw OSC 7, on the assumption that the shell would report every move from then on.
A shell only sends OSC 7 from its prompt hook.
`cd project && some-long-command` changes the folder and does not return to a prompt, so nothing reported the move.

## Fix

`CwdPoller` now polls for the life of the pane.
What made stopping attractive was that the two sources can name the same folder differently: the process's folder has symlinks resolved, and the one from OSC 7 may not.
Comparing them as strings would swap the shell's path for the resolved one on every poll, and the next prompt would swap it back.
So the poller resolves the known folder with `realpath` first, and emits `cwd-changed` only when the shell is really somewhere else.

## Rule

OSC 7 is a report at prompt time, not a live feed.
Do not retire a fallback because a better signal appeared once; make the two agree instead.
When comparing a path from the shell with one from the OS, compare resolved paths.
