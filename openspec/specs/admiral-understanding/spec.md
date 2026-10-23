# admiral-understanding Specification

## Purpose

Lets the Admiral learn how the client likes to work, keep it where the client can see and change it, and use it to ask fewer questions and work on its own like a dev team.

## Requirements

### Requirement: Two layers of preferences

The system SHALL keep the client's preferences in two layers: a You layer that applies to every project, and a project layer for each project.
Both layers SHALL be plain Markdown files the client can read and edit, with one preference per line.
Each line Fleet writes SHALL record where it came from and when.
The Admiral SHALL read both layers at the start of every job and every Bridge turn.
Where a project line and a You line disagree, the project line SHALL win.

#### Scenario: Project line wins

- **WHEN** the You layer says "Open PRs ready for review" and the project layer says "Open PRs as drafts"
- **THEN** the Admiral plans that project's work with draft pull requests

#### Scenario: You line reaches a new project

- **WHEN** the client saved "Never push to main" in the You layer and opens an Admiral on a new project
- **THEN** the Admiral's first plan on that project follows "Never push to main" without asking

### Requirement: Meet you

The first time the client opens an Admiral after this change, the Admiral SHALL ask six questions, one at a time.
Each question SHALL offer picks with one recommended, and SHALL accept a free-text answer instead.
The client SHALL be able to skip any question, and to finish later.
Each answer SHALL be saved as a line in the layer the question belongs to, and a side panel SHALL show the saved lines as they are added.
Questions about the client in general SHALL be asked once, for all projects; questions about a project SHALL be asked for each new project.
A project that finished the earlier starter questions SHALL keep those answers and SHALL NOT be asked its project questions again.
Meet you SHALL use no model time.

#### Scenario: Free-text answer

- **WHEN** the client types "e2e tests only for UI changes" instead of picking an option for the tests question
- **THEN** the project layer gets that line, marked as told by the client

#### Scenario: Second project

- **WHEN** the client finished Meet you on one project and opens an Admiral on another
- **THEN** only the project questions are asked

#### Scenario: Finish later

- **WHEN** the client clicks Finish later after four questions
- **THEN** the four answers stay saved and the Bridge opens, and Meet you offers the rest the next time

### Requirement: Read your work

The system SHALL offer to read the client's work to learn preferences, from sources the client ticks:
the project's `CLAUDE.md` and `AGENTS.md`, the client's own `~/.claude/CLAUDE.md`, the client's last 100 commit messages in the project, the client's review comments and pull request descriptions on the project's GitHub repository, and the project's past Admiral jobs.
The system SHALL read nothing that is not ticked, and SHALL never read the Claude login, `~/.claude.json`, env files, keys, or code.
Before sending, the system SHALL mask secrets in the text, and SHALL tell the client the text goes to the Admiral's model once.
The Admiral's model SHALL propose preference lines, each with its layer, its source and the evidence for it.
The client SHALL keep or drop each proposed line, and only kept lines SHALL be saved.
A proposed line that already says what a saved line says SHALL NOT be shown.
The read SHALL count as Admiral spend and SHALL be refused while the monthly cap is reached.

#### Scenario: Keep and drop

- **WHEN** the read proposes three lines and the client keeps two
- **THEN** only those two lines are saved, each marked as read from its source

#### Scenario: Nothing ticked

- **WHEN** the client unticks every source
- **THEN** the read does not start and nothing is sent

#### Scenario: No GitHub sign-in

- **WHEN** the GitHub CLI is not signed in
- **THEN** the GitHub sources show as unavailable and the other sources can still be read

### Requirement: Conflicts with instruction files

When a line the client added clashes with a rule in the project's `CLAUDE.md` or `AGENTS.md`, the system SHALL flag the line with the rule it clashes with.
The client SHALL pick which one wins.
When the line wins, the Admiral SHALL tell crew that the client's line overrides the rule.
When the rule wins, the line SHALL be removed.
A line taken from Read your work that clashes with a rule SHALL be dropped without asking, because crew read the rule anyway.

#### Scenario: Rule wins

- **WHEN** "Skip docs unless asked" clashes with the rule "Update docs with every user-facing change" and the client picks the rule
- **THEN** "Skip docs unless asked" is removed

#### Scenario: Read line clashes

- **WHEN** Read your work takes "Skip docs unless asked" and `CLAUDE.md` says "Update docs with every user-facing change"
- **THEN** the line is dropped and the client is not asked

### Requirement: Learn from you

When a job shows a lasting preference, such as a client plan edit or an answer that applies beyond the job, the Admiral SHALL save it as a line at once, without asking.
The Admiral SHALL pick the layer, and the line SHALL be marked as learned on that job.
The Admiral SHALL save only what holds for later jobs, and SHALL NOT save what a line already says.
The client SHALL be able to remove any learned line in What the Admiral knows.

When a job ends, Fleet SHALL review its record once for a crew lesson.
A lesson SHALL change the project's copy of the role at once, and SHALL NOT change a bundled role or the client's role for all projects.
Each applied lesson SHALL be recorded with the text it replaced, the new text, and the job.

#### Scenario: Removed step

- **WHEN** the client removes the end-to-end test step from a plan for a CLI flag
- **THEN** the project layer gets a line, marked as learned on that job, and later plans for CLI flags leave out end-to-end tests

#### Scenario: Crew lesson

- **WHEN** a job's record shows that the builder forgot to run the linter
- **THEN** the project's builder role gets the lesson, and What the Admiral knows lists it with Undo

### Requirement: What the Admiral knows

The system SHALL show a page with a You tab and a tab for each project, listing every line with its source and the number of jobs that used it.
The client SHALL be able to add, edit and remove lines, and to edit each layer as text.
Lines the client typed by hand SHALL be kept as they are.
Open conflicts SHALL show on the line they belong to, with the choice of winner.
A project tab SHALL list the crew lessons applied to the project's roles, each with Undo.
Undo SHALL put the old text back, and SHALL refuse with the reason when the client has edited that part of the role since.

#### Scenario: Edit a line

- **WHEN** the client edits a line read from commits
- **THEN** the line is saved as told by the client and keeps its use count

#### Scenario: Undo a crew lesson after an edit

- **WHEN** the client edited the text a crew lesson added, then clicks Undo on that lesson
- **THEN** the role is unchanged and the client sees why Undo refused

### Requirement: Plans start on their own

There SHALL be one mode, with no trust levels.
Every plan the Admiral writes SHALL start as soon as it passes Fleet's checks, without a plan card, and the client SHALL see it running with Stop and Change.
A plan with a blocking finding SHALL NOT start; the Admiral SHALL fix it, or ask the client when only the client can.
A plan the client writes SHALL also start once it passes the checks.
Fleet SHALL NOT merge a pull request unless the client asks.
Crew permission requests for risky acts SHALL still go to the client.

#### Scenario: A plan starts

- **WHEN** the Admiral proposes a $25 plan that passes the checks
- **THEN** the plan starts and nothing waits on the client

#### Scenario: A check holds the plan

- **WHEN** a plan delivers a pull request in a repository with no GitHub remote
- **THEN** the plan does not start and the Admiral gets the finding to fix

### Requirement: Preferences used

Each plan SHALL list the saved lines the Admiral used to make it.
The plan card and the job sheet SHALL show them, and each listed line's use count SHALL go up once per job.
The Admiral SHALL NOT ask a question a saved line answers.

#### Scenario: Shown on the plan

- **WHEN** the Admiral plans with "Open PRs as drafts" and "Vitest in **tests**"
- **THEN** the plan card shows both under "Using what I know about you"
