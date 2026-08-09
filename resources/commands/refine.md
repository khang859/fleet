---
name: refine
description: Look back over this session and write down what is worth keeping
---

Look back over the conversation you are in and record the few things a future session would otherwise have to learn the hard way.

Everything before this message is the evidence.
You do not need to go and fetch it, and there is nothing to search: it is already behind you.

If `$ARGUMENTS` says anything, treat it as a steer about what the user thinks was worth keeping.
It sharpens where you look first.
It does not lower the bar below, and it does not license writing something you cannot point at.

Writing nothing is a correct and common outcome.
Most sessions teach nothing durable, and a session that produced a working change is not the same as a session that produced a lasting fact.

## 1. Read the session as evidence

Go back through the conversation and collect candidates.
A candidate is something you can point at: a moment where you were wrong and were corrected, where a command failed for a reason that was not obvious, where the user told you how they want something done, or where you spent real effort establishing a fact about this project that was not written down anywhere.

Point at each one.
For every candidate, name the specific turn or tool call it came from before you go any further.
If you cannot say where it happened, it is not a candidate - it is a plausible thing you believe about this project, and those are exactly what should not be written down.

**If this conversation opens on a summary of an earlier one rather than on its own first message, say so, and treat only the part you can actually see as evidence.**
A summary tells you that something happened, not what was said.
Do not attribute a quote, a command, an error message or a correction to a part of the session that has been compacted away.
It is better to write one entry from what you can see, or none, than to write three from a reconstruction.

## 2. Decide what each candidate is

Three outcomes, and most candidates get the third.

**A memory** is a durable fact about this project or this user.
Something true before this session and still true after it, that cost you something to find out.

**A skill** is a procedure: a sequence somebody has to follow to get a particular job done here.
If what you want to write reads like a checklist, it is a skill, not a memory.

**Neither**, which is the usual answer.
Discard a candidate if it is:

- a fact `read` or `grep` answers in one call, because a note that duplicates a file goes wrong the moment the file changes and nobody updates the note;
- a preference the user stated in this conversation, because it is already in the transcript and this session can still see it;
- an account of what you just did, because that is what the transcript is;
- a state rather than a fact - which test is failing today, which version is current, which branch is checked out - because that will be wrong within the week and nothing will notice;
- something you are only fairly sure about.

The test for what survives: if this note were gone, would the next agent working here pay roughly what you just paid to find it out again?

## 3. Check each survivor before you believe it

You are about to write something down that nothing will re-check for months.
So check it now.

If a survivor claims something specific about the code - a path, a command, a flag, a file that behaves a certain way - go and confirm it against the repository as it is right now.
A claim that turns out to be wrong is dropped, not softened.
A claim that turns out to be true in a narrower way than you remembered is written in the narrower form.

## 4. Look at what is already recorded

The `memory` tool's description lists every entry that already exists.
Read it before writing anything.

If a survivor is already recorded and still right, do nothing with it.
If it is recorded and wrong or out of date, read that entry and write over it under the same name - that is how a wrong entry gets corrected, and the change stays visible in this conversation.
If it is close to an existing entry but genuinely different, prefer rewriting the existing one to cover both over leaving two entries that half overlap.

## 5. Write

Use `memory_write` for a fact and `skill_write` for a procedure.

Choose the tier deliberately.
`project` is for facts about this codebase, and it lands in the repository where anyone who opens it will read it.
`user` is for how this person works, and it follows them into every project.
A fact about this repository does not belong in the user tier, and a preference of the user's does not belong in the project one.

Keep each entry short.
The description is one line and it is the only thing a future session sees before deciding whether to read the rest, so write it as the reason to open the note rather than as a title.
The body is the fact and the reason it matters, not an essay around it.

Two or three entries from a long session is a lot.
If you are writing five, look again at the ones you are least sure of.

## 6. Report

Say plainly what you did, in a few lines.

For each thing you wrote: the name, the tier, whether it was new or a rewrite, and the one thing in this session that earned it.
Name that evidence specifically - the correction, the failure, the thing the user said.

If you wrote nothing, say that, and say what you considered and why it did not qualify.
That is a real answer and the user asked for it.
