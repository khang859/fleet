# Handoff: implement the Agent pane `schedule` tool

You are picking up a feature that has been fully researched, specified and designed, and not written.
This document is the working brief.
The design itself is in **`docs/agent-schedule-tool-plan.md`** and you must read it before writing anything.

Read the plan in full first.
It is about 350 lines and every section earns its place: section 6 is the architecture you are building, section 7 is the audit that will otherwise cost you an afternoon, section 11 is your build order, and section 12 is your test list.
This document does not repeat that content.
It tells you the state of the tree, what has already been decided and must not be reopened, the exact anchors you will edit, the traps specific to this repo, and what done means.

## 1. State of the tree

Branch `main` at `d095e403`, clean except for the two design docs.
**No source file has been touched.**
There is no partial implementation to find, no stub to fill in, no branch to check out.

Baseline, measured on a fresh `npm ci` clone rather than a working copy, so these are `main`'s real numbers:

- **Tests: 2060 passing across 172 files, all green.** Keep it green.
- **Typecheck: clean.**
- **Lint: 283 problems, 104 errors, 179 warnings, 88 files.** Pre-existing, and nothing in CI runs eslint. Do not add to it and do not fix it here (see section 7).

## 2. What is already decided

These were settled with the user across eight explicit decisions and one architecture choice.
**Do not reopen any of them.**
If you believe one is wrong, say so and stop, rather than quietly building something else.

1. Full 5-field cron, recurring and one-shot, read in the user's local timezone. Three tools: create, list, cancel.
2. Recurring schedules expire 7 days after creation, firing one last time on the way out. Jitter is derived deterministically from the schedule id.
3. Survives an app restart and fires late. Never silently lost.
4. When no pane is showing the session, the fire is recorded as due and **nothing runs, no tokens are spent.** It is delivered when a pane next opens that session and goes idle.
5. Missed fires coalesce to **exactly one** message, which says how overdue it is. The next due time is computed from now, not from the missed slot.
6. One app-wide store at `~/.fleet/agent/schedules.json`, keyed by session id.
7. Delivered as a new `AgentMessage.role: 'scheduled'` message. **Not** the `task` pattern of overwriting the scheduling call's `result`, which cannot work for a recurring schedule because one row cannot hold N fires.
8. All four guardrails are required: per-session cap, chain-depth cap, always-visible-and-cancellable UI, minimum delay floor.
9. Notification reuses `reportActivity` and adds **no new notification code.**

The architecture is the **synthesis in section 6 of the plan**, chosen by the user over three alternatives.
Its core is a claim/pull split: main's `ScheduleStore.claimDue(now)` is the only thing that decides due-ness, and the renderer's `pullDue(sessionId)` is the only consume path.
Three rejected alternatives are recorded in section 5 of the plan along with why, so you do not have to rediscover them.

**Scope is the schedule tool alone.**
The user was asked and declined to fold in anything else.

## 3. Build order

Follow section 11 of the plan.
Eleven steps, each verifiable before the next begins, starting with the pure cron module and ending with a full pass.

The ordering is not arbitrary.
Steps 1 to 4 are pure and testable with no Electron involved, so all the date arithmetic that is genuinely hard to be sure about is settled before anything is wired up.
Step 5 exists on its own because a zod-versus-JSON-Schema mismatch in a tool spec surfaces at typecheck, and finding that out while also debugging IPC is miserable.
Do not collapse steps to save time; the point is that when something breaks you know which step broke it.

## 4. Anchors

Every line number below was verified against `d095e403` on a clean tree.
If one does not say what this table claims, the tree has moved and you should re-grep rather than trust the number.

### Precedents to copy from

| What you need | Where it already exists |
| :-- | :-- |
| A tool that returns a receipt, not an answer | `src/main/agent/tools/task.ts` (79 lines, read all of it) |
| A cap claimed synchronously with no `await` in the middle | `SubagentManager.dispatch`, `subagents/manager.ts:189`, cap check at `:203` |
| A cap refusal that renders as an ordinary row, not a red error | `SubagentCapReached` class at `manager.ts:88`, handled in `tools/task.ts` |
| Atomic whole-file JSON write | `history-store.ts:106-110`, temp file then `renameSync` |
| A reminder block spliced into every round | `withTodoReminder` `agent-service.ts:282`, `withSubagentReminder` `:312`, `withResumeNote` `:342`, all splicing at `runRounds` `:900-902` |
| The wire prefix for a Fleet-authored message | `FLEET_WIRE_PREFIX`, `agent-service.ts:457`; and `SUMMARY_WIRE_PREFIX`, `agent-context.ts:311` |
| Waking an idle pane with an empty-text turn | `resume`, `agent-store.ts:415` |
| Deferring a wake while the pane is busy | `scheduleResume`, `agent-store.ts:844`, with `RESUME_BATCH_MS` at `:828` |
| Delivering a late result when no pane is showing the session | `finishTask`, `agent-store.ts:761`, specifically its `found === null` branch |
| Reconciling rows that claim to be live after a restart | `reconcileTasks`, `agent-store.ts:874` |
| Reporting activity so the dock badge, chime and Cmd-K all follow | `reportActivity`, `agent-store.ts:54`; `waitingOnUser`, `:80` |
| Side-column card plus narrow-pane chip | `subagent-view.ts`, `AgentSubagentPanel.tsx`, `SideColumnCard.tsx`; `fitsSideColumn` at `side-column.ts:48` |
| The narrow-pane chip itself | `SubagentChip`, `AgentThread.tsx:506` |
| A generic tool row needing no bespoke component | `AgentToolRow.tsx` driven by `tool-label.ts` |

