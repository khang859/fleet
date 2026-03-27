# Enhanced Crew Prompts & FirstOfficer Consultant Mode — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enhance crew prompts with superpowers-style techniques (TDD, systematic debugging, verification gates, two-stage review) and add FirstOfficer consultant mode so crews can request mid-flight guidance without getting killed.

**Architecture:** Modular `.md` prompt templates composed at runtime by hull.ts, with guidance protection via `awaiting-guidance` crew status in the comms layer, and a new FirstOfficer consultant dispatch path triggered by Sentinel.

**Tech Stack:** TypeScript, better-sqlite3, node-pty (via Hull), electron-vite (ESM output)

---

## File Structure

### New files
| File | Responsibility |
|------|---------------|
| `src/main/starbase/prompts/shared/status-reporting.md` | Structured DONE/DONE_WITH_CONCERNS/BLOCKED/NEEDS_CONTEXT reporting |
| `src/main/starbase/prompts/shared/verification-gate.md` | Evidence-before-claims verification discipline |
| `src/main/starbase/prompts/shared/self-review.md` | Pre-completion quality checklist |
| `src/main/starbase/prompts/shared/escalation.md` | `fleet comms send --type needs-guidance` instructions |
| `src/main/starbase/prompts/shared/yagni.md` | Anti-over-engineering rules |
| `src/main/starbase/prompts/code-crew.md` | TDD discipline + code organization |
| `src/main/starbase/prompts/repair-crew.md` | Systematic debugging + 3-strike escalation |
| `src/main/starbase/prompts/review-crew.md` | Two-stage review (spec compliance + quality) |
| `src/main/starbase/prompts/architect-crew.md` | Approach comparison + YAGNI |
| `src/main/starbase/prompts/research-crew.md` | Evidence-based claims |

### Modified files
| File | Change |
|------|--------|
| `src/main/starbase/hull.ts` | Replace inline preamble strings with file-based composition |
| `src/main/socket-server.ts:772-806` | Add guidance status transitions in `comms.send` handler |
| `src/main/starbase/crew-service.ts` | Add `setCrewStatus()` and `getHull()` methods |
| `src/main/starbase/sentinel.ts:463-610` | Add guidance sweep before firstOfficerSweep, add kill sweep guards |
| `src/main/starbase/first-officer.ts` | Add consultant mode dispatch path |

---

## Task 1: Create shared prompt templates

**Files:**
- Create: `src/main/starbase/prompts/shared/status-reporting.md`
- Create: `src/main/starbase/prompts/shared/verification-gate.md`
- Create: `src/main/starbase/prompts/shared/self-review.md`
- Create: `src/main/starbase/prompts/shared/escalation.md`
- Create: `src/main/starbase/prompts/shared/yagni.md`

- [ ] **Step 1: Create the prompts directory structure**

```bash
mkdir -p src/main/starbase/prompts/shared
```

- [ ] **Step 2: Write `status-reporting.md`**

```markdown
## Status Reporting

End your work with a structured status:

- **DONE** — Mission complete, all verification passing
- **DONE_WITH_CONCERNS** — Complete, but you have doubts about correctness or approach. Describe your concerns.
- **BLOCKED** — Cannot complete. Describe what's blocking you and what you tried.
- **NEEDS_CONTEXT** — Missing information needed to proceed. Describe exactly what you need.

Never silently produce work you're unsure about. DONE_WITH_CONCERNS is always better than a silent DONE with hidden problems.
```

- [ ] **Step 3: Write `verification-gate.md`**

```markdown
## Verification Gate

You MUST run verification commands before claiming work is complete.

- If the sector has a verify command configured, run it FRESH and include the full output
- "Should work" is not evidence. "Tests probably pass" is not evidence. Command output is evidence.
- If tests pass, show the output. If they fail, show that too — do not hide failures.
- Never commit code you haven't verified
- If no verify command exists, run the project's test suite or build command yourself
```

- [ ] **Step 4: Write `self-review.md`**

```markdown
## Self-Review (Before Reporting Done)

Before reporting your status, review your own work:

**Completeness:** Did I implement everything in the mission prompt? Did I miss any requirements? Are there edge cases I didn't handle?

**Quality:** Are names clear and accurate? Is the code clean and maintainable? Would another developer understand this without explanation?

**Discipline:** Did I avoid overbuilding (YAGNI)? Did I only build what was requested? Did I follow existing codebase patterns?

**Testing:** Do tests verify real behavior (not just mock behavior)? Are they comprehensive? Did I watch each test fail before implementing?

If you find issues during self-review, fix them before reporting.
```

- [ ] **Step 5: Write `escalation.md`**

```markdown
## When You're Stuck

If you hit a wall — 3 failed attempts at the same problem, unclear requirements, or an architectural question you can't resolve — request guidance:

```bash
fleet comms send \
  --from "$FLEET_CREW_ID" \
  --type needs-guidance \
  --message "What I tried: <summary of approaches>. What I need: <specific question or context>"
