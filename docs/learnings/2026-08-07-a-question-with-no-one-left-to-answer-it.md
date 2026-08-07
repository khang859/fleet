# Learnings: a question with no one left to answer it (2026-08-07)

## The bug

Subagents outlive the turn that dispatched them - that is the point of them.
A pane whose turn has ended can therefore be switched to another session, or closed, while a child is still running.

Both halves of the permission path assumed the pane was still there:

1. A question arriving **after** the switch found no thread to place it on and was dropped.
2. A question that had arrived **before** the switch was sitting in `thread.taskPermissions`, and `claimSession` replaced the thread with `EMPTY_THREAD` - taking the question with it.

Either way the child was left blocked on an answer that could no longer be given.
It held its slot for the rest of the session, with no process running and nothing on screen to say so.
The user's symptom is not an error, it is a subagent that never comes back.

## The rule

**A blocking question needs an owner at every moment, so every path that removes the owner has to answer the question - not forget it.**

The audit is mechanical once the shape is named: find the state that holds an outstanding request, then find every path that discards that state.
Here that was two paths, `claimSession` and `disposePane`, and only one of them routes through the other.

Fail-closed is the answer, not fail-open: `outcome: 'no'` refuses the one command the child happened to be stopped on, which it can report and carry on from.
`PermissionGate.refusePending` already makes exactly this bargain when the window reloads; the renderer just was not making it on the paths the renderer owns.

## The second-order bug behind it

The same "the pane moved on" case had another leak: `finishTask`'s not-found branch persisted the child's report but not its spend.
A child that ran for minutes after its pane was closed was still billed, and the total silently skipped it - wrong on exactly the sessions that used subagents most.

Fixed main-side (`AgentSessionStore.addSpend`), not in the renderer, because the total is cumulative and only the file holds it: two children finishing at once would race a read-modify-write done anywhere else, and the pane may not have the session open to add to.

## How it was found

By using the app, not by review and not by the tests.
The reproduction is a subagent slow enough to still be running after the turn ends (`sleep 45 && git status --short` asks for permission and then takes long enough to switch away from), then `startNewSession` on its pane.
The tell in the dev log is a `permission ask` line with no thread that could show it - and, after the first half of the fix, an ask with **no** matching refusal line, which is what proved the second half was still missing.

Tests written from the first symptom will only cover the first path.
Re-run the end-to-end after the fix and read the log for the *absence* of the line you expect, not just the presence of the one you added.
