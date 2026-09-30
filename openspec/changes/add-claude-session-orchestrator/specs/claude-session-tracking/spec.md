## Purpose

Fleet keeps an always-on, accurate record of every Claude Code session running inside its panes, so the status view and the Orchestrator can see what each session is doing and deliver input to it safely.

## ADDED Requirements

### Requirement: Session tracking runs on every supported platform

The system SHALL track Claude Code sessions running in Fleet panes on macOS and Linux, independent of whether the copilot mascot is enabled.
On Windows the system SHALL NOT start tracking and SHALL say so wherever tracking is surfaced.

#### Scenario: Tracking on Linux with copilot disabled

- **WHEN** a user on Linux with the copilot mascot disabled runs `claude` in a Fleet pane
- **THEN** the session appears in the registry and the pane's activity state follows the session's phase

#### Scenario: Toggling copilot does not affect tracking

- **WHEN** the user disables the copilot mascot while sessions are tracked
- **THEN** the mascot window closes and all tracked sessions remain tracked

### Requirement: Hook installation is on by default and safe

The system SHALL install its Claude Code hook entries into each Claude config folder Fleet uses by default, and SHALL provide a setting that turns installation off and removes Fleet's entries.
The installer SHALL preserve every setting and hook it did not create.

#### Scenario: Default install

- **WHEN** Fleet starts with tracking enabled and the hook is not yet installed in a Claude config folder Fleet uses
- **THEN** Fleet adds its hook entries to that folder's `settings.json` and leaves all other content unchanged

#### Scenario: Unparseable settings file

- **WHEN** the existing `settings.json` cannot be parsed or is not a JSON object
- **THEN** Fleet does not write to it, leaves the file byte-for-byte unchanged, and reports the problem in the hook settings UI

#### Scenario: Write is atomic and backed up

- **WHEN** Fleet writes `settings.json`
- **THEN** it first keeps a backup of the previous file and replaces the file atomically, so an interrupted write never leaves a truncated file

#### Scenario: Paths with spaces

- **WHEN** the hook binary lives under a home directory containing spaces
- **THEN** the installed hook command still runs

#### Scenario: Turning tracking off

- **WHEN** the user turns the tracking setting off
- **THEN** Fleet removes only its own hook entries and stops installing them on later launches

### Requirement: Only sessions inside Fleet panes are tracked

The system SHALL track a session only when it runs in a live Fleet pane of the running Fleet instance.

#### Scenario: Session outside Fleet

- **WHEN** Claude Code runs in a terminal that is not a Fleet pane
- **THEN** the session does not appear in the registry

#### Scenario: Pane identity from the environment

- **WHEN** a hook event carries a pane id that belongs to a live pane of this Fleet instance
- **THEN** the session is attributed to that pane without inspecting the process tree

#### Scenario: Older hook binary

- **WHEN** a hook event carries no pane id
- **THEN** the system falls back to matching the Claude process to a pane through its parent processes, and drops the event if no pane matches

### Requirement: Session phases are accurate

The system SHALL report each session's phase as one of starting, processing, waiting for input, waiting for approval, compacting, or ended.
When waiting for input, it SHALL also report whether the session awaits a normal prompt or an answer to a question dialog.
It SHALL record when the phase last changed.

#### Scenario: Subagent finishing does not end the parent's turn

- **WHEN** a session's subagent stops while the parent turn continues
- **THEN** the session's phase stays processing

#### Scenario: Question dialog is distinct from an idle prompt

- **WHEN** a session shows an AskUserQuestion dialog
- **THEN** its phase is waiting for input with kind question, not kind prompt

#### Scenario: Permission request

- **WHEN** a session requests permission to run a tool
- **THEN** its phase is waiting for approval and the pending request, including tool name and input preview, is available

#### Scenario: Process exits without a hook event

- **WHEN** the Claude process exits without sending an end event
- **THEN** the session is marked ended within the periodic liveness check and removed shortly after

#### Scenario: Running session survives the liveness check