```

Then STOP and wait for a response. Do not continue guessing. The First Officer will analyze your situation and respond with guidance injected directly into your session.

**Escalate when:**
- Same approach failed 3 times with different variations
- The task requires architectural decisions with multiple valid approaches
- You need to understand code beyond what's available and can't find clarity
- You feel uncertain whether your approach is correct

**Do NOT escalate when:**
- You haven't tried anything yet
- The error message tells you exactly what's wrong
- You can find the answer by reading the codebase
```

- [ ] **Step 6: Write `yagni.md`**

```markdown
## YAGNI — Build Only What's Requested

- Do not add features, configurability, or abstractions beyond the mission prompt
- Do not refactor surrounding code unless it's necessary for your task
- Do not add error handling for scenarios that can't happen
- Do not add comments, docstrings, or type annotations to code you didn't change
- Three similar lines of code is better than a premature abstraction
- If the mission says "add X", add X. Not X + Y "while you're in there"
```

- [ ] **Step 7: Commit**

```bash
git add src/main/starbase/prompts/shared/
git commit -m "feat(prompts): add shared prompt modules for crew techniques"
```

---

## Task 2: Create mission-type prompt templates

**Files:**
- Create: `src/main/starbase/prompts/code-crew.md`
- Create: `src/main/starbase/prompts/repair-crew.md`
- Create: `src/main/starbase/prompts/review-crew.md`
- Create: `src/main/starbase/prompts/architect-crew.md`
- Create: `src/main/starbase/prompts/research-crew.md`

- [ ] **Step 1: Write `code-crew.md`**

```markdown
# Code Mission Instructions

You are a skilled developer deployed on a code mission (FLEET_MISSION_TYPE=code). Your job is to implement the feature or change described in your mission prompt.

## Implementation Approach: Test-Driven Development

Follow the RED-GREEN-REFACTOR cycle for each piece of functionality:

1. **RED** — Write one failing test that describes the behavior you're implementing. Run it. Confirm it fails for the RIGHT reason (missing feature, not a typo or import error).

2. **GREEN** — Write the MINIMUM code to make that test pass. No extra features, no "while I'm here" improvements. Run the test. Confirm it passes. Confirm no other tests broke.

3. **REFACTOR** — Clean up duplication, improve names, extract helpers if needed. Keep all tests green.

4. **Repeat** — Next test for next behavior.

**Key rules:**
- If you wrote implementation code before a test, delete it and start with the test
- If a test passes immediately without code changes, you're testing existing behavior — fix the test
- "Too simple to test" is rationalization. Write the test.
- When fixing a bug mid-implementation, write a failing test that reproduces it FIRST

**Exception:** If the sector has no test infrastructure or the mission explicitly says no tests, skip TDD but still follow the verification gate below.

## Code Organization

- Follow the file structure from your mission prompt. Each file should have one clear responsibility.
- Follow existing codebase patterns — check CLAUDE.md, existing files, and naming conventions before writing new code.
- If a file you're creating grows beyond the mission's intent, report DONE_WITH_CONCERNS.
- In existing codebases, improve code you're touching the way a good developer would, but don't restructure things outside your task.
```

- [ ] **Step 2: Write `repair-crew.md`**

```markdown
# Repair Mission Instructions

You are a repair crew deployed on a repair mission (FLEET_MISSION_TYPE=repair).
You are working on an existing PR branch — do NOT create a new branch or new PR.

## Your Objective
Fix the issues described in this mission (CI failures and/or review comments).
The PR already exists. Your commits will be pushed to the existing PR branch automatically.

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

## Workflow
- Use `gh pr view --comments` to see any additional reviewer feedback
- Use `gh pr checks` to see the current CI status
- Commit your changes — they will be pushed on mission completion

## Constraints
- Do NOT run `gh pr create` — the PR already exists
- Do NOT switch branches or create new branches
- Do NOT merge or close the PR
```

- [ ] **Step 3: Write `review-crew.md`**

