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
It asks how to report to you, what crew must never do, how crew open pull requests, what a job needs before you see it, what tests a change comes with, and the default budget.
Each question has picks, and you can also answer in your own words.
**What I know about you** shows each answer as a line as you go.

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
- **Past jobs**: the plan edits and answers you gave the Admiral in this project.

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

The Admiral works like a dev team.
You give the brief and answer what only you can.
You hear from it when the work is ready, or when it is stuck.

1. **Brief the Admiral** on the **Bridge**, the first tab in the Admiral's header.
2. The Admiral asks only what it must know about what you want.
   Its questions show under **Waiting on you**.
   How to build it is the Admiral's decision.
3. It opens a job (shown as `j12`) in its own tab and writes a plan: the steps, the crew, what you get back, and a budget.
   The plan starts as soon as Fleet's checks pass.
   Nothing waits for your approval.
4. Crew start in their own panes in the job's tab, each in a worktree on a branch named `admiral/j12/<step>-<n>`.
   Click **Peek** on a crew row to watch one.
5. While work runs, the Admiral says nothing to you.
   Crew commit on their branch and never push.
   When a step is done, Fleet pushes its branch and opens the pull request, as a draft if you prefer drafts.
6. When the work is ready, the Admiral writes a report: what changed, the pull request links, and the choices it made for you.
   A pull request is ready when its required checks pass and each review bot in setup reviewed its newest commit.
7. You merge the pull requests.
   When every pull request of a job is merged on GitHub, Fleet closes the job.
   You can also click **Merge** to have Fleet merge them in order, or **Accept and close**.

A project with no GitHub remote gets a local branch in place of a pull request.

When you or a review bot from setup leaves a review comment on a pull request, the Admiral sends it to the crew to fix.
It does not ask you first.
Fleet pushes the fix to the same pull request.
When the fix is ready, you get a new report.
Comments from other people do not wake the Admiral.

### Change a running job

The plan card in the job's tab has two buttons:

- **Stop** cancels the job.
- **Change something** opens the plan to edit.
  Done steps are locked.
  Click **Send my version**, and it starts as soon as Fleet's checks pass.

To move one step to another role, runtime, or model, click **Swap** on its crew card in the job sheet.

When a check holds a plan back, the card says so.
The Admiral fixes the plan, or asks you when only you can fix it.

**Cancel job** stops the crew and removes worktrees that hold nothing.
A worktree on a local branch the job delivered goes, and the branch stays.
Work that is not committed or pushed is kept.
Past jobs can be exported as Markdown with **Export**.

If you type into a crew pane, the crew member is marked **yours** until you click **Hand back**.

A plan card lists the lines it used under **Using what I know about you**.
The Admiral asks only what those lines do not answer.

## Waiting on you

The Bridge's right column lists everything that waits on you across the project's open jobs: permission requests, questions, ready jobs, and crew that need you.
Permission requests come first, soonest to expire on top.
The **Bridge** tab shows how many items wait.

Each card has its main actions, such as **Allow once**, or the question's options.
Click a card, or its **Read in full** button, to read it in the wide column in place of the conversation.
The reader shows the full permission request with the crew pane's last lines, or the question with every option.
Use **Previous** and **Next** to move through the queue, and **Close** or Esc to go back to the conversation.
Your draft in the composer stays.

### Undo

An answer, a **Stop**, or a plan change waits a few seconds before it runs.
Click **Undo** on its row to take it back.
Today's decisions are listed under **Done today**, with what became of each job.

### Keys

The keys work while focus is in the queue or the reader.
They do nothing while you type in a text box, or while you hold Cmd, Ctrl, Alt, or Shift.

| Key   | What it does                                |
| ----- | ------------------------------------------- |
| J, K  | Move to the next or previous item           |
| Enter | Read the item in full                       |
| Esc   | Close the reader                            |
| A     | Allow the request, or answer                |
| D     | Deny the request                            |
| R     | Go to the answer box, or deny with a reason |

A key does nothing when its button is turned off.

