---
name: implement
description: Build a feature end to end, from research to a verified change
---

Build something the user asked for, from understanding the request to a change that passes the checks this repository already runs.

The order matters more than any single step in it.
Reading and planning are the cheapest part of this and the part that decides how the rest goes, so do not skip ahead to the first file that looks like it needs editing.

## 1. What was asked

The request is `$ARGUMENTS`.

It may be a sentence, a paragraph, an issue number, a URL, or nothing at all.
Nothing at all means the user is going to tell you in their next message: say what this command does, ask what they want built, and stop.
A bare number, or a URL ending `/issues/<n>`, is an issue - read it with `gh issue view <number>` and treat its body as the request, and its comments as context that may be out of date.

## 2. Understand the repository first

Read what the project says about itself before you read its code.
The root `CLAUDE.md`, any `CLAUDE.md` beside the area you will be working in, and `README.md` if one is there.
These carry conventions you cannot infer from a single file, and a change that reads well on its own but breaks a house rule is a change that gets sent back.

Then find the work.
Dispatch `explore` subagents with `task`, all in one message so they run at once, one per question you actually have.
Good questions are the ones whose answer is short and whose search is long:

- Where does the thing being changed live now, and what calls it.
- How does the nearest existing feature of the same shape do it, end to end.
- Where are the tests for this area, and what do they look like.
- What is the extension point - the registry, the switch, the folder of files - that a new one of these is added to.

Fleet runs at most five subagents at once across the whole app, so a dispatch can come back refused.
That is a queue, not a failure: keep the ones you got, and send the rest once one has reported.

Read a subagent's report as a claim and open the files it names yourself.
You are about to write code against what it says, and it did not.

Scale this to the request.
A one line fix does not need four subagents, and sending them anyway spends the user's money to tell you what one `grep` would have.

## 3. Ask what you cannot answer

Now, before any design and long before any code, name what the request does not say.

The things worth asking about are the ones where two reasonable readings lead to two different implementations:
what happens in the failure case, what the thing is called and where it appears, whether existing data or existing callers have to keep working, what is deliberately out of scope.

Ask them together, as a short list, and stop for the answer.
Do not ask about anything the code already answers - "does this project use TypeScript" is a question you had the tools to settle.
Do not ask about anything where one option is obviously right; make the call and say you made it.
If nothing is genuinely unclear, say so in a line and carry on.

## 4. Plan, then stop

Write the plan into the conversation as prose the user can read and argue with.
It says: what you are going to change, in which files, in what order, and how you will know it worked.
Name the real paths.
A plan that says "update the relevant components" is not a plan, it is a promise to decide later.

Say what you are not doing, and why, when the request could reasonably have included it.
If you found a simpler way to get what the user wants than the way they described, say that here rather than silently doing either one.

Then stop.
End your turn.
Do not call another tool, do not start on the first step because it seems safe, and do not ask a question whose answer you plan to assume.
This is the only checkpoint in this command: everything after it changes files, and the user gets one chance to redirect it before that happens.

Carry on when they answer, with whatever they changed folded in.

## 5. Build it

Keep a task list as you go, with `todo_add` and `todo_update`, so the user can see where you are.

Where the area you are changing already has tests, write the failing test first, then make it pass.
The point is not ceremony, it is that a red test turning green is the one signal you can act on without asking.
Where the area has no tests - a pane of UI, a wiring change, a script - do not invent a suite to have one.
Find another way to check yourself, and say in the report what that way was.

Follow the code that is already there.
Match its naming, its file layout, its error handling, and its comment density, even where you would have done it differently.
The nearest existing feature of the same shape, the one you read in step 2, is the pattern to copy.

Change what the work needs and nothing else.
Do not reformat, rename, or improve code you happened to be reading.
If your change leaves something behind - an import nothing uses now, a helper with no callers - remove that, because you made it dead.
If you find dead code you did not make, mention it and leave it.

The user's uncommitted work is theirs.
Do not revert it, do not stash it, and do not commit anything at all.

## 6. Make it green

Find the checks this repository runs, do not guess at them.
`CLAUDE.md` usually names them outright, `package.json` scripts and the CI workflow have the rest.
Run the type check, the linter, and the tests, and run them from the repository root the way a person would.

Fix what you broke until they pass.
A test that was already failing before you started is not yours to chase: say it was already red, and leave it.
Never make a check pass by weakening it - deleting the assertion, widening the type, skipping the test - and if the only way through is to change what a test expects, stop and say why you think the old expectation was wrong.

If the change is something a person sees, look at it rather than reasoning about it.
Most projects that can be looked at say how in `CLAUDE.md` or `README.md` - a dev server, a story, a screenshot script.
Use what the project gives you if it gives you anything, and if it gives you nothing, say in the report that you did not see it run.

## 7. Review your own change

Once it is green, dispatch a `review` subagent over the diff.
Your work is uncommitted, so tell it to read `git diff` and name the files you touched, along with what the change was meant to do.
Give it nothing else - it can read the code itself, and it has its own context to spend on doing so.

Then change sides on what comes back.
Your default verdict on each finding is that it is wrong, and you keep it only when you can open the file, quote the line, and name the input or sequence that makes it actually happen.
Its confidence carries no weight.

Fix what survives, and re-run the checks.
Say what you fixed in the report rather than quietly folding it in, because a bug you wrote and caught is worth the user knowing about.

## 8. Report

Say, in this order:

- What you built, in a sentence.
- The files you changed and what each change does.
- Which checks you ran and that they passed, naming the commands.
- Every decision you made that the user did not make for you, and what you would have needed to know to decide it differently.
- What you deliberately left out.

Do not paste the code back; the user is looking at the diff.
Do not commit, and do not open a pull request.
The change is sitting in their working tree, which is where they decide what happens to it.
