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

Top-level keys:

- name: required, up to 80 characters.
- shared: text that every agent reads, up to 20000 characters. Optional.
- board: true or false. The default is true. A board is a shared list of findings, and it stops agents from repeating each other.
- workspace: where agents work.
  - "current" is the default: the project folder. All agents share this folder, so do not let two agents edit the same files.
  - "pr-worktree" makes a new worktree for one pull request. It needs exactly one required input with type = "pr".

[[inputs]], up to 10. Fleet asks the person for these when the run starts:

- name: required, up to 64 characters. It starts with a-z, and then uses a-z, 0-9, _ and -. Do not use the name slug, because {{slug}} is taken.
- label: required, up to 80 characters.
- type: "text" is the default, or "pr".
- required: true is the default.

[[agents]], from 1 to 12. These agents work at the same time:

- role: required, up to 60 characters. Each role must be different.
- program: required. Use "claude" for Claude Code, or "pi" for Pi. If the person does not say which, ask them.
- prompt: required, up to 20000 characters.

[judge], optional. This agent has the same three keys, and it starts after the others finish. It merges the board, and its finish summary is the report. With no judge, the report joins each agent's summary.

[finish], optional. What happens at the end:

- action: "save-report" or "post-pr". "post-pr" needs workspace = "pr-worktree".
- path: where "save-report" writes, up to 400 characters. It is inside the project, and it must end in .md.

No other key is allowed. A workflow cannot run a command.

## Placeholders

Use {{name}} in shared, in a prompt, or in finish.path, with the name of an input. {{slug}} is also there: the PR number, or else the first text input, or else the workflow name, as a safe file name part. A placeholder with no matching input is refused.

## Prompts

Say only what the agent must do. Fleet tells each agent how to use the board and how to finish, so do not write that in a prompt. Give each agent its own focus, so they do not do the same work.`;

/** The whole guide. The examples are the real starters, so they always parse. */
export function workflowGuide(): string {
  const examples = STARTERS.map(({ label, text }) => `### ${label}\n\n\`\`\`toml\n${text}\`\`\``);
  return [INTRO, FORMAT, '## Examples', ...examples].join('\n\n');
}
