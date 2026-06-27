# AI Review posted double "## PR Summary" comments and never actually reviewed

## Symptom

Commenting `/oc` on a PR produced **two near-identical `## PR Summary` comments** (one
from the `review` job, one from `verify`) instead of a real code review. The reviewer
"wasn't reviewing" and comments were "doubled."

## Root cause

The workflow used `anomalyco/opencode/github` (`opencode github run`) for both stages and
relied on two assumptions that were both wrong:

1. **`default_agent` selects the agent but does NOT supply the task.** The run logs
   (`gh run view <id> --log`) confirmed the correct agents were selected
   (`agent: "reviewer"`, `agent: "verifier"`) and they read the real diff files — so
   `default_agent` works fine. But the *task* comes from the action's `prompt` input.
2. **With no `prompt` input and a bare `/oc` (empty `PROMPT`), the action falls back to a
   built-in default prompt** that tells the model to produce a generic PR summary. That
   default user task overrides the agent's system prompt's output-format instructions, so
   both agents emitted `## PR Summary` rather than their custom headers.

Because each of the two jobs hit the same default, both posted a summary → "double comments."
The `action.yml` input is documented as: `prompt: "Custom prompt to override the default prompt."`

## Fix

`docs`/CI only — see `.github/workflows/ai-review.yml` + `.github/ai-review-*.json`.

- Restructured to **one comment, posted only after verification**:
  - `review` job runs the reviewer **headless** via `opencode run` (NOT `opencode github
    run`, which always posts a comment), captures stdout, and **uploads it as a build
    artifact**. It posts nothing and holds a read-only token.
  - `verify` job downloads the artifact and runs the verifier via `opencode github run`
    with the candidate findings spliced into the **explicit `prompt` input** — overriding
    the default-summary behaviour. Only this stage posts.
- The artifact is the private handoff channel (replacing the old reviewer→verifier handoff
  that went through a *public* candidate-findings comment).

## Gotchas / how to debug this class of issue

- **Read the run logs, don't guess.** `gh run view <runId> --log` showed `agent: "reviewer"`
  and the `Read` tool calls — proving the agent ran but the *output format* was wrong. That
  ruled out "default_agent is broken" immediately.
- `issue_comment`-triggered workflows run the workflow file **from the default branch (main)**,
  not from the PR branch. The fix only takes effect once it's on `main`.
- `opencode run` (headless): `--print-logs` routes logs to stderr (stdout = the agent's
  reply), `--dangerously-skip-permissions` auto-approves non-denied tools so it never blocks.
  The config `permission` block (`edit`/`bash`/`webfetch: deny`) keeps it read-only.
- Pass `"$(cat promptfile)"` to embed a diff — command-substitution output is not re-scanned,
  so backticks/`$()` in the diff stay literal (safe). Build the file with a quoted heredoc.