### Sites you will edit

| Site | Line | What goes there |
| :-- | --: | :-- |
| `src/shared/agent-types.ts` | 455 | Add `'scheduled'` to the role union |
| `src/shared/agent-types.ts` | 617 | `scheduleChainDepth` beside the existing `resumed?: boolean` |
| `src/main/agent/agent-service.ts` | 504-507 | The `'scheduled'` branch in `toWireMessages`, mirroring the `'summary'` one at `:505` |
| `src/main/agent/agent-service.ts` | 282-355 | `withScheduleReminder`, colocated with the other three |
| `src/main/agent/agent-service.ts` | 900-902 | Splice the reminder into `runRounds` |
| `src/main/agent/agent-service.ts` | 1180 | `runTool`, where `ctx.schedule` is built |
| `src/renderer/src/components/agent/AgentThread.tsx` | 562-563 | Branch to `AgentScheduleFire` **before** the `'user'` check |
| `src/renderer/src/components/agent/AgentThread.tsx` | 239, 288 | `ScheduleChip`, following how `subagents` is derived and rendered |
| `src/renderer/src/store/agent-store.ts` | 1259 | Exclude `'scheduled'` from `nameSession`'s `users` filter |
| `src/renderer/src/store/agent-store.ts` | 1056 | `checkSchedules(paneId)` at the end of `endTurn` |
| `src/renderer/src/store/agent-store.ts` | 1199 | `checkSchedules(paneId)` inside `replayInto`, beside the existing `reconcileTasks` call |
| `src/shared/agent-context.ts` | 152 | `splitForCompaction`'s cut-point predicate accepts `'scheduled'` |
| `src/shared/agent-session.ts` | 372 | Exclude `'scheduled'` from the `firstUserText` capture |
| `src/shared/ipc-channels.ts` | 164-240 | Four `AGENT_SCHEDULE_*` channels, in the same voice as their neighbours |
| `src/main/agent/agent-ipc.ts` | - | Handlers, **and** `schedules.cancelAllFor(sessionId)` on `AGENT_SESSION_DELETE` (channel at `ipc-channels.ts:220`) |

The full file manifest, including the nine new files, is section 9 of the plan.

## 5. Traps

These are the specific ways this task goes wrong.
Most of them cost someone real time already.

**A new `role` member produces no compile errors.**
This is the big one and it is why section 7 of the plan exists.
`role` is branched on with `if` chains, not exhaustive switches, so adding `'scheduled'` to the union type compiles cleanly while `agent-service.ts:504` silently serializes the fire as an **assistant** message and `AgentThread.tsx:562` silently renders it as **assistant prose**.
All nine branch sites are enumerated in the plan's section 7 table, two of them confirmed as needing no change.
Work that table like a checklist.
Nothing else will tell you if you miss one.

**`session-store.ts:92` recreates a deleted session's file.**
The guard reads `if (!exists && event.t !== 'message') return;`, so a `message` event for a session whose file is gone **writes the file back**.
This is why the session-delete purge is a correctness requirement rather than tidiness: without it, a fire delivered into a deleted session resurrects it as a one-message orphan.
One of the three rejected designs failed exactly here.

**`pullDue` must stay synchronous.**
The design is safe against double delivery only because `pullDue` consumes atomically in one synchronous call, so the second of two racing `checkSchedules` calls trivially gets `[]`.
Make it async and you reopen the race that the whole claim/pull split exists to close.
Say this in a comment at the definition, because nothing in the type signature enforces it.

**Run `npm test`, never `npx vitest run`.**
After `npm run dev` the sqlite addon is built for Electron's ABI, and calling vitest directly produces roughly 456 phantom failures that have nothing to do with your change.

**Check whether a dev server is already running before starting one.**
A second `npm run dev` breaks `fleet-drive`.

**The renderer store test suite has tripped on `vi.mock`-versus-`require` ordering before.**
If mocks appear not to apply, that is the first thing to suspect rather than your own logic.

