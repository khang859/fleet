# Agent pane `schedule` tool - Implementation Plan

> Status: **designed, not implemented.**
> Requirements are locked (section 3), the architecture is chosen (section 6), and nothing has been written yet.
> Three independent architecture proposals were produced and reconciled; where they disagreed, section 5 records which won and why.

## 1. What this is

A way for the native Agent pane's model to ping itself later.

The motivating case is the plain one: the agent finishes something, knows it cannot judge the outcome yet, and wants to come back to it in five hours.
Today it has no way to do that.
It can only either spin inside the turn (`bash sleep`, which burns the turn and the user's patience) or tell the user to remind it, which puts the work back on the person who delegated it.

Three tools, on a cron expression, delivered as a message into the conversation that set them.

## 2. What other harnesses do

Research findings, recorded because they shaped every decision below.

**Claude Code** splits the capability in two, which is the most instructive part.
`ScheduleWakeup(delaySeconds, prompt, reason, stop)` is a one-shot self-ping clamped to `[60, 3600]` seconds, where the model passes its own prompt back to itself and `stop: true` cancels.
`CronCreate` / `CronList` / `CronDelete` are the durable half: 5-field cron, recurring or one-shot, 8-character ids, capped at 50 per session.
The semantics worth stealing are documented explicitly:

- A scheduled prompt fires **between turns, never mid-response**; if the model is busy when a task comes due, the prompt waits until the current turn ends.
- **No catch-up for missed fires.** It fires once on return to idle, not once per missed interval.
- Recurring tasks **expire after 7 days**, firing one final time before deleting themselves, which bounds how long a forgotten loop can run.
- **Jitter** is derived from the task id, so many sessions do not all hit the API on the same wall-clock second.
- If an iteration ends without either rescheduling or stopping, one fallback wakeup fires about 20 minutes later and then the loop ends.
- Times are local, not UTC.

**Cloudflare Agents** has the cleanest API surface, a single polymorphic `when`:

```ts
async schedule<T>(when: Date | string | number, callback, payload?, options?)
// number -> seconds delay | Date -> absolute | string -> cron
```

Plus `listSchedules({type, timeRange})`, `getScheduleById`, and `cancelSchedule`, persisted to SQLite and woken by Durable Object alarms so they survive restarts.
They also ship `getSchedulePrompt()` and `scheduleSchema` so the model itself parses "remind me to call mom tomorrow at 3pm" into a discriminated union.

**Letta** has Schedules with either cron or `--every`, caps local schedules at 50 per agent, and marks a locally-missed task as missed rather than firing it once it is more than five minutes late.
Their documentation says the best way to use schedules is to let the agent create its own by chatting.

**Vercel eve** makes a schedule a file: a cron expression plus a handler, deployed as a Vercel Cron Job on top of durable checkpointed sessions.

**Codex** has an open proposal (openai/codex#25466) that is essentially Claude Code's design cloned: `CronCreate`/`List`/`Delete` plus `ScheduleWakeup` plus `/loop`, session-only by default with optional persistence to `.codex/scheduled_tasks.json`, and the same 7-day auto-expiry.

### Failure modes the research turned up

These are real, shipped-and-filed problems, not hypotheticals, and each one is answered somewhere in section 6.

1. **Runaway self-rescheduling.** `ScheduleWakeup` has no cancellation mechanism, so an agent that re-schedules on every wakeup loops forever (anthropics/claude-code#58235).
2. **Silent stuck sessions.** Non-persistent wakeups plus no way to interrupt equals an unrecoverable session (anthropics/claude-code#61735).
3. **Mid-turn delivery corrupts the interaction**, so delivery has to wait for idle.
4. **Cold start.** A fired turn has only the note it was given, so the tool has to force a self-contained note rather than "check that thing". Every source converges on this being the single most common way self-scheduling is got wrong.
5. **Double dispatch.** Two paths deciding a schedule is due (a live timer and a catch-up scan) will double-fire without atomic claiming.
6. **Clocks are not monotonic.** A `setTimeout` armed for five hours does not survive laptop suspend reliably, and a wall-clock cron across a DST boundary is ambiguous.
7. **Kill switches must sit outside the agent's control surface** (hard caps, budget circuit-breakers, recursion limits), because the agent cannot reliably decide when it is done.

Sources: [Claude Code scheduled tasks](https://code.claude.com/docs/en/scheduled-tasks.md), [Cloudflare Agents](https://developers.cloudflare.com/agents/runtime/execution/schedule-tasks/), [Letta Schedules](https://docs.letta.com/configuration/schedules), [Vercel eve](https://vercel.com/blog/introducing-eve), [Zylos on autonomous task scheduling](https://zylos.ai/research/2026-06-19-autonomous-task-scheduling-self-directed-execution/), [codex#25466](https://github.com/openai/codex/issues/25466), [claude-code#58235](https://github.com/anthropics/claude-code/issues/58235), [claude-code#61735](https://github.com/anthropics/claude-code/issues/61735).

## 3. Locked requirements

These were decided with the user and are not open for relitigation during implementation.

**Shapes.** Full cron, recurring and one-shot.
Three tools: create, list, cancel.
Standard 5-field expressions read in the user's local timezone.
Recurring schedules expire 7 days after creation, firing one last time on the way out.
Jitter is applied deterministically from the schedule id.

**Durability.** Survives an app restart, fires late, and is never silently lost.
App running with a pane on that session means the pane wakes and runs a turn.
App running with no pane on that session means the fire is recorded as due and **nothing runs, no tokens are spent**; it is delivered when a pane next opens that session and goes idle.
App closed at the due time behaves the same way.

**Missed fires coalesce to exactly one.**
However many intervals were missed, the session gets one message saying it is a scheduled check and how overdue it is.
The next due time is computed from now, not from the missed slot.

**Storage.** One app-wide store in main at `~/.fleet/agent/schedules.json`, keyed by session id.
The scheduler must scan every pending schedule across all sessions, which it cannot do by reading N session logs.

**Delivery.** A synthetic message in the transcript, clearly marked as scheduled rather than as something the user typed, followed by a normal turn.
Explicitly **not** the `task` pattern of overwriting the scheduling call's `result`, because one tool-call row cannot hold N fires of a recurring schedule.

**Guardrails.** All four are required: a per-session cap on pending schedules, a chain-depth cap, always visible and cancellable in the UI, and a minimum delay floor.

**Notification.** Reuse the existing path with no new notification code.
A fire calls `reportActivity` exactly as `resume` already does, so the dock badge, glyph, chime, OS notification and Cmd-K jump-to-needy all follow from the user's existing alert settings.

## 4. What the codebase already provides

The Agent pane is a from-scratch build and deliberately does not reuse the Chat harness.
The good news is that the `task` (subagent) tool already built almost every mechanism this feature needs, and the design comment at `src/shared/agent-tools.ts:805-809` states the governing idea:

> It is also what makes the report arrive without a mechanism for reports.
> When the child finishes, its answer is written into this call's `result`... Nothing has to inject anything: a field the pane already persists simply says something different than it did an hour ago.

| Need | Existing mechanism |
| :-- | :-- |
| A tool that returns a receipt, not an answer | `runTask`, `src/main/agent/tools/task.ts` |
| Deliver a late result into a finished turn | `finishTask`, `agent-store.ts:761`, including the `found === null` branch that writes straight to the session log when no pane is showing the session |
| Wake an idle pane | `resume(paneId)`, `agent-store.ts:415` - empty `text`, `resumed: true`, transcript as-is |
| Do not fire mid-turn | `scheduleResume`, `agent-store.ts:844` - debounced by `RESUME_BATCH_MS`, reschedules itself while the pane is busy rather than dropping |
| Tell the model why it woke up | `withResumeNote`, `agent-service.ts:342`, using `FLEET_WIRE_PREFIX` |
| Reconcile rows claiming to be running after a restart | `reconcileTasks`, `agent-store.ts:874` + the `agent:task-running` channel |
| A synchronous cap claimed with no `await` in the middle | `SubagentManager.dispatch`, `subagents/manager.ts:198-207` |
| A cap refusal that is not a red error row | `SubagentCapReached` handling, `tools/task.ts:51-65` |
| Atomic whole-file JSON write | `AgentHistoryStore.compact`, `history-store.ts:106-110` - temp file then `renameSync` |
| Notify when a background pane needs attention | `reportActivity`, `agent-store.ts:54` into `routeActivityReport` and `raiseAlerts` |
| Render a new tool with no new component | generic `AgentToolRow` + one case in `tool-label.ts` |
| A side-column card plus narrow-pane chip | `subagent-view.ts`, `AgentSubagentPanel.tsx`, `SideColumnCard.tsx`, `fitsSideColumn` in `side-column.ts` |

### Constraints that shape everything

**Main is stateless per turn.**
The transcript lives in the renderer store and `agent:send` carries the whole history every time.
Main keeps no conversation state between turns.

**The renderer decides what is session-worthy; main only writes it down.**
This is stated at the top of `session-store.ts`.

**There is no scheduler infrastructure of any kind today.**
No cron parser, no job queue, no retry or backoff.
Every subsystem hand-rolls `setInterval` (`cwd-poller.ts`, `activity-tracker.ts`, `clipboard-monitor.ts`).
This is greenfield.

**No sqlite in the agent subsystem.**
It is flat-file JSONL and JSON throughout.

**Fleet is single-instance-locked** (`main/index.ts:290`), so exactly one process ever touches the schedule file.

## 5. The three proposals, and what was taken from each

Three architects worked independently from the same locked spec.
All three converged on: three tools named `schedule_create`/`schedule_list`/`schedule_cancel`, an own-code dependency-free 5-field cron parser with a brute-force forward search, whole-file JSON at `~/.fleet/agent/schedules.json` written via temp-plus-rename, reuse of `scheduleResume` and `reportActivity`, and chain depth carried as a per-request field alongside `resumed`.
They disagreed on three things that matter.

### Disagreement 1: how a fire reaches a pane that is not open

**A (minimal)** broadcasts the fire every tick and waits for the renderer to acknowledge it, so an unopened session is simply re-offered every 15 seconds.
Its own stated weakness is that an abandoned session broadcasts into the void forever, unbounded, for as long as the app runs.

**B (clean)** writes the fire message straight into the session log when no pane is showing it, then delivers on reopen by checking whether the transcript's last message is an unanswered `scheduled` message.
This is bounded, but it inherits a hazard: `session-store.ts:92` reads `if (!exists && event.t !== 'message') return;`, so a `message` event **recreates a deleted session's file**.
Writing a fire into a deleted session would resurrect it as an orphan holding one message.
It is also fragile in one ordinary case: if the user opens the session and types before the resume fires, the fire message is no longer last and nothing triggers the turn.

**C (pragmatic)** puts an explicit `state: 'pending' | 'due'` on the persisted record and splits the operation in two.
Main **claims** (`claimDue`), the renderer **pulls** (`pullDue`), and a due record simply sits in the store until someone pulls it.

**Chosen: C.** It is bounded (no forever-broadcast), it has no session-resurrection hazard (nothing is written to a log until a pane is actually delivering), and it survives the user-types-first case because due-ness is persisted state rather than inferred from the transcript's shape.

### Disagreement 2: `role: 'scheduled'` versus `role: 'user'` plus a text marker

**A and B** both add a fourth `AgentMessage.role`, arguing from the precedent already in the code at `agent-types.ts:452-454`: `summary` "is a distinct role because it is neither side of the conversation, and rendering it as the assistant's own words would be a lie."

**C** uses `role: 'user'` with a plain-text marker prefix, detected by an `isScheduleFireMessage()` helper.

**Chosen: the new `'scheduled'` role (A and B).**
C's two arguments were aimed at *reusing* `'summary'`, which nobody proposed: its first point (the `SUMMARY_WIRE_PREFIX` is hardcoded, so reuse would tell the model something false) does not apply to a new role at all.
Its second point (compaction wants `role === 'user'` cut points at `agent-context.ts:152`) is real but is a one-line predicate change, not a reason to abandon the type.
Determining a message's provenance by sniffing its text content is exactly the kind of thing that rots, and it would have to be re-derived at every call site that currently trusts `role === 'user'` to mean "what the person said".

### Disagreement 3: how the minimum delay floor is enforced

**A** enforces it structurally, always searching for the next occurrence from `now + floor`, which silently reinterprets a too-frequent cron rather than refusing it.

**B** additionally checks the *interval between consecutive occurrences*, so `* * * * *` is refused outright rather than quietly turned into a 5-minute schedule.

**Chosen: B's explicit refusal.**
Silently changing what a cron expression means is worse than saying no, because the model has no way to learn it happened.

### Also taken

From **A**: purge a session's schedules when the session is deleted.
B and C both listed the absence of this as their own weakest point, and A had it in the manifest.
Given the `session-store.ts:92` resurrection behaviour, this is a correctness requirement, not a tidiness one.

From **C**: the stateless 15-second interval that recomputes due-ness from the wall clock on every tick, and the unification of the app-launch catch-up into the ordinary tick so there is exactly one implementation of "what is due".

## 6. Chosen architecture

### 6.1 The governing split

**Claiming and delivering are different operations, done by different processes, and neither may do the other's job.**

**Claiming** answers "is this due, and what happens to its cron state".
It happens in exactly one function, `ScheduleStore.claimDue(now)`, in main.
It is called by the periodic tick and once eagerly at app launch, the same function both times.
It only ever reads `state === 'pending'` records and flips them to `'due'` in the same synchronous call, so a second call cannot reclaim them.

**Delivering** answers "turn a due record into a transcript message and a turn".
It happens in the renderer, is triggered from three hook points, and always goes through one atomic consume, `ScheduleStore.pullDue(sessionId)`, which deletes or recycles the records in the same synchronous call before returning them.
Calling it twice returns the batch once and `[]` after.

This is what makes failure modes 5 (double dispatch) and 6 (non-monotonic clocks) structural non-issues rather than things we hope do not happen.
There is one producer and several equally-safe idempotent consumers, and the asymmetry is the fix.

### 6.2 The persisted record

`~/.fleet/agent/schedules.json` holds one JSON array.
Not JSONL: this is a small mutable set that must be scanned whole, which is the opposite of what an append-only log is good at.

```ts
export type AgentScheduleState = 'pending' | 'due';

export type AgentScheduleRecord = {
  id: string;
  sessionId: string;
  /** Carried so a fire can be delivered without a session lookup, exactly as AgentTaskDone.cwd is. */
  cwd: string;
  cron: string;
  note: string;
  recurring: boolean;
  createdAt: string;
  /** createdAt + 7 days, recurring only. Null for a one-shot. */
  expiresAt: string | null;
  /** Chain-fire hops that produced this record. 0 for one an ordinary turn created. */
  depth: number;
  state: AgentScheduleState;
  /** This schedule's own idea of when it next needs claiming. Jitter already folded in. */
  nextDueAt: string;
  /** Frozen at claim time: the occurrence being delivered, so the message can say how late it is. */
  dueSince: string | null;
  /** Set at claim time: this due fire is the last one, so pullDue deletes rather than recycles. */
  terminal: boolean;
};
```

Guardrail constants live beside it in `src/shared/agent-schedule.ts`.

**Concurrency.** Every mutating method is fully synchronous with no `await` between reading the array and writing it back, so two panes calling `schedule_create` in the same instant are two serialized handler invocations with no interleaving possible.
This is the reasoning `subagents/manager.ts:198-206` already gives for its own cap.

**Crash mid-write.** `flush()` writes to a `.tmp` sibling and `renameSync`s over the real file, so a crash leaves the previous file whole.
The rename is the only atomic step and it is last.

**Version.** A `version` field, bumped informationally with no migration machinery.
Reminders are disposable in a way conversations are not, so an unparseable file logs a warning and starts empty, the same fallback `session-store.ts`'s `load()` already takes.

### 6.3 Cron

`src/shared/agent-schedule-cron.ts`, no dependency.

The case against a dependency: a 5-field parser supporting `*`, `,`, `-`, `/` and 3-letter day and month names is about 120 lines, and the matching has to run in the machine's own local wall-clock time, which `Date`'s local getters give for free.
Every library worth reaching for either brings an IANA timezone database this does not need or a much larger dialect (seconds fields, `L`/`W`/`#`, `@daily` macros) that the tool description would then have to support or suppress.

```ts
export function parseCron(expr: string): CronFields | null;
export function nextFireAfter(fields: CronFields, after: Date, limitMs?: number): Date | null;
export function jitterMs(scheduleId: string): number;
```

**Matching is a brute-force forward walk in real elapsed time**, not field arithmetic.
Round `after` up to the next whole minute, test the candidate against the five fields using local getters, advance by one real minute, repeat.
Closed-form next-occurrence calculation is where subtle date bugs live; at one comparison per candidate minute even a multi-year search is well under 50ms, and this function decides whether a user's reminder fires at all.

Day-of-month and day-of-week are **OR'd when both are restricted**, per POSIX `crontab(5)`.
This is the one cron rule that reliably surprises people, so it is stated in the tool description rather than left to be discovered.

**DST falls out correctly without special-casing**, because the search never asserts that a constructed wall-clock time equals itself.
Spring-forward: incrementing into the nonexistent hour normalizes to a real instant outside it, the field read-back does not match, and the search moves on, so the fire is skipped, which is the only sane answer for a time that did not happen.
Fall-back: the walk passes through both real instants that read as the repeated hour, and since the function only answers "next", it takes the first and stops.

**A timezone change is answered by not storing an offset at all.**
Matching always runs against the current local getters, so a schedule created in one zone and evaluated in another simply means 9am wherever the user now is.
A wall-clock cron has no fixed meaning across a timezone change, and this is the honest reading of "the user's local timezone".

**Termination** is capped at a four-year forward search.
An unsatisfiable expression such as `30 2 30 2 *` returns `null`, and `create` treats that as a validation failure.

**Jitter** is a small hash of the schedule's own id reduced into `[0, 60_000)`, added to the matched minute and recomputed at every re-arm.
Same id gives the same offset every time, so a daily 9am schedule fires at a consistent 9:00:0XX rather than wandering, and a fleet of `0 * * * *` schedules do not all wake in the same instant.

### 6.4 The timer

`setInterval` at `SCHEDULE_TICK_MS = 15_000`, well under both cron's one-minute granularity and the 60-second jitter window.

Each tick is stateless and asks the same question against the real wall clock: what is due right now.
This is the answer to failure mode 6.
A `setTimeout` armed for five hours before a laptop sleeps is not guaranteed to fire on time after resume, because Chromium throttles and coalesces timers and the OS may not deliver the callback until after wake.
A 15-second interval that recomputes from `Date.now()` does not care whether 15 seconds or 5 hours of real time elapsed since the last tick.

`start()` calls `tick()` **immediately** before arming the interval.
That single line is the whole of the app-was-closed catch-up: the first tick on next launch finds overdue pending records and claims them exactly as an ordinary tick would.
There is no separate catch-up implementation to keep in sync with the live one.

### 6.5 The firing sequence

**Case A: pane open on the session, idle.**

1. Tick calls `store.claimDue(now)`. For each due record: `dueSince := nextDueAt`, `nextDueAt := nextFireAfter(fields, now)` if non-terminal, `state := 'due'`.
2. Claimed records are grouped by `sessionId` and emitted as `AGENT_SCHEDULE_CHANGED` via the existing `agentEmit` closure.
3. The renderer's listener updates `thread.schedules` for display and calls `checkSchedules(paneId)` for every pane whose `sessionId` matches.
4. `checkSchedules` gates on idleness: `thread.streamId === null && !thread.loading`.
5. It calls `pullDue(sessionId)`. Main consumes atomically, deleting terminal records and recycling the rest to `pending`, and returns the pre-consumption snapshot.
6. `deliverSchedules` builds one `role: 'scheduled'` message per record, appends them to `thread.messages`, and calls `record(thread, { t: 'message', message })` - the ordinary session-log path, no new event type.
7. It then adds the streaming assistant placeholder, sets `streamId`, calls `reportActivity(paneId, 'working')`, and sends with `text: ''` and `scheduleChainDepth` set to the max `depth` of the batch. Because `toWireHistory:598-601` drops the opening message entirely when `text === ''`, the scheduled message is already the last wire message with no extra plumbing.
8. Each round calls `withScheduleReminder(messages, store.list(threadId))`, so the model sees what it still has pending from round one.
9. `endTurn` reports `done`/`error`/`needs_me` through the path every other turn uses. No new notification code.

**Case B: pane open but busy.**
Steps 1 to 3 are identical.
At step 4 the pane is streaming, so `checkSchedules` returns without doing anything and the record sits `due`.
When the in-flight turn ends, `endTurn` calls `checkSchedules(paneId)` again and delivery proceeds.
This is the fix for failure mode 3: there is no code path that appends a fire or calls `send` while `streamId !== null`, and both call sites read idleness fresh rather than from a value captured when the push arrived.

**Case C: no pane on that session, or the app was closed.**
Claiming is unconditional and does not care whether anyone is watching.
The push finds no matching pane and is a no-op.
The record sits `due` and **no turn runs, no tokens are spent** - achieved by construction, since nothing in main can start a turn and only a renderer pane calling `send` can.
When a pane later opens the session, `replayInto` gets a sibling to its existing `reconcileTasks` call: load the schedule list, then `checkSchedules(paneId)`.
The still-frozen `dueSince` is what lets the message say "this was due three hours ago" rather than "just now".

### 6.6 The four guardrails

**1. Per-session cap.** `MAX_SCHEDULES_PER_SESSION = 10`, counted and thrown inside `create()` with no `await` in between, mirroring `SubagentManager.dispatch`.
`runScheduleCreate` catches `ScheduleCapReached` specifically and returns `{ text, summary }` rather than throwing, so it renders as an ordinary row.
This is a retryable state, not a mistake, and a red row would misrepresent it, which is the reasoning `tools/task.ts:51-65` already applies.

**2. Chain depth.** `MAX_SCHEDULE_CHAIN_DEPTH = 3`, a plain `throw` so it does render as a failed row.
This asymmetry is deliberate: a chain past three hops is architecturally wrong and retrying will not fix it, so a person reviewing the transcript should see it.

`depth` is set once at creation and never mutated.
It is computed as `ctx.schedule.chainDepth === null ? 0 : ctx.schedule.chainDepth + 1`, where `chainDepth` is per-turn context built from `RoundsRequest.scheduleChainDepth`, threaded from `AgentSendRequest.scheduleChainDepth`.
That is the same plumbing shape the existing `resumed?: boolean` flag already uses: a fact about why this turn started, which the wire cannot show on its own, carried once per request rather than persisted anywhere new.
An ordinary `send` or `resume` never sets it, so it is `null` for every turn except one delivering a fire.

Subagents cannot reach any of this.
`schedule_*` is in `AGENT_TOOL_NAMES` but not `SUBAGENT_TOOL_NAMES`, and `ctx.schedule` is `null` on a subagent's context: the same double enforcement `task`'s own comment argues for, "not by checking a depth counter at dispatch, but by never giving a child the thing it would need".

**3. Always visible and cancellable.** The side-column card and the narrow-pane chip each carry a stop button that calls `window.fleet.agent.schedule.cancel(id)` **directly**.
No tool call, no permission gate, no model turn is in that path, the same shape as `AgentTaskCard.tsx:92`'s `cancelTask`.
The model's own `schedule_cancel` goes through the ownership-checked branch of the same method, which refuses to cancel another session's schedule; the user's button skips that check, because a person clicking in their own pane needs no such guard.
This is the answer to failure modes 1 and 2.

**4. Minimum delay floor.** `MIN_SCHEDULE_DELAY_MS`, checked in `create()` two ways: the first occurrence must be at least the floor away, **and** for a recurring schedule the gap between consecutive occurrences must also clear it, so `* * * * *` is refused rather than silently reinterpreted.
Note honestly that the floor alone does not stop a chain of distinct one-shot schedules each re-arming just past it; that shape is caught by the chain-depth cap and the per-session cap, not by the floor.

### 6.7 Cold start

Failure mode 4 cannot be enforced structurally, because zod validates shape and not semantic completeness.
It is forced the way `task`'s `prompt` field is already forced: by naming the actual failure in the description rather than describing the field abstractly, and by stating the mechanism that makes it true.
It is then reinforced at delivery time, because the fire message itself opens by saying this is the note you left for yourself and not something the user typed.

## 7. The `'scheduled'` role: call-site audit

A new member of a closed union sounds safe, but `role` is branched on with `if` chains rather than exhaustive switches, so **TypeScript will not force these changes**.
A missed one falls through to the assistant branch, silently.
Every site was audited; this list is exhaustive for `AgentMessage`.

| Site | What happens if missed | Action |
| :-- | :-- | :-- |
| `shared/agent-types.ts:455` | - | Add `'scheduled'` to the union. |
| `shared/agent-session.ts` `CommonMessageFields.role` | zod rejects the event, the fire never persists | Add to the enum. |
| `main/agent/agent-service.ts:504-507` `toWireMessages` | **Real bug**: falls through and serializes the fire as an assistant message | Add a branch emitting `role: 'user'` with a new `SCHEDULE_WIRE_PREFIX`, mirroring the `summary` branch exactly. |
| `renderer/components/agent/AgentThread.tsx:562-563` `Message()` | **Visible bug**: renders as assistant prose | Branch to a new `AgentScheduleFire` card before the `user` check. |
| `renderer/store/agent-store.ts:1259` `nameSession` | Auto-title may fire on, or be suppressed by, a synthetic message | Exclude `'scheduled'` from the `users` filter. |
| `shared/agent-context.ts:152` `splitForCompaction` | A fire is not treated as a valid cut point, so a compaction can open on an answer | Decide explicitly. A fire genuinely is a fresh question, so it should count. |
| `shared/agent-session.ts:372` `firstUserText` | A log whose first message is a fire would be titled by the note | Exclude `'scheduled'`. Low risk in practice, since a schedule cannot exist before a user message, but cheap to close. |
| `renderer/components/agent/activity.ts:42` | None. `last?.role !== 'assistant'` correctly yields `'waiting'`. | **No change needed** (verified). |
| `renderer/components/sessions/TranscriptView.tsx:143` | None. Uses `TranscriptMessage` from `shared/sessions.ts`, a different type for the Claude-session viewer. | **No change needed** (verified). |

## 8. Tools

Three tools in the `todo_add`/`todo_update` naming family, added to `AGENT_TOOL_NAMES` and **not** `SUBAGENT_TOOL_NAMES`.
A subagent has no durable reopenable session for a fire to land in, so offering it would be a tool backed by nothing, which the registry's own rule forbids.

```ts
export const ScheduleCreateArgs = z.object({
  cron: z.string().min(1),
  note: z.string().min(1).max(SCHEDULE_NOTE_MAX_CHARS),
  recurring: z.boolean()
});
export const ScheduleListArgs = z.object({});
export const ScheduleCancelArgs = z.object({ id: z.string().min(1) });
```

```ts
export type AgentScheduleCapability = {
  /** The depth of the schedule that fired to start this turn, or null for an ordinary one. */
  chainDepth: number | null;
  create: (input: { cron: string; note: string; recurring: boolean }) => AgentScheduleRecord;
  list: () => AgentScheduleRecord[];
  cancel: (id: string) => boolean;
};
```

`AgentToolContext.schedule: AgentScheduleCapability | null`, null exactly for a subagent, the same idiom as `dispatchTask` and `findSubagent`.

### `schedule_create` description

The prose the model reads matters as much as the code, and the cold-start clause is the load-bearing part.

```
Wake yourself up later to check on something, on a schedule you set now.

When it fires, `note` is the entire brief the turn that reads it will have -
not this conversation, not what you were doing when you called this, nothing
else. Write it as though for a version of yourself with no memory of today:
name the file, the command, the PR, the value you are watching, and what
"done" or "still wrong" looks like. "Check on it" or "see if it finished" is
not enough on its own to act on.

`cron` is a standard 5-field expression - minute hour day-of-month month
day-of-week - read in the user's own timezone. `*` means every value, `,`
lists several, `-` is a range, `/` is a step (`*/15` = every 15 minutes);
3-letter day and month names are accepted. Day-of-month and day-of-week are
OR'd together when both are restricted, the traditional cron rule.

`recurring: true` repeats on that schedule and expires itself a week after
being created, firing once more on its way out; `recurring: false` fires
once and is gone. A recurring schedule that missed several fires while
nothing was open to run it gets exactly one catch-up message, saying how
overdue it is, not one per missed interval.

The fire arrives as an ordinary message in this conversation once you are
next idle - never mid-turn - and a normal round follows from it. There is no
need to keep this turn open or check back yourself: stop your turn once the
schedule is set.

A conversation may only hold a handful of these at once, and a schedule
created by a schedule that fired from a schedule cannot chain forever - past
a few hops the call is refused and says to ask the user instead.
```

`schedule_list` says the list is this conversation's own, that most turns are told it unasked via the reminder block, and that it is mainly for getting an exact id before cancelling.
`schedule_cancel` says to use it once the thing being watched is no longer worth watching, because a schedule left running past its purpose is a turn nobody asked for.

## 9. File manifest

### New

| File | Responsibility |
| :-- | :-- |
| `src/shared/agent-schedule-cron.ts` | Pure 5-field parse, forward match, deterministic jitter. |
| `src/shared/agent-schedule.ts` | Record type and zod schema, guardrail constants, the fire-message prose renderer, `SCHEDULE_WIRE_PREFIX`. |
| `src/main/agent/schedule-store.ts` | Atomic JSON persistence, create/cancel/list, `claimDue`, `pullDue`, `cancelAllFor`. |
| `src/main/agent/schedule-timer.ts` | The interval plus the eager first tick. |
| `src/main/agent/tools/schedule.ts` | `runScheduleCreate` / `runScheduleList` / `runScheduleCancel`. |
| `src/renderer/src/store/agent-schedule.ts` | Delivery orchestration: `onScheduleChanged`, `checkSchedules`, `deliverSchedules`, the idle predicate. |
| `src/renderer/src/components/agent/schedule-view.ts` | Pure view-model for card and chip. |
| `src/renderer/src/components/agent/AgentSchedulePanel.tsx` | Side-column card. |
| `src/renderer/src/components/agent/AgentScheduleFire.tsx` | The delivered-fire transcript card. |

Plus colocated `__tests__` for each of `agent-schedule-cron`, `agent-schedule`, `schedule-store`, `schedule-timer`, `tools/schedule`, `store/agent-schedule`, and `schedule-view`.

### Modified

| File | Change |
| :-- | :-- |
| `src/shared/agent-tools.ts` | Three names into `AGENT_TOOL_NAMES`; three zod schemas; three `AGENT_TOOL_SPECS` entries; `AgentToolContext.schedule`. |
| `src/shared/agent-types.ts` | `'scheduled'` role; `AgentSendRequest.scheduleChainDepth`; `AGENT_SCHEDULE_INSTRUCTIONS` spliced into `buildSystemPrompt` unconditionally, as the todo block is. |
| `src/shared/agent-session.ts` | `'scheduled'` in the role enum; exclude it from `firstUserText`. No new event type. |
| `src/shared/agent-context.ts` | `splitForCompaction` cut-point predicate accepts `'scheduled'`. |
| `src/shared/ipc-channels.ts` | Four `AGENT_SCHEDULE_*` channels with rationale comments in house voice. |
| `src/main/agent/tools/run.ts` | Three dispatch cases. |
| `src/main/agent/agent-service.ts` | `Deps.schedules`; `withScheduleReminder` colocated with `withSubagentReminder` and spliced into `runRounds`; build `ctx.schedule` at the `runTool` site and `null` in `runTask`; thread `scheduleChainDepth`; the `'scheduled'` branch in `toWireMessages`. |
| `src/main/agent/agent-ipc.ts` | Handlers for list, cancel, pull-due; **`AGENT_SESSION_DELETE` also calls `schedules.cancelAllFor(sessionId)`**. |
| `src/preload/index.ts` | `agent.schedule = { list, cancel, pullDue, onChanged }`. |
| `src/main/index.ts` | Construct store and timer, wire the emit, pass deps, start it, stop it in `shutdownAll` beside `agentSubagents?.cancelAll()`. |
| `src/renderer/src/store/agent-store.ts` | `PaneThread.schedules`; `checkSchedules` at the end of `endTurn` and inside `replayInto`; the `onChanged` listener; the `nameSession` exclusion. |
| `src/renderer/src/components/agent/AgentThread.tsx` | `Message()` branch to `AgentScheduleFire`; `ScheduleChip`; `schedulesInPanel` prop. |
| `src/renderer/src/components/agent/AgentPane.tsx` | Selector, `showSchedulePanel`, fold into `columned`, render the panel, thread the prop. |
| `src/renderer/src/components/agent/tool-label.ts` | Three cases; `note`, `cron`, `id` added to `LabelArgs`. |

## 10. Rendering

**Tool row.** No bespoke component.
`schedule_create` and friends complete in one round with nothing left running, so `AgentTaskCard`'s reason for existing does not apply.
Three cases in `tool-label.ts` give `{ verb: 'Schedule', target: cron }`, `{ verb: 'List schedules', target: '' }`, `{ verb: 'Cancel schedule', target: id }`.

**The fire message.** `AgentScheduleFire.tsx`, modeled on `SummaryCard` but always expanded, since a note is short and is exactly what is worth reading at a glance.
A clock icon, a header reading "Scheduled check-in" plus how late it was, and the note underneath.
Visually distinct from both the user's bubble and the assistant's flat prose.

**Side-column card.** `AgentSchedulePanel.tsx`, structurally the same as `AgentSubagentPanel.tsx`, wrapping `SideColumnCard`, one row per record with note, cron, next fire, and a stop button.
Sourced from `thread.schedules`, not reconstructed from the transcript, for the same reason `taskActivity` is kept separate: live state belongs to main's durable store, not to the call that happened to create it.
`showSchedulePanel` reuses `fitsSideColumn` unchanged.
No reconcile step is needed, unlike subagents, because a schedule has no live-process ambiguity that a restart could leave stale.

**Narrow-pane chip.** `ScheduleChip` mirrors `SubagentChip`: a clock, a count, the next fire time when there is exactly one, and a hover title listing the rest.

Next-fire text is an absolute local time, not a live countdown.
A `setInterval` in the renderer for cosmetics is the kind of speculative complexity the project rules warn against, and nobody asked for a ticking clock.

## 11. Build sequence

Each step verifies on its own before the next begins.

1. **Cron module** plus tests. Verify: the new suite alone, no Electron involved.
2. **Record type, constants, prose renderer** plus tests. Verify: `npm run typecheck`.
3. **`ScheduleStore`** plus tests, not yet wired into `main/index.ts`. Verify: guardrails, double-claim, double-pull, crash-mid-flush, coalescing.
4. **`ScheduleTimer`** plus fake-timer tests. Verify: `start()` claims eagerly; a multi-hour fake-clock jump claims exactly once; `stop()` clears the interval.
5. **Tool args, specs, `AgentToolContext.schedule`** - shapes only. Verify: `npm run typecheck`, which is where a zod-versus-JSON-Schema mismatch surfaces first.
6. **`tools/schedule.ts`, `run.ts` dispatch, `ctx.schedule` construction, `withScheduleReminder`.** Verify: `agent-service.test.ts`-style tests, including that a subagent's `ctx.schedule` is `null` and the tool refuses cleanly.
7. **IPC, preload, `main/index.ts` wiring, and the `AGENT_SESSION_DELETE` purge.** Verify: `npm run dev` plus `npm run drive -- eval` round-tripping `window.fleet.agent.schedule.list(sessionId)`.
8. **Renderer delivery.** Verify: idle-predicate unit tests, then a `fleet-drive` pass creating a schedule just past the floor and watching it fire unattended.
9. **Rendering.** Verify: `npm run drive -- screenshot` at a wide and a narrow width; confirm the fire reads as a card and not a chat bubble.
10. **Guardrail exercise end to end.** Push a session past the per-session cap and past chain depth 3, and confirm the wording and row treatment match section 6.6.
11. **Full pass.** `npm run typecheck && npm test`, and confirm `npm run lint` has not grown past its baseline (see section 13).

## 12. Test plan

**Pure functions.**
`parseCron`: valid and invalid syntax, named days and months, step/range/list combinations, and the day-of-month versus day-of-week OR quirk both when one field is `*` and when both are restricted.
`nextFireAfter`: an ordinary case; **DST spring-forward**, where a cron matching a nonexistent local time is skipped rather than thrown or double-counted; **DST fall-back**, where the repeated hour matches exactly once at its first real instant; leap-day `0 0 29 2 *` resolving years out within the cap; an impossible expression returning `null` rather than looping.
`jitterMs`: same id gives the same output, output is bounded, the range is reasonably covered across many ids.
The fire-message renderer: the note is always recoverable verbatim, and the overdue phrasing covers on-time, minutes, hours and days.
`schedule-view`: filtering, ordering, truncation, in the shape of the existing `subagent-view.test.ts`.
The renderer idle predicate as a pure function of `{ streamId, loading }`.

**`ScheduleStore`, against a temp directory with plain `node:fs`.**
Each of these maps to a numbered failure mode from section 2.
Runaway loop (1): four schedules chained 0 to 3, the fourth throws; ten created then the eleventh throws `ScheduleCapReached` by `instanceof`, not merely "some error".
Persistence (2): construct a fresh store against the same file after a create and assert the record survives `pending` with its original `nextDueAt`.
Cold start (4): the delivered message always embeds the note unmodified.
Double dispatch (5): `claimDue` twice with the same `now` returns empty the second time; `pullDue` twice returns the batch then `[]`; `claimDue` at a much later fake time without an intervening pull does not reclaim.
Clock jump (6): a five-hour fake-clock jump on an hourly recurring schedule claims exactly once, `dueSince` reflects the first missed hour, and the recycled `nextDueAt` comes from the jumped-to now rather than replaying the missed hours.
Expiry: a recurring schedule claimed past `expiresAt` is `terminal` and `pullDue` deletes rather than recycles it.
Session delete: `cancelAllFor` removes that session's records and nothing else.

**Renderer orchestration, with `window.fleet.agent` mocked.**
Mid-turn corruption (3): `checkSchedules` does not call `pullDue` while `streamId !== null` or `loading`, and does when both are clear.
No pane: a push for a session with no matching pane records no `send` on the mock.
Batch: two due records produce two fire messages, one `send`, and `scheduleChainDepth` equal to the max depth.

Note the trap recorded in project memory for this suite: it has previously tripped on `vi.mock`-versus-`require` ordering.

**Wire building.** `toWireMessages` gives a `'scheduled'` message the `SCHEDULE_WIRE_PREFIX` and never gives it to a `'user'` message.

## 13. Baseline to hold

Measured on `d095e403` in a fresh `npm ci` clone, so these are `main`'s numbers rather than local drift.

- **Tests: 2060 passing across 172 files, all green.** This must stay green.
- **Lint: 283 problems, 104 errors, 179 warnings, 88 files.** Pre-existing and unenforced; CI runs `typecheck` and `test` but never `eslint`. Do not add to it.
- **Typecheck: clean.**

Two pre-existing problems were found while establishing this baseline and filed rather than folded into this work:

- **[#515](https://github.com/khang859/fleet/issues/515)** - `shiki` is declared `^4.0.2` but only the exact lockfile pin typechecks. `streamdown@2.5.0` imports types `from 'shiki'` while declaring no `shiki` dependency, so it binds to whatever is hoisted at the root, while `@streamdown/code` binds to its own nested `3.23.0`. Any float (pnpm, `npm update`, Dependabot, a lockfile-less install) breaks `npm run build`. A practical consequence: this repo cannot currently be installed with pnpm.
- **[#516](https://github.com/khang859/fleet/issues/516)** - nothing runs eslint, and one of the 104 errors is a real bug: `CopilotSection.tsx` calls `useCallback` and `useRef` after two early returns, so a render before settings load runs seven hooks and one after runs ten. It does not crash today only because the Settings UI mounts after settings have loaded.

## 14. Known risks and deferred items

**Chain-depth propagation is correct but intricate, and it is the piece most likely to rot silently.**
It threads a value from the fire event through a renderer field, `AgentSendRequest`, `RoundsRequest`, and `AgentToolContext` purely to answer one comparison at the end.
If a future refactor of `send` or `resume` stops forwarding it, the guardrail degrades quietly to "everything looks like depth 0" with no error and no failing test unless the specific test is kept alive.
This deserves one integration test spanning the whole path rather than unit tests at each end.

**Chain depth is one-shot, not causal.**
It tags only the turn a fire directly produces.
A model that dispatches a subagent from inside a delivered turn and calls `schedule_create` after that subagent reports would be treated as depth 0, because the second resume carries no depth.
This is a deliberate simplification over threading depth through every detour a turn can take.

**The multi-consumer pull is safe only because `pullDue` is synchronous.**
`checkSchedules` can legitimately fire twice in quick succession, and today the second call trivially returns `[]`.
If `pullDue` ever became asynchronous, the same call pattern would reopen the double-delivery race this design closes by construction.
The safety is an invariant of the implementation rather than of the interface, and only a comment enforces it.

**The floor does less work than its name suggests.**
It stops a single schedule firing near-instantly and stops a too-frequent recurring expression, but not a chain of distinct one-shots each re-arming just past it.
Chain depth and the per-session cap are the real backstop for that shape.

**Timing constants are reasoned, not measured.**
A machine that sleeps twelve hours will find every schedule in that window due on one tick.
Per schedule that is handled correctly, but nothing throttles a burst of many sessions each near the cap all resuming at once.
Bounded in practice by how many panes a person actually has open, but not proven.

**Not designed, deliberately out of scope:** absolute one-off times (`at:`) rather than cron, natural-language parsing of a schedule, schedules attached to a folder rather than a session, and any settings UI for schedules.
