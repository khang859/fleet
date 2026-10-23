# Plan: the Admiral works like a dev team

| Field   | Value                                                   |
| ------- | ------------------------------------------------------- |
| State   | proposed                                                |
| Date    | 2026-10-22                                              |
| Commit  | `5331d2ee` (all line anchors are pinned to this commit) |
| Origin  | Khang: "the admiral still feels VERY involved"          |
| Handoff | none yet, written once this plan is accepted            |

## What this is

Today the Admiral is a tool the client drives, not a team the client hands work to.
The client approves each plan, answers budget cards at 100%, answers settings cards, answers "Remember this?" and "Teach the builder role?" cards, and reads Bridge messages while the job runs.
Each card is small, but together they mean the client has to watch every job.

The client wants to brief the Admiral, answer a few "what do you want" questions, and come back to a PR with green checks.
Everything between those two points is the Admiral's job.

## Goals

1. After the brief, the Admiral asks only intent questions ("what do you want"), then starts work with no approval click.
2. The Admiral makes every technical choice on its own.
3. The client hears from the Admiral only when a PR is ready (green checks and bot reviews done), or when it is stuck.
4. A job stops at a ready PR. The client merges.
5. Human review comments on a delivered PR go back to crew without the client asking, and the client hears again when the PR is ready again.
6. The Admiral learns silently. Everything it saves shows in **What the Admiral knows** with a way to undo it.
7. Settings changes apply at once and are listed in the job's report.

## Non-goals

- **No proactive work.** The Admiral does not start jobs nobody briefed ("CTO mode"). Deferred by the client.
- **No change to setup and onboarding.** Meet your Admiral, Project setup, Meet you and Read your work stay as they are, except the one Meet you answer that sets a trust level.
- **No auto-merge.** The "Ship it" path goes away. The client always merges.
- **No loosening of the brakes the client owns.** The monthly cap, the Claude reserve, the Admiral model, and crew permission bypass stay the client's alone.
- **No change to risky-act escalation.** A production deploy, deleting data or cloud resources, pushing to a default branch, a merge, or spending money still asks the client.
- **No change to Fleet's own "stuck" cards.** Model unreachable, continue after the turn limit, resume after restart, and rehire after a crew pane closed stay.

## Prior art

GitHub Copilot coding agent and Devin both take an issue, work with no approval step, and open a PR.
Both iterate on PR review comments without a new brief.
Copilot only acts on comments from people with write access to the repository.
That rule transfers directly: a PR comment is text from outside, and anyone who can comment on a public repository could otherwise steer the crew.

What does not transfer: both run in a cloud sandbox.
Fleet crew run on the client's Mac with the client's logins (`docs/admiral.md:9`).
So the risky-act escalation stays, even though everything else stops asking.

## Locked requirements

Settled with the client on 2026-10-22.
Do not reopen these; if you think one is wrong, say so and stop.

1. No plan approval. The Admiral asks its clarifying questions first, then starts.
2. Only intent questions reach the client. Technical choices are the Admiral's.
3. The client hears only when a PR is ready or the Admiral is stuck.
4. The finish line is a ready PR. The client merges.
5. Risky acts outside the job still ask the client.
6. The per-job budget is a guide. Work stops only at the monthly cap, and then the client is told.
7. Learning is silent, with undo in **What the Admiral knows**.
8. One mode only. The three trust levels go away.
9. The Admiral fixes PR review comments on its own.
10. Settings changes apply at once and show in the report, with undo.
11. Setup and onboarding stay.

## What already exists

Most of this is already built for the "Show me the PR" trust level.
The change is mostly to make that path the only path, and to remove the cards around it.

