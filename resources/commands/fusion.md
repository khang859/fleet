---
name: fusion
description: Review a change with a panel of models and reconcile what they say
---

Put a change in front of a panel of models, and report what they agree on, what they disagree about, and what only one of them saw.

The argument is `$ARGUMENTS`.
Read it as the scope of the review: a branch name, a commit range, a path, a question to focus on, or nothing at all.
Nothing at all means the uncommitted work in this folder.

This runs `openrouter:fusion`, which is offered on this turn only.
It costs a full model call per panel member plus one more for the analyst, so it runs once.

## 1. Work out what is under review

Find the change before you describe it.

- No argument: `git status --short` and `git diff HEAD`. If the working tree is clean, use `git diff @{u}..HEAD` for the commits this branch has that its upstream does not.
- A branch or a range: `git diff <range>`.
- A path: the diff limited to it, and the file itself if it is new.

If the diff is empty, stop and say so. There is nothing to review and a panel called on nothing still bills.

## 2. Gather what the panel needs

The panel cannot see this folder.
Every model on it reads one string, which is the string you are about to write.
Anything you leave out is something eight models will guess at.

Collect:

- The diff in full. Do not summarise it and do not trim it to the interesting parts - deciding which parts are interesting is the review.
- The current contents of the files the diff touches, where the diff alone does not show enough of them to judge.
- The callers and the callees the change depends on. A function whose signature changed is not reviewable without the places that call it.
- The project's own rules: the repository instruction file if there is one, the checks that have to pass, the conventions the surrounding code follows.
- What the change is for. The commit messages, the branch name, the issue it references, or what the user said.

## 3. Call the panel once

Write the prompt as a self-contained brief.
State what the change is meant to do, then the constraints, then the material, then the question.

Ask for what a panel is good for and a single reviewer is not: correctness under inputs the author did not consider, assumptions the change makes that the rest of the codebase does not hold, and the failure the diff makes possible rather than the style it is written in.

Then call `openrouter:fusion` with it.

## 4. Report what came back

Write the review yourself. Do not paste the tool result.

Lead with the disagreements and the single-model findings, because those are what one reviewer would have missed.
For each finding worth keeping, say where it is - `path:line` - and what actually goes wrong, in terms of an input and an outcome.

Then say what the panel agreed on, briefly.
Then say what the analyst called a blind spot, if it named any, and whether you think it is right.

If the panel answered but the analyst did not, report the panel's answers and say the reconciliation is missing.
If some models failed and others answered, review from the ones that answered and say how many were lost - a panel of two is still a review, and it is not the review the user asked for.
If the whole call failed, say why in one line and do not call it again.

End with your own judgement.
The panel is evidence, not a verdict, and you are the one who can read the repository.
Say which findings you checked and which you are passing on unverified.
