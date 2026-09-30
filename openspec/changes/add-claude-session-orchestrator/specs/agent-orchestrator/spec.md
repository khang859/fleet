## Purpose

Lets an Agent pane act as an Orchestrator over the Claude Code sessions running in Fleet: it reads what they are doing, prompts them, spawns new ones, and is woken when they need attention, while the user keeps control of every action that reaches another terminal.

## ADDED Requirements

### Requirement: Orchestrator mode is per pane

The system SHALL let the user turn orchestrator mode on or off for an individual Agent pane, and SHALL show when it is on.
Fleet tools SHALL be offered only to turns in a pane with orchestrator mode on.

#### Scenario: Regular Agent pane

- **WHEN** a turn runs in an Agent pane without orchestrator mode
- **THEN** no fleet tool is offered to the model

#### Scenario: Mode survives restart

- **WHEN** Fleet restarts with an orchestrator pane in the saved layout
- **THEN** the pane is still in orchestrator mode

### Requirement: Listing sessions

The Orchestrator SHALL be able to list tracked sessions.
Each entry SHALL give:
- a short reference;
- the pane label;
- the project and branch;
- the phase, and whether it needs the user;
- time in phase;
- estimated cost;
- the goal.

#### Scenario: No sessions

- **WHEN** the Orchestrator lists sessions and none are tracked
- **THEN** it is told there are none and why tracking might be unavailable

### Requirement: Tiered reading with a cursor

The Orchestrator SHALL be able to read a session at three levels:
- **brief** - the session brief;
- **turns** - recent turns, with each tool call collapsed to one line;
- **tool** - one tool call's full result, paged.
Brief and turn reads SHALL support "since my last read" through a cursor kept per orchestrator conversation and session.
Prompts the Orchestrator sent SHALL be marked as such in turn reads.
All session content returned SHALL be labelled as untrusted data.

#### Scenario: Reading only what is new

- **WHEN** the Orchestrator reads a session's turns since its last read
- **THEN** only turns after its cursor are returned and the cursor advances

#### Scenario: Session was cleared

- **WHEN** the session started a new epoch since the Orchestrator's last read
- **THEN** it is told the session was cleared and receives the new brief

#### Scenario: Large tool output

- **WHEN** the Orchestrator reads a tool result larger than one page
- **THEN** it receives the first page and how to request the next

#### Scenario: Spoofed marker

- **WHEN** a user types a prompt beginning with the orchestrator prefix themselves
- **THEN** turn reads do not mark it as sent by the Orchestrator

### Requirement: Read-only diff

The Orchestrator SHALL be able to see a session's git status, diff, and recent log for the session's own folder, without write access and without widening the Agent pane's file sandbox.

#### Scenario: Path outside the session folder

- **WHEN** the Orchestrator asks for a diff of a path outside the session's folder
- **THEN** the request is refused

#### Scenario: Credential files

- **WHEN** the Orchestrator asks to view a file the Agent sandbox denies, such as `.env`
- **THEN** the request is refused

### Requirement: Deep reads through a subagent

The system SHALL provide a bundled analyst subagent that has only the read-only fleet tools, for reading a session in depth and returning a short report.
Subagents SHALL never receive tools that send, spawn, wait on, or answer for sessions.
A subagent's reads SHALL NOT move the Orchestrator's cursor.

#### Scenario: Delegated deep read

- **WHEN** the Orchestrator dispatches the analyst on a session
- **THEN** the analyst's report is returned to the Orchestrator and the Orchestrator's cursor for that session is unchanged

### Requirement: Prompting a session

The Orchestrator SHALL be able to send a prompt to a session, stating why it is sending it and what it expects back.
Delivery SHALL follow the safe prompt delivery rules, and the delivered prompt SHALL carry an `[orchestrator]` prefix.
By default the user SHALL be asked to approve each send.
The approval SHALL offer "always for this session", which lasts until the session ends and is never saved.
When the Agent pane has full access, sends SHALL NOT ask.

#### Scenario: Approval card

- **WHEN** the Orchestrator asks to send a prompt without a standing grant
- **THEN** the user sees the target session and the full prompt text and chooses once, always for this session, or no

#### Scenario: Refused send

