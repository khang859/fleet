## Context

See proposal.md for why.
What exists today:

- Roles load from three folders, most specific wins: bundled, `~/.fleet/crew/`, and the project's `crew/` (`src/main/agency/crew/catalog.ts`).
  `saveRole` writes a role from Settings, saving a bundled role as the user's copy.
- An approved plan snapshots the roles its steps use (`CrewSnapshot`), so a running job never sees an edit.
- `exportJob` (`src/main/agency/jobs/job-export.ts`) renders a whole job record as Markdown: brief, plan versions with the client's notes, steps, questions, permissions, results and the log.
- Read your work (`src/main/agency/understanding/`) makes one billed completion on the Admiral's model through `AdmiralCompletion`, behind `reserveAdmiralCall`, with secrets masked.
- `client_file` cards hold their change in `questions.data_json`, and `declined_topics` remembers what the client turned down.
- `CleanupRunner.run` ends a closing job with `finishClose` once its resources are cleaned.

## Goals / Non-Goals

**Goals:**

- Default to no lesson, and keep a lesson only when the job's own record supports it.
- Gate every write in code, and let the client approve every write.
- Keep roles short: a lesson must not grow a role without limit.

**Non-Goals:**

- Lessons for playbooks. Their steps are frontmatter, and a lesson that adds a step is a plan change, not a sentence.
- Reading crew transcripts. The job record already holds crew reports, notes, permissions and the client's plan changes.
- Running two crew members on one step and comparing them.
- A setting to turn reviews off. The monthly cap already bounds the spend, and the review costs one call per job.

## Decisions

### 1. Fleet runs the review, not the Admiral's thread

The review is one completion with a fixed prompt, like Read your work.
The Admiral's thread would need a new tool and a turn after the job is gone, and its answer could not be checked before it reached the client.
A fixed prompt with a JSON answer is checked in code, retried once, and tested without a model.

### 2. It starts when cleanup ends the job

`CleanupRunner` gets a `closed(jobId)` callback, called after `finishClose`.
So the record is complete, the review runs once per job, and a job a quit left closing is reviewed when cleanup resumes at the next launch.
A job that never ran a crew member is skipped: there is nothing to learn about the crew.

### 3. The evidence is the job record

The request holds:

- the job's `exportJob` Markdown, cut to 40,000 characters, with env file values and credentials masked;
- each role the job's crew ran with, as the snapshot had it, and the role's text now when it changed since;
- the lessons the client turned down on this project.

The prompt follows Harness²'s reflector rules:

- "No lesson" is the default answer.
- One event is a guess. A lesson needs the record to show the same problem more than once, or the client to say it, in a plan note, a rejection or an answer.
- A lesson is about how a role works, not about this job's code. A fact about one repository belongs in the client file, not in a role.
- Replace a sentence that is wrong rather than add one. If you add text, cut text that no longer earns its place.

### 4. A lesson is one text replacement in one role

The answer is `{"lesson": null, "why": "..."}` or:

```json
{
  "lesson": {
    "role": "builder",
    "cue": "When the project has a lint step",
    "lesson": "Run lint before opening the PR.",
    "evidence": "The review step sent back lint errors on both PRs.",
    "replace": "Run the project's tests.",
    "with": "Run the project's tests and lint before you open the PR."
  }
}
```

`replace: null` appends `with` as a new paragraph.
Fleet keeps the lesson only when:

- the role is one the job ran, and the catalog still has it;
- `replace` is in the role's current text exactly once;
- `with` is not empty, the role grows by at most 600 characters, and the new text fits `NEW_ROLE_MAX_CHARS`;
- `cue` and `evidence` are not empty;
- the client did not turn down the same role and cue before.

A failed check sends the reason back once, as "Your answer was refused: ...".
A second failure, a model error, or a reserved cap drops the review with a log line.

### 5. The card is a `crew_lesson` question on the Bridge

The job has ended, so the card goes to the project's Bridge (`jobId: null`).
Its data is the lesson, plus the job it came from and the role's source when the card went up.
It is Fleet's card, not the Admiral's, so answering it wakes no Admiral turn.

| Role source | Options                             |
| ----------- | ----------------------------------- |
| project     | Change it, Not now                  |
| user        | This project, All projects, Not now |
| bundled     | This project, All projects, Not now |

A project has at most one open `crew_lesson` card; a review that finds one open skips the model call.

### 6. Applying a lesson re-reads the role

On approval, Fleet reloads the catalog and applies the replacement to the role's text now.
If the replaced text is gone, the answer is refused, and the card says the role changed.
This project writes `<project>/crew/roles/<name>.md`; All projects writes the user's copy; Change it writes the project's own file.
Every write goes through `writeFrontmatterFile` with `RoleFrontmatter`, so a bad file is never saved.
Not now records the topic `crew-lesson:<role>:<cue>` in `declined_topics`.

## Risks / Trade-offs

- **The model proposes a weak lesson.** The client still decides, and the evidence line shows why.
- **A project copy hides later edits to the user's role.** This is how project roles work today; the option's detail says it saves a copy for this project.
- **Cost.** One call per job that ran crew, inside the monthly cap.
