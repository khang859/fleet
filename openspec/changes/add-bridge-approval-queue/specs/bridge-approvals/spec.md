## Purpose

Let the client approve, answer and decide everything that waits on them from the Bridge, across all open jobs of a project, without opening each job tab, and read long plans in full before they decide.

## ADDED Requirements

### Requirement: Waiting queue on the Bridge

The Bridge SHALL show a "Waiting on you" queue in its right column.
The queue SHALL list every item that waits on the client across all open jobs of the project: permission requests the client must answer, plan versions waiting for a decision, open questions, settings changes waiting for a decision, delivered jobs waiting to be accepted, and crew members that need the client in their pane.
Each item SHALL name its job and its kind.
An item SHALL leave the queue when it no longer waits on the client, whoever resolved it.
The past jobs list SHALL stay on the Bridge below the queue.

#### Scenario: Items from two jobs

- **WHEN** job j23 has a permission request for the client and job j24 has a proposed plan and an open question
- **THEN** the Bridge queue shows all three items, each with its job id and kind, without the client opening either job tab

#### Scenario: Resolved elsewhere

- **WHEN** a queue item is resolved on its job tab, in the crew pane, by the Admiral or by expiry
- **THEN** the item leaves the Bridge queue

#### Scenario: Job sheet unchanged

- **WHEN** the client opens a job tab
- **THEN** the job sheet shows that job's waiting items as before

### Requirement: Queue order

The queue SHALL put permission requests that have an expiry first, soonest expiry first.
All other items SHALL follow, oldest first.

#### Scenario: Expiring request first

- **WHEN** a plan has waited 5 minutes and a permission request that expires in 1 minute arrives
- **THEN** the permission request is first in the queue

### Requirement: Bridge tab count

The Bridge tab SHALL show the number of queue items as an amber badge whenever the number is above zero, on every tab of the Admiral pane.
The badge SHALL not show when the queue is empty.

#### Scenario: Count from a job tab

- **WHEN** the client is on job tab j23 and 3 items wait across the project
- **THEN** the Bridge tab shows a badge with 3

### Requirement: Inline actions

Each queue card SHALL offer the main actions of its kind without the reader: Allow once and Deny for a permission request, Approve, Change and Reject for a plan, the options and a free answer for a question, and the existing actions for the other kinds.
A refused action SHALL show the reason on the card and keep the item in the queue.

#### Scenario: Allow from the queue

- **WHEN** the client presses Allow once on a permission card in the Bridge queue
- **THEN** Fleet allows that one request and the card leaves the queue

#### Scenario: Refused approval

- **WHEN** the client approves a plan version that the Admiral has already replaced
- **THEN** the card says why the approval was refused, and the newer version shows in the queue

### Requirement: Undo for plan and question decisions

A plan approval, a plan rejection, a change request or a question answer given from the Bridge SHALL be held for 5 seconds before Fleet carries it out.
While it is held, the queue SHALL show the decision in one line with an Undo that cancels it and puts the item back.
A held decision SHALL be carried out at once when the Admiral pane closes or Fleet quits.
Permission answers SHALL be carried out at once, with no undo.

#### Scenario: Undo an approval

- **WHEN** the client approves a plan from the Bridge and presses Undo within 5 seconds
- **THEN** Fleet does not approve the plan, no crew is hired, and the plan card is back in the queue

#### Scenario: Approval goes through

- **WHEN** the client approves a plan from the Bridge and does nothing for 5 seconds
- **THEN** Fleet approves the plan

#### Scenario: Pane closes while held

- **WHEN** the client answers a question from the Bridge and closes the Admiral pane within 5 seconds
- **THEN** Fleet sends the answer

### Requirement: Reader

Opening a queue item SHALL show it in full in the Bridge's wide main column, in place of the conversation, while the queue stays in the right column with that item marked as being read.
The reader SHALL keep the item's actions in a footer that stays in view while the content scrolls.
The reader SHALL show the item's place in the queue and offer Previous and Next.
Leaving the reader SHALL show the conversation as the client left it.
When the item on screen leaves the queue, the reader SHALL move to the next item, or back to the conversation when the queue is empty.

#### Scenario: Open and leave

