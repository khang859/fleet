# Pi Code-Review Skill Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a `/skill:code-review` capability for Pi that reviews the current branch's diff against a base ref and writes findings to `docs/reviews/YYYY-MM-DD-<topic>.md`, packaged as a Fleet-bundled Pi skill.

**Architecture:** A single SKILL.md (markdown + frontmatter) shipped under `resources/pi-skills/code-review/`, plus a five-line wiring change in `src/main/pi-agent-manager.ts` to mount Pi's `--skill` flag pointing at the bundled directory. No new TypeScript extension, no IPC, no Fleet UI changes.

**Tech Stack:** TypeScript (Electron main process), vitest, Pi's [Agent Skills standard](https://agentskills.io/specification), electron-builder for production bundling.

**Spec:** `docs/superpowers/specs/2026-04-27-pi-code-review-skill-design.md`

---

## Task 1: Create the bundled SKILL.md

Create the skill content. This file is the deliverable — Pi reads it at runtime, the user gets value from it, all the prompt-engineering research is encoded here. No automated test for the markdown itself; it's exercised at runtime when the user invokes `/skill:code-review`.

**Files:**
- Create: `resources/pi-skills/code-review/SKILL.md`

- [ ] **Step 1: Create the directory**

```bash
mkdir -p resources/pi-skills/code-review
```

- [ ] **Step 2: Write SKILL.md with the full prompt content**

Create `resources/pi-skills/code-review/SKILL.md` with this exact content (copied verbatim from the design spec — do not paraphrase):

````markdown
---
name: code-review
description: Review the current branch's diff for bugs, logic errors, broken edge cases, and project-rule violations. Writes findings to docs/reviews/YYYY-MM-DD-<topic>.md. Use when the user asks to "review", "code review", "check my changes", or "look at my work" before opening a PR. Pass an optional base git ref as argument; defaults to main. Examples: /skill:code-review, /skill:code-review release-1.2, /skill:code-review HEAD~5.
---

# Code Review

You are reviewing the current branch's diff against a base git ref. Your job is to find bugs that would break behavior in production, not to nitpick style. The output is a markdown report saved to disk that the user will paste into a PR description or use as a checklist before merging.

This skill assumes the user is running you inside a git working tree. If `git rev-parse --is-inside-work-tree` returns false, stop and tell the user.

## Inputs

