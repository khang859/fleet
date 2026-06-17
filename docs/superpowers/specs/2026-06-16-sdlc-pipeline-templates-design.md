# SDLC Pipeline Templates — Explore → Spec → Implement → Review → QA

**Date:** 2026-06-16
**Status:** Approved design
**Issue:** #234 (autonomous-dev-team epic #236; builds on #233's proposal machinery)

## Problem

The pipeline shape is hardcoded: `(decompose) → work → human review`. The orchestrator
decomposes a task by calling `kanban_create` freely **without ever reading the code**, and
profiles support only `worker | orchestrator | reviewer` — so SDLC roles (explorer, architect,
QA) have nowhere to live and nothing routes work through a design or QA stage. A feature-sized
ticket cannot flow through exploration and design before implementation, nor through QA before
integration, without a human wiring every task by hand.

This spec adds **selectable pipeline templates**: a feature ticket flows automatically through
`explore → spec → (human approval) → implement → review → QA` while a small fix keeps today's
lightweight `work → review` flow.

## Goals

- A feature-sized ticket runs explore + design before implementation and review + QA before
  integration, with **no manual task wiring**.
- The pipeline shape is **deterministic** (a code-defined skeleton) while the number/shape of
  implementation sub-tasks is **LLM-decided** by the architect.
