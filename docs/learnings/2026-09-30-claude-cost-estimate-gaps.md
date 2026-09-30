# Claude session cost estimates were missing for most sessions

Found while building the status view's cost column (`src/main/claude-sessions/usage-accumulator.ts`).

## What happened

The price table in `src/shared/claude-pricing.ts` and `resources/claude-pricing.json` stopped at the Claude 4 families plus `claude-fable-` and `claude-mythos-`.
Transcripts on this machine were almost all `claude-opus-5`, `claude-opus-5-5`, `claude-sonnet-5-5` and `claude-fable-5-1`.
`estimateSessionCostUsd` returns `undefined` when any model in a session is unpriced, so those sessions had no cost at all.

A second cause hid behind the first.
Claude Code records an API error as an assistant message from model `<synthetic>` with every usage field at zero.
The aggregator counted it as a model, and one error line was enough to leave a whole session unpriced.

## How it was fixed

- The table now has `claude-opus-5-5`, `claude-opus-5`, `claude-sonnet-5`, `claude-fable-5-1` and `claude-mythos-5-1`, with the rates from the official pricing page (platform.claude.com/docs/en/about-claude/pricing) on 2026-09-30.
  Opus 5.5 reads its cache at 0.05x input and Fable and Mythos 5.1 at 0.025x, not the usual 0.1x.
- A test keeps the bundled table and the published JSON identical, since the app falls back from one to the other.
- Lines with zero usage are skipped entirely.
- The Sessions tool and the status view both add the subagent transcripts (`listSubagentTranscripts` in `src/main/claude-sessions/transcript-path.ts`).

## How the estimate was checked

Claude Code writes a `cost-state` line with `totalCostUSD` when a session exits.
Comparing the estimate with it across real transcripts gave a ratio of 0.94 to 1.00 for most sessions.
The outliers were sessions that ran subagents: since at least 2.1.285, subagent transcripts live in their own files at `<transcript without .jsonl>/subagents/agent-*.jsonl`, not in the main transcript as `isSidechain` lines.
Adding those files brought the worst case from 0.31 to 0.73.
The rest of the gap is spend the transcripts do not record, which is why the UI calls it an estimate.

## Takeaways

- Before trusting a derived number, compare it with the source's own figure when one exists.
- A price table needs updating with each model launch; an unpriced model shows as a placeholder, never as zero.
- A session's transcript is no longer one file; check the folder beside it.