| Needed                                            | Already does it                                                                                                                            |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Start a plan with no click                        | `autoStart` → `approve(..., rule)` in `src/main/agency/jobs/index.ts:256-267`                                                              |
| Same checks as a client approve                   | `approvable` in `jobs/index.ts:621-651`                                                                                                    |
| Client can still stop or change a started plan    | `StartedPlan` (Stop / Change) in `src/renderer/src/components/admiral/PlanCard.tsx:86-120`                                                 |
| Intent questions that do not block                | `ask_client` tool, `src/main/agency/tools/ask-client.ts:9-44`; prompt `src/shared/agency-prompt.ts:119`                                    |
| "PR is ready" signal                              | `reviewEvents` emits "PR #N is ready" in `src/main/agency/results/pr-reviews.ts:219-224`                                                   |
| Watch PRs of delivered jobs                       | `PR_WATCH_MS` 120 s poll, `src/main/agency/results/pr-cards.ts:16,72-84`                                                                   |
| Send review comments to the step that made the PR | `commentsEvent`, `pr-reviews.ts:237-253` (bots only today)                                                                                 |
| Delivered job goes back to work                   | `follow_up` event, `src/main/agency/jobs/job-machine.ts:57,67`                                                                             |
| Apply a settings change, and undo it              | `SettingsService.change` / `undo`, `src/main/agency/settings/index.ts:168-202,235-259`                                                     |
| Write a learned line with its source              | `clientFiles.apply`, `src/main/agency/projects/client-file.ts:152-159`; source "Learned on jN" in `src/shared/agency-client-file.ts:28-35` |
| Show and remove learned lines                     | `AdmiralKnows.tsx:311-350`                                                                                                                 |
| Apply a crew lesson to a role                     | `applyLesson` → `writeRole`, `src/main/agency/lessons/index.ts:187-219`                                                                    |
| Monthly cap stop and card                         | `capRefusal` / `budgetCard` cap variant, `src/main/agency/spend/spend-service.ts:405-427,556-599`                                          |

## Alternatives considered

**Keep trust levels, add a fourth "Dev team" level as the default.**
This keeps every existing path working and is the smallest diff.
It lost because the client asked for one mode, and because three levels keep three sets of copy, tests and prompt branches alive for a mode nobody picks.
The levels also leak into the Admiral's prompt (`snapshot-note.ts:177-187`), so the Admiral would keep reasoning about modes it never runs in.

**Show the plan once, approve by default after a timeout.**
This keeps a review window without a click.
It lost because a timeout is still a card the client must notice.
The started-plan card already gives the client Stop and Change, which is the same power without the wait.

**Keep the per-job 120% hard stop as a runaway guard.**
This would cap the damage of a job that loops.
It lost to locked requirement 6.
The monthly cap is the brake, and the turn limit (`turnLimit`, default 20) still stops a looping Admiral.

**Let the Admiral change every setting, including the monthly cap and the reserve.**
Rejected outright.
If "approve" changes simply became "apply", the Admiral could raise the monthly cap that is its only spend brake, lower the Claude reserve that protects the client's own usage, or drop a required check to make a PR look green.
Each of these fails in the permissive direction and silently.
These keys become client-only instead (section 5).

**Act on every human PR comment.**
Rejected outright.
On a public repository anyone can comment, and the comment text reaches the Admiral's turn and then a crew brief.
Only comments from the client's own GitHub login, and from the review bots in setup, wake the Admiral (section 6).

## The chosen architecture

### 1. Every Admiral plan starts on its own - `locked`

`autoStart` runs for every Admiral-written plan, first or changed.
The trust rule is gone: `autoStartable` keeps only "passes the checks".
Budget size, Claude share and new roles no longer hold a plan.

A plan with a `block` finding does not start.
The finding goes back to the Admiral in the `job_plan` result, as it does today, and the Admiral sends a fixed version.
If it cannot fix it, it is stuck, and it asks the client with `ask_client`.

A plan the client writes (an edit, or a change note turned into a version) also applies at once.
The client is the authority, so there is nothing left to approve.

### 2. eva cost caps and new roles accept themselves - `author's call`

Today an eva step's `accept` finding needs a tick box on the plan card (`PlanCard.tsx:556-601`).
Fleet already stops eva crew at the cap, so the tick adds no safety, only a click.
`approve` is called with `acceptCost: true` for Admiral plans.
An uncapped eva step is still a `block`.

New roles in `newRoles` are saved to the project's crew on start, as an approve does today (`approvedCrew`, `jobs/index.ts:600-614`).
They show in Settings > Agency > Crew, where the client can edit or remove them.

### 3. Trust levels are removed - `locked`

Remove `TRUST_LEVELS`, `ProjectTrust`, `AutoStartRule` (`src/shared/agency-projects.ts:296-313`), the store and IPC (`preference-store.ts:154-174`, `agency-ipc.ts:190-193,508-512`), `TrustPicker`, the Ship it merge path (`MergeStarter 'trust'`, `shipped`, `deliveryAction` `merge`), and the trust lines in the prompt and snapshot note.
A migration drops the `project_trust` table.

