# Admiral

An Admiral runs one repository's work for you.
You brief it, it plans the job, it hires Claude Code or eva crew in their own panes, and it brings back the result.
It only comes back to you with questions and results.

## Before you start

> [!WARNING]
> Crew are not sandboxed.
> They run on this Mac with your own logins, tools, SSH keys and cloud CLIs, the same as when you run Claude Code or eva yourself.
> Each crew member works in its own git worktree, and the Admiral answers its permission prompts by the rules below.
> Only brief work you would trust an agent to do with your account.

You need:

- **A model for the Admiral.** An OpenRouter key or a local model server, set up in Agent settings. The Admiral never uses your Claude Code login.
- **At least one crew runtime.** Claude Code 2.1.78 or later, signed in by you, or eva 0.3.0 or later.
- **Optional: the GitHub CLI.** Run `gh auth login` so crew can open pull requests. Without it, crew leave local branches.

## Open the Admiral

The Admiral is on by default.
To turn it off, clear **Enable Admiral** in **Settings > Agency > Admiral**.

To open it, do one of these:

- Click the compass next to **New agent** in the sidebar.
- Run **Open Admiral** from the command palette.

There is one Admiral per repository.
A worktree of the repository opens the same Admiral.
The Admiral runs on this machine only, so it does not open on a remote SSH folder.

The first time, **Meet your Admiral** checks the model, the crew runtimes and the GitHub sign-in.
Then **Pick a project** asks which repository, or which workspace of repositories, the Admiral runs.

## Project setup

Setup reads the project and tells you what it found.
It reads the tip of the default branch from git, runs no code from the repository, uses no model time, and starts no crew.

You can edit each finding:

- **Stack**, **New worktree** (the command that prepares a fresh worktree), **Crew checks**, **CI checks**, **Must pass**, **Review bot**, **Ports** and **Default branch**.
- **Member order** and **Workspace setup** for a workspace of several repositories.
- **Servers** and **Stack slots** for projects that run local servers.
- **Env files**: click **Give to crew** to copy an env file into each new worktree. The Admiral never sees the values.

Click **Looks right** to save.
Setup is saved in Fleet, in `~/.fleet/agency/projects/<project-id>/fleet.agency.toml`.
Nothing is written to the repository, so no commit is needed.

Last, click **Open Claude Code here** and answer Claude Code's folder trust prompt yourself.
Fleet never answers that prompt for you.

## Meet you

Before the first job, the Admiral asks how you like the work, one question at a time.
It asks how to report to you, what crew must never do, how crew open pull requests, what a job needs before you see it, what tests a change comes with, the default budget, and what to do when a job is done.
Each question has picks, and you can also answer in your own words.
**What I know about you** shows each answer as a line as you go.
The last answer sets the project's trust level.

Each answer is saved when you give it.
Click **Finish later** to stop, and **Answer them** on the Bridge to go on.
Questions about you are asked once for every project.
Questions about the project are asked once for each project.
At the end, you can pick rules from `CLAUDE.md` or `AGENTS.md` that the Admiral holds every job to.

## Read your work

After Meet you, the Admiral offers to read some of your work.
It learns faster from what you did than from questions.
Tick what it may read:

- **Instructions**: the project's `CLAUDE.md` and `AGENTS.md`, and your own `~/.claude/CLAUDE.md`.
- **Commits**: the messages of your own last commits in the project.
- **Review comments** and **Pull requests**: yours, on the project's GitHub repository. These need the GitHub CLI.
- **Past jobs**: the plan edits, turn-downs and answers you gave the Admiral in this project.

Fleet reads only what you tick.
It never reads your Claude login, env files, keys, or code.
It masks secrets in what it reads, and sends it once to the Admiral's model.
The read counts against the monthly cap.

The Admiral then shows each line it took, with where it saw it.
Click **Keep** to save a line, or **Not me** to drop it.
Nothing is saved that you do not keep.
To read again later, click **Read my work** in **What the Admiral knows**.

## Import files from the repository

Setup lists agent and crew files it finds under **Found in the repo**:

| File                                                   | What happens                                                |
| ------------------------------------------------------ | ----------------------------------------------------------- |
| `CLAUDE.md`, `AGENTS.md`                               | In place. Crew read them as they are.                       |
| `.claude/skills`, `.eva/skills`, `.agents/skills`      | In place. The runtime loads them.                           |
| `.claude/agents/*.md`                                  | **Import** makes a Claude Code role.                        |
| `.opencode/agents`, `.eva/agents`, `.agents/agents`    | **Import** makes an eva role.                               |
| `.fleet/crew/roles/*.md`, `.fleet/crew/playbooks/*.md` | **Import** adds the role or playbook to the project.        |
| `.fleet/fleet.agency.toml`                             | **Import** fills in the setup findings from the team setup. |

