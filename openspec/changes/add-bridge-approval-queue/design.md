## Context

Today each job's waiting items show only on its job tab, in the job sheet's WAITING ON YOU section (`JobSheet.tsx`, `WaitingSection`).
The Bridge (the lobby tab) shows THE JOB placeholder, leftovers and past jobs.
A job tab shows an amber dot when something waits, and the Bridge tab a dot only for lobby questions.

What exists and is reused:

- `AgencySnapshot` per project, mirrored in `agency-store.ts`, with per-job hints: `pendingPlan`, `permissionsWaiting`, `crewNeedingYou`, `state`, plus `questions` and `settingsCards`.
- `AgencyJobDetail`, loaded per job by `useJobDetail` and kept fresh by `reloadDetails` on change events.
  Plans, permissions and crew flags need it.
- The cards: `PlanCard` (with `PlanEditor`, `DecisionBar`, `ChangeBlock`), `QuestionCard`, `PermissionCard`, `SettingsCardView`, `DeliveredCard`, `NeedsYouCard`.
- `waitingCount(snapshot, jobId)` and the sheet's own `waitingOnClient`, which count different things: the second counts settings cards, the first does not.
- `diffPlans(prev, next)` in `src/shared/agency-plan.ts`, today run only against the approved parent.
- Plan reject with a note: the version becomes `rejected`, a first plan sends the job back to `briefing`, and the Admiral gets a `client_action` wakeup with the note.
- `PtyManager.screen(paneId)` reads a mirrored pane's screen in main, and `Redactor` masks env values.
- The copilot hook already passes a deny `reason` to the runtime (`hooks/fleet-copilot-go/main.go`).

The design canvas (row A) is the reference for layout and copy: https://claude.ai/artifact/EZwBXMUsBEBAhrZZQ6yx1a.

## Goals / Non-Goals

**Goals:**

- One place, the Bridge, for every decision the client owes across the project's open jobs.
- Read a long plan, permission or question in full width, then decide, without leaving the Bridge.
- Ask for a plan change in words, and see what changed in the next version.
- Recover from a wrong click on a plan or question by undo, not by confirm dialogs.
- Work by keyboard without risk of acting while typing.

**Non-Goals:**

- No "Approve all" or bulk actions.
  Each decision stays one deliberate act.
- No approval by typed chat commands that a model interprets.
- No new plan fields such as step descriptions, "done when" lines or time and cost estimates per step.
  The reader shows what the plan holds; see Open Questions.
- No queue across projects.
  The queue covers the project of the Admiral pane.
- No change to the job sheet on job tabs.

## Decisions

### 1. One queue model, shared with the job sheet

A pure function `waitingItems(snapshot, details)` in `src/renderer/src/components/admiral/waiting-queue.ts` returns the waiting items of one job or of every open job.
Each item has a stable `key` (`perm:7`, `plan:12`, `q:35`, `settings:4`, `delivered:24`, `crew:9`), its `jobId`, its kind and payload, `expiresAt` and `since`.
`queueOrder` sorts items with an expiry first, soonest first, then by `since`, oldest first.
`JobSheet`'s `waitingOnClient` is rebuilt on the same function, so the sheet and the queue cannot disagree.
`waitingCount` gets pending settings cards so the badge and the queue count agree; it stays snapshot-only so the badge needs no details.

Alternative: a second, queue-only collector.
Rejected: two lists of "what waits" drift, as `waitingCount` and `waitingOnClient` already have.

### 2. Details for every job with waiting items

`useJobDetails(jobIds)` loads the details of every open job whose snapshot row says something waits that needs details (`pendingPlan`, `permissionsWaiting`, `crewNeedingYou`, `delivered`).
The existing `reloadDetails` keeps them fresh.
Until a detail arrives, the queue shows a one-line row for that job's item from the snapshot hint, so the count never jumps.

### 3. The Bridge layout

In `AdmiralWorkspace`, when the lobby is on screen, the right column renders a new `BridgeQueue` in place of `JobSheet`.
`BridgeQueue` holds the queue, then the parts the lobby sheet showed: the client file notice, leftovers, past jobs, the first-run explainer and the settings box.
It keeps `JOB_SHEET_WIDTH_PX`, and the narrow-pane toggle opens it as today.

The reader is per pane state in a new small store, `bridge-store.ts`: `reading: string | null` (an item key) by pane id.
While reading, the main column renders `QueueReader`, and the `AgentThread` stays mounted but hidden, so the draft, scroll and stream survive.
When the key leaves the queue, the reader moves to the item that took its place, or closes when the queue is empty.

### 4. Undo by a short hold in main

Plan approve, reject and revise, and question answers, given from the Bridge go through a new `agency.hold(decision)` call.
Main keeps the decision for 5 seconds, then runs it through the same path as today; `agency.undo(holdId)` drops it.
Held decisions are in the snapshot (`held: HeldDecision[]`), so every view hides the item and shows "Approved plan v1 · Undo".
The main window's close handler (before a quit or a close goes on) and the pane's release run held decisions at once.
`agency.hold` settles with how the decision ended (`done`, `refused` with the reason, or `undone`), so the card can show a refusal.
If the target moved on during the hold (a newer version, an answered question), the run is refused as today, and the refusal shows in the Done today row.