The last Meet you question (`checks`, `src/shared/agency-meet.ts:139-155`) only set trust.
It is removed, and `meetAnswerResult` returns lines only.

### 4. Budget is a guide; the monthly cap is the brake - `locked`

In `afterSpend` (`spend-service.ts:477-497`), a job meter at 100% or 120% no longer holds or interrupts.
At 80% the Admiral is told, but the wakeup no longer says "tell the client".
`budgetRefusal` is removed: even a `busy` check on the job budget would block a job for good once it passes its budget.
The monthly cap keeps its hold and its card, which is the "stuck" message the client asked for.
Keep in reserve is unchanged.

The Claude share meter (`week_pct`) follows the same rule as money.

### 5. Settings apply at once, except the brakes - `author's call`

The `approve` kind goes away.
Each key becomes `apply` or `client-only`:

| Key                                                                                              | New kind                         |
| ------------------------------------------------------------------------------------------------ | -------------------------------- |
| `monthlyCapUsd` raise                                                                            | client-only (lower stays apply)  |
| `reserveFiveHourPct`, `reserveSevenDayPct` raise                                                 | client-only (lower stays apply)  |
| `members.*.requiredChecks`, `members.*.reviewBots` drop                                          | client-only (add stays apply)    |
| `members.*.envFiles` add                                                                         | client-only (remove stays apply) |
| `turnLimit` raise                                                                                | client-only (lower stays apply)  |
| `defaultBudgetUsd`, `defaultBudgetWeekPct`, `nudgeLimit`, `crew.*.atOnce`, `crew.*.defaultModel` | apply                            |
| Every key that is client-only or apply today                                                     | unchanged                        |

A reserve key is the usage level where Claude crew stop.
A higher line leaves the client less of their own subscription (`agency-settings.ts:116`), so raising it is the loosening direction.

A client-only refusal tells the Admiral to ask the client, which is the "stuck" path.
The settings card and the `settings` queue item go away.
Applied changes are listed in the job's report (section 8) and keep their existing undo.

### 6. Review comments go back to crew - `author's call`

`parsePrReview` (`pr-reviews.ts:110-135`) keeps unresolved threads whose first comment is from a review bot in setup, or from the client's GitHub login.
The login is read once with `gh api user` and cached for the session.
Every other author is dropped, as today.

`commentsEvent` already tells the Admiral to send comments to the step that delivered the PR.
That turns the job from `delivered` back to `running` through `follow_up`.
When the PR is ready again, the "PR #N is ready" event fires, and the Admiral reports again.

Only unresolved review threads count.
Review summary bodies and conversation comments stay out of scope for this change.

### 7. Learning is silent - `locked`, with the details `author's call`

`client_file_propose` writes the line at once, to the layer the Admiral picks, with source "Learned on jN".
No card, no topic memory.
`proposeClientFile` (`src/main/agency/index.ts:735-788`) shrinks to a write.
The prompt keeps the rule "never save what a line already says", and adds "save only what holds for later jobs".

Crew lessons apply at once to the project's copy of the role, never to "All projects".
Each applied lesson is recorded with its `replace` and `with` text and job id.
**What the Admiral knows** gets a "Crew lessons" list, each row with Undo.
Undo puts the old text back when the new text is still in the role, and says it cannot when the client has since edited that part.

A clash between a Read your work line and `CLAUDE.md` or `AGENTS.md` no longer asks.
The instruction file wins, because crew read it anyway, and the line is dropped.
The existing clash prompt in **What the Admiral knows** stays for lines the client adds by hand.

### 8. The client hears only "ready" or "stuck" - `author's call`

The prompt changes the Admiral's voice: no Bridge messages while work runs.
It writes to the client in three cases only:

1. An intent question, with `ask_client`, before or during a job.
2. A report when a PR is ready: what changed for the user, the PR links, the choices it made on the client's behalf, and the settings and lines it changed.
3. Stuck: the monthly cap, a client-only setting it needs, a risky act, or a plan check it cannot fix.

The `delivered` queue item shows only once the job's PRs are ready, not when the steps finish.
A job that delivers findings only (reports, docs) is ready on delivery, as today.

When every PR of a delivered job is merged on GitHub, Fleet closes the job.
Today only a Fleet-started merge does that.

### 9. Permissions - `locked`

The prompt's `ask_client` rule (`agency-prompt.ts:112`) drops "anything outside the plan" and keeps the list of risky acts.
Anything else the Admiral allows or denies by its own judgement against the brief.
The 90-second fallback and the expiry stay.

