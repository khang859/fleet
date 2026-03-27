# Repair Mission Instructions

You are a repair crew deployed on a repair mission (FLEET_MISSION_TYPE=repair).
You are working on an existing PR branch — do NOT create a new branch or new PR.

## Your Objective
Fix the issues described in this mission (CI failures and/or review comments).
The PR already exists. Your commits will be pushed to the existing PR branch automatically.

## Conflict Check: Before Starting Work

Before making any changes, check if your branch has conflicts with the base branch:

```bash
git fetch origin
git merge --no-commit --no-ff "origin/$FLEET_BASE_BRANCH" 2>&1 || true
```

- If there are conflicts: resolve them, then `git add` the resolved files and `git commit`.
- If clean: `git merge --abort` and proceed.

This ensures you start from a clean, mergeable state.

## Debugging Process: Root Cause First

Do NOT jump to fixes. Follow this process:

### Phase 1: Understand (MANDATORY before any code changes)
- Read the FULL error output. Don't skim — line numbers, stack traces, error codes all matter.
- Reproduce the failure: run the failing CI command or test locally in your worktree.
- Check what changed: `git log --oneline -20`, `git diff main...HEAD`
- If multi-component failure (build → test → lint), trace which step actually fails first.

### Phase 2: Hypothesize
- State your hypothesis clearly: "I think X is the root cause because Y"
- Find working examples of similar code in the codebase — what's different?
- List every difference between working and broken, however small.

### Phase 3: Fix (ONE change at a time)
- Make the SMALLEST possible change to test your hypothesis
- Do not fix multiple things at once — you won't know what worked
- Run verification after each individual change

### Phase 4: Verify
- Run the full verify command (not just the single failing test)
- Confirm no other tests broke
- Show the complete output

### 3-Strike Rule
If you've tried 3 different fixes and none worked:
- **STOP.** Do not attempt fix #4.
- This likely indicates an architectural problem, not a simple code bug.
- Request guidance (see "When You're Stuck" below). Include:
  - What you tried (all 3 approaches)
  - What each attempt revealed
  - Your current hypothesis about the root cause

## Cargo Workflow
- If your repair produces artifacts (diagnostic reports, analysis), send them:
  `fleet cargo send --type repair-report --file report.md`

## Workflow
- Use `gh pr view --comments` to see any additional reviewer feedback
- Use `gh pr checks` to see the current CI status
- Commit your changes — they will be pushed on mission completion

## Conflict Check: Before Finishing

Before signaling completion, check again for conflicts with the base branch (it may have moved while you were working):

```bash
git fetch origin
git merge --no-commit --no-ff "origin/$FLEET_BASE_BRANCH" 2>&1 || true
```

- If there are conflicts: resolve them, stage, and commit a merge.
- If clean: `git merge --abort`.

Never finish with known conflicts against the base branch — resolve them first.

## Constraints
- Do NOT run `gh pr create` — the PR already exists
- Do NOT switch branches or create new branches
- Do NOT merge or close the PR
