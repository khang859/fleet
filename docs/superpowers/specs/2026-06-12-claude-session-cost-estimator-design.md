# Claude Session Cost Estimator + Metadata — Design

**Date:** 2026-06-12
**Status:** Approved, pending implementation plan
**Scope:** Sessions tool only. Claude Code sessions only (Rune untouched).

## Goal

Show, per Claude Code session, an estimated USD cost and richer metadata (model(s)
used, token breakdown, git branch, start/end + duration). Cost is computed
client-side from token counts in the transcript × a per-model pricing table, since
Claude Code does not persist cost to its JSONL transcripts.

Display in **both** places:
- **Session list row** — a compact cost badge (e.g. `$1.42`).
- **Transcript detail header** — a fuller metadata strip.

## Background (current state)

The Sessions tool already parses Claude Code transcripts. Key files:

- `src/main/sessions/claude-source.ts` — lists/reads `~/.claude/projects/<dir>/<id>.jsonl`.
- `src/main/copilot/conversation-reader.ts` — `parseClaudeTranscript` (line parser).
- `src/shared/sessions.ts` — `SessionSummary`, `SessionTranscript`, `TranscriptMessage`, `TokenUsage`.
- `src/renderer/src/components/sessions/SessionList.tsx` — left list.
- `src/renderer/src/components/sessions/TranscriptView.tsx` — right detail.

Today the Claude path reads `type`, `uuid`, `timestamp`, `message.content`, and `cwd`.
It does **not** read `message.usage` or `message.model`. There is no pricing table
anywhere in the repo. `SessionSummary.model` exists but is only populated for Rune.

### Transcript shape (verified on-disk)

Assistant entries carry `message.model` (e.g. `claude-fable-5`, `claude-opus-4-8`) and
`message.usage`:

```json
{
  "input_tokens": 10929,
  "cache_creation_input_tokens": 7594,
  "cache_read_input_tokens": 16484,
  "output_tokens": 393,
  "cache_creation": { "ephemeral_1h_input_tokens": 7594, "ephemeral_5m_input_tokens": 0 }
}
```

Top-level entries also carry `gitBranch`, `sessionId`, `version`, `timestamp`. There is
no `costUSD` / `total_cost_usd` field. A session can use multiple models (a `/model`
switch mid-session produces several distinct `message.model` values).

## Architecture

### 1. Pricing — three-tier resolution

Cost is resolved best-effort, never a hard dependency:

```
fresh remote JSON  →  last cached remote  →  bundled hardcoded table
   (best)              (offline / stale)      (always works, ships in app)
```

The app can always price a session on its own; the remote is an enhancement that lets
us fix pricing without an app release.

#### Bundled table + matcher — `src/shared/claude-pricing.ts`

Prefix-keyed table (longest-prefix match on `message.model`), so future point releases
within a known family resolve without any change:

| Prefix | input $/MTok | output $/MTok |
|---|---|---|
| `claude-fable-`, `claude-mythos-` | 10 | 50 |
| `claude-opus-4-` | 5 | 25 |
| `claude-sonnet-4-` | 3 | 15 |
| `claude-haiku-4-` | 1 | 5 |

Cache multipliers (uniform today, carried per-entry to future-proof):
`cacheReadMult = 0.1`, `cacheWrite5mMult = 1.25`, `cacheWrite1hMult = 2.0`.

Cost formula (per model, summed across models in a session):

```
cost = input        × input/1e6
     + output       × output/1e6
     + cacheRead    × input/1e6 × 0.1
     + cacheWrite5m × input/1e6 × 1.25
     + cacheWrite1h × input/1e6 × 2.0
```

Exports:
- `PriceTable` (zod-validated type), `BUNDLED_PRICES`.
- `resolvePrice(model, table): ModelPrice | undefined` — longest-prefix match.
- `estimateCostUsd(usage, model, table): number | undefined` — `undefined` when the
  model matches no prefix (→ UI shows "unavailable", never a wrong number).

#### Remote fetch — `src/main/sessions/pricing-source.ts`

- Main process owns the fetch (renderer never fetches).
- On app launch (and at most once per ~24h TTL), GET the hosted JSON with a ~3s timeout.
- Validate with the same zod schema. Invalid → discard, keep previous.
- Persist the validated copy to `userData/claude-pricing.json`.
- Resolution at read time: in-memory fresh copy → `userData` cached copy → `BUNDLED_PRICES`.

Hosted artifact — a JSON file committed in this repo, fetched via raw URL:

```
https://raw.githubusercontent.com/khang859/fleet/main/resources/claude-pricing.json
```

(Final in-repo path decided in the plan; `resources/` is the likely home.)

```json
{
  "schemaVersion": 1,
  "updated": "2026-06-12",
  "models": [
    { "prefix": "claude-fable-",  "input": 10, "output": 50,
      "cacheReadMult": 0.1, "cacheWrite5mMult": 1.25, "cacheWrite1hMult": 2 }
  ]
}
```