- **WHEN** the user refuses a send
- **THEN** nothing is written and the Orchestrator is not asked again for the same send in that turn

#### Scenario: Grant ends with the session

- **WHEN** a session with an "always" grant ends
- **THEN** the grant is dropped

### Requirement: Spawning a session

The Orchestrator SHALL be able to open a new tab running Claude Code with an initial prompt, optionally in a new git worktree, after user approval (or under full access).
The spawn SHALL NOT take focus from the user.
The prompt SHALL NOT be saved in the layout.

#### Scenario: Spawn in a worktree

- **WHEN** the Orchestrator spawns a session with a worktree for a git repository
- **THEN** a worktree is created, a new tab opens in it running Claude Code with the prompt, and the user's active tab does not change

#### Scenario: Restart after spawn

- **WHEN** Fleet restarts after a spawn
- **THEN** the restored tab does not run the initial prompt again

#### Scenario: Trust dialog

- **WHEN** a spawned session is held at Claude Code's folder trust dialog
- **THEN** the session is reported as starting and no answer is typed for the user

### Requirement: Waiting for sessions

The Orchestrator SHALL be able to wait until one or more sessions need attention, with a timeout.
The wait SHALL be cancellable by the user.

#### Scenario: Session finishes during wait

- **WHEN** a watched session finishes its turn during a wait
- **THEN** the wait returns with what changed in that session

#### Scenario: Nothing is running

- **WHEN** the Orchestrator waits and no watched session is working
- **THEN** the wait returns immediately and says so

### Requirement: Answering permissions is opt-in

The Orchestrator SHALL be able to allow or deny a session's pending permission request only when the user has enabled that in settings.
The user's deny rules SHALL always apply, including under full access.
Requests for commands that the Agent's permission rules would always ask about SHALL still be put to the user.

#### Scenario: Setting off

- **WHEN** the setting is off
- **THEN** the tool is not offered, and a call that arrives anyway is refused with an explanation

#### Scenario: Deny rule matches

- **WHEN** the Orchestrator tries to allow a command that matches a user deny rule
- **THEN** the request is not allowed

### Requirement: Ledger of orchestrator actions

The system SHALL record each send and spawn in a ledger kept per orchestrator conversation.
Each entry SHALL hold the target, the prompt, why it was sent, what is expected back, and whether it has been answered.
The ledger SHALL be given to the model on every round, so conversation compaction cannot lose it.

#### Scenario: Answer arrives

- **WHEN** the target session finishes its next turn after a send
- **THEN** the ledger entry is marked answered

#### Scenario: After compaction

- **WHEN** the orchestrator conversation is compacted
- **THEN** open ledger entries are still visible to the model on the next round

### Requirement: Wakeups with digests

An orchestrator pane SHALL take a turn automatically when a tracked session:
- finishes a turn;
- requests permission;
- shows a question;
- ends.
The turn SHALL begin from a digest that states, for each session:
- what happened;
- what changed since the Orchestrator last looked;
- any pending question or permission with its options;
- the matching ledger entry.
Events arriving close together SHALL be combined into one digest.
A digest SHALL wait while the pane is busy.
Sessions covered by an active wait SHALL be left out.

#### Scenario: Two sessions finish together

- **WHEN** two sessions finish within the debounce window
- **THEN** the orchestrator pane receives one digest covering both

#### Scenario: Pane is busy

- **WHEN** an event arrives while the orchestrator pane is mid-turn
- **THEN** the digest is delivered after the turn ends

#### Scenario: Enabling mode

- **WHEN** the user turns orchestrator mode on
- **THEN** earlier session history does not produce a digest

### Requirement: Loop and rate limits

The system SHALL stop automatic chains of wakeups after a fixed depth until the user sends a message.
It SHALL limit how many sends and spawns an orchestrator conversation can make in a time window.

#### Scenario: Chain limit reached

- **WHEN** wakeup-started turns reach the chain limit
- **THEN** further digests are held, the pane shows that it is paused, and sends and spawns are refused until the user writes

#### Scenario: Rate limit reached

- **WHEN** the send and spawn limit is exhausted
- **THEN** further sends and spawns are refused with a message saying when they will be allowed again
