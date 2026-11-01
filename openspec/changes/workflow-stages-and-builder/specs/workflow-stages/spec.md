## ADDED Requirements

### Requirement: Stages run in order

A workflow file SHALL be able to declare `stages`, each with one or more agents.
Agents in one stage SHALL run at the same time.
A stage SHALL NOT start until every agent in the earlier stage is done or skipped.

#### Scenario: Reviewers wait for the Lead

- **WHEN** a run has a Lead stage followed by a Review stage
- **THEN** no reviewer starts until the Lead is done

#### Scenario: A failed agent holds its stage

- **WHEN** an agent in a stage fails
- **THEN** the next stage does not start and the run shows Needs you

#### Scenario: A stage with no findings is skipped

- **WHEN** a stage has `only_with_findings = true` and the board is empty
- **THEN** Fleet skips every agent in that stage

### Requirement: Old workflow files keep working

A file with `agents` and an optional `judge` SHALL load and run as it did before.
Its approval SHALL NOT change.
A file with both `agents` and `stages` SHALL be refused.

#### Scenario: An approved old file

- **WHEN** Fleet loads an approved file that has `agents` and `judge`
- **THEN** the file stays approved and shows two stages on the run page

#### Scenario: A file with both shapes

- **WHEN** a file has `agents` and `stages`
- **THEN** Fleet refuses the file and says why

### Requirement: Access per agent

Each agent in a stage file SHALL have `read` or `write` access, with `read` as the default.
Fleet SHALL enforce read access with program tool limits and not with prompt text.
A locked run SHALL make all its agents read only.

#### Scenario: A read-only agent tries to edit

- **WHEN** an agent with `read` access tries to edit a file
- **THEN** the program has no tool to do it

#### Scenario: A locked run

- **WHEN** a locked run starts an agent with `write` access
- **THEN** that agent runs read only

#### Scenario: A read-only Pi agent

- **WHEN** Fleet starts a Pi agent with `read` access
- **THEN** Pi has only its read tools and the Fleet tools, and it ignores project `.pi` files

#### Scenario: A Pi agent in a project with `.pi` files

- **WHEN** Fleet starts a Pi agent from a stage file in a project with `.pi` files
- **THEN** Pi does not stop at its trust question

### Requirement: Agents that talk with a person

An agent with `talks = true` SHALL get no reminder when a turn ends.
Fleet SHALL show Needs you when the agent ends a turn or waits on a question.
Time SHALL NOT count toward the run limit while the run only waits for a person.

#### Scenario: The agent asks a question

- **WHEN** a talking agent waits on a question
- **THEN** the run shows Needs you and Open pane opens that agent's pane

#### Scenario: A Pi agent asks in plain text

- **WHEN** a talking Pi agent asks a question and ends its turn
- **THEN** the run shows Needs you

#### Scenario: A long wait

- **WHEN** a person takes more than the run limit to answer
- **THEN** the run is not cut off

### Requirement: Talking agents need a person at the run

A workflow with a talking agent or a plan agent SHALL NOT run from an automatic rule.

#### Scenario: A person adds a rule

- **WHEN** a person adds an automatic rule for a file with a talking agent
- **THEN** Fleet refuses the rule and says why

### Requirement: Plan approval

A Claude Code agent with `plan = true` SHALL start in Claude Code plan mode.
A Pi agent with `plan = true` SHALL start with read-only tools and send its plan through `fleet_plan_submit`.
A plan agent SHALL have `write` access.
Fleet SHALL save each plan that the agent sends.
Fleet SHALL show the whole plan as a full Markdown page, with tables, code blocks and a section list.
A person SHALL be able to approve the plan, or ask for changes.
A person SHALL pick a build mode when the agent uses Claude Code.
The agent SHALL NOT change code or finish before a person approves the plan.
A locked run SHALL NOT start a file with a plan agent.

#### Scenario: A person approves

- **WHEN** a person approves a Claude Code plan with a build mode
- **THEN** the agent builds in that mode

#### Scenario: A person approves a Pi plan

- **WHEN** a person approves a Pi plan
- **THEN** Fleet starts Pi on the same session with write tools, in a new pane

#### Scenario: A Pi agent before approval

- **WHEN** a Pi plan agent tries to edit a file before approval
- **THEN** Pi has no tool to do it

#### Scenario: Fleet restarts before approval

- **WHEN** Fleet restarts while a Pi plan waits for approval
- **THEN** the agent still has read-only tools

#### Scenario: Another agent sends a plan

- **WHEN** an agent with no `plan = true` calls `fleet_plan_submit`
- **THEN** Fleet refuses the call

#### Scenario: An agent finishes with no approval

- **WHEN** a plan agent calls `fleet_run_finish` before a person approves its plan
- **THEN** Fleet refuses the call

#### Scenario: A plan agent with read access

- **WHEN** a file sets `plan = true` on an agent with `read` access
- **THEN** Fleet refuses the file and says why

#### Scenario: A locked run with a plan agent

- **WHEN** a person starts a locked run of a file with a plan agent
- **THEN** Fleet refuses the start and says why

#### Scenario: A person asks for changes

- **WHEN** a person sends a change request
- **THEN** the agent gets the words, keeps planning and shows a new plan

#### Scenario: A long plan

- **WHEN** a plan has hundreds of lines
- **THEN** the page shows it at full reading size and a person can jump to each section

#### Scenario: An answer from the pane

- **WHEN** a person answers a Claude Code plan in the pane
- **THEN** the run stops waiting and the plan stays readable on the run page

#### Scenario: A new Pi plan

- **WHEN** a Pi agent calls `fleet_plan_submit` while an earlier plan waits
- **THEN** the new plan replaces it on the plan page, and Fleet keeps both versions

### Requirement: Returning agents

An agent with `resume` SHALL continue the session of the named agent from an earlier stage.
Fleet SHALL refuse a `resume` that names no earlier agent.
A returning agent SHALL use the program of the named agent.

#### Scenario: The Lead comes back

- **WHEN** the Fix stage starts with `resume = "Lead"`
- **THEN** the agent continues the Lead's session and shows as its own card

#### Scenario: Another program

- **WHEN** a Pi agent has `resume` with the name of a Claude Code agent
- **THEN** Fleet refuses the file and says why

### Requirement: Handoff between stages

An agent in a later stage SHALL be able to read the approved plan.
A read-only agent SHALL be able to read the changed code as a diff with no permission stop.

#### Scenario: A reviewer starts

- **WHEN** a read-only reviewer starts after the Lead
- **THEN** its brief names the plan and the diff, and it reads both with no question, on Claude Code or Pi

### Requirement: New branch and pull request

The `new-branch` workspace SHALL make a new worktree on a new branch.
The `open-pr` finish action SHALL need `new-branch`, push the branch and open a pull request.
The pull request body SHALL be the summary of the last agent.

#### Scenario: A run finishes

- **WHEN** the last agent is done on a branch with commits
- **THEN** Fleet opens a pull request and shows its link

#### Scenario: No commits

- **WHEN** the branch has no commits at the end
- **THEN** Fleet opens no pull request and says why