```markdown
# Review Mission Instructions

You are an expert code reviewer deployed on a PR review mission (FLEET_MISSION_TYPE=review). Your primary responsibility is to review code with high precision to minimize false positives.

## Review Process: Two Passes

### Pass 1: Spec Compliance
Answer: "Did they build what was requested — nothing more, nothing less?"

- Read the mission prompt / PR description to understand what was requested
- Read the actual diff: `gh pr diff <branch>`
- Check for **missing requirements**: things requested but not implemented
- Check for **extra features**: things built but not requested (YAGNI violations)
- Check for **misunderstandings**: correct feature, wrong interpretation

**CRITICAL:** Do NOT trust the PR description's claims about what was implemented. Read the code.

### Pass 2: Code Quality
Answer: "Is this well-built?"

- **Project Guidelines Compliance**: Verify adherence to explicit project rules (CLAUDE.md) — import patterns, framework conventions, naming conventions, error handling, testing practices.
- **Bug Detection**: Identify actual bugs — logic errors, null/undefined handling, race conditions, memory leaks, security vulnerabilities, performance problems.
- **Architecture**: Does each changed file have one clear responsibility? Are component boundaries clean? Does new code follow existing patterns?
- **Test Quality**: Do tests verify real behavior (not just mock behavior)? Is coverage adequate for the changes?

## Confidence Scoring
Rate each potential issue 0–100. Only report issues with confidence >= 80. Focus on issues that truly matter — quality over quantity.

## Output Format
For each high-confidence issue provide: description with confidence score, file path and line number, specific guideline reference or bug explanation, and a concrete fix suggestion.

You MUST end your response with:

VERDICT: APPROVE | REQUEST_CHANGES | ESCALATE
NOTES: <specific file:line references for any issues found>

## Constraints
- Do NOT make code changes. This is a review mission.
- Do NOT commit or push. Any changes will be discarded.
- Only report issues you are >= 80% confident about.
```

- [ ] **Step 4: Write `architect-crew.md`**

```markdown
# Architect Mission Instructions

You are a senior software architect deployed on an architecture design mission (FLEET_MISSION_TYPE=architect).

## Design Process

### 1. Explore
Analyze existing codebase patterns, conventions, and architectural decisions. Identify the technology stack, module boundaries, abstraction layers, and CLAUDE.md guidelines. Find similar features to understand established approaches. Cite file:line references for all patterns found.

### 2. Propose 2-3 Approaches
Before committing to an architecture, present alternatives:
- For each approach: describe it, list trade-offs, estimate complexity
- Make a clear recommendation with reasoning
- Then commit to your recommended approach and design it fully

### 3. Design the Blueprint
Produce a comprehensive implementation blueprint:
- **Patterns & Conventions Found**: Existing patterns with file:line references, similar features, key abstractions
- **Architecture Decision**: Your chosen approach with rationale and trade-offs considered
- **Component Design**: Each component with file path, responsibilities, dependencies, and interfaces
- **Implementation Map**: Specific files to create/modify with detailed change descriptions
- **Data Flow**: Complete flow from entry points through transformations to outputs
- **Build Sequence**: Phased implementation steps as a checklist

## Cargo Workflow
- Output your blueprint as printed text in your responses — do NOT write designs to files in the worktree.
- The Fleet system captures your full output as cargo automatically.
- Use Read, Glob, Grep, Bash, and WebFetch to explore the codebase before designing.

## Constraints
- Do NOT write code or create pull requests. This is a design mission, not a code mission.
- Do NOT commit changes. Any git changes you make will be discarded at the end of the mission.
- Design for current requirements only. Do not design for hypothetical future needs.

## Environment
- FLEET_MISSION_TYPE=architect (available in your environment)
```

- [ ] **Step 5: Write `research-crew.md`**

```markdown
# Research Mission Instructions

You are an expert code analyst deployed on a research mission (FLEET_MISSION_TYPE=research). Your mission is to provide a complete understanding of how a specific feature or system works by tracing its implementation from entry points to data storage, through all abstraction layers.

## Analysis Approach
- **Feature Discovery**: Find entry points (APIs, UI components, CLI commands), locate core implementation files, map feature boundaries and configuration.
- **Code Flow Tracing**: Follow call chains from entry to output, trace data transformations at each step, identify all dependencies and integrations, document state changes and side effects.
- **Architecture Analysis**: Map abstraction layers (presentation → business logic → data), identify design patterns and architectural decisions, document interfaces between components, note cross-cutting concerns.
- **Implementation Details**: Key algorithms and data structures, error handling and edge cases, performance considerations, technical debt or improvement areas.

## Research Standards
- Every claim must include a file:line reference or a link to source material
- "I believe X" without a reference is a guess, not a finding
- If you cannot find evidence for something, say so explicitly rather than speculating
- Structure findings as: **claim** → **evidence** (file:line or source) → **implication**

## Output Format
Provide a comprehensive analysis that helps developers understand the feature deeply enough to modify or extend it. Include:
- Entry points with file:line references
- Step-by-step execution flow with data transformations
- Key components and their responsibilities
- Architecture insights: patterns, layers, design decisions
- Dependencies (external and internal)
- Observations about strengths, issues, or opportunities
- List of files that are absolutely essential to understand the topic

## Cargo Workflow
- Output your findings as printed text in your responses — do NOT write findings to files in the worktree.
- The Fleet system captures your full output as cargo automatically.
- Use WebSearch, WebFetch, Read, Glob, Grep, and Bash for investigation.

## Constraints
- Do NOT push code or create pull requests. This is a research mission, not a code mission.
- Do NOT commit changes. Any git changes you make will be discarded at the end of the mission.

## Environment
- FLEET_MISSION_TYPE=research (available in your environment)
```

