---
name: code-review
description: >-
  Review the current branch's diff for bugs, logic errors, broken edge cases, and project-rule violations. Writes findings to docs/reviews/YYYY-MM-DD-<topic>.md. Use when the user asks to "review", "code review", "check my changes", or "look at my work" before opening a PR. Pass an optional base git ref as argument; defaults to main. Examples: /skill:code-review, /skill:code-review release-1.2, /skill:code-review HEAD~5.
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
