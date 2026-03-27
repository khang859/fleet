# Analyst — LLM-Powered Sentinel Intelligence

**Date:** 2026-03-22
**Status:** Approved

## Problem

The Sentinel, First Officer, and Hull currently use regex patterns and string matching for error classification, CI log parsing, and verdict extraction. These are brittle: they miss novel error patterns, break on non-standard output formats, and produce low-signal context for the Admiral.

Four specific gaps:

1. **Error classification** (`error-fingerprint.ts`) — regex patterns for non-retryable errors miss nuanced cases and produce false positives/negatives, causing the First Officer to waste time on non-retryable errors or give up too early on transient ones.
2. **CI log summarization** (`checkAndRepairMission()` in `sentinel.ts`) — raw CI logs (hundreds of lines) are passed directly to repair crews, forcing them to self-filter before they can act.
3. **PR verdict extraction** (`hull.ts`) — strict `VERDICT:` regex parsing fails if a review crew writes the verdict in a natural but non-standard way.
4. **Hailing memo context** (`writeHailingMemo()` in `first-officer.ts`) — template-based memos give the Admiral low-signal context when a crew goes unresponsive.

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

1. Spawns `claude --print --model <model>` with `stdio: ['pipe', 'pipe', 'pipe']`
2. Writes prompt to stdin and closes it
3. Collects stdout as raw text (the LLM's response)
4. Finds and parses the first JSON object in the output (same `indexOf('{') / lastIndexOf('}')` extraction already used in `first-officer.ts`)
5. On timeout (5s), parse error, or non-zero exit: throws `AnalystError`
6. If process hangs past 5s: sends `SIGKILL`

Note: `--output-format json` is NOT used with `--print`. The `--print` flag returns the LLM's response as plain text on stdout. JSON is parsed from the LLM's own structured response, not from a CLI wrapper format.

**`analyst_degraded` comms:** Rate-limited via a `lastDegradedAt: Map<string, number>` keyed by method name on the `Analyst` instance. Fires at most once per 5 minutes per method (time-based, not level-change-based). Carries the method name and error reason.

### Four Public Methods

#### `classifyError(errorTail: string): Promise<'transient' | 'persistent' | 'non-retryable' | null>`

Replaces the regex patterns in `error-fingerprint.ts`.

**Input size:** Last 50 lines / up to 10,000 characters of error output (consistent with existing fingerprint window).

**Prompt:**

> Given this error output, classify it as one of: "transient" (safe to retry, likely network/timing), "non-retryable" (config/auth/missing file — retrying won't help), or "persistent" (same error repeating across attempts). Reply with `{"classification": "...", "reason": "..."}` only.

**Fallback:** Existing `classifyError()` in `error-fingerprint.ts`, renamed to `classifyFromFingerprint()` to avoid name collision with the Analyst method.

**Call site:** `firstOfficerSweep()` in `sentinel.ts`, before FO dispatch.

---

#### `summarizeCILogs(rawLogs: string): Promise<string | null>`

Called after `gh run view --log-failed` in `checkAndRepairMission()`.

**Input size:** Caller already truncates to 4,000 chars (`log.slice(0, 4000)`). No additional truncation needed.

**Prompt:**

> Extract only the root cause error lines from this CI failure log. Ignore setup, teardown, and passing step output. Be concise. Reply with `{"summary": "..."}` only.

**Fallback:** Raw logs passed as-is (current behaviour).

**Call site:** `checkAndRepairMission()` in `sentinel.ts`, before repair mission prompt construction.

---

#### `extractPRVerdict(crewOutput: string): Promise<{ verdict: 'APPROVE' | 'REQUEST_CHANGES' | 'ESCALATE'; notes: string } | null>`

Replaces the `VERDICT:` regex in `hull.ts`.

**Input size:** Caller truncates to last 4,000 characters of `fullOutput` before passing to the Analyst. Consistent with the existing `notes.slice(-2000)` convention in `hull.ts`.

**Prompt:**

> Extract the review verdict and notes from this crew output. The verdict must be one of: APPROVE, REQUEST_CHANGES, ESCALATE. Reply with `{"verdict": "...", "notes": "..."}` only.

**Fallback:** Current `VERDICT:` and `NOTES:` regex match in `hull.ts`.

**Call site:** `hull.ts`, in the two `missionType === 'review'` verdict extraction blocks (around lines 831 and 1155). `Analyst` is passed into `Hull` via its opts.

---

#### `writeHailingContext(payloadText: string): Promise<string | null>`

Called in `writeHailingMemo()` in `first-officer.ts`. `payloadText` is the already-extracted message/question string (computed at line ~305: `msg ?? question ?? JSON.stringify(rawParsed)`).

**Input size:** `payloadText` is short by nature (a hailing message or question). No truncation needed.

**Prompt:**

> A crew is stuck and unresponsive. They sent this hailing message and have received no response for over 60 seconds. Write 2-3 sentences explaining what likely happened and what the operator should check. Reply with `{"context": "..."}` only.

**Fallback:** Current "Action Required" template text in `writeHailingMemo()`.

**Call site:** `writeHailingMemo()` in `first-officer.ts`, after `payloadText` is resolved (after line ~308).

---

### Injection

`Analyst` is constructed in `starbase-runtime-core.ts` alongside existing services and passed via `deps` to:

- `Sentinel` (for `classifyError`, `summarizeCILogs`)
- `FirstOfficer` (for `writeHailingContext`)
- `Hull` opts (for `extractPRVerdict`)

### Fallback Pattern

Every call site follows this pattern:

```typescript
const result = await this.deps.analyst.classifyError(errorTail);
const classification = result ?? classifyFromFingerprint(errorTail, fingerprint, prevFingerprint);
```

### Timeout & Process Lifecycle

- 5-second timeout per call
- On timeout: `SIGKILL` the subprocess
- No retry — the Sentinel will naturally retry on the next sweep cycle (every 10 seconds)

## Error Handling

| Failure Mode                | Behaviour                                                   |
| --------------------------- | ----------------------------------------------------------- |
| API key missing             | `AnalystError` thrown → fallback + `analyst_degraded` comms |
| Non-zero exit code          | `AnalystError` thrown → fallback + comms                    |
| JSON parse failure          | `AnalystError` thrown → fallback + comms                    |
| 5s timeout                  | Process killed → fallback + comms                           |
| Unknown/invalid JSON fields | Validated at call site → fallback if schema mismatch        |

`analyst_degraded` comms are rate-limited (once per 5 minutes per method) via `lastDegradedAt: Map<string, number>` on the `Analyst` instance. This is time-based, not level-change-based.

## Files Changed

| File                                     | Change                                                                                                                |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `src/main/starbase/analyst.ts`           | New — `Analyst` class                                                                                                 |
| `src/main/starbase/error-fingerprint.ts` | Rename `classifyError` export to `classifyFromFingerprint` to avoid name collision                                    |
| `src/main/starbase/sentinel.ts`          | Inject `analyst` dep; use `classifyError()` + `summarizeCILogs()`; update import of renamed `classifyFromFingerprint` |
| `src/main/starbase/hull.ts`              | Accept `analyst` in opts; use `extractPRVerdict()` in both `missionType === 'review'` blocks                          |
| `src/main/starbase/first-officer.ts`     | Inject `analyst` dep; use `writeHailingContext()` in `writeHailingMemo()`                                             |
| `src/main/starbase-runtime-core.ts`      | Construct `Analyst`, pass to Sentinel, FirstOfficer, and Hull opts                                                    |

## Non-Goals

- No Anthropic SDK dependency — uses `claude` CLI subprocess exclusively
- No streaming — `--print` mode only, one-shot calls
- No caching of Analyst responses — each call is fresh
- No new UI for Analyst status — degradation surfaced via existing comms system