## Call-site audit

| Site                                                                               | Change                                                                                             |
| ---------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `jobs/index.ts:115-124` `autoStartable`                                            | Checks only                                                                                        |
| `jobs/index.ts:194-239` `propose`                                                  | Calls `autoStart` for every Admiral version                                                        |
| `jobs/index.ts:368-427` `decide`, `changesStarted`, `editStarted`                  | Client versions apply at once; no client change card                                               |
| `jobs/index.ts:472-495` `proposeForClient`                                         | Applies, drops `LEARN_HINT`                                                                        |
| `jobs/index.ts:653-732` `reject`, `revise`, `sendBack`                             | Become Stop and Change on a started plan                                                           |
| `jobs/index.ts:276-300` `raiseBudget`                                              | Removed; the cap card raises the setting                                                           |
| `jobs/index.ts:434-466` `swapStep`                                                 | No change: "proposed" is now transient                                                             |
| `src/main/agency/index.ts:934-943` `autoStartRule`                                 | Removed                                                                                            |
| `src/main/agency/index.ts:956-1027` `delivered`, `shipped`                         | No merge action; close when all PRs merged                                                         |
| `src/main/agency/index.ts:735-801` `proposeClientFile`, `topicRefusal`             | Write at once                                                                                      |
| `src/main/agency/index.ts:661-700` `answerBudget`                                  | Cap variant only                                                                                   |
| `src/main/agency/lessons/index.ts:161-219`                                         | Apply at once, record, no card                                                                     |
| `src/main/agency/understanding/index.ts:218-280`                                   | Rule file wins without asking                                                                      |
| `src/main/agency/spend/spend-service.ts:372-403,477-599`                           | Job meters never hold                                                                              |
| `src/main/agency/settings/index.ts:168-229`                                        | No pending changes                                                                                 |
| `src/shared/agency-settings.ts:29-180`                                             | Rule table in section 5                                                                            |
| `src/main/agency/results/pr-reviews.ts:110-135`                                    | Client login comments kept                                                                         |
| `src/main/agency/results/delivery.ts:20-26`                                        | `merge` action removed                                                                             |
| `src/main/agency/results/merge-queue.ts:97,126,390`                                | `'trust'` starter removed                                                                          |
| `src/main/agency/crew/permissions.ts`                                              | No change                                                                                          |
| `src/main/agency/held-decisions.ts`                                                | No change: still holds Stop, Change and answers                                                    |
| `src/shared/agency-prompt.ts:70-131`                                               | Rewritten for sections 1, 8, 9, 7                                                                  |
| `src/shared/agency-tools.ts:383-387`                                               | Tool text without approval                                                                         |
| `src/main/agency/admiral/snapshot-note.ts:84,177-187`                              | No trust line; "no plan yet" wording                                                               |
| `src/shared/agency-meet.ts:139-201`                                                | `checks` question and `trust` removed                                                              |
| `src/shared/agency.ts:128-150`                                                     | `client_file`, `crew_lesson` kinds removed                                                         |
| `src/renderer/.../admiral/waiting-queue.ts:28-34`                                  | `plan`, `settings` items removed; `delivered` waits for ready                                      |
| `src/renderer/.../admiral/PlanCard.tsx`, `PlanReader.tsx`, `QueueCard.tsx:243-296` | Approve / Reject UI removed; started view stays                                                    |
| `src/renderer/.../admiral/queue-keys.ts:20-23`                                     | `D`, `C` for plans removed; `A` stays for permissions and answers                                  |
| `src/renderer/.../admiral/QuestionCard.tsx`                                        | Remember and lesson variants removed                                                               |
| `src/renderer/.../admiral/EmptyBrief.tsx`, `JobSheet.tsx`, `BridgeQueue.tsx:104`   | Trust copy removed                                                                                 |
| `src/renderer/.../settings/TrustPicker.tsx`, `AdmiralKnows.tsx:125`                | Removed; Crew lessons list added                                                                   |
| `src/renderer/.../admiral/MeetYou.tsx:121,353`                                     | No trust step                                                                                      |
| `src/renderer/.../admiral/BridgeQueue.tsx:259-281` Done today                      | No change                                                                                          |
| `docs/admiral.md`                                                                  | Rewritten sections: Run a job, Waiting on you, Remember this?, Crew lessons, Trust levels, Budgets |
| `openspec/specs/admiral-understanding/spec.md:78-104`                              | Scenarios updated for silent learning                                                              |