- **Base ref.** Default `main`. If the user passed an argument (visible as `User: <arg>` below), use that as the base ref instead. Validate it exists with `git rev-parse --verify <ref>` before computing the diff.
- **Diff.** Use `git diff <base>...HEAD` (three-dot syntax — diff from the merge-base, not from base's tip). This is the change set the branch introduces.
- **PR-style context.** Read the most recent commit messages on this branch with `git log <base>..HEAD --oneline` to understand author intent.
- **Project rules.** Read the project's `CLAUDE.md` (root and any in directories the diff touches) and `REVIEW.md` if present. Treat clear, unambiguous violations of these as findings.

## Protocol

Three phases, in order. Do all three in a single turn.

### Phase 1 — Find (coverage, not filtering)

Read the diff and identify candidate findings. At this stage your goal is **coverage**: report everything you suspect, including uncertain ones. A separate verification phase will filter. It is better to surface a finding that gets dropped than to silently miss a real bug.

For each candidate, capture:

- **What:** one-sentence description of the issue.
- **Where:** absolute file path plus line number(s) from the post-change file.
- **Why:** the concrete reason — quote the diff line or the rule it violates.
- **Confidence:** `low` / `medium` / `high` (your prior on whether it's real before verification).
- **Severity:** `important` / `nit` / `pre-existing` (defined under "What counts" below).

Look for:

- Code that won't compile or parse (syntax errors, type errors, missing imports, unresolved references).
- Logic that produces wrong results regardless of inputs (off-by-one, inverted conditions, wrong operator, return value not used, mutation through a stale reference, control flow that can't reach a `return`).
- Broken edge cases the change introduces (null/undefined handling on a new code path, empty input, error paths that swallow errors, race conditions on shared state, resource leaks on early return).
- Regressions: behavior the change accidentally alters relative to the original (a refactor that drops a check, a renamed function with a different signature, a removed `await`).
- Clear, unambiguous violations of `CLAUDE.md` or `REVIEW.md` rules where you can quote the rule and the violating line.

Investigate before claiming. Never speculate about code you have not opened. If a finding depends on the behavior of a function in another file, read that file. If you can't read enough to be confident, that finding's confidence is `low`.

### Phase 2 — Verify (drop the unfounded)

For each Phase 1 candidate, re-read enough surrounding code to confirm or refute it. Drop:

- Anything you can't validate without reading code outside the diff that you haven't read.
- Issues that look buggy in isolation but are correct given context you've now read (e.g., the "missing null check" is unreachable because the caller already checked).
- Pre-existing issues that the diff did not introduce — unless the user explicitly asked to flag pre-existing bugs, mark them `pre-existing` and demote to the optional appendix.
- Anything a linter, type-checker, or formatter would catch — those have their own pipeline.
- Anything explicitly silenced in the code (e.g., an `eslint-disable` or `// @ts-expect-error` comment with a justification).

Confidence after verification must be `medium` or `high` to be reported. Drop `low` confidence findings.

### Phase 3 — Write

Pick a kebab-case topic for the filename based on the branch's main change (e.g., `auth-refresh-fix`, `add-pi-review-skill`). Compute the path:

- `<cwd>/docs/reviews/YYYY-MM-DD-<topic>.md` where the date is today.
- If that path already exists, append `-2`, `-3`, etc. until unique.

Use the `write` tool to save the report (see "Output format" below). Make sure `docs/reviews/` exists; use `mkdir -p` via bash if needed. Then tell the user — in chat — the absolute path and a one-line tally (e.g., "Review written to /path/to/file.md — 2 important, 1 nit, 0 pre-existing").

## What counts as a finding

Concrete bar — apply this in Phase 2.

**🔴 Important** (report inline, gate on these before merge):

- Code will fail to compile, parse, or pass type-checking.
- Logic that will produce wrong results for some realistic input.
- A regression: the diff removes or alters behavior that callers depend on.
- A leak, race, or unhandled error path that is reachable in production.
- A clear, citable violation of a project rule in `CLAUDE.md` / `REVIEW.md` that the user has opted in to enforcing.

**🟡 Nit** (report inline, do not block):

- A correctness-adjacent issue that is unlikely to bite in practice (e.g., redundant null check, unused but harmless variable on a new line).
- A `CLAUDE.md` violation that is real but minor.

**🟣 Pre-existing** (report in an appendix, never inline):

- A bug that exists in code the diff touches but was there before the diff. Useful context but not gating.

If a finding doesn't fit any of these, it doesn't belong in the report.

## What to skip

Do not flag any of:

- Pure style, naming, or formatting preferences.
- Missing tests, missing docs, missing comments — unless `REVIEW.md` opts in.
- General code-quality observations ("this function is long", "this could be a helper").
- Refactoring suggestions that aren't responding to a real bug.
- Issues a linter, formatter, or type-checker will catch.
- Issues in code that is explicitly marked as ignored (lint-disable, ts-expect-error with a comment).
- Speculative issues that depend on inputs or state you can't verify.
- Issues outside the diff (unless `pre-existing`, which goes in the appendix).
- Things you cannot cite with a `file:line` reference.

## Output format

The markdown file follows this shape exactly. Match it — the user pastes it into PR descriptions.

```markdown
# Code Review — <branch-name> vs <base-ref>

<one-line summary: "N important, M nits, K pre-existing" — or "No blocking issues found.">

## Findings

### 🔴 Important

#### 1. <one-sentence description>

`path/to/file.ts:123-127`

```ts
// 2-4 lines of context including the cited line
```

<2-3 sentences explaining the issue concretely. Cite the rule or behavior it breaks. Suggest the fix only if it's a one-liner.>

#### 2. ...

### 🟡 Nits

#### 1. <one-sentence description>

`path/to/file.ts:45`

<1-2 sentences. Keep nits terse.>

## Pre-existing (informational)

#### 1. <one-sentence description>

`path/to/file.ts:200`

<1 sentence. These are not blocking.>

---

*Review generated by Pi against `<base-ref>` at `<commit-sha>`.*
```

If a section has no entries, omit the heading. If there are no findings at all, the file body is just the one-line summary "No blocking issues found." plus the trailing footer.

## Worked example

A correct Important finding:

> #### 1. `parseExpiry` returns `0` on malformed input, which downstream is treated as "expired immediately"
>
> `src/auth/session.ts:88-92`
>
> ```ts
> function parseExpiry(raw: string): number {
>   const n = Number(raw);
>   return Number.isFinite(n) ? n : 0;
> }
> ```
>
> Callers at `session.ts:142` use `parseExpiry(token.exp) < Date.now()` to gate refresh. A malformed `exp` field returns `0`, which is always less than `Date.now()`, forcing a refresh on every call. Either return `Infinity` (treat as "no expiry") or throw and let the caller decide.

That finding is reportable because: it cites a specific file:line, the cited code is shown in context, the consequence is concrete (refresh-on-every-call), and the reviewer read the caller to verify the bug actually triggers.

A correct decision to *not* report:

> Phase 1 candidate: "`session.ts:142` doesn't handle the case where `parseExpiry` throws."
>
> Phase 2 verification: re-reading `parseExpiry`, it can't throw — it returns 0 on bad input. The candidate is invalid given Phase 1's other finding. Drop.

That candidate is dropped because Phase 2 confirmed it can't trigger.
````

- [ ] **Step 3: Sanity-check the file landed correctly**

```bash
ls -la resources/pi-skills/code-review/SKILL.md && head -3 resources/pi-skills/code-review/SKILL.md
```

Expected output: file size > 5KB, first three lines are:
```
---
name: code-review
description: Review the current branch's diff for bugs, logic errors, broken edge cases, and project-rule violations. ...
```

- [ ] **Step 4: Commit**

```bash
git add resources/pi-skills/code-review/SKILL.md
git commit -m "$(cat <<'EOF'
feat(pi): add bundled code-review skill

A Pi skill that reviews the current branch's diff against a base ref
and writes findings to docs/reviews/YYYY-MM-DD-<topic>.md. Prompt
applies Anthropic's current code-review prompt-harness guidance:
two-phase find-then-verify, concrete severity criteria (Important /
Nit / Pre-existing), and mandatory file:line citations.

Wiring follows in a subsequent commit.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: TDD the `--skill` flag wiring in `pi-agent-manager.ts`

Add a `getSkillsDir()` and `getSkillPaths()` to `PiAgentManager`, and append `--skill <abs path>` flags in `buildLaunchCommand` after the existing `-e` extension-flag loop. Test-first: confirm the launch command contains the new flag with proper POSIX quoting.

**Files:**
- Modify: `src/main/pi-agent-manager.ts` (add two methods, update `buildLaunchCommand`)
- Modify: `src/main/__tests__/pi-agent-manager.test.ts` (add one test)

- [ ] **Step 1: Write the failing test**

Append this test to `src/main/__tests__/pi-agent-manager.test.ts` inside the existing `describe('PiAgentManager.buildLaunchCommand', ...)` block (after the last `it(...)` and before the closing `});`):

```typescript
  it("appends --skill flags with POSIX-quoted absolute paths to bundled skills", () => {
    const cmd = mgr.buildLaunchCommand(8123, 'tok', 'pane-1', {});
    // The skills dir resolves via app.getAppPath() in tests (mocked to /tmp/fleet-test-app).
    expect(cmd).toContain(
      "--skill '/tmp/fleet-test-app/resources/pi-skills/code-review'"
    );
    // --skill flags must come after the extension -e flags (the binary path
    // separates them; --skill is part of pi's own argv).
    const dashEIdx = cmd.indexOf(" -e '");
    const dashSkillIdx = cmd.indexOf(" --skill '");
    expect(dashEIdx).toBeGreaterThan(-1);
    expect(dashSkillIdx).toBeGreaterThan(dashEIdx);
  });
```

- [ ] **Step 2: Run the test and confirm it fails**

Run:
```bash
npx vitest run src/main/__tests__/pi-agent-manager.test.ts
```

Expected: the new test fails with a message like `expected '...' to contain '--skill ...'`. Existing tests still pass.

- [ ] **Step 3: Implement the production change**

Edit `src/main/pi-agent-manager.ts`. Add a `getSkillsDir()` method and a `getSkillPaths()` method directly after the existing `getExtensionPaths()` method (around line 95). Then update `buildLaunchCommand` to append `--skill` flags after the existing `-e` flag loop.

Add these two methods after `getExtensionPaths()`:

```typescript
  getSkillsDir(): string {
    const resourcesPath = app.isPackaged
      ? join(process.resourcesPath, 'pi-skills')
      : join(app.getAppPath(), 'resources', 'pi-skills');
    return resourcesPath;
  }

  getSkillPaths(): string[] {
    const dir = this.getSkillsDir();
    const skills = ['code-review'];
    return skills.map((s) => join(dir, s));
  }
```

Then in `buildLaunchCommand`, locate the existing extension-flag loop:

```typescript
    for (const ext of extensionPaths) {
      parts.push('-e', posixShellQuote(ext));
    }

    return parts.join(' ');
```

Replace it with:

```typescript
    for (const ext of extensionPaths) {
      parts.push('-e', posixShellQuote(ext));
    }

    for (const skill of this.getSkillPaths()) {
      parts.push('--skill', posixShellQuote(skill));
    }

    return parts.join(' ');
```

- [ ] **Step 4: Run the test again and confirm it passes**

Run:
```bash
npx vitest run src/main/__tests__/pi-agent-manager.test.ts
```

Expected: all tests in this file pass, including the new one.

- [ ] **Step 5: Run the full type-check and lint**

Run:
```bash
npm run typecheck && npm run lint
```

Expected: both pass with no errors.

- [ ] **Step 6: Run the full test suite**

Run:
```bash
npx vitest run
```

Expected: all tests pass — no regressions in the wider suite.

- [ ] **Step 7: Commit**

```bash
git add src/main/pi-agent-manager.ts src/main/__tests__/pi-agent-manager.test.ts
git commit -m "$(cat <<'EOF'
feat(pi): mount bundled skills via --skill flag

Adds getSkillsDir() / getSkillPaths() mirroring the extension-path
pattern, and appends --skill flags to the launch command after the
-e extension flags. The code-review skill is the first to ship.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: Bundle `pi-skills/` in `electron-builder.yml`

`electron-builder.yml` does NOT auto-include `resources/**` — it explicitly enumerates each subdirectory under `extraResources`. Without this entry, the skill ships fine in dev (where `app.getAppPath()` resolves to the repo) but is missing from packaged DMG/EXE/AppImage builds.

**Files:**
- Modify: `electron-builder.yml`

- [ ] **Step 1: Read the current `extraResources` section**

```bash
grep -n -A 8 'extraResources:' electron-builder.yml
```

Expected: shows three existing entries (hooks, mascots, pi-extensions) at roughly lines 15–22.

- [ ] **Step 2: Add the `pi-skills` entry**

Edit `electron-builder.yml`. Locate the existing `extraResources` block (lines 15–22):

```yaml
extraResources:
  - from: hooks/bin/
    to: hooks/
  - from: resources/mascots/
    to: resources/mascots/
  - from: resources/pi-extensions/
    to: pi-extensions/
```

Add a `pi-skills` entry immediately after the `pi-extensions` entry, mirroring its mapping convention (no `resources/` prefix in the destination — matches how `getSkillsDir()` resolves `process.resourcesPath` in packaged builds):

```yaml
extraResources:
  - from: hooks/bin/
    to: hooks/
  - from: resources/mascots/
    to: resources/mascots/
  - from: resources/pi-extensions/
    to: pi-extensions/
  - from: resources/pi-skills/
    to: pi-skills/
```

- [ ] **Step 3: Verify the YAML still parses**

```bash
npx js-yaml electron-builder.yml > /dev/null && echo "yaml OK"
```

Expected: prints `yaml OK`. (If `js-yaml` isn't installed globally, use `node -e "require('js-yaml').load(require('fs').readFileSync('electron-builder.yml','utf8'))"` instead.)

- [ ] **Step 4: Confirm the existing build pipeline still passes type-check and tests**

```bash
npm run typecheck && npx vitest run
```

Expected: both pass.

- [ ] **Step 5: Commit**

```bash
git add electron-builder.yml
git commit -m "$(cat <<'EOF'
build: bundle resources/pi-skills/ in packaged Fleet builds

Adds pi-skills to extraResources so the bundled code-review skill is
present in production DMG/EXE/AppImage outputs, matching the existing
pi-extensions bundling pattern.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: Manual smoke test in dev

Automated tests cover the wiring; the skill prompt itself is exercised at runtime. This task is a one-pass manual verification against a dev Fleet build with an intentional bug planted in the diff. Skip if you've already done equivalent testing.

**Files:** none modified.

- [ ] **Step 1: Build & launch dev Fleet**

```bash
npm run dev
```

Expected: Fleet launches. If it fails to build, fix the underlying issue before continuing.

- [ ] **Step 2: Plant a bug on a throwaway branch**

In a separate terminal, in this same worktree:

```bash
git checkout -b smoke-test-code-review-skill
```

Edit `src/shared/pi-presets.ts` (or any small file). Introduce a deliberate, low-risk bug — for example, change a comparison operator from `===` to `==` in a path that isn't on the hot path. Save.

```bash
git add -A && git commit -m "test: planted bug for smoke test"
```

- [ ] **Step 3: Open Pi in Fleet on this worktree and run the skill**

In the running Fleet app, open a Pi pane in this worktree. Type:

```
/skill:code-review main
```

Expected within ~30 seconds:
- Pi runs `git diff main...HEAD` and reads the diff (visible as tool calls in the TUI).
- Pi reads the file containing the planted bug.
- Pi calls `write` to save a markdown file under `docs/reviews/`.
- Pi posts a final chat message with the absolute path and a tally line.

- [ ] **Step 4: Inspect the produced report**

```bash
ls docs/reviews/
cat docs/reviews/$(ls -t docs/reviews/ | head -1)
```

Expected:
- A file named `<today's date>-<some-kebab-topic>.md` exists.
- The planted bug appears under `### 🔴 Important` with a `path/to/file.ts:NN` citation and 2-4 lines of context.
- No findings about pure style, formatting, or "this could be a helper".

- [ ] **Step 5: Run the empty-diff case**

```bash
git checkout main
```

In Pi, run `/skill:code-review main`. Expected: Pi reports there's no diff and either skips writing a file or writes one with body "No blocking issues found." Confirm whichever shape Pi produces is reasonable; document any surprise.

- [ ] **Step 6: Run the bad-ref case**

In Pi, run `/skill:code-review nonexistent-ref-xyz`. Expected: Pi runs `git rev-parse --verify nonexistent-ref-xyz`, sees it fail, and reports "ref doesn't exist" rather than producing a bogus review.

- [ ] **Step 7: Clean up the smoke test branch**

```bash
git checkout fleet-gold-root-peak
git branch -D smoke-test-code-review-skill
rm -rf docs/reviews/  # only if the smoke-test-produced files weren't already gitignored
```

- [ ] **Step 8: Note any issues for follow-up**

If the smoke test surfaced anything that should be tightened in the prompt (e.g., Pi flagged style nits despite the skip rules; Pi didn't read enough surrounding code; the kebab-case topic was bad), open a separate follow-up task to revise `resources/pi-skills/code-review/SKILL.md`. Do **not** revise the skill mid-implementation — the prompt was approved as a unit; tuning happens after first contact with reality.

---

## Self-Review Notes

**Spec coverage:** all four spec requirements are covered:
- Skill content → Task 1
- Wiring (`getSkillsDir` / `getSkillPaths` / `--skill` flags) → Task 2
- Tests → Task 2 (Step 1)
- electron-builder bundling → Task 3
- Manual verification → Task 4

**Type consistency:** `getSkillsDir()` and `getSkillPaths()` are introduced together in Task 2 Step 3 with consistent signatures. `--skill` flag spelling is identical in test (Task 2 Step 1) and implementation (Task 2 Step 3). Skill directory name `code-review` is consistent across the SKILL.md path (Task 1), the `getSkillPaths()` array (Task 2), and the test assertion (Task 2 Step 1).

**Placeholders:** none. Every code block contains the actual content to write or run. Commit messages are fully specified.