## How the Admiral learns

The Admiral learns on its own, and does not ask you first.

When a job teaches it something about how you like the work, it adds a line to **What the Admiral knows**.
The line shows where it was learned, such as **Learned on j12**.
It saves only what holds for later jobs, and never what a line says already.

When a job ends, Fleet reads the job's record once on the Admiral's model.
It looks for one thing a crew role should do differently next time.
Most jobs teach nothing, and then nothing happens.
When there is a lesson, Fleet changes the project's copy of that role at once.
It never changes the roles Fleet ships, or your own copy for all projects.
Each review is one call inside your monthly cap.

To undo what the Admiral learned, see the next section.

## What the Admiral knows

**Settings > Agency > Admiral > What the Admiral knows** shows every line the Admiral reads at the start of a job.
The **You · every project** tab holds the lines for all projects.
Each project has a tab of its own.
Where a project line and a You line disagree, the project line wins.

Each line shows where it came from and how many jobs used it.
You can edit or remove a line, click **Add a line**, or click **Edit as text** to edit the whole file.

A project tab also lists **Crew lessons**: each change Fleet made to a role, with the job it came from.
Click **Undo** to put the role's old text back.
Fleet refuses, and says why, when you have edited that part of the role since.

A line you add can clash with a rule in `CLAUDE.md` or `AGENTS.md`.
Then the line asks which one wins: **Keep this line**, or the rule file.
If the rule wins, the line is removed.
A line the Admiral takes from **Read your work** that clashes with a rule file is dropped, because crew read the rule file anyway.

If you change a file outside Fleet, the Admiral uses the version Fleet last wrote.
Click **Keep this version** to use your change.

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
A job keeps the crew it started with, so an edit never changes a running job.

The **Runtimes** tab sets how many crew of each runtime work at once and their default model.

## How crew run

- **Claude Code** runs as the normal interactive Claude Code app in a Fleet pane, on your Claude plan.
  Fleet adds its own settings on top of yours, and your permission rules stay in force.
  Fleet never reads or changes your Claude login.
- **eva** runs in a Fleet pane with the server from `~/.eva/config.toml`.
  Fleet reads only the server, never the key.

## Permissions

Crew permission prompts go to the Admiral first.

- The Admiral allows or denies each request by its own judgement against the brief.
- It asks you first for merges, production deploys, deletes, pushes to the default branch, and spending money.

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

A job's budget is a guide only.
At 80%, the Admiral is told, and the job keeps going.
Work stops only at the monthly cap: no new work starts, and you get a card to raise the cap or stop the job.

**Settings > Agency > Admiral** sets:

- **Default job budget** and **Default Claude share** for new plans.
- **Monthly cap**: the most all jobs together may spend in a month. It starts over at 00:00 on the 1st, local time.
- **Keep in reserve**: no new Claude crew work starts once your 5-hour or weekly Claude Code usage reaches these levels, so some is left for you.

eva reports a cost only when its model server does.
So every eva step needs a cap on its turns or minutes.
Fleet stops the crew member at the cap.

### Settings the Admiral changes

The Admiral can change most settings on its own, and the change applies at once.
Its report lists each change, and you can undo it.

Only you can loosen the brakes:

- Raise the monthly cap, a **Keep in reserve** level, or **Automatic turns in a row**.
- Drop a required check or a review bot.
- Add an env file to a project.

When the Admiral needs one of these, it asks you.

## Where Fleet keeps things

| What                     | Where                                     |
| ------------------------ | ----------------------------------------- |
| Project setup and crew   | `~/.fleet/agency/projects/<project-id>/`  |
| What it knows about you  | `~/.fleet/agency/you.md`                  |
| Client file              | `~/.fleet/agency/clients/<project-id>.md` |
| Your roles and playbooks | `~/.fleet/crew/`                          |
| Job worktrees            | `~/.fleet/agency/jobs/<job-id>/`          |
| Jobs, plans and spend    | `~/.fleet/agency.db`                      |
