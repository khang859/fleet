## Why

After one real job, the Admiral felt like one Claude Code session with extra steps.
The client approved the plan, watched a log of every crew step, and closed the job by hand.
The Admiral knows almost nothing about the client: four starter answers and the rules picked from `CLAUDE.md`.
So it cannot safely act alone, and it asks what a teammate would already know.

This change makes understanding the client a first step, and uses what the Admiral knows to ask less.
The approved design is the canvas at https://claude.ai/artifact/TzmCVeHrgs52CqGhB37LLH.

## What Changes

- **Two layers of preferences.**
  A new "You" file holds preferences for every project, next to the per-project client file that exists today.
  The project layer wins where the two disagree.
- **Meet you.**
  The first time, the Admiral asks seven short questions, one at a time, each with picks and a free-text answer.
  A side panel shows each line as it is saved.
  This replaces the four starter questions; the starter answers already saved stay.
- **Read your work.**
  The client ticks sources: `CLAUDE.md` and `AGENTS.md`, their last 100 commit messages, their GitHub review comments and pull request descriptions on the project, and past Admiral jobs.
  Fleet sends the ticked text, with secrets masked, once to the Admiral's model, which proposes preference lines with the evidence for each.
  The client keeps or drops each line.
  A proposed line that clashes with a rule in the repository's instruction files is flagged, and the client picks which one wins.
- **Learn from you.**
  When the client changes or rejects a plan, or gives an answer that applies beyond the job, the Admiral asks "Remember this?" once.
  The client picks This project, All projects or Just this job, or rewrites the line.
  Ignoring the card saves nothing, and the Admiral does not ask again about the same kind of change.
- **What the Admiral knows.**
  A page in Settings, with a You tab and a tab per project, lists every line with where it came from and how many jobs used it.
  The client can add, edit and remove lines, or edit the file as text as today.
- **Trust levels per project.**
  Ask me (today's flow), Show me the PR (a plan within the project's auto-start budget starts without a plan card), and Ship it (Fleet also merges the job's pull requests when their checks pass, closes the job, and reports).
  Permission rules for crew do not change.
- **The payoff on the job.**
  Each plan lists the preferences the Admiral used, and the plan card and job sheet show them.
- Not in this change: opening the Admiral without a pane, and the calmer job board.
  Those are the next change.

## Capabilities

### New Capabilities

- `admiral-understanding`: how the Admiral learns the client's preferences (meet, read, learn), keeps them in two layers the client can see and edit, and uses them to ask less and act alone within the client's trust level.

### Modified Capabilities

None in `openspec/specs/`.
The Admiral's existing requirements live in the unarchived change `add-admiral-agency`.
This change supersedes that change's "Starter questions" requirement and extends its "Client file" requirement; see design.md, Migration Plan.

## Impact

- **Main process:** `src/main/agency/projects/client-file.ts` and `src/shared/agency-client-file.ts` gain the You layer; new readers for commits, GitHub review comments, pull request descriptions and past jobs under `src/main/agency/understanding/`; one-shot extraction through `completeOnce` in `src/main/agent/completions.ts`; plan auto-start in `src/main/agency/jobs/index.ts`; Ship it through the merge queue in `src/main/agency/results/merge-queue.ts`.
- **Store:** `~/.fleet/agency.db` gains tables for trust levels, preference uses, open conflicts and declined topics.
- **Files:** a new `~/.fleet/agency/you.md`.
- **Agent tools:** `job_plan` gains `uses`; `client_file_propose` gains a scope and a topic.
- **Renderer:** Meet you replaces `StarterQuestions.tsx`; new Read your work and What the Admiral knows views; plan card and job sheet show the preferences used.
- **Prompt:** `src/shared/agency-prompt.ts` reads both layers and says how to cite them.
- **Privacy:** Read your work sends the ticked text to the Admiral's model (OpenRouter or local), after masking.
  It never reads the Claude login, `~/.claude.json`, env files, keys, or code outside the project.
- **Docs:** `docs/admiral.md`.
