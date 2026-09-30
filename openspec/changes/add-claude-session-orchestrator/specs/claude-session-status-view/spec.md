## Purpose

An always-visible view of every tracked Claude Code session, so a developer running many agents can see at a glance which ones need them without an LLM in the loop.

## ADDED Requirements

### Requirement: Sessions are listed in the sidebar

The system SHALL show tracked sessions in a section pinned to the sidebar that stays visible while the user works in any tab.
Each row SHALL show:

- the pane or tab label and git branch;
- a phase indicator;
- time in the current phase;
- estimated cost;
- estimated context usage.

#### Scenario: Live update

- **WHEN** a tracked session changes phase
- **THEN** its row updates without the user taking any action

#### Scenario: Unknown cost

- **WHEN** a session's cost cannot be estimated
- **THEN** the row shows a placeholder, not zero

### Requirement: Sessions that need the user stand out

The system SHALL mark a session as needing the user when it waits for approval or shows a question dialog.
It SHALL mark a session that finished its turn and awaits a prompt as ready, styled less urgently.
Rows SHALL be ordered with sessions needing the user first, then working sessions, then idle ones.

#### Scenario: Permission request

- **WHEN** a session requests permission
- **THEN** its row shows a needs-you badge and moves to the top

### Requirement: Click to focus

The system SHALL switch to the session's tab and focus its pane when the user clicks a row.

#### Scenario: Session in another tab

- **WHEN** the user clicks a row for a session in a background tab
- **THEN** that tab becomes active and its pane receives keyboard focus

### Requirement: Empty and disabled states

The system SHALL hide the section when there are no tracked sessions and tracking is working.
When tracking is turned off, unavailable on the platform, or blocked by a hook install problem, the section SHALL explain why and, where possible, offer the fix.

#### Scenario: Install problem

- **WHEN** the hook could not be installed because `settings.json` is unparseable
- **THEN** the section explains the problem and links to the hook settings
