# Pi Code-Review Skill — Design

**Date:** 2026-04-27
**Status:** Approved — ready for implementation plan

## Goal

Add a `code-review` capability to the Pi agent in Fleet, packaged as a Pi skill (per the [Agent Skills standard](https://agentskills.io/specification)) that ships bundled with Fleet's resources. When invoked via `/skill:code-review` (optionally with a base ref argument), Pi reviews the current branch's diff for bugs, logic errors, and broken edge cases, and writes the findings to `docs/reviews/YYYY-MM-DD-<topic>.md`.

The skill's prompt applies current Anthropic prompt-engineering best practices specific to code-review harnesses: concrete severity criteria (not qualitative "important"), explicit two-phase find-then-verify, mandatory file:line citations, and a concrete false-positive filter list.

## Non-Goals

- **Pi extension code.** No new TypeScript extension, no tool gating, no mode state, no system-prompt injection. The skill is a self-contained markdown file.
- **Multi-agent / parallel verification.** Anthropic's hosted reviewer fans out across 4 agents; Pi runs a single agent. The skill collapses that pattern into two phases within one turn.
- **GitHub PR integration.** No `gh pr` fetching, no inline comments. Reviews operate on the local working tree's diff against a git ref. PR review is a future extension.
- **Fleet UI surface.** No status bar, no modal, no renderer changes. The findings file lives on disk; the user opens it however they like.
- **Non-Fleet portability work.** The skill ships with Fleet and is wired via Fleet's launch command. Publishing to a public skills repo or supporting non-Fleet Pi installs is out of scope.
- **Hardcoding Fleet's CLAUDE.md rules.** The skill reads whatever `CLAUDE.md` / `REVIEW.md` exists in the cwd at runtime, like Anthropic's hosted reviewer. It works on any project Pi is run in.

## Architecture

Two artifacts:

**A bundled Pi skill** at `resources/pi-skills/code-review/SKILL.md`. A directory containing a single `SKILL.md` (frontmatter + prompt). No helper scripts, no assets — Pi already has the bash, read, grep, find, ls, and write tools needed to compute a diff and produce a markdown report.

**A wiring change** in `src/main/pi-agent-manager.ts`: add `getSkillsDir()` and `getSkillPaths()` mirroring `getExtensionsDir()` / `getExtensionPaths()`, and append `--skill <abs path>` flags in `buildLaunchCommand` after the `-e` flag loop. Pi's `--skill` CLI flag is repeatable and accepts an absolute path to a skill directory.

The skill is discovered by Pi at startup, surfaces in the system prompt as a one-line description (progressive disclosure), and is invokable via `/skill:code-review` or by Pi inferring intent from natural-language requests.

## Behavior

### Invocation

Three ways the skill can run:

1. **Explicit slash command:** `/skill:code-review` — review against `main`.
2. **With base ref argument:** `/skill:code-review release-1.2` or `/skill:code-review HEAD~5` — review against the supplied ref. Per Pi's skill conventions, arguments after the command are appended to the skill content as `User: <args>`.
3. **Implicit invocation:** the user types something like "review my changes" or "code-review this branch" in the Pi chat. The skill description in the system prompt makes Pi load the SKILL.md on-demand. Models don't always do this reliably; the explicit `/skill:code-review` form is the canonical path.

### The Skill Prompt

The full content of `resources/pi-skills/code-review/SKILL.md`:

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

### Output destination

Findings file at `<cwd>/docs/reviews/YYYY-MM-DD-<topic>.md`, where:

- `<cwd>` is the session's working directory (the project Pi is running against).
- `YYYY-MM-DD` is today's date in the session's local time.
- `<topic>` is a short kebab-case slug Pi picks based on the branch's main change.
- Collisions resolve by appending `-2`, `-3`, etc.

`docs/reviews/` is created on demand by Pi using `mkdir -p` via the bash tool. No Fleet-side scaffolding.

### No mode, no tool gating

The skill does **not** restrict tools, change Pi's mode, or inject anything into the system prompt. After the review is written, Pi returns to normal operation — the user can immediately ask "fix #3" and Pi can edit. This is the deliberate divergence from `fleet-plan-mode`, where the user is in a "don't touch the code yet" state and tool gating prevents premature edits.

## Files

- **Create:** `resources/pi-skills/code-review/SKILL.md` — the skill content above.
- **Modify:** `src/main/pi-agent-manager.ts` — add `getSkillsDir()` and `getSkillPaths()`; append `--skill` flags in `buildLaunchCommand` after the `-e` flag loop.
- **Modify:** `src/main/__tests__/pi-agent-manager.test.ts` — extend the existing `buildLaunchCommand` test to assert the `--skill` flags appear with quoted absolute paths to each skill directory.
- **Modify:** `electron-builder.yml` — confirm `resources/pi-skills/**` is included in the packaged app's `extraResources` (it likely already covers `resources/**`; verify and add if not).

No changes in `src/renderer/`, no new IPC, no Fleet UI.

## Testing

Manual verification in a running Fleet + Pi session against this very repo:

1. Make a small intentionally-buggy change on a feature branch (e.g., invert a condition in a non-critical path).
2. In the Pi tab, run `/skill:code-review main`.
3. Confirm Pi reads the diff (visible via tool calls in the TUI), reads the buggy file, and writes a markdown file to `docs/reviews/YYYY-MM-DD-<topic>.md`.
4. Open the file. Confirm: severity table, file:line citations with surrounding context, the planted bug is flagged Important, no nits about formatting.
5. Run `/skill:code-review` with no argument on a clean branch (no diff against main). Confirm Pi handles the empty-diff case gracefully (file body says "No blocking issues found.").
6. Run `/skill:code-review release-1.2` against a non-existent ref. Confirm Pi reports the ref doesn't exist instead of producing a bogus review.
7. Run `/skill:code-review` twice in the same day on the same topic. Confirm the second run writes `<date>-<topic>-2.md`.

Automated test for the wiring:

- Extend `pi-agent-manager.test.ts` to assert `buildLaunchCommand` includes `--skill '/.../resources/pi-skills/code-review'` with proper POSIX quoting.

No automated test for the skill content itself — the prompt is exercised by Pi at runtime, and prompt regressions are best caught by manual review of the produced markdown.

## Open Questions

None blocking. Everything below is a deliberate v1 deferral:

- **Repo-specific tuning via REVIEW.md.** The skill respects `REVIEW.md` if present in the cwd. Fleet itself does not ship a `REVIEW.md` for v1; we'll see what the default skill produces on real Fleet branches before deciding if Fleet needs one.
- **PR review.** Adding `gh pr diff <N>` support is straightforward later — accept either a ref or a `#123` style argument.
- **Streaming progress.** Pi's TUI shows tool calls in real time, which is enough signal. If users want a "phase 1: 4 candidates → phase 2: 2 verified" running tally we can add it via `ctx.ui.notify` calls in a future iteration (would require turning the skill into an extension).
