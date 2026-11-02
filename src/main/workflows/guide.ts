import { STARTERS } from './starters';

const INTRO = `# How to make a Fleet workflow

A workflow is one TOML file. One press starts several agents, each in its own pane. Fleet then joins their work into one report.

## Steps

1. If it is not clear what the agents must do, ask the person first.
2. Write the file with the format below.
3. Call fleet_workflow_create with an id and the whole file. A bad file is refused, and the message says why. Fix it and call again.
4. Tell the person to open the Workflows page and press Review. You cannot approve a file, because a prompt can tell an agent to do anything.
5. After approval, the person presses Run. You can also call fleet_workflow_run. The first time, Fleet asks the person to allow that.

fleet_workflow_create never replaces a file. To change a file, ask the person to edit it in Fleet.`;

const FORMAT = `## Format

A file has stages, or it has agents and a judge. It cannot have both. Use stages for new work.

Top-level keys:

- name: required, up to 80 characters.
- shared: text that every agent reads, up to 20000 characters. Optional.
- board: true or false. The default is true. A board is a shared list of findings, and it stops agents from repeating each other.
- workspace: where agents work.
  - "current" is the default: the project folder. All agents share this folder, so do not let two agents edit the same files.
  - "pr-worktree" makes a new worktree for one pull request. It needs exactly one required input with type = "pr".
  - "new-branch" makes a new worktree on a new branch, so an agent can change code away from the project folder.

[[inputs]], up to 10. Fleet asks the person for these when the run starts:

- name: required, up to 64 characters. It starts with a-z, and then uses a-z, 0-9, _ and -. Do not use the name slug, because {{slug}} is taken.
- label: required, up to 80 characters.
- type: "text" is the default, or "pr", or "issue". "issue" takes a number or a link to an issue in this repo. Fleet reads the issue with gh when the run starts, and it stops the run if it cannot. Each agent's brief then holds the title, the body and the comments. A file can have only one "issue" input.
- required: true is the default.

[[stages]], from 1 to 12. Stages run in order. A stage starts when each agent of the stage before it is done or skipped:

- name: required, up to 60 characters.
- only_with_findings: true skips the stage when the board is empty. It needs board = true, and the first stage cannot use it.

[[stages.agents]], from 1 to 12 in a stage. These agents work at the same time:

- role: required, up to 60 characters. Each role must be different, but an agent with resume = its own role can use it again.
- program: "claude" or "pi". If the person does not say which, ask them. An agent with resume takes the program of the named agent.
- prompt: required, up to 20000 characters.
- access: "read" is the default, and the agent cannot change files. "write" lets it change code. Do not let two agents with "write" work at the same time in one folder.
- talks: true means that the agent talks with a person, and Fleet waits for that person. Such a file cannot run from an automatic rule.
- plan: true means that the agent must get its plan approved before it changes code. It needs access = "write", and the file cannot run from an automatic rule.
- resume: the role of an agent in an earlier stage. This agent goes on with that agent's session, and it remembers that talk. It keeps the access of that agent, unless you set access.

With a finish, the last stage must have one agent. Its summary is the report.

[[agents]], from 1 to 12, in a file with no stages. These agents work at the same time:

- role: required, up to 60 characters. Each role must be different.
- program: required. Use "claude" for Claude Code, or "pi" for Pi. If the person does not say which, ask them.
- prompt: required, up to 20000 characters.

[judge], optional. This agent has the same three keys, and it starts after the others finish. It merges the board, and its finish summary is the report. With no judge, the report joins each agent's summary.

[finish], optional. What happens at the end:

- action: "save-report", "post-pr", "post-issue" or "open-pr". "post-pr" needs workspace = "pr-worktree". It makes Post the main button, and Post sends the report as one PR comment. "post-issue" needs one required input with type = "issue". It makes Post the main button, and Post sends the report as one issue comment. "open-pr" needs workspace = "new-branch". It pushes the branch and opens a pull request, with the report as the body.
- path: where "save-report" writes, up to 400 characters. It is inside the project, and it must end in .md.

No other key is allowed. A workflow cannot run a command. So do not tell agents to use gh: use a "pr" or "issue" input, and a finish action.

## Placeholders

Use {{name}} in shared, in a prompt, or in finish.path, with the name of an input. {{slug}} is also there: pr- and the PR number, or issue- and the issue number, or else the first text input, or else the workflow name, as a safe file name part. For the plain number, use the name of the input, such as {{pr}} or {{issue}}. A placeholder with no matching input is refused.

## Prompts

Say only what the agent must do. Fleet tells each agent how to use the board and how to finish, so do not write that in a prompt. Give each agent its own focus, so they do not do the same work.`;

/** The whole guide. The examples are the real starters, so they always parse. */
export function workflowGuide(): string {
  const examples = STARTERS.map(({ label, text }) => `### ${label}\n\n\`\`\`toml\n${text}\`\`\``);
  return [INTRO, FORMAT, '## Examples', ...examples].join('\n\n');
}
