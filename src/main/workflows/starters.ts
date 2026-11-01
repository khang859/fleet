import type { WorkflowStarter } from '../../shared/workflows';

const PR_REVIEW = `name = "PR review"
shared = """
Review the pull request in this folder. Do not change code.
Report only real problems, and give the file and line for each one.
"""
board = true
workspace = "pr-worktree"

[[inputs]]
name = "pr"
label = "Pull request"
type = "pr"

[[agents]]
role = "Correctness"
program = "pi"
prompt = "Look for logic bugs, wrong edge cases and broken error handling."

[[agents]]
role = "Best practices"
program = "pi"
prompt = "Look for code that does not follow the patterns of this repo."

[[agents]]
role = "Tests"
program = "pi"
prompt = "Look for changed behavior that has no test, and for weak tests."

[judge]
role = "Lead reviewer"
program = "pi"
prompt = "Read the board, merge repeats, drop weak items, and write the review."

[finish]
action = "post-pr"
`;

const RESEARCH = `name = "Research"
shared = "Answer the question. Give a source for each note. Do not change code."
board = true
workspace = "current"

[[inputs]]
name = "question"
label = "Question"
type = "text"

[[agents]]
role = "Docs"
program = "pi"
prompt = "Read the official docs about: {{question}}"

[[agents]]
role = "Code"
program = "pi"
prompt = "Read this repo for what it shows about: {{question}}"

[judge]
role = "Writer"
program = "pi"
prompt = "Read the board. Write the answer first, then the reasons and the sources."

[finish]
action = "save-report"
path = "docs/research/{{slug}}.md"
`;

const AGENT_TASK = `name = "Agent task"
shared = "Do the task. Keep the change small, and run the tests."
board = false
workspace = "current"

[[inputs]]
name = "task"
label = "Task"
type = "text"

[[agents]]
role = "Worker"
program = "pi"
prompt = "{{task}}"

[finish]
action = "save-report"
path = "docs/tasks/{{slug}}.md"
`;

const BUILD_FEATURE = `name = "Build a feature"
shared = "The task: {{task}}"
board = true
workspace = "new-branch"

[[inputs]]
name = "task"
label = "What to build"
type = "text"

[[stages]]
name = "Talk, plan and build"

[[stages.agents]]
role = "Lead"
program = "claude"
access = "write"
talks = true
plan = true
prompt = """
Read the code first.
Ask the person questions until you agree on what to build.
Then write the plan.
After a person approves it, build it, run the tests and commit your work.
"""

[[stages]]
name = "Review"

[[stages.agents]]
role = "Correctness"
program = "pi"
prompt = "Compare the change with the plan. Look for logic bugs and wrong edge cases."

[[stages.agents]]
role = "Best practices"
program = "pi"
prompt = "Look for code in the change that does not follow the patterns of this repo."

[[stages.agents]]
role = "Tests"
program = "pi"
prompt = "Look for changed behavior that has no test, and for weak tests."

[[stages]]
name = "Fix"
only_with_findings = true

[[stages.agents]]
role = "Lead"
resume = "Lead"
access = "write"
prompt = "Read the board. Fix the real problems, run the tests and commit your work."

[finish]
action = "open-pr"
`;

export const STARTERS: WorkflowStarter[] = [
  {
    id: 'build-feature',
    label: 'Build a feature',
    description: 'One agent talks, plans and builds. Three agents review, then a PR opens.',
    text: BUILD_FEATURE
  },
  {
    id: 'pr-review',
    label: 'PR review',
    description: 'Three agents review one pull request, and one writes the review.',
    text: PR_REVIEW
  },
  {
    id: 'research',
    label: 'Research',
    description: 'Agents collect notes on a question, and one writes the report.',
    text: RESEARCH
  },
  {
    id: 'agent-task',
    label: 'Agent task',
    description: 'One agent does a task that you type.',
    text: AGENT_TASK
  }
];

/** A short file for New, with one agent and a task input. */
export const BLANK_WORKFLOW = `name = "New workflow"
shared = ""
board = true

[[agents]]
role = "Worker"
program = "pi"
prompt = "Say what this agent does."
`;
