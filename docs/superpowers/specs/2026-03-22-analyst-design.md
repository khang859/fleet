# Analyst — LLM-Powered Sentinel Intelligence

**Date:** 2026-03-22
**Status:** Approved

## Problem

The Sentinel, First Officer, and PR review sweep currently use regex patterns and string matching for error classification, CI log parsing, and verdict extraction. These are brittle: they miss novel error patterns, break on non-standard output formats, and produce low-signal context for the Admiral.

Four specific gaps:

1. **Error classification** (`error-fingerprint.ts`) — regex patterns for non-retryable errors miss nuanced cases and produce false positives/negatives, causing the First Officer to waste time on non-retryable errors or give up too early on transient ones.
2. **CI log summarization** (`checkAndRepairMission()`) — raw CI logs (hundreds of lines) are passed directly to repair crews, forcing them to self-filter before they can act.
3. **PR verdict extraction** (`reviewSweep()`) — strict `VERDICT:` string parsing fails if a review crew writes the verdict in a natural but non-standard way.
4. **Hailing memo context** (`writeHailingMemo()`) — template-based memos give the Admiral low-signal context when a crew goes unresponsive.

## Solution

A new `Analyst` service (`src/main/starbase/analyst.ts`) that wraps short-lived `claude --print` subprocess calls for lightweight classification and summarization tasks. The Analyst is model-agnostic — the model is injectable via `deps` and defaults to `claude-haiku-4-5-20251001`.

All four improvements degrade gracefully: on any failure, the Analyst returns `null` and the caller falls back to existing logic. The operator is notified via Admiral comms when degradation occurs.

## Architecture

### `Analyst` Class

**File:** `src/main/starbase/analyst.ts`

**Constructor deps:**
```typescript
interface AnalystDeps {
  db: DB;
  filterEnv: () => Record<string, string>;
  model?: string; // defaults to 'claude-haiku-4-5-20251001'
}
```

**Private `run(prompt: string): Promise<unknown>`**

1. Spawns `claude --print --model <model> --output-format json` with `stdio: ['pipe', 'pipe', 'pipe']`
2. Writes prompt to stdin, closes stdin
3. Collects stdout, parses JSON
4. On timeout (5s), parse error, or non-zero exit: throws `AnalystError`
5. If process hangs past 5s: sends `SIGKILL`

**`analyst_degraded` comms:** Rate-limited to once per 5 minutes. Carries the method name and error reason. Uses the same alert-level dedup pattern as `memory_warning` in the Sentinel.

### Four Public Methods

#### `classifyError(errorTail: string): Promise<'transient' | 'persistent' | 'non-retryable' | null>`

Replaces the regex patterns in `error-fingerprint.ts`.

**Prompt:**
> Given this error output, classify it as one of: "transient" (safe to retry, likely network/timing), "non-retryable" (config/auth/missing file — retrying won't help), or "persistent" (same error repeating across attempts). Reply with `{"classification": "...", "reason": "..."}` only.

**Fallback:** Existing regex classification in `classifyFromFingerprint()`.

**Call site:** `firstOfficerSweep()` in `sentinel.ts`, before FO dispatch.

---

#### `summarizeCILogs(rawLogs: string): Promise<string | null>`

Called after `gh run view --log-failed` in `checkAndRepairMission()`.

**Prompt:**
> Extract only the root cause error lines from this CI failure log. Ignore setup, teardown, and passing step output. Be concise. Reply with `{"summary": "..."}` only.

**Fallback:** Raw logs passed as-is (current behaviour).

**Call site:** `checkAndRepairMission()` in `sentinel.ts`, before repair mission prompt construction.

---

#### `extractPRVerdict(crewOutput: string): Promise<{ verdict: 'APPROVE' | 'REQUEST_CHANGES' | 'ESCALATE'; notes: string } | null>`

Replaces strict `VERDICT:` string parsing in `reviewSweep()`.

**Prompt:**
> Extract the review verdict and notes from this crew output. The verdict must be one of: APPROVE, REQUEST_CHANGES, ESCALATE. Reply with `{"verdict": "...", "notes": "..."}` only.

**Fallback:** Current regex string match on `VERDICT:` line.

**Call site:** `reviewSweep()` in `sentinel.ts`, after crew output is collected.

---

#### `writeHailingContext(crewOutput: string, errorState: string): Promise<string | null>`

Called in `writeHailingMemo()` in `first-officer.ts`.

**Prompt:**
> A crew is stuck and unresponsive. Given their recent output and error state, write 2-3 sentences explaining what likely happened and what the operator should check. Reply with `{"context": "..."}` only.

**Fallback:** Current template-based memo text.

**Call site:** `writeHailingMemo()` in `first-officer.ts`.

---

### Injection

`Analyst` is constructed in `starbase-runtime-core.ts` alongside existing services and passed via `deps` to:
- `Sentinel` (for `classifyError`, `summarizeCILogs`, `extractPRVerdict`)
- `FirstOfficer` (for `writeHailingContext`)

### Fallback Pattern

Every call site follows this pattern:

```typescript
const result = await this.deps.analyst.classifyError(errorTail);
const classification = result ?? classifyFromFingerprint(fingerprint, prevFingerprint);
```

### Timeout & Process Lifecycle

- 5-second timeout per call
- On timeout: `SIGKILL` the subprocess
- No retry — the Sentinel will naturally retry on the next sweep cycle

## Error Handling

| Failure Mode | Behaviour |
|---|---|
| API key missing | `AnalystError` thrown → fallback + `analyst_degraded` comms |
| Non-zero exit code | `AnalystError` thrown → fallback + comms |
| JSON parse failure | `AnalystError` thrown → fallback + comms |
| 5s timeout | Process killed → fallback + comms |
| Unknown JSON fields | Validated at call site, fallback if schema mismatch |

`analyst_degraded` comms are rate-limited (once per 5 minutes) to avoid flooding the Admiral inbox during sustained outages.

## Files Changed

| File | Change |
|---|---|
| `src/main/starbase/analyst.ts` | New — `Analyst` class |
| `src/main/starbase/error-fingerprint.ts` | Replace regex classification with `analyst.classifyError()` |
| `src/main/starbase/sentinel.ts` | Inject `analyst` dep; use `summarizeCILogs()` + `extractPRVerdict()` |
| `src/main/starbase/first-officer.ts` | Inject `analyst` dep; use `writeHailingContext()` |
| `src/main/starbase-runtime-core.ts` | Construct `Analyst`, pass to Sentinel + FirstOfficer deps |

## Non-Goals

- No Anthropic SDK dependency — uses `claude` CLI subprocess exclusively
- No streaming — `--print` mode only, one-shot calls
- No caching of Haiku responses — each call is fresh
- No new UI for Analyst status — degradation surfaced via existing comms system
