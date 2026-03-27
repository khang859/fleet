# Enhanced Crew Prompts & FirstOfficer Consultant Mode

**Date:** 2026-03-27
**Status:** Draft
**Scope:** Crew prompt templates, FirstOfficer consultant mode, guidance protection

## Summary

Extract techniques from the superpowers plugin (TDD, systematic debugging, verification gates, two-stage review, structured status reporting, YAGNI enforcement, escalation protocols) and embed them into Fleet's crew prompts. Add a FirstOfficer "consultant mode" so crews can request mid-flight guidance instead of failing and being triaged post-mortem. Add guidance protection to prevent Sentinel from killing crews that are waiting for help.

## Motivation

Fleet's current crew prompts are minimal — they describe the mission type's role and constraints but don't prescribe implementation discipline. A code crew gets "implement this" but no TDD process. A repair crew gets "fix this" but no systematic debugging methodology. Review crews do a single-pass review instead of structured spec-compliance + quality passes.

The superpowers plugin has battle-tested techniques for each of these. Adapting them for autonomous operation (no human gates) with FirstOfficer as the guidance provider fills the gap.

Additionally, crews currently have no way to ask for help mid-flight. If they get stuck, they either thrash until timeout or fail — then FirstOfficer triages the corpse. This wastes compute and misses the opportunity for course correction.

---

## Part 1: Guidance Protection

### Problem

Six mechanisms can kill a running crew. None check whether the crew has a pending guidance request:

| Mechanism | Location |
|---|---|
| Lifesign timeout | sentinel.ts — marks crew as 'lost' |
| Mission deadline timeout | sentinel.ts — sends SIGTERM |
| Sector path missing | sentinel.ts — bulk marks crews as 'lost' |
| Hull internal timeout | hull.ts — closes stdin, SIGTERM, SIGKILL |
| Explicit recall | crew-service.ts — Admiral or programmatic |
| App shutdown | crew-service.ts — SIGKILL all |

### Solution: `awaiting-guidance` crew status

When a crew sends a `needs-guidance` comm, the system transitions the crew to `awaiting-guidance` status and extends its deadline. Kill sweeps skip crews in this status.

#### Status transition flow

```
Crew sends: fleet comms send --from $FLEET_CREW_ID --type needs-guidance --message "..."
    |
    v
socket-server.ts comms handler detects type='needs-guidance':
  1. UPDATE crew SET status = 'awaiting-guidance' WHERE id = crewId
  2. Call hull.resetTimeout() to extend deadline
    |
    v
Crew blocks, waiting for response in its session
    |
    v
FirstOfficer (or Admiral) sends response:
  fleet comms send --to crewId --type guidance-response --message "..."
    |
    v
socket-server.ts comms handler detects type='guidance-response' + crew status='awaiting-guidance':
  1. UPDATE crew SET status = 'active' WHERE id = crewId
  2. Call hull.resetTimeout() to reset deadline
  3. Auto-inject message into crew stdin (existing behavior)
    |
    v
Crew receives guidance as new user turn, resumes work
```

#### Kill sweep guards

| Mechanism | Guard |
|---|---|
| Lifesign timeout | Already filters `WHERE status = 'active'` — `awaiting-guidance` excluded automatically |
| Mission deadline | Add `AND status != 'awaiting-guidance'` to sweep query |
| Hull internal timeout | `resetTimeout()` called on guidance request, so timer is extended |
| Sector path missing | No guard — if disk is gone, nothing helps |
| Explicit recall | No guard — Admiral intent is always respected |
| App shutdown | No guard — hard requirement |

---

## Part 2: FirstOfficer Consultant Mode

### Current state

FirstOfficer has one mode: **triage**. Sentinel dispatches it after a crew has failed/exited. It returns a JSON decision: retry, recover-and-dismiss, or escalate-and-dismiss.

### New mode: **consult**

Sentinel dispatches FirstOfficer when it detects an unanswered `needs-guidance` comm from a crew in `awaiting-guidance` status.

#### Dispatch trigger (Sentinel sweep)

```sql
SELECT c.*, cr.id as crew_id, m.id as mission_id, m.prompt, m.summary
FROM comms c
JOIN crew cr ON c.from_crew = cr.id
JOIN missions m ON cr.mission_id = m.id
WHERE c.type = 'needs-guidance'
  AND c.read = 0
  AND cr.status = 'awaiting-guidance'
  AND NOT EXISTS (
    SELECT 1 FROM comms
    WHERE type = 'guidance-response'
    AND to_crew = cr.id AND read = 0
  )
```

No 60-second delay — dispatches on next sweep cycle.

#### Mode discriminator

`dispatch()` receives an event with `eventType`:

- `eventType: 'crew-failed'` → triage mode (existing, unchanged)
- `eventType: 'needs-guidance'` → consultant mode (new)

#### Consultant system prompt