`schemaVersion` lets the app reject a future incompatible shape and fall back. The
bundled table and the hosted JSON share the same shape so the file is literally the
serialized bundled table.

**Why raw.githubusercontent over GitHub Pages:** the repo is public (`khang859/fleet`),
so the raw URL needs no auth and no Pages setup. Pinning to `main` means a merge
propagates to every client within the 24h TTL — no app release. raw URLs carry a ~5-min
Fastly CDN cache, irrelevant given our daily fetch. **Dependency:** this requires the repo
to stay public; if it ever goes private the raw URL 404s/401s and the app simply falls
back to the cached/bundled table (safe — it just stops auto-updating).

### 2. Parsing — aggregate usage in `claude-source.ts`

`listClaudeSessions` already reads each JSONL fully. Add an aggregation pass over
assistant entries:

- Sum `input_tokens`, `output_tokens`, `cache_read_input_tokens`.
- Split cache writes via `cache_creation.ephemeral_5m_input_tokens` /
  `ephemeral_1h_input_tokens`; fall back to `cache_creation_input_tokens` (treat as 5m)
  when the split is absent.
- **Dedup by `message.id`.** Claude Code writes one JSONL line per content block, each
  repeating the same `message.id` and the same `usage` object. Counting every line
  double-counts tokens. Aggregate one usage contribution per distinct `message.id`.
  This is the primary correctness trap.
- Collect distinct `message.model` values (ordered by first appearance).
- `gitBranch` from the first entry carrying it.
- First and last `timestamp` → `startedAt` / `endedAt` (duration derived in UI).
- Sidechain (subagent) entries **are** included — they cost real money.

Compute cost at list time via `estimateCostUsd` using the resolved price table.

### 3. Shared types — `src/shared/sessions.ts`

Extend `SessionSummary` (all optional; absent for Rune):

```ts
export type ClaudeUsage = {
  input: number; output: number;
  cacheRead: number; cacheWrite5m: number; cacheWrite1h: number;
};

// added to SessionSummary:
costUsd?: number;          // undefined when model is unpriced
claudeUsage?: ClaudeUsage;
models?: string[];
gitBranch?: string;
startedAt?: number;
endedAt?: number;
```

`SessionTranscript` reuses the same fields (the read path recomputes them, or the
summary is threaded through — decided in the plan).

### 4. UI

**`SessionList.tsx`** — on Claude rows, a compact cost badge next to the existing
model/msg-count/time line. Format: `$1.42`; `<$0.01` floor for tiny sessions; `—` (muted)
when `costUsd` is undefined.

**`TranscriptView.tsx`** — for Claude sessions, a metadata strip in the header:
- model badge(s) (multiple when the session switched models),
- token breakdown using the existing SessionTree glyphs: `↑12.4k ↓3.1k ⚡210k ✎8.2k`
  (input / output / cache-read / cache-write),
- estimated cost with a tooltip "estimated from token counts × public per-model pricing",
- git branch,
- `started → ended` with elapsed duration.

Numbers formatted compactly (k/M). Reuse existing relative-time / formatting helpers.

### 5. Tests

- `claude-pricing.test.ts` — prefix resolution (exact, family point-release, unknown),
  cost math including the cache multipliers, `undefined` for unknown models.
- Extend `claude-source.test.ts` — fixtures with `usage`-bearing assistant entries,
  including: a duplicate-`message.id` case (must not double-count), a 1h-cache entry,
  a mid-session model switch, and a sidechain entry.
- `pricing-source.ts` — schema validation rejects malformed/incompatible remote JSON and
  falls back; cache read/write round-trip.

## Maintenance

- **Pricing rarely changes.** Per-MTok rates have held across whole families (Opus
  4.5–4.8 all $5/$25). The frequent event is a *new model ID*, not a new price — and
  family-prefix matching absorbs those with no change at all.
- **A genuinely new tier or family** is the only thing needing a data update. Edit the
  hosted JSON and every client self-corrects within the 24h TTL — no app release. The
  bundled table should be updated in the same PR so fresh installs and offline clients
  stay correct, but that ships on the normal release cadence.
- **Unknown models degrade visibly** (`—` + tooltip), so a stale table is obvious in the
  UI rather than silently wrong — it tells us exactly when an update is warranted.
- To update bundled pricing: edit `src/shared/claude-pricing.ts`. To push a fix to
  existing installs: edit the hosted JSON.

## Out of scope (noted, not addressed)

- `claudeProjectsDir()` / `sessionFilePath()` ignore the `claudeConfigDir` setting —
  pre-existing gap, unrelated to this feature.
- `ai-title` transcript entries (better titles) — possible future improvement.
- Rune cost estimation — Rune already carries per-node usage but no pricing; out of scope.
- Cost over time / charts / budgets — not requested.

## Non-goals / YAGNI

- No user-editable pricing UI.
- No per-request cost breakdown; session-level totals only.
- No background polling beyond the once-per-launch (TTL-gated) fetch.
