## Purpose

Defines the life of an agency job, from the client's brief through an approved plan and crew work to delivered results and cleanup, with a budget the client controls.

## ADDED Requirements

### Requirement: Job lifecycle

A job SHALL move through these states: `briefing`, `planned`, `running`, `waiting`, `delivered`, `closing`, `closed`.
A job SHALL also be able to end as `cancelled` or `failed` through `closing`, and SHALL become `interrupted` when Fleet restarts while it has live steps.
Only these moves SHALL be allowed: briefing to planned; planned to running (on approval) or back to briefing (on rejection); running to waiting and back; running to delivered; delivered to running (follow-up inside the plan or an approved plan change) or to closing (accepted); any open state to closing (cancel or failure); running or waiting to interrupted; interrupted to running (resume) or closing (cancel); closing to closed, cancelled or failed.
A closed job SHALL be read-only, and a follow-up on it SHALL open a new job linked to it.
The job sheet SHALL show the current state.
Every state change SHALL be written to the job record with the time and the reason.

#### Scenario: Normal job

- **WHEN** the client briefs a job, approves the plan, and accepts the results
- **THEN** the job goes through briefing, planned, running, delivered, closing and closed in that order

#### Scenario: Waiting on the client

- **WHEN** every remaining step depends on an open question
- **THEN** the job state is `waiting` until the question is answered

#### Scenario: Follow-up after delivery

- **WHEN** the client asks to change the headline on a delivered job and the change fits the approved plan
- **THEN** the job goes back to `running`

#### Scenario: Follow-up after close

- **WHEN** the client asks for a change on a closed job
- **THEN** a new job opens, linked to the closed one

#### Scenario: Cancel

- **WHEN** the client cancels a running job
- **THEN** its crew panes are stopped, its worktrees are cleaned up, and the job ends as `cancelled`

### Requirement: Plan before work

The Admiral SHALL propose a plan before any crew is hired for a job.
A plan SHALL name the playbook, each step with its role, the budget, and what will be delivered.
The system SHALL NOT start crew or create worktrees until the client approves the plan.
The client SHALL be able to edit the plan before approving it.
An approved plan SHALL be stored with the job and SHALL NOT change without a new approval.

#### Scenario: Approve

- **WHEN** the client approves a plan
- **THEN** the job state becomes `running` and the first steps start

#### Scenario: Reject

- **WHEN** the client rejects a plan with a note
- **THEN** no crew starts and the Admiral gets the note to revise the plan

#### Scenario: Plan change during the job

- **WHEN** the Admiral needs a step the approved plan does not have
- **THEN** it asks the client to approve a plan change, and the new step does not start before approval

### Requirement: Step deliverables

The Admiral SHALL decide what each plan step hands back, from the brief and the role, and the plan card SHALL show it on each step.
The client SHALL be able to change a step's deliverables before approval, with Edit plan, or by asking in the chat.
A deliverable SHALL have a kind and an optional label in the client's words.
The kind SHALL decide how Fleet shows and checks the result:

| Kind | Default label | How Fleet shows and checks it |
| --- | --- | --- |
| `pr` | Branch and PR | PR card with checks and reviews |
| `doc` | Document | Markdown or PDF opened in a Fleet pane |
| `image` | Images | Image gallery |
| `copy` | Copy drafts | Text with a copy control |
| `preview` | Preview link | Preview deployment, opened in a browser pane |
| `review` | Review notes | Findings with file and line |
| `report` | Report with screenshots | Verdict with screenshots |
| `file` | File | Any file, previewed when Fleet can show its type |
| `link` | Link | Any web address |

`file` and `link` SHALL cover anything else, so a new kind of result needs no new Fleet code.
A crew member SHALL be able to hand back a result that the step did not list, and Fleet SHALL show it as a result card of its kind.

#### Scenario: Admiral picks the deliverables

- **WHEN** the client briefs "test the savings screens on a preview"
- **THEN** the plan's QA step hands back a preview link and a report with screenshots

#### Scenario: Asked for in the brief

- **WHEN** the client writes "also send me a short demo video" in a brief
- **THEN** the plan's QA step also hands back "Demo video" as a `file`, and no role file changes