## File manifest

New:

- `src/main/agency/lessons/lesson-log.ts` - record and undo applied lessons.
- `src/renderer/src/components/settings/CrewLessons.tsx` - the list with Undo.
- A migration entry in `src/main/agency/store/agency-db.ts`: drop `project_trust`, add `crew_lessons_applied`.

Removed:

- `src/renderer/src/components/settings/TrustPicker.tsx`
- `src/main/agency/__tests__/agency-trust.test.ts` (its check cases move to `agency-plans.test.ts`)

Modified: every row marked with a change in the call-site audit.

## Build sequence

1. **Settings rule table** (section 5).
   This is the part that can fail silently in the permissive direction, so it goes first.
   Verify: a test per key and direction asserts the kind; a test that `settings_change` raising `monthlyCapUsd` is refused.
2. **Auto-start for every plan** (sections 1-3, main only).
   Verify: `agency-plans.test.ts` rewritten: a first plan starts with no client action, a blocked plan does not and the Admiral gets the finding, an eva step with a cap starts, a changed plan starts.
3. **Remove trust levels** (store, IPC, migration, Meet you).
   Verify: migration test from the current schema version; typecheck shows no `TrustLevel` left.
4. **Budget as a guide** (section 4).
   Verify: a job at 130% of its budget keeps running; a job at the monthly cap holds and gets the cap card.
5. **Silent learning** (section 7).
   Verify: `client_file_propose` writes a line with source "Learned on jN"; a lesson applies to the project copy and Undo restores it; Undo after a client edit refuses.
6. **PR comments and ready** (sections 6, 8).
   Verify: unit tests for `parsePrReview` with a client comment, a stranger's comment, and a bot comment; the `delivered` item waits for ready; all-merged closes the job.
7. **Prompt and tool text** (sections 8, 9).
   Verify: `agency-prompt` snapshot tests updated; then an E2E job (step 9).
8. **Renderer** (cards, queue, keys, Admiral knows).
   Verify: renderer tests updated; screenshots of the Bridge with an empty queue during a running job.
9. **E2E with fleet-drive.**
   Brief a small change on a test repository: the Admiral asks at most intent questions, starts with no click, the Bridge queue stays empty while it runs, the PR is opened, and the report arrives once checks pass.
   Leave a review comment from the client's login: crew fix it and the report comes again.
   Verify by screenshots in `.fleet-drive/screenshots/`.
10. **Docs**: `docs/admiral.md` and the openspec scenarios.

## Test plan

- **Permissive failures** (step 1, 6): the Admiral cannot raise the cap, lower the reserve, drop a required check, add an env file, or act on a stranger's PR comment.
- **Start path** (step 2): every plan that passes checks starts; nothing that fails a `block` starts; crew snapshot and pinned bases exist after auto-start.
- **Spend** (step 4): job meters never hold; the cap does.
- **Learning** (step 5): lines and lessons apply and undo.
- **Ready and close** (step 6): ready gating, re-ready after a fix, close on merge.
- **E2E** (step 9): the whole client experience, from brief to ready PR, with no card in between.

## Baseline to hold

Measured at `5331d2ee` on 2026-10-22, before any change:

- `npm run typecheck`: pass.
- `npm run lint`: pass.
- `npm test`: 443 test files, 5510 tests, all pass.

## Known risks

**A runaway job now spends up to the monthly cap.**
Before, a job held at 100% of its own budget.
Now one bad job can use the whole month.
The turn limit still stops a looping Admiral, but a crew member burning tokens in one long turn is only stopped by the cap.
The client accepted this risk on 2026-10-22: add a per-job brake later only if it becomes a problem.

**The Admiral's judgement replaces the client's eyes on the plan.**
A plan that is wrong in intent, not in checks, runs to a PR before anyone sees it.
The intent questions up front are the only guard, and they depend on the prompt.
This is the weakest part of the design, and the E2E run in step 9 is where it will show.

**"Only talk when ready or stuck" is a prompt rule, not enforced.**
The Admiral can still write on the Bridge mid-job.
If it does in testing, the fix is prompt wording, not code.

**Undo of a crew lesson can fail** when the client edited the same text after.
It says so instead of guessing, but the client then fixes the role by hand.

**The client's GitHub login is read once per session.**
If they switch `gh` accounts mid-session, their comments are dropped until restart.
