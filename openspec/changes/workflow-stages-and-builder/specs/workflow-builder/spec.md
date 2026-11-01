## ADDED Requirements

### Requirement: The builder uses the real program

Fleet SHALL make a workflow with an agent only in a terminal pane that runs the real Claude Code or Pi app.
Fleet SHALL NOT use a Fleet chat window, the Agent SDK or `claude -p` for this work.

#### Scenario: A person starts the builder with Claude Code

- **WHEN** a person starts the builder with Claude Code
- **THEN** a terminal pane runs the `claude` app and that app uses the person's own login

#### Scenario: A person starts the builder with Pi

- **WHEN** a person starts the builder with Pi
- **THEN** a terminal pane runs the `pi` app with the read-only flags, the agent asks in plain text, and it can save the draft

### Requirement: The builder agent knows its job

Fleet SHALL start the builder agent with a brief that names its only job and includes the workflow guide.
Fleet SHALL mark the pane as a builder pane, so that the agent has only the tools for this job.

#### Scenario: The person asks for something else

- **WHEN** a person asks the builder agent to change code
- **THEN** the agent has no tool to do it and says that this pane only makes workflows

#### Scenario: The agent calls a run tool

- **WHEN** a builder pane calls `fleet_workflow_run`
- **THEN** Fleet refuses the call

### Requirement: The builder saves one draft

A builder pane SHALL save one draft through `fleet_draft_save`.
The first save SHALL NOT replace a file that exists.
Later saves from that pane SHALL replace only that draft.
Fleet SHALL refuse a bad file and tell the agent why.
Only a builder pane SHALL be able to call `fleet_draft_save`.

#### Scenario: A second save

- **WHEN** the agent saves again from the same pane
- **THEN** the draft changes and the draft pane shows the new version

#### Scenario: A name that exists

- **WHEN** the first save uses the name of an existing file
- **THEN** Fleet refuses the save and the file does not change

### Requirement: A person approves every draft

A draft SHALL NOT run until a person approves it.
A change to an approved draft SHALL need approval again.

#### Scenario: The agent finishes

- **WHEN** the agent says that the draft is ready
- **THEN** a person must check and approve it in Fleet before a run

### Requirement: A person can change a draft later

A person SHALL be able to reopen a draft with the same session and brief.

#### Scenario: Edit with the agent

- **WHEN** a person opens a draft with its builder session
- **THEN** the agent has its earlier talk and can save the same draft

### Requirement: Stage Map editor

The workflow editor SHALL show stages as columns in run order and agents as cards.
Cards in one column SHALL run at the same time.
A person SHALL be able to add, rename, move and remove stages and agents.
The File tab SHALL show the same file.
Fleet SHALL show problems while a person edits.

#### Scenario: A person adds a stage

- **WHEN** a person presses the add button between two columns
- **THEN** a new stage appears there

#### Scenario: A file edit

- **WHEN** a person changes the file in the File tab
- **THEN** the map shows the change

### Requirement: Add agent dialog

The Add agent dialog SHALL ask what the agent does, which program runs it, and what it may do.
Picking a job SHALL fill the other fields.
A job SHALL copy its text into the file, so that approval covers the exact prompt.
The dialog SHALL show which programs are installed.
The dialog SHALL warn when two agents in one stage can change code.

#### Scenario: A person picks a job

- **WHEN** a person picks the Security job
- **THEN** the name, program, access and instructions fill in, and a person can edit them

#### Scenario: Two agents can change code

- **WHEN** a person adds a code-changing agent to a stage that has one
- **THEN** the dialog shows a warning

#### Scenario: Plan approval needs change-code access

- **WHEN** a person picks read-only access
- **THEN** the plan approval choice is off and says that the agent must be able to change code

### Requirement: Live view uses the map

A run page SHALL show the same map as the editor, with each agent's state.
The page SHALL say what the person must do next.

#### Scenario: A run needs a person

- **WHEN** an agent waits for a person
- **THEN** its card and the run badge show Needs you, and the page offers the next action