#### Scenario: Something extra

- **WHEN** the Strategist step lists a document and its crew member also hands back a pricing spreadsheet
- **THEN** the spreadsheet shows as a file card with its name, and the step is not blocked

### Requirement: Client file

The system SHALL keep a client file per repository with the client's standing preferences.
The Admiral SHALL read the client file at the start of each job.
The Admiral SHALL propose additions to the client file when the client gives an answer that applies beyond the job, and SHALL add them only when the client agrees.
The client SHALL be able to view and edit the client file in Settings › Agency › Admiral, and hand edits SHALL win.
Each entry SHALL record its date and the job it came from.
A proposed entry that contradicts an existing one SHALL show both, and SHALL replace the old one only on approval.
The client file SHALL change only through the Fleet UI or an approved proposal, and Fleet SHALL warn at job start when it changed outside Fleet.
When the client file grows past a size limit, the Admiral SHALL propose a cleanup.

#### Scenario: Remember a preference

- **WHEN** the client answers "always open PRs as drafts" and agrees to remember it
- **THEN** the client file has the preference and later jobs do not ask again

### Requirement: Budgets and spend

Each job SHALL have a budget in US dollars, set in the plan, with a default from Settings › Agency › Admiral.
Every place that sets a budget (the starter question, Settings and the plan card) SHALL offer preset values and a Custom value: $5, $10, $25 and $50 for dollars, and 5%, 10%, 25% and 50% of the week for subscription usage.
A Custom value SHALL accept a positive number, and SHALL be refused with a message when it is zero, negative or above the monthly cap.
The system SHALL also enforce a monthly cap across all jobs, which SHALL reset at 00:00 on the 1st of the month in the user's local timezone.
The budget and the cap SHALL count real dollars only: the Admiral's model cost, crew paid through an API key, and eva crew when eva reports cost or token counts.
Claude Code crew on the user's subscription SHALL be measured as subscription usage, with its own budget, and SHALL NOT be counted as dollars.
Subscription usage SHALL come from the `rate_limits` data that Claude Code gives its status line (`five_hour` and `seven_day` with `used_percentage` and `resets_at`), read through a status line command in the crew's settings; Fleet SHALL NOT read the Claude login or call Claude's servers for it.
Each job SHALL have a subscription budget as a share of the weekly limit, set in the plan, with a default from Settings › Agency › Admiral.
A job's usage SHALL be the rise in the weekly percentage while its Claude crew are working, split evenly across the jobs that have Claude crew working at that time, and SHALL be shown as an estimate, because the percentage also counts the user's own Claude use.
The system SHALL keep a reserve for the user: no new Claude crew work SHALL start while the 5-hour window is at or above 80% or the weekly limit is at or above 90%, and both thresholds SHALL be settings.
When Claude Code reports no `rate_limits` after its first response, the crew member SHALL be treated as paid by API, and its reported session cost SHALL count as dollars.
The 80%, 100% and 120% steps below SHALL apply to the subscription budget in the same way as to the dollar budget.
The job sheet SHALL show live spend for the Admiral and for each crew member.
A step whose cost cannot be measured SHALL need explicit client acceptance on the plan card, and SHALL have a turn or time cap.
The plan card SHALL say that cloud service costs are not counted.
The budget check SHALL run before each crew hire, each crew prompt and each automatic Admiral turn, and SHALL reserve an estimate in the same step, so parallel jobs cannot both pass the cap.
When a job reaches 80% of its budget, the Admiral SHALL tell the client.
When a job reaches its budget or the monthly cap, the system SHALL start no new crew work and no automatic Admiral turn for that job, and SHALL ask the client to raise the budget or stop.
When a job reaches 120% of its budget, the system SHALL interrupt its running crew turns and Admiral turns.
The job sheet SHALL show any spend past the budget.

#### Scenario: Custom budget

- **WHEN** the user picks Custom and enters $15 as the default job budget
- **THEN** new plans start with a $15 budget, and Settings shows Custom selected with $15

#### Scenario: Budget warning

- **WHEN** job spend passes 80% of the budget
- **THEN** a notice appears in the conversation and the SPEND section turns to a warning color