An imported file is a copy.
Jobs keep using your copy when a teammate changes the file in the repository.
When the default branch has a newer version, setup shows **Newer in the repo**.
Click **Review** to see the diff, then **Update** to take it or **Keep mine** to keep your copy.

## Share with team

**Share with team** copies your saved setup and the crew files you imported into `.fleet/` in the main checkout:

- `.fleet/fleet.agency.toml`
- `.fleet/crew/roles/*.md` and `.fleet/crew/playbooks/*.md`

Fleet stages and commits nothing.
You decide whether to commit the files.
The setup file holds no paths from your machine, so a teammate can import it as it is.

## Run a job

1. **Brief the Admiral** on the **Bridge**, the first tab in the Admiral's header.
2. The Admiral opens a job (shown as `j12`) in its own tab and writes a plan: the steps, the crew, what you get back, and a budget.
3. On the plan card, click **Approve plan**, **Change something** to edit it, or **Reject** to say what to do instead.
   Nothing starts until you approve.
4. Crew start in their own panes in the job's tab, each in a worktree on a branch named `admiral/j12/<step>-<n>`.
   Click **Peek** on a crew row to watch one.
5. Questions and cards show under **Waiting on you** in the job sheet, and on the Bridge for every job at once.
   Results come back as cards, such as a pull request.
6. When everything in the plan is in, click **Merge** to merge the pull requests in order after their checks pass, or **Accept and close**.

**Cancel job** stops the crew and removes worktrees that hold nothing.
Work that is not committed or pushed is kept.
Past jobs can be exported as Markdown with **Export**.

If you type into a crew pane, the crew member is marked **yours** until you click **Hand back**.

A plan card lists the lines it used under **Using what I know about you**.
The Admiral asks only what those lines do not answer.

## Waiting on you

The Bridge's right column lists everything that waits on you across the project's open jobs: permission requests, plans, questions, settings cards, delivered jobs, and crew that need you.
Permission requests come first, soonest to expire on top.
The **Bridge** tab shows how many items wait.

Each card has its main actions, such as **Allow once**, **Approve plan**, or the question's options.
Click a card, or its **Read in full** button, to read it in the wide column in place of the conversation.
The reader shows the whole plan with every step, the full permission request with the crew pane's last lines, or the question with every option.
Use **Previous** and **Next** to move through the queue, and **Close** or Esc to go back to the conversation.
Your draft in the composer stays.

### Undo

A decision on a plan or a question waits a few seconds before it runs.
Click **Undo** on its row to take it back.
An approved plan does not hire crew until the time is up.
Today's decisions are listed under **Done today**, with what became of each job.

### Ask for a change

1. In the plan reader, click **Change**.
2. Click the steps your note is about.
   Each one shows as a chip on the note.
3. Type what should change, then press Cmd+Enter (Ctrl+Enter on Windows and Linux).

The Admiral writes the next version of the plan.
Nothing starts until you approve it.
To edit the plan yourself, click **Edit the plan**.

The new version shows what changed: your note under **You said**, the old budget struck through, and each step marked **New**, **Moved up**, **Moved down**, or **Changed**.
Removed steps show in a red dashed row.
Turn off **Show changes** to read the plan without the marks, or click **See v1** to read the version before.

### Keys

The keys work while focus is in the queue or the reader.
They do nothing while you type in a text box, or while you hold Cmd, Ctrl, Alt, or Shift.

| Key   | What it does                                   |
| ----- | ---------------------------------------------- |
| J, K  | Move to the next or previous item              |
| Enter | Read the item in full                          |
| Esc   | Close the reader                               |
| A     | Approve the plan, allow the request, or answer |
| D     | Deny the request, or reject the plan           |
| C     | Ask for a change to the plan                   |
| R     | Go to the answer box, or deny with a reason    |

A key does nothing when its button is turned off, for example on a plan that a check holds.

## Remember this?

When you edit a plan, turn one down, swap a step, or answer a question, the Admiral can ask to remember it.
A **Remember this?** card shows the one line it would save.

- **This project** saves the line for this project.
- **All projects** saves it for every project.
- **Just this job** saves nothing, and the Admiral does not ask about it again on this project.

To save it in your own words, type them in **Or put it your way:** before you pick.
If you ignore the card, nothing is saved.
The Admiral asks once per kind of change, and never asks about what a saved line says already.

## What the Admiral knows

**Settings > Agency > Admiral > What the Admiral knows** shows every line the Admiral reads at the start of a job.
The **You · every project** tab holds the lines for all projects.
Each project has a tab of its own.
Where a project line and a You line disagree, the project line wins.

Each line shows where it came from and how many jobs used it.
You can edit or remove a line, click **Add a line**, or click **Edit as text** to edit the whole file.