- **WHEN** the client opens a plan from the queue and then presses Esc
- **THEN** the plan shows in the main column while open, and the conversation shows again after Esc with the draft in the composer kept

#### Scenario: Item resolved while open

- **WHEN** the plan on screen in the reader is approved on its job tab
- **THEN** the reader shows the next queue item

### Requirement: Plan reader content

The plan reader SHALL show the job, the version, the client's brief, the plan summary, the budget, the share of the Claude week when the plan names one, the number of crew members, the steps in order, and the saved preference lines the plan uses with where each came from.
Each step SHALL show its title, role, runtime and model when set, skills, what it hands back, the steps it waits on, and its cap when set.
The plan reader SHALL show everything the plan card shows before approval: new roles, where the work starts, env files, cautions and the checks that hold approval.

#### Scenario: Long plan

- **WHEN** a plan has 9 steps and the client opens it in the reader
- **THEN** every step shows in full, the content scrolls, and the actions stay in view

### Requirement: Ask for a plan change

The client SHALL be able to ask the Admiral for a change to a proposed plan with a note, in place of editing the plan.
The client SHALL be able to point the note at one or more steps.
Asking for a change SHALL send the note and the steps it points at to the Admiral, close the version as replaced, and start nothing.
The direct plan edit SHALL stay available.

#### Scenario: Change with a note

- **WHEN** the client points at step 3 and sends "Do #63 first, it blocks the release"
- **THEN** plan v1 is replaced, the Admiral gets the note with step 3 named, and no crew is hired until the client approves a later version

### Requirement: Changes since the previous version

A plan version after the first SHALL show what changed since the version before it, whether that version was approved, rejected or replaced.
It SHALL show the client's note on the version before it, when there is one.
Changed budget, Claude week share and crew count SHALL show the old value next to the new one.
Added, removed, moved and changed steps SHALL be marked, and a changed step SHALL name what changed.
The client SHALL be able to hide the marks and to open the version before it.

#### Scenario: Version 2 after a change request

- **WHEN** the Admiral writes v2 after the client's note on v1, with a lower budget and two steps swapped
- **THEN** v2 shows the note, the old and new budget, and both steps marked as moved

### Requirement: Permission reader content

The permission reader SHALL show the crew member and job, the tool and its full target, the time left before the request is denied, why the request came to the client, the checks of the job's pull requests when it has any, and the last lines the crew member's pane shows.
Env file values given to the crew SHALL be masked in those lines.
The reader SHALL offer to show the crew pane.

#### Scenario: Pane lines masked

- **WHEN** the crew pane shows a line holding a value from an env file the client gave the job
- **THEN** the permission reader shows that line with the value masked

### Requirement: Deny with a reason

The client SHALL be able to deny a permission request with a short reason.
The crew member SHALL get the reason with the deny, where its runtime takes one.

#### Scenario: Reason reaches the crew

- **WHEN** the client denies `gh pr merge 61` with the reason "I merge myself"
- **THEN** the request is denied and the crew member's runtime gets "I merge myself" as the reason

### Requirement: Question reader content

The question reader SHALL show the question, the Admiral's context for it, every option with its detail and the Admiral's pick marked, and the free answer box.

#### Scenario: Answer from the reader

- **WHEN** the client picks an option in the question reader and presses Answer
- **THEN** the answer is held for undo like an answer from a queue card

### Requirement: All clear and done today

When nothing waits on the client, the queue SHALL say so.
The queue SHALL list the client's decisions of the current day across the project's jobs, newest first, each with its job and outcome.

#### Scenario: Empty queue

- **WHEN** the client resolves the last waiting item
- **THEN** the queue says nothing waits on the client and the Done today list shows that decision first

### Requirement: Queue keys

While focus is in the queue or the reader, J and K SHALL move to the next and previous item, Enter SHALL open the item in the reader, Esc SHALL leave the reader, A SHALL approve or allow, D SHALL deny, C SHALL start a change request, and R SHALL move focus to the answer or reason box.
The keys SHALL do nothing while focus is in a text field or with a modifier key held, and SHALL never act outside the queue and the reader.
The queue and the reader SHALL show the keys as hints.

#### Scenario: Typing in the composer

- **WHEN** the client types "a" in the Bridge composer while a plan waits
- **THEN** the letter goes into the composer and no plan is approved