#### Scenario: Budget reached

- **WHEN** job spend reaches the budget
- **THEN** no new crew step or automatic Admiral turn starts and an approval card asks to raise the budget or stop

#### Scenario: Hard stop

- **WHEN** a running eva turn takes job spend to 120% of the budget
- **THEN** the turn is interrupted

#### Scenario: Two jobs at the cap

- **WHEN** two jobs try to start crew at the same time with room for only one under the monthly cap
- **THEN** one starts and the other gets the raise-or-stop card

#### Scenario: Subscription crew

- **WHEN** a Claude Code crew member runs on the user's subscription
- **THEN** its usage shows as an estimated share of the weekly limit beside the dollar spend and does not count toward the dollar budget

#### Scenario: Reserve for the user

- **WHEN** the 5-hour window reaches 80% while a job has a step waiting for a Claude crew member
- **THEN** the step waits, the job sheet shows the reset time, and the step starts after the reset without a new approval

#### Scenario: Claude Code on an API key

- **WHEN** a Claude crew member's status line data has no `rate_limits` after its first response
- **THEN** its session cost counts toward the job's dollar budget

### Requirement: Job record

The system SHALL keep a record per job with the brief, the approved plan and every change to it, questions and answers, crew members and their panes, results, state changes, spend, and every permission answer.
Job records SHALL be stored locally and SHALL NOT contain the values of chosen environment files.
The client SHALL be able to export a closed job's record as Markdown.

#### Scenario: Export

- **WHEN** the client exports a closed job
- **THEN** a Markdown file with the brief, plan, decisions, results, spend and permission answers is written

### Requirement: Close and cleanup

When the client accepts the results, the job SHALL go to `closing` and then `closed`.
Closing or cancelling a job SHALL stop its crew panes, stop the job's Docker Compose project, and remove its worktrees.
Cleanup SHALL be safe to run more than once: a second cancel or close SHALL join the running cleanup, and a cleanup cut short by a quit or crash SHALL resume when Fleet starts.
A job in `closing` SHALL refuse new crew work.
Cleanup SHALL NOT remove a worktree that has uncommitted changes, untracked files, or unmerged commits, and the close summary SHALL list kept worktrees.
Delivered files SHALL be copied out of worktrees into the job's results folder when they are delivered, so cleanup never loses them.
If a cleanup step fails, the leftover SHALL stay in a Leftovers list with Retry until it is cleaned or the user dismisses it, and the system SHALL retry when Fleet is back online.

#### Scenario: Close with an open PR

- **WHEN** a job closes while its PR branch is pushed but not merged
- **THEN** its local worktree is removed, the remote branch and PR stay, and the summary links the PR

#### Scenario: Cleanup failure

- **WHEN** the job's Docker Compose containers cannot be stopped at close
- **THEN** they stay in Leftovers with a Retry control until cleaned or dismissed

#### Scenario: Untracked design files

- **WHEN** a Designer's worktree has untracked files at close
- **THEN** the worktree is kept and the summary says so

#### Scenario: Quit during cleanup

- **WHEN** Fleet quits while a job is closing
- **THEN** cleanup resumes on the next start

### Requirement: Plan versions and base commit

Proposing a plan SHALL NOT block the Admiral; the client's approval, edit or rejection SHALL reach the Admiral as a new event.
Each plan revision SHALL be a new version, and only the newest version SHALL be approvable; older plan cards SHALL show that they were replaced.
Approval SHALL pin a base commit for each member the job uses, shown on the plan card: the member's default branch tip unless the client picks its current HEAD.
All crew worktrees of a member SHALL start from that member's base commit, or from it merged with the branches of earlier steps.
The plan card SHALL warn when a member's main checkout has uncommitted changes, because they are not in the base, and when a submodule's base differs from the commit the umbrella points to.
Before approval, the system SHALL check each deliverable can be met; a `pr` deliverable SHALL need a GitHub remote for each member it changes and a signed-in GitHub CLI, and otherwise the plan SHALL offer a local branch deliverable instead.

#### Scenario: Chat while a plan is open