```
You are the First Officer aboard Star Command, acting as a consultant.

A crew member is stuck and requesting guidance. They are STILL RUNNING —
your response will be delivered directly into their active session.

Analyze their situation and respond using:

fleet comms send \
  --from first-officer \
  --to <crew-id> \
  --type guidance-response \
  --message "your guidance here"

Your guidance should include:
- Analysis of what they tried and why it failed
- A specific recommended next approach
- Key files or patterns to look at
- Any architectural context they may be missing

You may send multiple messages if needed.
```

Context provided to consultant:
- The crew's `needs-guidance` message content
- The original mission prompt
- Recent crew output (last N lines from stdout buffer)
- Relevant cargo from the same sector (research/architect findings)
- Sector system prompt and CLAUDE.md contents

#### Consultant CLAUDE.md

```
# First Officer — Consultant Mode

You are the First Officer aboard Star Command, consulting for a running crew.
Your job is to analyze their situation and send actionable guidance via fleet comms.

Do not modify code, deploy crews, recall crews, or write files yourself.
Use `fleet comms send` to deliver your guidance to the crew.
```

#### Fallback on failure

When the FirstOfficer consultant process exits:
- Check if a `guidance-response` comm was sent to the crew
- If yes: done (crew already received guidance and resumed)
- If no: fall back to writing a hailing-memo to Admiral (existing escalation path)

---

## Part 3: Enhanced Crew Prompts

### Architecture

Prompts move from inline TypeScript template literals in `hull.ts` to modular `.md` files:

```
src/main/starbase/prompts/
  shared/
    verification-gate.md
    self-review.md
    status-reporting.md
    escalation.md
    yagni.md
  code-crew.md
  research-crew.md
  review-crew.md
  architect-crew.md
  repair-crew.md
```

#### Composition in hull.ts

```typescript
const preamble = readFileSync(join(PROMPTS_DIR, `${missionType}-crew.md`), 'utf-8');

const sharedModules = ['status-reporting'];
if (missionType === 'code' || missionType === 'repair') {
  sharedModules.push('verification-gate', 'self-review', 'escalation');
}
if (missionType === 'code' || missionType === 'architect') {
  sharedModules.push('yagni');
}

const shared = sharedModules
  .map(m => readFileSync(join(PROMPTS_DIR, 'shared', `${m}.md`), 'utf-8'))
  .join('\n\n');

const combinedSystemPrompt = [preamble, shared, this.opts.systemPrompt]
  .filter(Boolean)
  .join('\n\n');
```

`PROMPTS_DIR` is `join(dirname(fileURLToPath(import.meta.url)), 'prompts')` in the source, which resolves to the bundled output directory after electron-vite builds. The `.md` files are imported as static assets or read at runtime from the build output.

### Shared Modules

#### shared/verification-gate.md

Embedded in: code, repair

Core rule: No completion claims without fresh verification command output. "Should work" is not evidence. Run the command, paste the output, then claim the result.

#### shared/self-review.md

Embedded in: code, repair

Checklist before reporting done: completeness (all requirements met?), quality (clean, maintainable?), discipline (YAGNI, followed existing patterns?), testing (tests verify behavior?). Fix issues found during self-review before reporting.

#### shared/status-reporting.md

Embedded in: all crew types

Structured status at end of work:
- **DONE** — Mission complete, verification passing
- **DONE_WITH_CONCERNS** — Complete but with doubts about correctness
- **BLOCKED** — Cannot complete, describes what's blocking
- **NEEDS_CONTEXT** — Missing information needed to proceed

#### shared/escalation.md

Embedded in: code, repair

Instructions for requesting guidance via `fleet comms send --type needs-guidance`. Trigger conditions: 3 failed attempts at same problem, unclear requirements, architectural questions. Crew must STOP and wait after sending.

#### shared/yagni.md

Embedded in: code, architect

Anti-over-engineering rules: no features beyond mission prompt, no unrelated refactoring, no error handling for impossible scenarios, no premature abstractions.

### Mission-Type Prompts

#### code-crew.md

Existing content: (current code crew has no preamble — defaults to sector system prompt only)

New content includes:
- **TDD discipline**: RED-GREEN-REFACTOR cycle. Write failing test, verify it fails for the right reason, write minimal code, verify it passes, refactor. If code was written before tests, delete and restart. If sector has no test infrastructure or mission explicitly says no tests, skip TDD but follow verification-gate.
- **Code organization**: Follow file structure from mission prompt. Each file has one responsibility. If a file grows beyond intent, report DONE_WITH_CONCERNS. Follow existing codebase patterns.

Shared modules: verification-gate, self-review, status-reporting, escalation, yagni

#### repair-crew.md

Existing content preserved: working on existing PR branch, don't create new branch/PR, commit changes for push on completion.

New content includes:
- **Systematic debugging**: 4-phase mandatory process:
  1. **Understand** (mandatory before code changes): Read full error output, reproduce failure locally, check recent changes via git log/diff, trace data flow at component boundaries
  2. **Hypothesize**: State hypothesis clearly ("X is root cause because Y"), find working examples of similar code, identify differences
  3. **Fix**: One change at a time, smallest possible change, run verification after each
  4. **Verify**: Full verify command (not just the single failing test), confirm no regressions, show output
