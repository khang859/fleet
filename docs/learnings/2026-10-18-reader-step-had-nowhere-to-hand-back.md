# A review step had nowhere to put its review notes

## What happened

In job j9 of the `journey` test project, the bundled bug-fix playbook ran `review` with `workspace: { of: fix }`.
Fleet's brief told the reviewer: "This worktree is step fix's. Read and run it, but change and commit nothing."
The bundled reviewer role told it to write the findings to `docs/admiral/<job>-review.md` on its branch.
It could not do both.
The brief also never said that the step hands back "Review notes", so the reviewer handed back no file.
The Admiral then could not deliver the step, and the job could not finish.

## Fix

`stepBrief` now lists what the step hands back, by label and kind.
For a file kind, it says to pass each file to `fleet agency done --deliver <path>`.
A step that reads another step's worktree and hands back files gets a hand-back folder, `<job folder>/handback/<step>`.
Fleet makes the folder, names it in the brief, and passes it to Claude with `--add-dir`.
`job_deliver` takes paths in the job folder, so the files reach the client.
The reviewer and qa roles now name that folder as the place to write when the worktree is another step's.

## Rule

When the brief forbids something, check that the role text and the deliverables still leave a way to finish the step.
The role says "your brief names what the step delivers", so the brief must name it.