- **WHEN** a plan card is waiting and the client writes "also add an undo"
- **THEN** the Admiral reads the message and proposes a new plan version

#### Scenario: Old plan card

- **WHEN** the client clicks Approve on a plan card that a newer version replaced
- **THEN** nothing is approved and the card points to the newest version

#### Scenario: Builders hired apart

- **WHEN** two Builders are hired 20 minutes apart and the user switched branches in between
- **THEN** both start from the pinned base commit

#### Scenario: No remote

- **WHEN** a plan delivers a PR in a repository with no GitHub remote
- **THEN** the plan offers a local branch deliverable and does not offer a PR

### Requirement: Plan changes during a job

The client SHALL be able to change a running job at any time: in chat, with Swap on a crew card, or by editing the plan.
The Admiral SHALL be able to propose a change, for example when a crew member is `stuck` or `limited`.
A change SHALL be able to swap a crew member's role, runtime or model, add, remove or reorder steps, change the budget, the deliverables or the member repositories, and change the brief.
Edit plan SHALL open the plan in place in the conversation, where done steps are locked, a running step can be swapped or removed, steps not started can be changed, moved or removed, steps can be added, and the budget and deliverables can be changed.
Edit plan SHALL end with "Review change", which turns the edits into a plan change card, and SHALL NOT apply anything by itself.
Each change SHALL be a new plan version, shown on a plan change card with the difference from the approved version, the crew members it stops or swaps, the open questions it withdraws, what was already delivered, and the spend so far.
Nothing SHALL change until the client approves, and running crew SHALL keep working while the card waits.
On approval, removed steps SHALL be stopped.
Steps that have not started SHALL follow the new version, and a running step SHALL change only when the change names it.
A swapped crew member SHALL be stopped before its replacement starts.
For a swap, the client SHALL choose:

- **Continue its work** (the default) - the replacement starts in the same worktrees on the same branches, with uncommitted changes kept, and a handoff brief with the step's brief, a summary of what was done, the diff from the base, and the step's open questions;
- **Start over** - the replacement gets new worktrees from the base commit on a new branch number, and the old worktrees are kept until close.

A change SHALL NOT undo a merged PR or a delivered result.
A budget SHALL NOT be lowered below the spend so far, and the spend of a swapped crew member SHALL stay in the job's spend.
An approved plan SHALL keep the role and playbook content it stored, so a later edit to a role file or a setting reaches a running job only through a plan change.

#### Scenario: Remove a running step

- **WHEN** the client approves a plan change that removes a running QA step
- **THEN** the QA crew member is stopped

#### Scenario: Edit plan

- **WHEN** the client opens Edit plan, swaps the running Builder 2 to eva, adds a Reviewer and raises the budget, and clicks "Review change"
- **THEN** a plan change card for v3 with those three changes appears, and nothing changes until the client approves it

#### Scenario: Swap a builder and keep its work

- **WHEN** the client asks to move Builder 2 from eva to Claude Code and approves "Continue its work"
- **THEN** the eva Builder stops, and a Claude Code Builder starts in the same worktrees with the 14 changed files and a handoff brief

#### Scenario: Start over

- **WHEN** the client picks "Start over" for a swapped Builder
- **THEN** the new Builder works on a new branch from the base commit, and the old worktree is kept and listed at close

#### Scenario: Admiral proposes a swap

- **WHEN** a Claude Code Builder is `limited` until 15:00 and the job has a Builder role on eva
- **THEN** the Admiral posts a plan change card that swaps the step to eva, and nothing changes until the client approves

#### Scenario: Role file edited mid-job

- **WHEN** the client edits the reviewer role while a job is running
- **THEN** the running job keeps the stored reviewer, and the Admiral offers a plan change to use the new version

### Requirement: Automatic turn limit

Inside an approved job, the automatic Admiral turns SHALL be counted per job and reset by every client action and every finished step.
When the count reaches the job limit, the job SHALL go to `waiting` with a card asking whether to continue.

#### Scenario: Busy bug fix

- **WHEN** a job with two Builders makes the Admiral take many automatic turns in a row
- **THEN** the job keeps going until the per-job limit, and then a "continue?" card appears

