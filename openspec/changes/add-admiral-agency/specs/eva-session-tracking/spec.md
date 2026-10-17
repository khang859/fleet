## Purpose

Lets Fleet track eva sessions running in its terminal panes the same way it tracks Claude Code sessions, so the Admiral can brief, read, wait on and approve eva crew members.

## ADDED Requirements

### Requirement: eva hook events

The system SHALL accept lifecycle events from eva hooks over the same local hook socket Claude Code uses.
An eva event SHALL be identified by its source and SHALL carry the session id, the pane id from `FLEET_PANE_ID`, the working folder, the event name, the path to eva's session database, and the last record id.
The system SHALL map eva events to the same session phases as Claude Code: starting, processing, waiting for input, waiting for approval, compacting, ended.
The system SHALL ignore eva events whose protocol version it does not know, and SHALL log them once.

#### Scenario: eva turn ends

- **WHEN** eva sends a `Stop` event for a session in a Fleet pane
- **THEN** the session's phase becomes waiting for input and the Admiral is woken if it is waiting on that crew member

#### Scenario: Unknown protocol

- **WHEN** an eva event arrives with an unknown protocol version
- **THEN** the event is ignored and one warning is logged

### Requirement: eva sessions in the registry

eva sessions SHALL appear in the same session registry as Claude Code sessions, marked with their runtime.
The session tools SHALL work for eva sessions the same way as for Claude Code sessions: list, brief, read turns, read one tool result, diff, prompt, and wait.

#### Scenario: List mixed crew

- **WHEN** a job has one Claude Code crew member and one eva crew member
- **THEN** listing sessions shows both, each with its runtime

### Requirement: Reading eva transcripts

The system SHALL read eva transcripts from eva's session database through eva's stable read-only views, opened read-only.
The system SHALL accept a database path from an eva event only when it is eva's own session database for the current user.
Reads SHALL be short, so they never hold back eva's database maintenance, and SHALL wait briefly instead of failing when the database is busy.
The system SHALL read only records after the last record id it has read for that session.
The system SHALL NOT write to eva's session database.
If the views are missing or their version is unknown, the system SHALL report that eva is too old or too new and SHALL still track phases from hook events.

#### Scenario: Incremental read

- **WHEN** the Admiral reads an eva session's turns since its last read
- **THEN** only records with an id above its cursor are read

#### Scenario: Old eva

- **WHEN** the eva session database has no `transcript_v1` view
- **THEN** phase tracking still works and reads return a message that eva must be updated

### Requirement: eva permission requests

When eva sends a permission request event, the session SHALL be waiting for approval, and the request SHALL go to the Admiral as described in `agency-crew`.
The answer SHALL be sent back to eva as the hook's answer.

#### Scenario: Admiral asks the client

- **WHEN** an eva crew member asks to run a command that uses a production AWS profile
- **THEN** the Admiral asks the client on a card, and eva gets the client's answer through the hook

### Requirement: Starting eva

The system SHALL start eva with its goal, name and settings as command-line arguments, not by typing them after start.
The system SHALL deliver later prompts by typing into eva's terminal with bracketed paste.

#### Scenario: Start with a goal

- **WHEN** the Admiral hires an eva crew member
- **THEN** eva starts with the step's goal and the session name, and its first hook event maps to that pane

#### Scenario: Wrong database path

- **WHEN** an eva event names a database path outside eva's session database
- **THEN** the path is ignored and a warning is logged

### Requirement: eva permission enforcement

The system SHALL NOT start eva with its permission bypass option.
eva SHALL use the user's own eva permission settings.
When the installed eva cannot take hook answers, eva SHALL ask in its own pane, and the crew member SHALL show `needs you` with a card that says to answer in the pane.

#### Scenario: eva without hook answers

- **WHEN** an eva crew member asks for permission and the installed eva cannot take hook answers
- **THEN** a card says to answer in the crew pane, and Fleet does not type into it

### Requirement: eva resume and limits

The system SHALL start each eva crew member with a session id chosen by Fleet, and SHALL resume it by that id after a restart.
When eva reports that an API error ended a turn, the session SHALL show the error kind, and a rate limit SHALL make the crew member `limited`.

#### Scenario: Resume eva

- **WHEN** the client picks Resume on an interrupted job with an eva crew member
- **THEN** eva restarts with the same session id in the same worktree
