## Context

See proposal.md for why.
What exists today, from `add-admiral-agency`:

- One client file per project at `~/.fleet/agency/clients/<project-id>.md`, owned by `ClientFiles` (`src/main/agency/projects/client-file.ts`).
  Fleet-written lines carry a tag, `- Open PRs as drafts. (from starter questions, 2026-10-17)`, parsed by `src/shared/agency-client-file.ts`.
  Hand-typed lines have no tag and are never touched.
  Writes are marked in the store, so an outside change is detected and the Admiral keeps Fleet's last version until the client keeps it.
- `forNote` puts the client file in each turn's note, capped at 8,000 characters.
- `StarterQuestions.tsx` asks four questions, writes lines with `replaceSource: 'starter questions'`, and offers rules from `CLAUDE.md` and `AGENTS.md` via `ruleCandidates`.
- `client_file_propose` puts an add or remove up as a card; nothing is written until the client approves.
- `JobsService.decide` handles approve, edit and reject on plan cards; `approve` runs the pre-approval checks (`approvable`) and hires crew.
- The merge queue (`src/main/agency/results/merge-queue.ts`) merges a job's pull requests in order after their checks pass, when the client clicks Merge.
- `completeOnce` (`src/main/agent/completions.ts`) makes one non-streamed, tool-less, billed completion.
- `readOnlyGit` and the `gh` runner in `src/main/agency/projects/` already read repositories and GitHub without side effects.

Constraints that stay in force: crew run as the unmodified TUIs, Fleet never touches the Claude login or `~/.claude.json`, never writes the Claude config folder, and never reads or sends env file values.

## Goals / Non-Goals

**Goals:**

- Keep Markdown files as the source of truth, so the client can always read and hand-edit what the Admiral knows.
- Put every judgment that needs a model in the Admiral's model, and every rule that gates action (trust, budgets, permissions) in Fleet code.
- Ship in phases that each work alone.

**Non-Goals:**

- Opening the Admiral without a pane, and the job board.
- Changing how crew permission requests are answered.
- Learning from crew transcripts or from the client's Claude Code sessions.
- Syncing preferences between machines.

## Decisions

### 1. The You layer is a second Markdown file, not a database table

`~/.fleet/agency/you.md` uses the same line format and the same `ClientFiles` code path as the project files, including the outside-change mark.
`ClientFiles` takes a layer key (`you` or a project id) instead of a repo id.

Alternative: one table of preference rows.
Rejected: the client could no longer edit the file as text, and the existing outside-change and proposal flows would need a rewrite.

The note gets both layers, You first and the project second, each capped at 4,000 characters, with one sentence that the project layer wins.
Line numbers in the note are prefixed `Y1..`, `P1..` so the Admiral can cite them in `job_plan.uses`.

### 2. Line tags grow a small, fixed set of sources

Sources stay free text in the tag, as in `(from you, 2026-10-18)`, but Fleet writes only these: `you`, `starter questions` (kept for old lines), `CLAUDE.md`, `your commits`, `your review comments`, `your PR descriptions`, `past jobs`, `job j<N>`.
The What the Admiral knows page maps them to labels like "You told me", "Read from your commits" and "Learned on j21"; a hand-typed line with no tag reads "You told me".
Editing a line in the page rewrites it as `(from you, date)` and keeps its use count.

### 3. Use counts, conflicts, declined topics and trust live in the store

The Markdown stays readable; counters and states that change often go in `~/.fleet/agency.db`:

- `preference_uses(layer, norm_text, job_id)`: one row per line per job, written when a plan with `uses` is approved. The count is the number of distinct jobs. `norm_text` is `sameText`'s normal form, and an edit on the page carries the count over to the new text.
- `preference_conflicts(id, layer, norm_text, rule_source, rule_text, status)`: open until the client picks a winner.
- `declined_topics(project_id, topic)`: topics the client answered Just this job on.
- `project_trust(project_id, level, auto_start_usd)`: default Ask me and the project's default job budget.

### 4. Meet you is a fixed question bank in shared code, with no model

`src/shared/agency-meet.ts` holds the seven questions, their layer, their picks, the recommended pick, and the line each pick writes:

1. You: how should I report to you (short, only questions and results; explain my reasoning; step by step).
2. You: what must crew never do (several picks: push to the default branch, edit `CHANGELOG.md` or generated files, add a dependency without asking, force push).
3. Project: how pull requests open (draft or ready).
4. Project: what a job needs before you see it (today's starter question).
5. Project: tests (unit tests with every change; unit, plus end-to-end for UI changes; my call per job).
6. Project: default job budget (today's `BudgetPicker`).
7. Project: when checks pass (Show me the PR, Merge it for me, Ask me each time), which sets the trust level instead of writing a line.

Free text is saved as typed, made one line.
Progress is kept in the store per layer, so Finish later resumes at the next unanswered question.
A project whose onboarding has `starter` done counts its project questions as answered.

Alternative: the Admiral runs the interview as a chat turn.
Rejected: it costs model time before the client has given any work, and the picks are what make it fast.

### 5. Read your work: Fleet collects, the model extracts once, the client decides

Collectors under `src/main/agency/understanding/`, one per source, each returning `{ source, items: string[] }` with fixed caps:

- Instruction files: the project's `CLAUDE.md` and `AGENTS.md` at the default branch tip (the existing repo reader), and `~/.claude/CLAUDE.md`, read only by that exact path.
- Commits: `git log --author=<user.email> -n 100 --format=%s%n%b` through `readOnlyGit`, each message cut to 500 characters.
- Review comments: the viewer's review comments on the project's GitHub repository through `gh api graphql`, newest 100, each cut to 500 characters.
- PR descriptions: `gh pr list --author @me --state all -L 30 --json title,body`, each body cut to 1,000 characters.
- Past jobs: from the store, the client's plan edits as before-and-after step lists, reject notes, and answered questions.

All text goes through the existing `Redactor` and the project's env secrets before it leaves the main process.
The extraction is one `completeOnce` call on the Admiral's model and target, with `reasoning` set low, a fixed prompt, the saved lines of both layers, and the instruction file rules.
It must return JSON validated by zod: `{ lines: [{ text, layer, source, evidence, clashesWith? }] }`.
Lines that `sameText` matches to a saved line are dropped before the client sees them.
The cost is recorded as Admiral spend with no job, and the read is refused while the monthly cap is reached (the existing cap check).

The UI copy says the ticked text goes once to the Admiral's model.
This corrects the design canvas, whose copy said it stays on the Mac: that is only true with a local model.

Alternative: an Admiral turn with read tools.
Rejected: more model time, harder to cap, and the model would choose what to read instead of the client.

### 6. Conflicts come from the model, choices from the client

The extraction prompt gets the instruction-file rules and flags `clashesWith` per proposed line.
Learn proposals may name a clashing rule the same way.
A kept line with a clash opens a `preference_conflicts` row.
When the line wins, the note marks it `(overrides CLAUDE.md)` and the prompt tells the Admiral to say so in crew briefs.
When the rule wins, the line is removed.

### 7. Learn from you extends client_file_propose and the wakeups

Fleet enqueues a wakeup for the job's Admiral after a client plan edit or reject, with the before-and-after steps or the reject note and the line "Consider whether this is a lasting preference".
Answers to questions already reach the Admiral as wakeups.
`client_file_propose` gains `topic` (a short key, like `e2e-tests` or `reviewer-model`) and `layer` (`project` or `you`, the Admiral's suggestion).
The card becomes a Remember this? card: the line, editable, and This project, All projects, Just this job.
Fleet refuses a proposal whose topic is in `declined_topics` for the project, and a second open proposal with the same topic.
The card is a job question, so closing the job withdraws it, as for every other question.

### 8. Trust levels are enforced by Fleet, not the Admiral

When the Admiral calls `job_plan` and the project is at Show me the PR or Ship it, `JobsService` runs the same `approvable` checks the client's Approve runs.
It approves on its own only when they pass, the budget is within `auto_start_usd` and the project's default Claude share, the plan adds no new role, and no step needs a client tick (eva caps).
Otherwise the plan card shows as today.
An auto-approved plan logs "Started on its own", and its card shows Stop and Change instead of Approve.

Under Ship it, when a job reaches `delivered` and every deliverable is a pull request, Fleet starts the merge queue as if the client clicked Merge.
When the queue merges all of them, Fleet accepts and closes the job and posts a report card.
When the queue stops, the job stays delivered and waits for the client, as today.

The trust level is only in Fleet code paths, never in the prompt as permission, so a model cannot raise its own trust.
The prompt is told the level only so it can describe what will happen.

### 9. `job_plan.uses` drives the payoff

`PlanSchema` gains `uses: string[]` (line ids from the note, at most 20).
Unknown ids are dropped with a note to the Admiral, never an error.
The plan card and the job sheet show the cited lines as chips under "Using what I know about you".
The canvas's "3 questions I did not need to ask" count is left out: Fleet cannot count questions that were never asked.

## Risks / Trade-offs

- [The extraction proposes lines the client never meant] → Every line needs a Keep, and each shows its evidence.
- [Review comments or commits contain secrets] → Redactor and env-secret masking run before sending; collectors never read files other than the named instruction files.
- [Auto-start runs a plan the client would have changed] → Default trust is Ask me; Show me the PR only starts plans within a budget the client set; the card keeps Stop and Change.
- [Ship it merges something bad] → It merges only pull requests whose required checks pass, through the same queue the client's Merge uses, and stops on any failure.
- [Two layers overflow the note] → Each layer is capped at 4,000 characters, and the existing cleanup proposal runs per layer.
- [The You file is edited outside Fleet] → The same outside-change mark and Keep flow as the project files.

## Migration Plan

- Existing client files keep working: their lines and tags are unchanged, and `starter questions` stays a known source.
- Projects with `starter` done skip the project questions of Meet you; the You questions are offered once on the next Admiral open.
- New tables are created by the store's migration; `project_trust` rows default to Ask me, so behavior does not change until the client picks a level.
- When `add-admiral-agency` is archived, its "Starter questions" requirement should be removed from the archived spec in favor of Meet you, and its "Client file" requirement should point at this capability for the You layer.
- Rollback: the Markdown files are readable by the old code; the new tables are ignored by it.

## Open Questions

- eva's global instruction file path, if eva gains one, as an extra Read your work source.
