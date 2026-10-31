# Lines typed ahead into a terminal go to the running command

PR #712 started a worktree's agent by typing `setup\nagent` into the new shell at once.
That looks like a sequence, but nothing waits between the lines.

## What happened

The second line sat in the terminal's input while the first line ran.
A setup that reads stdin took it as its answer.
With `head -n 1 > answer.txt` as the setup, the file held `touch agent-ran.txt`, and the agent never started.
A setup that flushes pending input can also discard the line.

## The fix

`typeWhenReady` in `src/main/pty-manager.ts` now types one line at a time.
Each next line waits until `proc.process` is the shell again and the output is quiet.
Ctrl+C in `PtyManager.write` drops the lines not typed yet, so stopping a setup does not start the agent.

## Limits

`proc.process` gives only a name.
A setup line that runs a program with the shell's own name looks finished once it goes quiet.
A shell builtin like `read` also looks finished, because the shell stays in the foreground.
Windows and WSL report one name throughout, so quiet alone decides there.

## Testing it

A fake PTY cannot show this bug.
`src/main/__tests__/type-when-ready.real-shell.test.ts` uses a real shell, and it fails on the old code.
A new zsh pane took about 2 seconds to start in the dev app, so a drive script must wait for the typed line before it sends an answer.