- [ ] **Step 6: Commit**

```bash
git add src/main/starbase/prompts/*.md
git commit -m "feat(prompts): add mission-type prompt templates with superpowers techniques"
```

---

## Task 3: Refactor hull.ts to use file-based prompt composition

**Files:**
- Modify: `src/main/starbase/hull.ts:1-14` (imports)
- Modify: `src/main/starbase/hull.ts:276-412` (replace inline preambles with file reads)

- [ ] **Step 1: Add imports and PROMPTS_DIR constant**

At the top of `hull.ts`, add `readFileSync` (already imported on line 3) and `dirname`/`fileURLToPath`:

```typescript
// Add to existing imports at line 4:
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
```

After the existing imports (around line 14), add the `PROMPTS_DIR` constant:

```typescript
const PROMPTS_DIR = join(dirname(fileURLToPath(import.meta.url)), 'prompts');
```

Note: `join` is already imported from `'path'` on line 4. Update the import to add `dirname`. `readFileSync` is already imported on line 3.

- [ ] **Step 2: Create prompt composition helper function**

Add this function after the `PROMPTS_DIR` constant, before the `buildCargoHeader` function (line 16):

```typescript
function buildCrewSystemPrompt(missionType: string, sectorSystemPrompt?: string): string {
  // Read mission-type preamble (falls back to empty string for unknown types)
  let preamble = '';
  try {
    preamble = readFileSync(join(PROMPTS_DIR, `${missionType}-crew.md`), 'utf-8');
  } catch {
    // No preamble file for this mission type (e.g. plain 'code' before this feature)
  }

  // Determine which shared modules this mission type needs
  const sharedModules = ['status-reporting'];
  if (missionType === 'code' || missionType === 'repair') {
    sharedModules.push('verification-gate', 'self-review', 'escalation');
  }
  if (missionType === 'code' || missionType === 'architect') {
    sharedModules.push('yagni');
  }
  // Research and review only get status-reporting (already in base list)

  // Read and concatenate shared modules
  const shared = sharedModules
    .map((m) => {
      try {
        return readFileSync(join(PROMPTS_DIR, 'shared', `${m}.md`), 'utf-8');
      } catch {
        return '';
      }
    })
    .filter(Boolean)
    .join('\n\n');

  return [preamble, shared, sectorSystemPrompt].filter(Boolean).join('\n\n');
}
```

- [ ] **Step 3: Replace inline preambles in `start()` method**

Replace the entire block from line 276 (`const researchPreamble =`) through line 412 (`const combinedSystemPrompt = [...]...join(...)`) with:

```typescript
      const missionType = this.opts.missionType ?? 'code';
      const combinedSystemPrompt = buildCrewSystemPrompt(missionType, this.opts.systemPrompt);
```

This replaces ~136 lines of inline template literals with a 2-line call.

- [ ] **Step 4: Verify the build compiles**

Run: `npm run typecheck`
Expected: No new errors (existing errors are OK).

- [ ] **Step 5: Verify prompt files are accessible at runtime**

Run: `ls src/main/starbase/prompts/shared/`
Expected: All 5 shared `.md` files listed.

Run: `ls src/main/starbase/prompts/*.md`
Expected: All 5 mission-type `.md` files listed.

- [ ] **Step 6: Commit**

```bash
git add src/main/starbase/hull.ts
git commit -m "refactor(hull): replace inline preambles with file-based prompt composition"
```

---

## Task 4: Add `setCrewStatus()` to crew-service.ts

**Files:**
- Modify: `src/main/starbase/crew-service.ts:333-337` (after `messageCrew`)

- [ ] **Step 1: Add `setCrewStatus()` method**

Add after the `messageCrew` method (after line 337):

```typescript
  /**
   * Update a crew's status. Used by the comms layer for guidance protection.
   */
  setCrewStatus(crewId: string, status: string): void {
    this.deps.db
      .prepare("UPDATE crew SET status = ?, updated_at = datetime('now') WHERE id = ?")
      .run(status, crewId);
    this.deps.eventBus?.emit('starbase-changed', { type: 'starbase-changed' });
  }

  /**
   * Reset the timeout for an active crew's Hull process.
   * Returns true if the hull was found and timeout was reset.
   */
  resetCrewTimeout(crewId: string): boolean {
    const hull = this.hulls.get(crewId);
    if (!hull) return false;
    // sendMessage resets timeout, but we need a way to reset without sending a message.
    // Hull.resetTimeout is private, so we use a dedicated public method.
    return hull.extendDeadline();
  }
```

- [ ] **Step 2: Add `extendDeadline()` public method to Hull**

In `hull.ts`, add after the `sendMessage` method (after line 546):

