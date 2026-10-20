## ADDED Requirements

### Requirement: Review after a job

When a job that ran at least one crew member ends, the system SHALL ask the Admiral's model once for at most one change to a role the job's crew ran with.
The request SHALL hold the job's record and the role files, with env file values and credentials masked.
The system SHALL NOT review a job that ran no crew, and SHALL NOT review a job twice.
The review SHALL count toward the monthly cap, and SHALL be skipped when the cap is reached or the Admiral has no model.

#### Scenario: Job with crew ends

- **WHEN** a job whose builder step ran is accepted and its cleanup ends
- **THEN** the system asks the Admiral's model once for a lesson about the builder role

#### Scenario: Job without crew

- **WHEN** the client cancels a job before any step started
- **THEN** no review runs

### Requirement: Evidence-backed lessons only

The system SHALL keep a lesson only when the role exists, the text it replaces appears in the role exactly once, the role grows by at most 600 characters and stays within the role limit, and the lesson names a cue and evidence.
The system SHALL NOT keep a lesson the client turned down before on the same project.
A lesson that fails a check SHALL be retried once with the reason, and then dropped.

#### Scenario: Replaced text is not in the role

- **WHEN** the model's lesson replaces a sentence the builder role does not contain, twice
- **THEN** no card goes up

#### Scenario: Turned down before

- **WHEN** the client picked Not now on a builder lesson with the same cue
- **THEN** the same lesson is not proposed again on that project

### Requirement: The client approves every lesson

A kept lesson SHALL go up as a card on the project's Bridge that shows the role, the cue, the evidence, and the text removed and added.
A project SHALL have at most one open lesson card.
No role file SHALL change until the client approves the card.
A bundled role SHALL never be changed: the client's pick SHALL save a copy for the project or for all projects.

#### Scenario: Approve for this project

- **WHEN** the client picks This project on a lesson for the bundled builder role
- **THEN** the project's crew folder gets a builder role with the change, and the bundled file is unchanged

#### Scenario: Role changed before the answer

- **WHEN** the client edits the builder role so the replaced text is gone, then approves the card
- **THEN** the answer is refused and no file is written

#### Scenario: Not now

- **WHEN** the client picks Not now
- **THEN** no file is written and the lesson's topic is remembered as turned down