- A **human approves the spec** before implementation begins — the one high-leverage gate.
- Ship default profiles for the new SDLC roles.
- **Off by default**: a task with no template behaves exactly as today. Pipelines work whether
  or not the PM agent (#233 autopilot) is enabled.

## Non-goals

- Auto-merging the feature PR to main — staying a human/PM action (`ship_feature` proposal,
  #233). The feature PR is the terminal human gate, and it already exists.
- A second long-lived process — the pipeline is driven entirely by the existing dispatcher tick.
- User-editable templates / a template builder UI — templates are code constants (YAGNI).
- Mid-flight `quick_fix → full_feature` escalation — deferred follow-up (see §11).
- Cross-feature coordination — everything is feature/board-scoped.

## Background: machinery this builds on

Grounded in the current code (verified during design review):

- **Dispatcher tick** (`kanban-dispatcher.ts`) runs `decompose → autoAssign → promote →
  claimAndSpawn → reviewTasks → integrate` each tick. Task statuses:
  `triage | scheduled | todo | ready | running | blocked | review | done | archived`.
- **Gating** is a parent→child DAG in `task_links`. `promotableTodoTasks()` promotes a `todo`
  child to `ready` only when **every** parent is `done`/`archived`
  (`kanban-store.ts`, the `NOT EXISTS … status NOT IN ('done','archived')` predicate).
- **Swarm skeleton** (`kanban-swarm.ts` `createSwarm`) is the precedent: it deterministically
  creates root → workers → verifier → synthesizer tasks and wires `addLink(parent, child)`,
  gating verifier on all workers and synthesizer on the verifier. The template expander mirrors
  this exactly.
- **Review per child is already automatic**: `reviewTasks()` spawns a `review` run on every
  `review`-status worktree task **when `config.autoReview` is true** (default true,
  `constants.ts`). `request_changes` → `spawnReviewFix`; `approve` → integration-eligible.
- **Proposals (#233)**: `pm_proposals` table + `kanban_propose` + `executeProposal` +
  `PM_PROPOSAL_KINDS`. Approve/Dismiss cards render in PM chat. `approveProposal` /
  `executeProposal` run over IPC **independent of `pmAutopilotEnabled`**. A proposal row can be
  created directly via `store.createProposal()` without any PM turn.
- **Feature integration**: `integrateFeatures()` flips the feature PR from draft to ready via
  `markFeaturePrReady` once `featureRollup` shows all member tasks `done`/`archived`. Merge to
  main stays a human/PM action.
- **Schema**: `SCHEMA_VERSION` currently **17**; additive columns via `addColumnIfMissing` under
  the `user_version` migration pattern. `SCHEMA_SQL` runs **before** migrations (never put an
  index on a migration-added column there — see `docs/learnings/2026-06-16-migration-column-index-in-schema-sql.md`).

## Architecture

A pipeline **template** is a TS constant listing ordered **stages**. A new
**`template-expander.ts`** turns a chosen template into a task graph + `task_links`, mirroring
`createSwarm`. Only the implement-children fan-out is produced by an LLM (the architect); every
other task and every link is created deterministically by code.

```
PM/UI sets tasks.pipeline_template = 'full_feature' at intake
        │
        ▼
dispatcher.decompose() routes a templated triage task to the expander
        │  expandTemplate(rootTask, FULL_FEATURE)   ← deterministic
        ▼
   explore ──▶ spec ──▶ ⟨approval gate task: blocked⟩ ──▶ [impl children] ──▶ review/child ──▶ qa
  (explorer)  (architect)   (released by approve_spec)     (LLM fan-out)      (reviewer, auto)  (qa)
        │                          ▲                                                            │
        │                   store.createProposal('approve_spec')                                │
        │                   → Approve/Dismiss card in PM chat (PM-agent-independent)             │
        │                                                                                        ▼
        └────── artifacts (capped) carry explore findings + spec slices ──────▶ QA gates feature PR-ready
```

No new process, no new table. The graph lives in `task_links`; the gate lives in `pm_proposals`;
stage identity lives in a column.

## 1. Data model

`SCHEMA_VERSION` **17 → 18**. All additive via `addColumnIfMissing`.

**`tasks` — two new columns:**

| Column             | Type | Meaning                                                                 |
|--------------------|------|-------------------------------------------------------------------------|
| `pipeline_template`| TEXT | `'full_feature' \| 'quick_fix' \| NULL`. Carried by the **root** task. NULL ⇒ treated as `quick_fix` (today's flow). |
| `pipeline_stage`   | TEXT | `'explore' \| 'spec' \| 'gate' \| 'implement' \| 'review' \| 'qa' \| NULL`. Carried by **generated** stage tasks. NULL ⇒ ordinary non-pipeline task. |

**Role union** (`WorkerProfile.role`, `src/shared/types.ts`):

```ts
role: 'worker' | 'orchestrator' | 'reviewer' | 'explorer' | 'architect' | 'qa'
```

**Run modes** (`RunMode`, `src/shared/kanban-types.ts`) — add three:

```ts
'work' | 'decompose' | 'specify' | 'assign' | 'resolve' | 'suggest' | 'verify' | 'review'
  | 'explore' | 'spec' | 'qa'
```

**Proposal kind** — extend `PmProposalKind` / `PM_PROPOSAL_KINDS` (#233) with one:

```ts
'approve_spec'
```

**Feature QA verdict** — one new `features` column so QA can gate PR-ready distinctly from mere
task completion:

| Column       | Type | Meaning                                              |
|--------------|------|------------------------------------------------------|
| `qa_verdict` | TEXT | `'pass' \| 'request_changes' \| NULL`. NULL ⇒ not yet QA'd or non-pipeline feature. |

No new tables.

## 2. Templates

`src/main/kanban/pipeline-templates.ts`:

```ts
export type StageKind = 'explore' | 'spec' | 'gate' | 'implement' | 'review' | 'qa'

export interface PipelineTemplate {
  id: 'full_feature' | 'quick_fix'
  /** Ordered stages the expander lays down (excludes LLM-fanned implement children,
   *  which the architect emits at the spec stage). */
  stages: StageKind[]
}

export const FULL_FEATURE: PipelineTemplate = {
  id: 'full_feature',
  stages: ['explore', 'spec', 'gate', 'qa'] // implement + per-child review are dynamic
}

export const QUICK_FIX: PipelineTemplate = {
  id: 'quick_fix',
  stages: [] // no expansion: the root task runs today's work → review flow unchanged
}
```

`quick_fix` is intentionally inert — selecting it (or leaving the template NULL) preserves the
current behavior with zero new code paths exercised.

## 3. The expander (`template-expander.ts`)

`expandTemplate(root: Task, template: PipelineTemplate, store, deps): void`, called from
`decompose()` when a triage task carries `pipeline_template === 'full_feature'` (instead of the
blind orchestrator decompose). It mirrors `createSwarm`:

1. Ensure the root has a `featureId` (create a feature if absent) so all stages ship as one unit.
2. Create **explore** (`pipeline_stage='explore'`, `explorer` role, status `ready`).
3. Create **spec** (`pipeline_stage='spec'`, `architect` role, status `todo`); `addLink(explore, spec)`.
4. Create the **gate task** (`pipeline_stage='gate'`, `system_kind='pipeline_gate'`, status
   **`blocked`**); `addLink(spec, gate)`. The gate starts blocked and is **only** released —
   marked `done` — by `executeProposal('approve_spec')`; promotion never touches a `blocked`
   task, so nothing else can release it. Implement children are gated on **this gate task**, not
   on the spec task — the spec task completes when the architect's run finishes (before
   approval), so gating children on spec would release them early. (Marking `system_kind` keeps
   the gate out of `featureRollup`, which already excludes `system_kind IS NOT NULL`.)
5. Create **qa** (`pipeline_stage='qa'`, `qa` role, status `todo`); `addLink(gate, qa)` as a
   baseline link so QA cannot precede approval. Implement children, when emitted, are **also**
   linked `child → qa` so QA waits for all implementation + review too.
6. Persist a `pipeline_expanded` task event on the root for idempotency: if present, a re-run of
   `expandTemplate` is a no-op (reclaim safety).

The fan-out (implement children) is **not** created here — the architect creates them in §5.

**Graceful degradation:** if a required role profile (`explorer`/`architect`/`qa`) is missing,
the expander logs and **falls back to `quick_fix`** (root runs the normal flow) rather than
wedging. This is the master safety valve — there is no separate feature toggle because the
template is opt-in per task.

## 4. Explore stage

- New `explore` run mode. `spawn-worker.ts` `buildPrompt` gains an `explore` branch:
  *read the codebase relevant to the root task; map affected files/modules/patterns; surface
  risks and unknowns; **write no code**; register findings as a `kanban_artifact` and post a
  one-paragraph summary comment on the root task.*
- `requireToolsForMode('explore')` grants read tools only (no write/PR tools).
- Output is a **capped artifact** (read via the existing 64 KB-capped artifact path), not a prose
  blob on the blackboard — this is the explorer→architect handoff.

## 5. Spec stage + idempotent fan-out

- New `spec` run mode. `buildPrompt` `spec` branch: *read the explore artifact + root task; write
  a concrete implementation spec; decompose the work by calling `kanban_create` once per unit,
  passing `pipeline_stage='implement'` and a per-child slice of the spec in the body; cap the
  fan-out at `MAX_FANOUT` (12) children; then stop — do not implement.* The architect does **not**
  manage parent links manually — the create path wires them (below).
- **Auto-linking (create path):** when a `spec`-stage run calls `kanban_create`, the tool path
  detects the full_feature pipeline and deterministically wires the new child: `featureId =`
  the root feature, `addLink(gateTask, child)` (gating the child on the **gate**, so it stays held
  until approval), and `addLink(child, qaTask)` (gating QA on it). The architect never needs the
  internal gate/qa ids.
- **Idempotency:** the first child-creating call on a spec task records a `children_emitted` event;
  if a reclaim re-runs the spec stage and that event exists, child creation is a no-op (prevents
  double fan-out). Enforced in the same `kanban_create` tool path.
- **Empty fan-out guard:** if the spec stage completes having emitted **zero** children, the spec
  stage is marked `blocked` with a reason ("architect produced no implementation tasks") and **no
  approval proposal is raised** — closing the "approve nothing → ship nothing" hole.
- On a non-empty spec completion, the **dispatcher** (not a PM turn) calls
  `store.createProposal({ kind:'approve_spec', boardId, targetId: gateTaskId, rationale })`. The
  rationale embeds the architect's plan summary + the affected-file citations from explore so the
  human can judge it (anti-rubber-stamping); there is no auto-approve default.

## 6. Spec approval gate (reuses #233, PM-agent-independent)

- The `approve_spec` proposal surfaces as an Approve/Dismiss card in PM chat (created directly at
  the store level, so it appears **with or without** `pmAutopilotEnabled`).
- **Approve** → `executeProposal('approve_spec')` deterministically marks the **gate task `done`**.
  Its children (linked `gate → child`) then promote via normal `task_links` gating on the next
  tick. Approval is an explicit, auditable event that a kanban card drag cannot trigger (the gate
  is `blocked`, and only `executeProposal` moves it to `done`).
- **Dismiss** → the spec stage is re-armed with the human's dismissal comment injected as
  guidance, and re-runs (the `children_emitted` guard is reset on an explicit re-arm so the new
  run may re-fan-out).
- `executeProposal` already throws-on-failure and marks the row `failed` with the error surfaced
  to chat — inherited unchanged.

## 7. Implement + review stages

- Implement children are ordinary `work` runs in worktrees — **no new code**. The architect may
  add inter-child `task_links` for true dependencies.
- Review per child is the existing automatic path (`reviewTasks()` with `autoReview` true).
  **Reviewer independence:** the default `reviewer` profile is distinct from `worker` and may set
  a different model — recommended in the profile instructions to counter self-preference bias.
- This spec documents the **`autoReview` dependency**: `full_feature` assumes `config.autoReview`
  (default true). If disabled, implement children land in `review` and wait for a human reviewer —
  the pipeline still flows, just with manual review.

## 8. QA stage

- New `qa` run mode, gated on the gate task **and** every implement child (so it runs only after
  all implementation + per-child review is done).
- `buildPrompt` `qa` branch: *validate the whole feature against the root task's acceptance
  criteria; **run the project verify commands** and exercise end-to-end behavior (execution-based,
  not a re-read of diffs); check the explore-identified risks; emit a verdict.* QA calls a tool to
  record `features.qa_verdict = 'pass' | 'request_changes'`.
- **QA gates PR-ready explicitly:** `markFeaturePrReady` gains a guard
  `&& feature.qa_verdict === 'pass'` for pipeline features (mirrors the existing review-verdict
  guard at integrate). Without this, completing QA would satisfy the rollup and flip the PR on the
  same tick — the verdict would never gate. Non-pipeline features (`qa_verdict` NULL, no QA task)
  are unaffected.
- **`request_changes`** posts findings and re-arms the relevant implement children (reusing the
  review-fix attempt budget), bounded by a new `QA_ATTEMPT_CAP`. On cap exhaustion the feature is
  marked blocked and the human is notified.

## 9. Default profiles

Seed in `DEFAULT_SETTINGS.kanban.profiles` (`src/shared/constants.ts`) — currently only `default`
(worker) and `orchestrator` are seeded. Add **all** of:

| Name        | Role        | Persona (instructions)                                                            |
|-------------|-------------|-----------------------------------------------------------------------------------|
| `explorer`  | `explorer`  | Read-only cartographer: map affected files/modules/patterns, surface risks, register an artifact + root summary. Never writes code. |
| `architect` | `architect` | Consume explore findings, write a concrete impl spec, emit the implement-children fan-out (capped), then stop. |
| `reviewer`  | `reviewer`  | Already referenced (auto-materialized when review is enabled); seed it explicitly. Distinct from worker; may use a different model. |
| `qa`        | `qa`        | Feature-level, execution-based validation against acceptance criteria; run verify commands; emit pass / request_changes. |

Reserved singleton names like the existing `orchestrator`.

## 10. Intake & selection surface

- **PM tool:** `kanban_create` (and the PM intake path) gains an optional `pipeline_template` arg
  (`z.enum(['full_feature','quick_fix'])`, optional). The PM persona documents when to pick each.
- **UI:** the task-create form gets a template dropdown (`quick_fix` default; `full_feature`
  opt-in), wired via the existing `typedInvoke` preload pattern (no new architectural surface).
- **Board/feature view:** a templated task renders a stage badge per child (`pipeline_stage`) so
  the explore→spec→…→qa progress is legible.

## 11. Config & rollout

- **No new master toggle** — `full_feature` is opt-in per task and degrades to `quick_fix` if
  roles are missing (§3). The PM-agent dependency is removed by §6.
- New tuning constants (co-located, not user settings): `MAX_FANOUT` (12), `QA_ATTEMPT_CAP` (2).
- **Default behavior unchanged**: NULL/`quick_fix` template = today's flow exactly. Existing
  boards/tasks see no difference.
- **Deferred follow-ups:** mid-flight `quick_fix → full_feature` escalation; a routing
  classifier that auto-picks the template at intake; a third "standard" template tier.

## 12. Liveness & error handling

- **Per-task failures** inherit existing coverage: `reclaim()` (lease/PID), `failureLimit`→`giveUp`
  (→ `blocked`), verify/review attempt caps.
- **Pipeline-level stalls** (the gap today): a new tick sweep `sweepStalePipelines()` flags any
  pipeline whose current stage has been idle past a threshold (e.g. spec approved but no child
  progress, gate never approved, QA looping) — marks the feature `blocked` and emits a `blocked`
  event (which the #233 autopilot trigger set already surfaces). This covers
  human-never-approves, QA-never-passes, dead-stage, and abandoned-gate.
- **Expander failure** marks the root task `blocked` with a reason rather than throwing into the
  tick loop.
- **All mutations** route through `KanbanCommands` / store accessors, inheriting validation.

## 13. Testing

- **Expander:** `full_feature` produces the expected graph (explore→spec→gate, gate→qa, no impl
  children yet); the `pipeline_expanded` event makes a second `expandTemplate` a no-op; missing
  roles → falls back to `quick_fix`; `quick_fix`/NULL → no expansion.
- **Fan-out idempotency:** a spec re-run with `children_emitted` present creates no duplicate
  children; an explicit re-arm (Dismiss) resets the guard.
- **Gate:** the gate task starts `blocked`; children cannot promote while it is blocked;
  `approve_spec` proposal Approve unblocks it → children promote; Dismiss re-arms the spec;
  empty fan-out blocks the spec and raises **no** proposal.
- **PM independence:** the `approve_spec` proposal is created and approvable with
  `pmAutopilotEnabled` false.
- **QA gating:** QA stays `todo` until gate + all impl children are done; `markFeaturePrReady`
  does not flip until `qa_verdict==='pass'`; `request_changes` re-arms children within
  `QA_ATTEMPT_CAP`, then blocks.
- **Run modes:** `explore`/`spec`/`qa` prompt-builder tests assert read-only stages get no write
  mandate and the right context is injected.
- **Stall sweep:** an idle-past-threshold pipeline is marked blocked + emits the event.
- **Schema:** bump the 12 `toBe(17)` assertions to `toBe(18)` (10 in
  `kanban-store.test.ts`, 1 in `kanban-review-store.test.ts`, plus any added) and add migration
  coverage for the new columns.

## Research basis

The structure follows current best practice (verified against external sources during design
review): explore-before-plan (Anthropic Claude Code "explore, plan, code"; Agentless localization);
hybrid deterministic-skeleton + LLM-decided fan-out (Anthropic "Building Effective Agents"
orchestrator-workers; AWS agentic guidance; LangGraph); a human gate at the spec/plan boundary as
the highest-leverage checkpoint (Devin Interactive Planning; GitHub Copilot Plan mode; shift-left
defect economics); a per-diff review distinct from an **execution-based** QA stage (DeepMind
self-correction limits; SWE-bench execution verification; LLM-as-judge bias → reviewer
independence); and process-weight matched to task type via templates (Anthropic "routing" +
"simplest solution first"). The known multi-agent failure mode — parallel agents writing code with
divergent assumptions (Cognition "Don't Build Multi-Agents"; Berkeley MAST) — is contained by
keeping parallelism to **independent** worktrees and passing artifacts/spec-slices between stages.