- **3-strike escalation**: After 3 failed fix attempts, STOP and request guidance. Include what was tried, what each attempt revealed, current hypothesis. Do not attempt fix #4 without guidance.

Shared modules: verification-gate, self-review, status-reporting, escalation

#### review-crew.md

Existing content preserved: confidence scoring, VERDICT output format.

New content restructures review as **two passes**:
- **Pass 1 — Spec compliance**: Did they build what was requested, nothing more, nothing less? Read the actual diff, don't trust PR description claims. Check for missing requirements, extra features, misunderstood requirements.
- **Pass 2 — Code quality**: Bug detection, project guidelines compliance, architecture review, test quality assessment.

Shared modules: status-reporting

#### architect-crew.md

Existing content preserved: codebase analysis, blueprint output format, cargo workflow.

New content includes:
- **Approach comparison**: Before committing to an architecture, propose 2-3 approaches with trade-offs and a clear recommendation. Then commit to the recommended approach and design it fully.
- **Design for current requirements only**: Explicit instruction not to design for hypothetical future needs.

Shared modules: status-reporting, yagni

#### research-crew.md

Existing content preserved: analysis approach, output format, cargo workflow.

New content includes:
- **Evidence-based claims**: Every claim must include file:line reference or source link. "I believe X" without evidence is a guess, not a finding. If evidence can't be found, state that explicitly. Structure as: claim, evidence, implication.

Shared modules: status-reporting

---

## Part 4: System Integration

### Sentinel changes

1. **New sweep**: Detect unanswered `needs-guidance` comms from crews in `awaiting-guidance` status. Dispatch FirstOfficer in consultant mode.
2. **Kill sweep guards**: Existing deadline sweep adds `AND status != 'awaiting-guidance'`.
3. **Ordering**: Guidance sweep runs before kill sweeps to ensure FirstOfficer is dispatched before any timeout consideration.

### Comms layer changes (socket-server.ts)

Two conditional checks added to comms send handler:

1. When `type = 'needs-guidance'`: Set crew status to `awaiting-guidance`, call `hull.resetTimeout()`.
2. When `type = 'guidance-response'` and target crew is in `awaiting-guidance`: Revert crew status to `active`, call `hull.resetTimeout()`.

### FirstOfficer changes (first-officer.ts)

1. `dispatch()` gains mode branch on `eventType`:
   - `'crew-failed'` → existing triage flow (unchanged)
   - `'needs-guidance'` → consultant mode (new system prompt, no JSON parsing)
2. New `buildConsultantSystemPrompt()` method
3. New `buildConsultantClaudeMd()` method
4. `handleProcessExit()` gains consultant fallback: if no `guidance-response` comm was sent, create hailing-memo to Admiral

### Hull changes (hull.ts)

1. Prompt composition refactored from inline strings to file reads (as described in composition section)
2. No new methods — `resetTimeout()` and `sendMessage()` already exist and work correctly

### Analyst changes

None. Error classification and verdict extraction are unaffected.

### Database changes

No schema changes. `awaiting-guidance` is a new value for the existing `crew.status` text column. No migration needed.

---

## Edge Cases

| Scenario | Behavior |
|---|---|
| Crew requests guidance, FirstOfficer responds | Crew gets guidance via stdin, resumes as `active` |
| Crew requests guidance, FirstOfficer crashes | No `guidance-response` comm → fallback to hailing-memo to Admiral |
| Crew requests guidance, then would have timed out | Can't happen — `awaiting-guidance` excluded from deadline sweep |
| Crew requests guidance during protocol execution | Navigator only watches for cargo/review-pass signals, doesn't interfere |
| Crew requests guidance multiple times | Comms rate limit prevents spam. Second request is no-op if already `awaiting-guidance` |
| Admiral manually recalls crew in `awaiting-guidance` | Allowed — explicit recall always respected |
| FirstOfficer responds but crew already finished | Comm lands in DB, no stdin to inject into — harmless |
| Crew sends `needs-guidance` but FirstOfficer is at max concurrency | Queued until a FirstOfficer slot opens. Crew stays shielded in `awaiting-guidance`. |

---

## Files Changed

### New files
- `src/main/starbase/prompts/code-crew.md`
- `src/main/starbase/prompts/repair-crew.md`
- `src/main/starbase/prompts/review-crew.md`
- `src/main/starbase/prompts/architect-crew.md`
- `src/main/starbase/prompts/research-crew.md`
- `src/main/starbase/prompts/shared/verification-gate.md`
- `src/main/starbase/prompts/shared/self-review.md`
- `src/main/starbase/prompts/shared/status-reporting.md`
- `src/main/starbase/prompts/shared/escalation.md`
- `src/main/starbase/prompts/shared/yagni.md`

### Modified files
- `src/main/starbase/hull.ts` — Prompt composition refactor (inline strings → file reads)
- `src/main/starbase/first-officer.ts` — Consultant mode (new system prompt, CLAUDE.md, fallback logic)
- `src/main/starbase/sentinel.ts` — Guidance sweep + kill sweep guards
- `src/main/socket-server.ts` — Comms handler for `needs-guidance` and `guidance-response` status transitions