A line can clash with a rule in `CLAUDE.md` or `AGENTS.md`.
Then the line asks which one wins: **Keep this line**, or the rule file.
If the rule wins, the line is removed.

If you change a file outside Fleet, the Admiral uses the version Fleet last wrote.
Click **Keep this version** to use your change.

## Trust levels

Each project tab sets **How much I do on my own**.
Fleet enforces the level, not the Admiral.

| Level              | What Fleet does                                                                             |
| ------------------ | ------------------------------------------------------------------------------------------- |
| **Ask me**         | You approve each plan and result. This is the default.                                      |
| **Show me the PR** | A first plan up to the dollar limit starts on its own. You merge the pull requests.         |
| **Ship it**        | Like Show me the PR, and Fleet merges the pull requests when checks pass. It reports after. |

A plan starts on its own only when it is the Admiral's first plan for the job, it stays within the dollar limit and the default Claude share, it adds no new role, and it passes every check.
A changed plan, or anything bigger, waits for you.
Under **Ship it**, a job that delivered only pull requests merges them in order and closes.

## Crew roles and playbooks

A role is a worker the Admiral can hire.
A playbook is a team of roles in order, which the Admiral starts plans from.
Both are Markdown files with frontmatter, and the body of a role is its instructions.

Fleet loads them from three places, and the most specific wins:

| Place                                         | In Settings  |
| --------------------------------------------- | ------------ |
| Bundled with Fleet                            | Fleet        |
| `~/.fleet/crew/`                              | All projects |
| `~/.fleet/agency/projects/<project-id>/crew/` | This project |

A role file looks like this:

```markdown
---
name: builder
description: Builds the change and opens a pull request.
runtime: claude # or eva
model: sonnet # optional
stack: false # true waits for a stack slot to run the project's servers
---

Instructions for the crew member.
```

Edit roles and playbooks in **Settings > Agency > Crew**.
Editing a bundled role saves your own copy in `~/.fleet/crew/`.
A job keeps the crew it was approved with, so an edit never changes a running job.

The **Runtimes** tab sets how many crew of each runtime work at once and their default model.

## How crew run

- **Claude Code** runs as the normal interactive Claude Code app in a Fleet pane, on your Claude plan.
  Fleet adds its own settings on top of yours, and your permission rules stay in force.
  Fleet never reads or changes your Claude login.
- **eva** runs in a Fleet pane with the server from `~/.eva/config.toml`.
  Fleet reads only the server, never the key.

## Permissions

Crew permission prompts go to the Admiral first.

- The Admiral allows what the plan needs: tests, builds, edits in the worktree, and pushing the job's own branch.
- It asks you first for merges, production deploys, deletes, pushes to the default branch, spending money, and anything outside the plan.
- It denies what goes against the plan.

A request for you shows as a permission card with **Allow once** and **Deny**.
If the Admiral does not answer in 90 seconds, or the Admiral is paused, the request goes straight to you.
A card that expires is denied, never allowed.
The expiry is set by **Permission card expiry** in **Settings > Agency > Admiral**.
Every answer is listed under **Permissions** in the job sheet.

## Budgets

Each job has a budget on two meters:

- **Money**: the Admiral's model, eva, and Claude Code paid through an API key.
- **Claude sub**: the share of your weekly Claude Code limit that the job's Claude crew may use.
  Claude Code reports one share for the whole account, so a job's share is an estimate, marked `~`.

At 80% of a budget, the Admiral is told.
At 100%, the job holds and you get a card to raise the budget or stop the job.
At 120%, running crew and the Admiral are interrupted.

**Settings > Agency > Admiral** sets:

- **Default job budget** and **Default Claude share** for new plans.
- **Monthly cap**: the most all jobs together may spend in a month. It starts over at 00:00 on the 1st, local time.
- **Keep in reserve**: no new Claude crew work starts once your 5-hour or weekly Claude Code usage reaches these levels, so some is left for you.

eva reports a cost only when its model server does.
So every eva step needs a cap on its turns or minutes, and you tick a box on the plan card to accept it.
Fleet stops the crew member at the cap.

Cloud costs, such as Neon, Vercel or AWS, are not counted.

## Where Fleet keeps things

| What                     | Where                                     |
| ------------------------ | ----------------------------------------- |
| Project setup and crew   | `~/.fleet/agency/projects/<project-id>/`  |
| What it knows about you  | `~/.fleet/agency/you.md`                  |
| Client file              | `~/.fleet/agency/clients/<project-id>.md` |
| Your roles and playbooks | `~/.fleet/crew/`                          |
| Job worktrees            | `~/.fleet/agency/jobs/<job-id>/`          |
| Jobs, plans and spend    | `~/.fleet/agency.db`                      |
