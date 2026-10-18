## 1. Phase 1: the You layer and What the Admiral knows (one PR)

- [x] 1.1 Make `ClientFiles` take a layer key (`you` or a project id), with `you` at `~/.fleet/agency/you.md` and the same outside-change mark; verify with new cases in `src/main/agency/projects/__tests__/client-file.test.ts` for read, write, merge and outside change on the You layer.
- [x] 1.2 Add the fixed source labels and an `editLine` / `removeLine` / `addLine` helper to `src/shared/agency-client-file.ts`, where an edit rewrites the tag to `(from you, date)` and hand lines stay untouched; verify with unit tests in `src/shared/__tests__/`.
- [x] 1.3 Put both layers in the turn note, You first, each capped at 4,000 characters, lines prefixed `Y1..` and `P1..`, with the sentence that the project layer wins, and update `src/shared/agency-prompt.ts`; verify with `snapshot-note` tests and the Admiral prompt test.
- [x] 1.4 Add the store migration for `preference_uses`, `preference_conflicts`, `declined_topics` and `project_trust`, with accessors; verify with `agency-store` tests that open an old database and see the new tables empty.
- [x] 1.5 Add IPC to read and change a layer's lines (add, edit, remove, edit as text, keep outside change); verify with an IPC handler test.
- [x] 1.6 Build the What the Admiral knows page in Settings › Agency › Admiral: You tab and one tab per project, each line with its source label, add, edit, remove, Edit as text (the existing `ClientFileEditor`); verify with a renderer test and by checking it in the running app with `npm run drive -- screenshot`.

## 2. Phase 2: Meet you (one PR)

- [x] 2.1 Write the question bank in `src/shared/agency-meet.ts` (seven questions, layer, picks, recommended pick, the line each pick writes, question 7 setting the trust level); verify with a unit test that every pick maps to a line or a trust level.
- [x] 2.2 Keep Meet you progress per layer in the store, treating a project with `starter` done as having answered the project questions; verify with store tests for resume and for an old project.
- [x] 2.3 Add the main-process save path: a pick or free text writes one `(from you, date)` line to its layer, question 7 writes `project_trust`; verify with service tests, including free text made one line.
- [x] 2.4 Build `MeetYou.tsx` to replace `StarterQuestions.tsx` in the onboarding stages: one question at a time, picks with the recommended one first, free text, Skip, Finish later, progress, and the live What I know about you panel; verify with renderer tests and in the running app, including a second project that only gets the project questions.
- [x] 2.5 Keep the instruction-file rules step from the starter flow at the end of Meet you; verify a picked rule lands as `(from CLAUDE.md, date)`.

## 3. Phase 3: trust levels and preferences used (one PR)

- [x] 3.1 Add `uses` to `PlanSchema` and `job_plan` (line ids from the note, at most 20, unknown ids dropped with a note); verify with `agency-tools` tests.
- [x] 3.2 Write `preference_uses` rows when a plan version with `uses` is approved, once per line per job; verify the count goes up once per job across two plan versions.
- [x] 3.3 Auto-start under Show me the PR and Ship it: run `approvable`, then approve without a card when the budget is within `auto_start_usd` and the default Claude share, no new role, and no client tick, logging "Started on its own"; verify with jobs tests for a small plan, a big plan, a plan with a new role, and an eva step needing a tick.
- [x] 3.4 Show an auto-started plan card with Stop and Change instead of Approve; verify with a `PlanCard` renderer test.
- [x] 3.5 Ship it: when a job reaches `delivered` with only pull request deliverables, start the merge queue, then accept and close and post a report card when every merge is in; leave the job waiting when the queue stops; verify with merge-queue tests for green, red check, and failed merge.
- [x] 3.6 Show the trust level and auto-start budget on the What the Admiral knows page for each project; verify with a renderer test.
- [x] 3.7 Show the cited lines as chips under "Using what I know about you" on the plan card and the job sheet, and the use count on the profile page; verify with renderer tests and in the running app on a real job.
- [x] 3.8 Tell the Admiral the trust level in the prompt, only to describe what will happen, and to cite `uses`; verify with the Admiral prompt test.

## 4. Phase 4: Read your work (one PR)

- [ ] 4.1 Write the collectors under `src/main/agency/understanding/` for instruction files (project files and exactly `~/.claude/CLAUDE.md`), commits, review comments, PR descriptions and past jobs, each capped; verify with tests on a git fixture and a fake `gh`, including no `gh` sign-in.
- [ ] 4.2 Mask the collected text with the `Redactor` and the project's env secrets; verify a test with a planted token and an env value shows neither in the request.
- [ ] 4.3 Run the extraction as one `completeOnce` call with the fixed prompt and zod-checked JSON, drop lines that match saved ones, record the cost as Admiral spend with no job, and refuse at the monthly cap; verify with a fake completion target for good JSON, bad JSON, and the cap.
- [ ] 4.4 Build the Read your work view: the source list with ticks and availability, the line that the text goes to the Admiral's model once, proposed lines with evidence, Keep, Not me, Keep all; verify with renderer tests and in the running app.
- [ ] 4.5 Save kept lines with their read source and open a conflict for a kept line that clashes with a rule; show conflicts on the profile page with Keep this line and the rule wins; verify the rule-wins path removes the line and the line-wins path marks it `(overrides CLAUDE.md)` in the note.
- [ ] 4.6 Offer Read your work at the end of Meet you and from the profile page; verify both entry points in the running app.

## 5. Phase 5: Learn from you (one PR)

- [ ] 5.1 Enqueue a wakeup for the job's Admiral after a client plan edit or reject, with the before-and-after steps or the note; verify with jobs tests.
- [ ] 5.2 Add `topic` and `layer` to `client_file_propose`, refuse a declined topic or a second open proposal with the same topic; verify with tool tests.
- [ ] 5.3 Turn the proposal card into Remember this?: editable line, This project, All projects, Just this job, where Just this job records the declined topic and saves nothing; verify with `QuestionCard` renderer tests and service tests for each choice.
- [ ] 5.4 Update the prompt: consider a lasting preference after plan edits, rejects and answers, ask at most once per topic, and never ask what a saved line answers; verify with the Admiral prompt test.
- [ ] 5.5 Run one job end to end in the running app: edit a plan, answer Remember this? with This project, and see the next plan cite the new line; record the result in the PR.

## 6. Phase 6: docs and wrap-up (one PR)

- [ ] 6.1 Update `docs/admiral.md` for Meet you, Read your work, Remember this?, What the Admiral knows and trust levels, one sentence per line; verify with prettier on the file.
- [ ] 6.2 Write a learning in `docs/learnings/` for anything that went wrong during the phases; verify the file exists or note that nothing went wrong.
