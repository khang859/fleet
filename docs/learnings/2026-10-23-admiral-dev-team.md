# Admiral as a dev team: what went wrong on the way

Work on `feat/admiral-dev-team`, which removed plan approval, trust levels, and the Remember this? and lesson cards.

## Bugs the E2E found

### Dev builds blocked every Claude crew job

`c7ff571c` made a dev build skip the hook install (`leftToReleaseApp`), because the installed hook hands a dev pane off to `FLEET_HOOK_BIN`.
`hookBinaryCurrent` still compared the installed hook with the checkout's build byte for byte.
In dev they never match, so the crew check refused every Claude crew plan with "Turn on Track Claude Code sessions", which does nothing in dev.
Fix: `hookBinaryCurrent(configDir, dev = IS_FLEET_DEV)` only checks that the hook is installed in a dev build.
Unit tests did not catch it, because they run with `IS_FLEET_DEV` off.
Only a real job in `npm run drive -- up` showed it.

### A delivered job kept a stale question

Finishing a step withdraws the questions tied to that step.
A job-level question (no `step`) stayed open after the job delivered, so the client still saw it under Waiting on you.
Fix: `afterStepChange` withdraws the job's open questions when the job delivers.
A late answer still reaches the Admiral.

### Cleanup kept the worktree of a delivered local branch

Cleanup deletes a worktree's own branch, so `inspectWorktree` excludes that branch when it counts unsafe commits.
For a `branch` result, the worktree's own branch is the result, so every commit counted as unsafe, and the client got a Leftovers card.
Fix: when the job delivered that branch, cleanup passes `null` as the branch, so the branch stays and the worktree goes.

### Nothing pushed a crew branch, so a PR job could never finish

The E2E on a real GitHub repository showed it.
In auto mode, crew are denied `git push` and `gh pr create`, and the classifier is told "Fleet does these itself after the step".
No Fleet code did it: the only push was the umbrella bump.
The Admiral's brief also asked the crew for "the draft PR URL", so the crew tried to push, was blocked, and the Admiral asked the client a technical question.
Fix: `job_deliver` with `kind: pr` and a `branch` makes Fleet push the branch and open the PR (`workspaces/open-pr.ts`), or push to the PR the branch already has.
It never pushes the default branch.
The push first lived in `results/`, and `git-write-boundary.test.ts` failed: only `workspaces/` and `cleanup/` may write to git.
The crew brief for a `pr` step now says to commit and finish, and the prompt says never to ask crew for a PR URL.
A comment that says Fleet does something is not proof: grep for the code that does it.

### Copy that said the wrong thing

- MeetEnd said "Two last things" when the repository had no `CLAUDE.md`, and only one card showed.
- A held plan said "The Admiral is fixing it" while the job waited on the client.
  It now says "It starts once that is fixed", which is true either way.
- The empty queue still said "New plans ... show here".
- Meet you offered "My call per job: Ask in the plan" for tests, and the read step offered "What you changed in plans".
  The client no longer sees plans.
- The default budget hint said "unless you approve a plan with another budget".

### Prompt gaps

- The Admiral asked about a Claude Code trust screen that already had its own "needs you in its pane" card.
  The prompt now says never to `ask_client` about it.
- A job that left a local branch reported twice: in its tab, and again on the Bridge.
  The Bridge rule covered PR jobs and findings-only jobs, but not a local branch.

## Tooling pitfalls

- GitHub Actions on a private repository of this account do not start: "recent account payments have failed".
  A test fixture repository needs no CI, or setup must list no required checks.
- The test `factsGit` hides every branch named `refs/heads/admiral...`, so use a plain branch name in tests that need one.
- `grep` is aliased to `rg` in this shell, so `grep` flags behave like ripgrep.
  Use `/usr/bin/grep`.
- zsh expands `--include=*.ts` as a glob and fails with "no matches found".
  Quote it: `--include='*.ts'`.
- To read Vitest failures without the huge console output: `npx vitest run <paths> --reporter=json --outputFile=<file>`, then read `numFailedTests` and `failureMessages` from the JSON.
- `npm run drive -- restart` rebuilds `better-sqlite3` for Electron.
  A bare `npx vitest run` after it fails with `NODE_MODULE_VERSION` errors.
  Run `npm run rebuild:node` first, or use `npm test`, which does it in `pretest`.
- The claude-sessions test "pushes changes as one coalesced snapshot" failed now and then in the full run.
  It sent three events over real sockets and expected them inside the 100 ms window, which a busy machine can miss.
  It did not fail alone, even under CPU load.
  Fix: fake `setTimeout` after start, send the events, and advance the clock by hand.
- For scripted edits, assert the old text occurs exactly once before you replace it.
  Otherwise a near-miss silently changes nothing, or changes too much.
- Prompt strings in `agency-prompt.ts` that hold an apostrophe must use double quotes.
- In `pr-reviews.ts`, a type guard on the author narrowed the else-branch to `never`, so the code after it could not use the value.
  Compute the condition without the guard.

## ripwire dead-code hints are not proof

ripwire flagged `diffLine` in `src/shared/agency-plan.ts` as dead.
Deleting it broke `job-plan.ts`, which imports it.
It also flags React components that only JSX uses.
Before you delete a symbol on a dead-code hint, grep the whole tree for it.

## fleet-drive selectors for Meet you

- `click 'text=My pick'` does not press the option.
  Use `click 'role=button[name^="1 "] >> nth=0'`.
- A multi-pick question needs `click 'role=button[name="Send"]'` after the picks.
- The budget question has its picks pressed already, so only Send is needed.
- The Admiral opens only when the focused terminal's folder is a git repository.
  After `cd`, wait a few seconds before you open it.
- Claude Code's folder trust prompt starts on "No, exit".
  Use `term-key down`, then `term-key enter`.