### Requirement: Resume after restart

When Fleet starts, every job that is not closed SHALL be checked.
Steps whose crew pane no longer runs SHALL become `interrupted`, and the Admiral SHALL get a summary of each step's worktree state and last turn.
The client SHALL get a Resume or Cancel card for the job, and nothing SHALL resume without it.
Resume SHALL restart each crew member in its own worktree, continuing its previous session in the same runtime.

#### Scenario: Fleet updated mid-job

- **WHEN** Fleet restarts while a job has two running Builders
- **THEN** the job shows `interrupted` with a Resume or Cancel card, and no crew restarts until the client picks Resume

### Requirement: Jobs across member repositories

A plan SHALL be able to change any number of the project's member repositories in one job, with one approval and one budget.
The plan card SHALL list, for each step, the members it changes and the members it only reads.
Each step SHALL work in one job workspace folder that holds a checkout of each member the step needs, laid out as in the project, so relative paths and runner scripts work.
A member the step changes SHALL be on the step's branch; a member it only reads SHALL be at the job's base commit for that member and SHALL NOT be pushed.
Each changed member SHALL deliver its own PR, and each PR SHALL link the job's other PRs.
PRs SHALL merge one at a time in the member order from project setup, and each merge SHALL wait for that PR's checks against its updated base.
When the project has an umbrella repository, the job SHALL end delivery with an umbrella PR that moves each changed submodule to its merged commit, and this PR SHALL open only after the member PRs merge.
A plan SHALL NOT be able to change a repository outside the project; the Admiral SHALL offer to add it as a member first.

#### Scenario: Change across three members

- **WHEN** the client briefs a change that needs `journey-api`, `journey-component-library` and `journey-client`
- **THEN** one plan with one approval starts the job, each Builder works in a job workspace that holds all three members, and the job delivers three linked PRs and one umbrella PR

#### Scenario: Merge order

- **WHEN** the client approves the merge of PRs in `journey-component-library` and `journey-client`
- **THEN** the component library PR merges first, and the client PR merges only after its checks pass again

#### Scenario: Repository outside the project

- **WHEN** a brief needs a repository that is not a member
- **THEN** the plan card says "Add `infra` to this project first" and Approve is disabled

### Requirement: Checks and reviews before delivery

For each member with a GitHub remote, project setup SHALL find the required status checks of the default branch and the review bots that review its PRs, and the user SHALL be able to edit both lists.
The Admiral SHALL NOT present a PR as ready until its required checks pass and each listed review bot has reviewed the newest commit.
Review bot comments SHALL go to the plan's fix step when it has one, and otherwise to the Admiral, and the result card SHALL show which comments are still open.
A required check that does not start within 15 minutes SHALL show a WAITING ON YOU card, and the job SHALL NOT merge until it passes or the client chooses to skip it where the branch rule allows.

#### Scenario: Review bot

- **WHEN** a Builder pushes a fix and the Greptile bot has not yet reviewed the new commit
- **THEN** the PR result card says "Waiting for Greptile" and Merge stays disabled

#### Scenario: Bot asks for a change

- **WHEN** the Greptile bot leaves two comments on a PR and the plan has a fix step
- **THEN** the fix step gets the two comments in its brief, and the result card shows them as open until they are resolved

### Requirement: Other jobs in the project

When a plan is proposed while another job in the same project is running, the plan card SHALL list the paths, with their member, that both jobs are expected to touch, and the Admiral SHALL ask whether to queue the new job or run it in parallel.
The system SHALL limit concurrent crew members per job and across all jobs, with a default of 4, and SHALL queue extra steps.

#### Scenario: Overlapping jobs

- **WHEN** a new plan touches `Sidebar.tsx` while a running job also changes it
- **THEN** the plan card shows the overlap and asks queue or parallel

### Requirement: Client changes are kept

The Admiral SHALL treat changes it did not order, in a worktree or the main checkout, as the client's, and SHALL NOT revert or overwrite them without asking.

#### Scenario: Hand edit mid-job

- **WHEN** the client edits a file in a Builder's worktree
- **THEN** the Reviewer's findings do not ask to revert it, and the Admiral asks before changing it