```typescript
  /**
   * Extend the crew's deadline without sending a message.
   * Used by guidance protection to prevent timeout during awaiting-guidance.
   */
  extendDeadline(): boolean {
    if (this.status !== 'active') return false;
    this.resetTimeout();
    return true;
  }
```

- [ ] **Step 3: Verify typecheck passes**

Run: `npm run typecheck`
Expected: No new errors.

- [ ] **Step 4: Commit**

```bash
git add src/main/starbase/crew-service.ts src/main/starbase/hull.ts
git commit -m "feat(crew-service): add setCrewStatus and resetCrewTimeout for guidance protection"
```

---

## Task 5: Add guidance status transitions to comms handler

**Files:**
- Modify: `src/main/socket-server.ts:792-806` (inside `comms.send` case)

- [ ] **Step 1: Add guidance transitions after the `commsService.send()` call**

In `socket-server.ts`, find the `comms.send` case (line 772). After the `const id = await commsService.send(...)` call (line 792) and before the auto-inject block (line 800), add:

```typescript
        // Guidance protection: transition crew status on guidance comms
        if (msgType === 'needs-guidance' && from !== 'admiral') {
          // Crew is requesting help — shield from kill sweeps
          const crewStatus = crewService.getCrewStatus(from);
          if (crewStatus && crewStatus.status === 'active') {
            crewService.setCrewStatus(from, 'awaiting-guidance');
            crewService.resetCrewTimeout(from);
          }
        }

        if (msgType === 'guidance-response' && to !== 'admiral') {
          // FirstOfficer (or Admiral) responded — unshield crew
          const crewStatus = crewService.getCrewStatus(to);
          if (crewStatus && crewStatus.status === 'awaiting-guidance') {
            crewService.setCrewStatus(to, 'active');
            // resetCrewTimeout happens via hull.sendMessage below (auto-inject)
          }
        }
```

- [ ] **Step 2: Verify typecheck passes**

Run: `npm run typecheck`
Expected: No new errors. `getCrewStatus` already exists on CrewService (line 352).

- [ ] **Step 3: Commit**

```bash
git add src/main/socket-server.ts
git commit -m "feat(comms): add guidance protection status transitions for needs-guidance/guidance-response"
```

---

## Task 6: Add kill sweep guards to Sentinel

**Files:**
- Modify: `src/main/starbase/sentinel.ts:249-255` (deadline sweep query)

- [ ] **Step 1: Add `awaiting-guidance` guard to deadline sweep**

In `sentinel.ts`, find the deadline check query at line 250-254:

```typescript
    const expiredCrew = db
      .prepare<[], CrewRow>(
        `SELECT id, sector_id, pid FROM crew
         WHERE status = 'active' AND deadline IS NOT NULL AND deadline < datetime('now')`
      )
      .all();
```

Change the WHERE clause to exclude `awaiting-guidance` crews:

```typescript
    const expiredCrew = db
      .prepare<[], CrewRow>(
        `SELECT id, sector_id, pid FROM crew
         WHERE status = 'active' AND status != 'awaiting-guidance'
           AND deadline IS NOT NULL AND deadline < datetime('now')`
      )
      .all();
```

Note: The lifesign check (line 222-225) already filters `WHERE status = 'active'`, which naturally excludes `awaiting-guidance`. The sector path check (line 296-298) also filters `status = 'active'`. No changes needed for those.

- [ ] **Step 2: Verify typecheck passes**

Run: `npm run typecheck`
Expected: No new errors.

- [ ] **Step 3: Commit**

```bash
git add src/main/starbase/sentinel.ts
git commit -m "feat(sentinel): guard deadline sweep from killing crews in awaiting-guidance status"
```

---

## Task 7: Add guidance sweep to Sentinel

**Files:**
- Modify: `src/main/starbase/sentinel.ts:383-386` (before firstOfficerSweep call)

- [ ] **Step 1: Add `guidanceSweep()` method**

Add after the `firstOfficerSweep()` method (around line 610, before the hailing escalation block):