- **WHEN** the Claude process is still running, including where the system shell forks to run hooks
- **THEN** the periodic liveness check keeps the session tracked

#### Scenario: Permission denied in the terminal

- **WHEN** the user answers a permission request "No" or cancels it in the terminal, which Claude Code reports through no hook event
- **THEN** once the transcript records the rejection, the session's pending request is cleared and it is reported waiting for a prompt

#### Scenario: Prompt queued while a turn runs

- **WHEN** the user types a prompt while a turn runs, or a background task finishes and queues a turn, and Claude Code starts that turn after the running turn's `Stop` without a hook event of its own
- **THEN** once the transcript records the queued turn starting, the session is reported processing until that turn stops

#### Scenario: Nested Claude in the same pane

- **WHEN** a second Claude process starts in a pane whose session is still running, for example `claude -p` run by a tool
- **THEN** both sessions are tracked, the pane's session is not ended, and the pane keeps reporting its own session

#### Scenario: Clear starts a new epoch

- **WHEN** the user runs `/clear` in a session
- **THEN** the registry starts a new epoch for that pane, and briefs and read cursors from the previous epoch no longer apply

### Requirement: Recent session events are retained

The system SHALL keep a bounded, ordered history of recent hook events per session with a monotonic sequence number, so consumers can ask for events after a known point.

#### Scenario: Reading events after a cursor

- **WHEN** a consumer asks for a session's events after sequence number N
- **THEN** it receives only events with a higher sequence number, oldest first, up to the retention bound

### Requirement: Transcripts are located correctly

The system SHALL read a session's transcript from the path Claude Code reports, and otherwise from the session's Claude config folder, including folders set with `CLAUDE_CONFIG_DIR`.

#### Scenario: Per-workspace config folder

- **WHEN** a pane runs Claude with a workspace-specific `CLAUDE_CONFIG_DIR`
- **THEN** the session's transcript, cost, and brief come from that folder

### Requirement: Session brief

The system SHALL maintain a deterministic brief for each session, built without an LLM and kept current as the transcript grows.
The brief SHALL contain:

- the goal (the first prompt of the epoch);
- the latest todo list;
- the latest plan;
- files edited;
- recent commands, and recent failures with an output tail;
- the last assistant message;
- any pending question with its options;
- git branch and change summary;
- estimated cost and context usage.
  Each item SHALL be versioned so a consumer can ask for only what changed since a known version.

#### Scenario: Brief after a failing test run

- **WHEN** a session runs a command that fails
- **THEN** the brief lists the command as failed with a short tail of its output

#### Scenario: Delta since a version

- **WHEN** a consumer asks for the brief delta since version V
- **THEN** only items changed after V are returned

#### Scenario: Unknown transcript shapes

- **WHEN** the transcript contains entries the system does not recognise
- **THEN** the brief skips them and remains available

### Requirement: Safe prompt delivery

The system SHALL deliver a prompt to a session only when:

- the session is waiting for a normal prompt;
- the user has no unsent text in that pane;
- the user has not typed in that pane in the last few seconds.
  The delivered text SHALL be pasted as a single block and submitted once.
  The system SHALL report delivery as confirmed only after Claude Code acknowledges receipt of the prompt.

#### Scenario: Session is busy

- **WHEN** delivery is requested while the session is processing, waiting for approval, showing a question dialog, compacting, starting, or ended
- **THEN** nothing is written to the pane and the refusal names the session's actual state

#### Scenario: User is typing

- **WHEN** the pane holds unsent text typed by the user
- **THEN** nothing is written and the refusal says the user is typing

#### Scenario: Multi-line prompt

- **WHEN** a prompt containing line breaks is delivered
- **THEN** Claude Code receives it as one prompt, not several

#### Scenario: No acknowledgement

- **WHEN** Claude Code does not acknowledge the prompt within the timeout
- **THEN** the delivery is reported as not confirmed

### Requirement: Hook socket is private

The system SHALL restrict the hook socket to the current user.

#### Scenario: Another local user

- **WHEN** a different local user tries to connect to the hook socket
- **THEN** the connection is refused by file permissions
