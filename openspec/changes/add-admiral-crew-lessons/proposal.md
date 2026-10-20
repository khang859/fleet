## Why

The Admiral learns how the client likes work done, but it never learns how its crew should work.
A role file says the same thing on the hundredth job as on the first, even when the same step went wrong on every job.
The client has to notice the pattern, open Settings, and fix the role by hand.

Google Research's Harness² (https://github.com/google-research/harness2) shows a cheap way to close this loop without ground truth.
After each task, a reflector reads what happened and records at most one lesson, and only when the run's own record supports it.
"No lesson" is the default, and an edit that only one run supports counts as a guess.
This change brings that step to the Admiral, with the client approving every change, as Remember this? cards do today.

## What Changes

- **A review after each job.**
  When a job that ran crew ends (accepted, cancelled or failed), Fleet sends its record and the role files its crew ran with to the Admiral's model, once.
  The model proposes at most one change to one role, or none.
- **Evidence or nothing.**
  A lesson names the cue, the change, and what in the record shows it.
  Fleet checks it in code: the role exists, the text it replaces is in the role word for word, the role grows by at most 600 characters and stays within the role limit, and the client did not turn the same lesson down before.
  A lesson that fails a check gets one retry with the reason, and then Fleet drops it.
- **A card on the Bridge.**
  "Teach the builder role?" shows the cue, the evidence, and the text struck out and added.
  The client picks This project or All projects, or Not now.
  A role the project owns offers Change it or Not now.
  Ignoring the card changes nothing.
- **Small, safe writes.**
  An approved lesson edits the role file through the same path as Settings > Agency > Crew.
  A bundled role is never changed: All projects saves the user's own copy, and This project saves the project's copy.
  A job keeps the crew it was approved with, so a lesson reaches only later jobs.
- **One card at a time.**
  A project has at most one open lesson card, so lessons cannot pile up.
- Not in this change: lessons for playbooks, reading crew transcripts, and trying two crew members on one step.

## Capabilities

### New Capabilities

- `admiral-crew-lessons`: after a job ends, Fleet proposes at most one evidence-backed change to a crew role, and the client approves it.

### Modified Capabilities

None.

## Impact

- `src/main/agency/lessons/` (new): the review, its prompt, the checks, and applying an approved lesson.
- `src/main/agency/cleanup/cleanup-runner.ts`: tell the service when a job has ended.
- `src/main/agency/index.ts`: run the review, answer the card.
- `src/shared/agency.ts`, `src/main/agency/store/`: a `crew_lesson` card kind and its data.
- `src/renderer/src/components/admiral/QuestionCard.tsx`: show the lesson.
- `docs/admiral.md`: a Crew lessons section.
- One Admiral model call per job that ran crew, inside the monthly cap.