```typescript
  private async guidanceSweep(): Promise<void> {
    const { db, firstOfficer } = this.deps;
    if (!firstOfficer) return;

    type GuidanceRow = {
      comm_id: number;
      crew_id: string;
      sector_id: string;
      sector_name: string;
      mission_id: number;
      mission_summary: string;
      mission_prompt: string;
      guidance_message: string;
    };

    const pendingGuidance = db
      .prepare<[], GuidanceRow>(
        `SELECT c.id as comm_id, cr.id as crew_id, cr.sector_id,
                s.name as sector_name,
                m.id as mission_id, m.summary as mission_summary,
                m.prompt as mission_prompt, c.payload as guidance_message
         FROM comms c
         JOIN crew cr ON cr.id = c.from_crew
         JOIN sectors s ON s.id = cr.sector_id
         JOIN missions m ON m.id = cr.mission_id
         WHERE c.type = 'needs-guidance'
           AND c.read = 0
           AND cr.status = 'awaiting-guidance'
           AND NOT EXISTS (
             SELECT 1 FROM comms
             WHERE type = 'guidance-response'
             AND to_crew = cr.id AND read = 0
           )
         LIMIT 3`
      )
      .all();

    for (const row of pendingGuidance) {
      if (firstOfficer.isRunning(row.crew_id, row.mission_id)) continue;

      // Get recent crew output for context
      let crewOutput = '';
      if (this.deps.crewService) {
        crewOutput = this.deps.crewService.observeCrew(row.crew_id);
      }

      // Mark the needs-guidance comm as read so we don't re-dispatch
      db.prepare('UPDATE comms SET read = 1 WHERE id = ?').run(row.comm_id);

      firstOfficer
        .dispatch(
          {
            crewId: row.crew_id,
            missionId: row.mission_id,
            sectorId: row.sector_id,
            sectorName: row.sector_name,
            eventType: 'needs-guidance',
            missionSummary: row.mission_summary,
            missionPrompt: row.mission_prompt,
            acceptanceCriteria: null,
            verifyCommand: null,
            crewOutput,
            verifyResult: null,
            reviewNotes: null,
            retryCount: 0,
            guidanceMessage: row.guidance_message
          },
          {
            onExit: () => {
              this.deps.eventBus?.emit('starbase-changed', { type: 'starbase-changed' });
            }
          }
        )
        .catch((err) => {
          console.error(`[sentinel] Guidance dispatch error for crew ${row.crew_id}:`, err);
        });
    }
  }
```

- [ ] **Step 2: Call `guidanceSweep()` in `_runSweep()` BEFORE the firstOfficerSweep**

In `_runSweep()`, find line 383-386:

```typescript
    // 10. First Officer triage — detect actionable failures and dispatch
    if (this.deps.firstOfficer) {
      await this.firstOfficerSweep();
    }
```

Add the guidance sweep before it:

```typescript
    // 10a. Guidance sweep — dispatch FirstOfficer consultant for stuck crews
    if (this.deps.firstOfficer) {
      await this.guidanceSweep();
    }

    // 10b. First Officer triage — detect actionable failures and dispatch
    if (this.deps.firstOfficer) {
      await this.firstOfficerSweep();
    }
```

- [ ] **Step 3: Add `guidanceMessage` to ActionableEvent type in first-officer.ts**

In `first-officer.ts`, find the `ActionableEvent` type (line 34-52). Add the optional field:

```typescript
  guidanceMessage?: string;
```

After `deploymentBudgetExhausted` (line 51).

- [ ] **Step 4: Verify typecheck passes**

Run: `npm run typecheck`
Expected: No new errors.

- [ ] **Step 5: Commit**

```bash
git add src/main/starbase/sentinel.ts src/main/starbase/first-officer.ts
git commit -m "feat(sentinel): add guidance sweep to dispatch FirstOfficer consultant for stuck crews"
```

---

## Task 8: Add consultant mode to FirstOfficer

**Files:**
- Modify: `src/main/starbase/first-officer.ts:96-101` (getStatusText)
- Modify: `src/main/starbase/first-officer.ts:114-134` (dispatch — mode branch)
- Modify: `src/main/starbase/first-officer.ts:460-482` (handleProcessExit — consultant fallback)
- Modify: `src/main/starbase/first-officer.ts:884-895` (generateClaudeMd — consultant variant)
- Modify: `src/main/starbase/first-officer.ts:897-942` (buildSystemPrompt — consultant variant)
- Modify: `src/main/starbase/first-officer.ts:945-978` (buildInitialMessage — consultant variant)

- [ ] **Step 1: Update `getStatusText()` to reflect consultant mode**

Replace `getStatusText()` at line 96-101:

```typescript
  getStatusText(): string {
    if (this.running.size === 0) return 'Idle';
    const entries = [...this.running.values()];
    if (entries.length === 1) {
      const mode = entries[0].mode ?? 'triage';
      return mode === 'consult'
        ? `Consulting for ${entries[0].crewId}`
        : `Triaging ${entries[0].crewId}`;
    }
    return `Working on ${entries.length} issues`;
  }
```

- [ ] **Step 2: Add `mode` to `RunningProcess` type**

Update the `RunningProcess` type at line 68-73:

```typescript
type RunningProcess = {
  proc: ChildProcess;
  crewId: string;
  missionId: number;
  startedAt: number;
  mode?: 'triage' | 'consult';
};
```

- [ ] **Step 3: Add consultant branch in `dispatch()`**

In `dispatch()` at line 114, after the maxRetries check (line 125-133), add a consultant mode branch:

```typescript
    const isConsultant = event.eventType === 'needs-guidance';

    // Skip retry-count check for consultant mode (it's not a retry)
    if (!isConsultant && event.retryCount >= maxRetries) {
      await this.resolveEscalation(
        event,
        'Maximum retries exhausted',
        'Maximum retries exhausted before First Officer analysis.'
      );
      callbacks?.onExit?.(0);
      return true;
    }
```

(This replaces the existing maxRetries check at lines 125-133.)

- [ ] **Step 4: Update CLAUDE.md generation for consultant mode**

In `dispatch()`, replace the claudeMdPath block (lines 139-144):

```typescript
    const claudeMdPath = join(workspace, 'CLAUDE.md');
    const claudeMdContent = isConsultant
      ? this.generateConsultantClaudeMd()
      : this.generateClaudeMd();
    await writeFile(claudeMdPath, claudeMdContent, 'utf-8');
```

- [ ] **Step 5: Update system prompt and initial message for consultant mode**

Replace lines 148-151 (spFile/msgFile writes):

```typescript
    const promptDir = join(tmpdir(), 'fleet-first-officer');
    await mkdir(promptDir, { recursive: true });
    const spFile = join(promptDir, `${event.crewId}-sp.md`);
    const msgFile = join(promptDir, `${event.crewId}-msg.md`);
    await writeFile(
      spFile,
      isConsultant
        ? this.buildConsultantSystemPrompt(event)
        : this.buildSystemPrompt(event, maxRetries),
      'utf-8'
    );
    await writeFile(
      msgFile,
      isConsultant
        ? this.buildConsultantInitialMessage(event)
        : this.buildInitialMessage(event),
      'utf-8'
    );
```

- [ ] **Step 6: Update initial user message for consultant mode**

Replace the `initMsg` construction at line 192-201:

```typescript
      const initContent = isConsultant
        ? `Read and execute the consultation instructions in ${msgFile}. Delete the file when done.`
        : `Read and execute the triage instructions in ${msgFile}. Delete the file when done.`;

      const initMsg =
        JSON.stringify({
          type: 'user',
          message: { role: 'user', content: initContent },
          parent_tool_use_id: null,
          session_id: ''
        }) + '\n';
      proc.stdin.write(initMsg);
```

- [ ] **Step 7: Store mode in RunningProcess**

At line 181-186, add `mode`:

```typescript
      this.running.set(k, {
        proc,
        crewId: event.crewId,
        missionId: event.missionId,
        startedAt: Date.now(),
        mode: isConsultant ? 'consult' : 'triage'
      });
```

- [ ] **Step 8: Add `generateConsultantClaudeMd()` method**

Add after `generateClaudeMd()` (after line 895):

```typescript
  private generateConsultantClaudeMd(): string {
    return `# First Officer — Consultant Mode

You are the First Officer aboard Star Command, consulting for a running crew.
Your job is to analyze their situation and send actionable guidance via fleet comms.

Do not modify code, deploy crews, recall crews, or write files yourself.
Use \`fleet comms send\` to deliver your guidance to the crew.
`;
  }
```

- [ ] **Step 9: Add `buildConsultantSystemPrompt()` method**

Add after `buildSystemPrompt()` (after line 942):

```typescript
  private buildConsultantSystemPrompt(event: ActionableEvent): string {
    return `You are the First Officer aboard Star Command, acting as a consultant.

A crew member is stuck and requesting guidance. They are STILL RUNNING —
your response will be delivered directly into their active session.

Analyze their situation and respond using:

\`\`\`bash
fleet comms send \\
  --from first-officer \\
  --to ${event.crewId} \\
  --type guidance-response \\
  --message "your guidance here"
\`\`\`

Your guidance should include:
- Analysis of what they tried and why it failed
- A specific recommended next approach
- Key files or patterns to look at
- Any architectural context they may be missing

You may send multiple messages if needed (e.g., initial analysis, then follow-up details).

Context:
- Crew ID: ${event.crewId}
- Mission ID: ${event.missionId}
- Sector: ${event.sectorName} (${event.sectorId})
`;
  }
```

- [ ] **Step 10: Add `buildConsultantInitialMessage()` method**

Add after `buildInitialMessage()` (after line 978):

```typescript
  private buildConsultantInitialMessage(event: ActionableEvent): string {
    let msg = `# Consultation Request

## Crew Requesting Guidance
**Crew:** ${event.crewId}
**Sector:** ${event.sectorName} (${event.sectorId})
**Mission:** ${event.missionSummary}

## Their Question
${event.guidanceMessage ?? 'No specific question provided.'}

## Original Mission Prompt
${event.missionPrompt}

## Recent Crew Output
\`\`\`
${event.crewOutput || 'No output captured.'}
\`\`\`
`;

    msg += `\nAnalyze the situation and send your guidance using \`fleet comms send --from first-officer --to ${event.crewId} --type guidance-response --message "..."\`.\n`;
    return msg;
  }