Alternative: hold in the renderer with a timer.
Rejected: a reload or quit loses the decision or sends it late, and other views do not see it.

Permission answers skip the hold: a crew member waits on them and they expire.

### 5. Ask for a change: a `revise` plan action

`PlanAction` gets `{ planVersionId, action: 'revise', note, steps: string[] }`.
Main marks the version `replaced` with the note as `decisionNote`, sends a first plan back to `briefing` as reject does, and wakes the Admiral with "Client asked for a change to plan vN", the note, the step ids and titles, and the learn hint.
The Admiral's instructions say that a change request expects a new `job_plan` for the same job.
A proposed change on a running job is replaced the same way; the job keeps running on its approved plan.

Alternative: reuse `reject` with the note.
Rejected: the Admiral and the record would read it as "the client does not want this", not "do this differently".

### 6. Changes since the previous version

`AgencyPlanVersion` gets `previous: { version, status, note, diff } | null`, built in main next to `diff` from the version right before it, whatever its status.
The existing `diff` against the approved parent stays for `ChangeBlock`.
`PlanDiffView` renders `previous.diff` on the reader's steps: a blue edge and a tag for moved and changed steps (naming the fields), added steps marked new, removed steps in a red dashed row, and old budget, week share and crew count struck through next to the new values.
Crew count is the number of steps.

### 7. Deny with a reason

`PermissionAnswerRequest` gets `reason?: string` (300 characters at most, trimmed).
Main passes it as the deny reason to the waiting hook call and writes it to the job log.
Claude Code and eva both read the deny message of the hook's answer (eva in `read_decision`, `src/hooks.rs`), so every crew runtime gets the reason.

### 8. Pane lines for the permission reader

A new `agency.crewScreen(crewId)` call returns the last 12 non-blank lines of the crew pane's screen, from `PtyManager.screen`, put through the job's `Redactor`, or null when the pane is gone or not mirrored.
The reader asks every 2 seconds while it is open.
The text is untrusted: it renders as plain text in a `<pre>`, with no links or markdown.

### 9. Done today

`AgencySnapshot` gets `decisions: ClientDecision[]`: the client's decisions since local midnight across the project's jobs, newest first, at most 50.
Main builds it from plan versions the client decided (approved by the client, rejected, replaced by a revise), questions with `answered_at`, and permissions with `answeredBy: 'client'`.
Each has the job, a short label (`Approved plan v2`, `Answered q35`, `Allowed once`), what it was about, and the job's state now, which the renderer words as the outcome (`Running`, `Done`).

### 10. Keys

One `onKeyDown` handler on the Bridge root, not on `window`.
It ignores events from `input`, `textarea`, `select` and content-editable targets, and any event with Meta, Ctrl or Alt held.
The queue is a list with one focusable item at a time (roving tab index); J and K move it, Enter opens the reader, Esc closes it.
A, D, C and R press the matching button of the focused or open item, so a disabled button (for example a plan with a blocking check) cannot be bypassed.

### 11. Cards in compact and reader forms

The queue needs compact cards and the reader full ones.
`PlanCard`'s pieces (`PlanSteps`, `DecisionBar`, `useDecision`, `Cautions`, `StartsFrom`, `EnvFiles`, `YouGet`, `NewRoles`) are exported and reused by `PlanReader`, which lays them out wide with a fixed footer.
`QuestionCard` and `PermissionCard` get a `layout: 'card' | 'reader'` prop, so answer logic stays in one place.
Compact queue cards (`QueueCard`) show title, job, kind, time or expiry and the inline actions, and call the same store actions.

## Risks / Trade-offs

- A plan approved from the Bridge starts 5 seconds later → accepted; undo matters more than 5 seconds of crew time.
- Loading details for many waiting jobs costs IPC → only jobs with waiting items load, and loads are cached and refreshed by the existing change events.
- A held decision and a quit race → the quit path runs held decisions before the database closes; covered by a test.
- Crew pane text could hold secrets that are not env file values → only env values are known to Fleet; the reader shows the same text the pane already shows the client, and nothing of it reaches a model.
- Single-letter keys could surprise → they only work with focus in the queue or reader, and the hints are always shown.
- The queue column replaces THE JOB placeholder on the Bridge → past jobs and leftovers stay, below the queue.

## Migration Plan

- Snapshot and plan version types gain fields; old renderers do not exist, since main and renderer ship together.
- No database migration: held decisions live in memory in main, and Done today reads existing columns.
- Rollback is a revert of the change.

## Open Questions

- Should plans gain an optional per-step `detail` ("what it does") and `doneWhen` line, written by the Admiral, so the reader can show them as in the canvas?
  Recommendation: yes, as a follow-up change, since it touches the `job_plan` tool, the Admiral's instructions and the plan editor.