**Do not ship a `setTimeout` armed for the delay.**
The plan calls for a stateless 15-second interval recomputing from the wall clock, and the reason is in section 6.4: Chromium throttles and coalesces timers, so a five-hour timeout armed before a laptop sleeps is not guaranteed to fire on time after wake.
A long timeout looks simpler and quietly loses fires.

**Do not add a cron dependency without making the case.**
The argument against is written out in section 6.3.
The short version is that every candidate either brings an IANA timezone database this does not need or a much larger dialect the tool description would then have to explain or suppress.

**DST needs tests, not special-casing.**
The forward-walk search handles both transitions correctly by construction, because it never asserts that a constructed wall-clock time equals itself.
But that is a claim, and claims about date arithmetic need tests: both transitions are on the list in section 12.

## 6. Conventions that will be enforced in review

- **Never the em dash.** Plain dash only. This applies to code comments and prose alike.
- **No `as` type assertions and no `eslint-disable` anywhere in `src/`.** Runtime validation is zod. There are 38 existing violations on `main` and the rule is unenforced, which is not a licence to add the 39th.
- **Comments in this codebase explain why, at length, in prose, and are a large fraction of every file.** Read `src/main/agent/tools/task.ts` and the header of `src/shared/agent-tools.ts` to calibrate before writing your own. Terse code with no rationale will read as foreign here, and this feature has a lot of non-obvious reasoning behind it that belongs next to the code rather than only in a plan document.
- **Tests are vitest, colocated in `__tests__/`.** The dominant style pulls pure logic out of `.tsx` into a plain `.ts` sibling so it can be unit-tested without a renderer, which is why the manifest has `schedule-view.ts` separate from `AgentSchedulePanel.tsx`.
- **Simplicity first.** Minimum code that solves the problem, no speculative abstraction, no configurability nobody asked for. Section 14 of the plan lists what was deliberately left out; do not build those.
- **Surgical changes.** Touch only what the feature needs. If you notice unrelated dead code, mention it rather than deleting it.
- **In long Markdown files, one full sentence per line.**
- **Never add an agent name as a commit co-author.** Never hand-edit `CHANGELOG.md`.

The tool descriptions are part of the deliverable, not documentation of it.
Section 8 of the plan contains the full `schedule_create` description as approved prose.
The cold-start clause in it is load-bearing: research across five harnesses converged on "the note was not self-contained" being the single most common way self-scheduling gets built wrong, and that clause is the only thing defending against it, because zod validates shape and not semantic completeness.
Ship it close to as written.

## 7. Out of scope

**Do not fix these here, even though you will see them.**
Both are filed, both were offered to the user, and the user chose to keep this change surgical.

- **[#515](https://github.com/khang859/fleet/issues/515)** - `shiki` is declared `^4.0.2` but only the exact lockfile pin typechecks, so `npm run build` is one dependency refresh away from breaking and the repo cannot currently be installed with pnpm. If your local tree fails typecheck at `AgentMarkdown.tsx:32` complaining about `"actionscript"`, this is why, and it is not something you introduced. A fresh `npm ci` clone is clean.
- **[#516](https://github.com/khang859/fleet/issues/516)** - nothing in CI runs eslint, and one of the 104 errors is a real conditional-hooks bug in `CopilotSection.tsx`.

The general project rule is to fix lint and test problems you encounter even when unrelated.
These two are the deliberate exception, by the user's explicit choice, because they are filed and separately sized.

Also out of scope, from section 14 of the plan: absolute one-off times rather than cron, natural-language schedule parsing, folder-scoped rather than session-scoped schedules, and any settings UI.

## 8. Done means

1. `npm run typecheck` clean.
2. `npm test` green, with all of section 12's cases present. That section is a test list, not a suggestion: each `ScheduleStore` case maps to a numbered failure mode from section 2 of the plan, all of which are filed bugs in shipped harnesses rather than hypotheticals.
3. `npm run lint` has not grown past the 283-problem baseline.
4. Every row of the section 7 role-audit table accounted for, including the two marked no-change-needed.
5. **Verified end to end in the running app, by you, with `fleet-drive`.** Start `npm run dev`, then `npm run drive -- screenshot` and read the image. A schedule created just past the minimum floor must fire unattended, the fire must read as a distinct card rather than as a user bubble or assistant prose, and the side-column card and narrow-pane chip must both look right at a wide and a narrow pane width. Be picky about the pixels.
6. Both guardrail refusals exercised: push a session past the per-session cap and past chain depth 3, and confirm the wording and the row treatment match section 6.6. The asymmetry is deliberate and easy to get backwards: the cap refusal is a plain-text result because it is retryable, and the chain-depth refusal throws because it is not.
7. The claim/pull invariant commented at `pullDue`'s definition, per section 5 above.

If you finish and something in the plan turned out to be wrong, amend `docs/agent-schedule-tool-plan.md` rather than leaving the two out of step.
Section 14 already lists the parts the design itself flags as weakest, and the chain-depth propagation named there is the one most likely to have a problem you discover only while building it.