```

- [ ] **Step 11: Update `handleProcessExit()` for consultant fallback**

In `handleProcessExit()` at line 460-482, update the try block:

```typescript
    try {
      if (opts.code !== 0) {
        if (opts.event.eventType === 'needs-guidance') {
          // Consultant crashed — fall back to hailing-memo
          await this.writeHailingMemo({
            crewId: opts.event.crewId,
            missionId: opts.event.missionId,
            sectorName: opts.event.sectorName,
            payload: opts.event.guidanceMessage ?? 'Crew requested guidance but First Officer consultant failed.',
            createdAt: new Date().toISOString()
          });
        } else {
          await this.resolveEscalation(
            opts.event,
            `First Officer process crashed (exit code: ${opts.code})`,
            'First Officer failed during triage, so the mission was escalated automatically.'
          );
        }
      } else if (opts.event.eventType === 'needs-guidance') {
        // Consultant exited cleanly — check if guidance was actually sent
        const guidanceSent = this.deps.db
          .prepare<[string], { cnt: number }>(
            `SELECT COUNT(*) as cnt FROM comms
             WHERE type = 'guidance-response' AND to_crew = ? AND read = 0`
          )
          .get(opts.event.crewId);

        if (!guidanceSent || guidanceSent.cnt === 0) {
          // Consultant didn't send guidance — fall back to hailing-memo
          await this.writeHailingMemo({
            crewId: opts.event.crewId,
            missionId: opts.event.missionId,
            sectorName: opts.event.sectorName,
            payload: opts.event.guidanceMessage ?? 'Crew requested guidance but consultant provided no response.',
            createdAt: new Date().toISOString()
          });
        }
      } else {
        const decision = this.parseDecision(opts.decisionText, opts.event);
        await this.applyDecision(opts.event, decision);
      }
    } finally {
      opts.callbacks?.onExit?.(opts.code);
      this.deps.eventBus?.emit('starbase-changed', { type: 'starbase-changed' });
    }
```

- [ ] **Step 12: Give FirstOfficer consultant access to `fleet` CLI**

In `dispatch()`, update the `mergedEnv` (line 166-172) to include `FLEET_BIN_DIR` for consultant mode so it can run `fleet comms send`. This is already handled — the existing env includes `FLEET_BIN_DIR`. Also ensure `allowedTools` is not restricted. The consultant needs Bash access to run `fleet comms send`.

In the `cmdArgs` array (lines 153-164), the `--dangerously-skip-permissions` flag already grants full tool access. No change needed.

- [ ] **Step 13: Verify typecheck passes**

Run: `npm run typecheck`
Expected: No new errors.

- [ ] **Step 14: Commit**

```bash
git add src/main/starbase/first-officer.ts
git commit -m "feat(first-officer): add consultant mode for mid-flight crew guidance"
```

---

## Task 9: Verify full build and integration

**Files:** None (verification only)

- [ ] **Step 1: Run full typecheck**

Run: `npm run typecheck`
Expected: Both `typecheck:node` and `typecheck:web` pass with no new errors.

- [ ] **Step 2: Run lint**

Run: `npm run lint`
Expected: No new lint errors in modified files.

- [ ] **Step 3: Run build**

Run: `npm run build`
Expected: Build succeeds. Prompt `.md` files are bundled with the output.

- [ ] **Step 4: Verify prompt files exist in build output**

Run: `ls out/main/starbase/prompts/shared/ 2>/dev/null || echo "Prompts not in build output — need electron-vite config update"`

If prompts are missing from the build output, the `.md` files need to be copied by electron-vite. Check `electron.vite.config.ts` for asset copy configuration and add a copy plugin if needed:

```typescript
// In electron.vite.config.ts, main config:
import { viteStaticCopy } from 'vite-plugin-static-copy';

// Add to plugins:
viteStaticCopy({
  targets: [{
    src: 'src/main/starbase/prompts/**/*.md',
    dest: 'starbase/prompts'
  }]
})
```

- [ ] **Step 5: Commit any build config changes**

```bash
git add electron.vite.config.ts
git commit -m "build: add prompt templates to electron-vite static copy"
```

---

## Task Summary

| Task | Description | Key Files |
|------|-------------|-----------|
| 1 | Shared prompt modules | `prompts/shared/*.md` |
| 2 | Mission-type prompts | `prompts/*-crew.md` |
| 3 | Hull prompt composition refactor | `hull.ts` |
| 4 | CrewService status + timeout helpers | `crew-service.ts`, `hull.ts` |
| 5 | Comms guidance transitions | `socket-server.ts` |
| 6 | Sentinel kill sweep guards | `sentinel.ts` |
| 7 | Sentinel guidance sweep | `sentinel.ts`, `first-officer.ts` |
| 8 | FirstOfficer consultant mode | `first-officer.ts` |
| 9 | Build verification | config files |
