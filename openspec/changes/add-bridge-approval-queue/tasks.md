## 1. Phase 1 - Main: data and actions the Bridge needs

- [x] 1.1 Add `previous: { version, status, note, diff } | null` to `AgencyPlanVersion` in `src/shared/agency-jobs.ts`, built in `src/main/agency/jobs/index.ts` from the version right before each one with `diffPlans`; test v2 after an approved, a rejected and a replaced v1
- [x] 1.2 Add the `revise` plan action (`note`, `steps`) to `PlanAction` and to `decide` in `src/main/agency/jobs/index.ts`: version to `replaced` with the note, first plan back to `briefing`, `client_action` wakeup naming the steps; tests for a first plan and for a proposed change on a running job
- [x] 1.3 Tell the Admiral in its instructions that a change request expects a new `job_plan` for the same job, and check the wakeup text in `src/main/agency/wakeup-text.ts`
- [x] 1.4 Add `reason?: string` to `PermissionAnswerRequest`, validate it in `agency-ipc.ts`, pass it as the deny reason to the waiting hook call and the job log; tests in main, and confirm the Go hook test for `reason` still passes
- [x] 1.5 Find how eva crew take a deny and pass the reason where its runtime takes one; record what happens where it does not
- [x] 1.6 Add `agency.crewScreen(crewId)`: the last 12 non-blank lines of the crew pane from `PtyManager.screen`, put through the job's `Redactor`, null when the pane is gone or not mirrored; confirm crew panes are mirrored; tests for masking and for a gone pane
- [x] 1.7 Add the hold: `agency.hold(decision)` and `agency.undo(holdId)`, 5 seconds, held decisions in the snapshot as `held`, run at once on quit through `quit-work.ts` and when the pane releases its claim; tests with fake timers for undo, run, refused run and quit
- [x] 1.8 Add `decisions: ClientDecision[]` to `AgencySnapshot`: the client's plan, question and permission decisions since local midnight, newest first, at most 50; tests
- [x] 1.9 Expose the new calls in `src/preload/index.ts` and their types; run typecheck, lint, `npm test`, `ripwire . --quality-delta`

## 2. Phase 2 - Renderer: one queue model

- [x] 2.1 Write `waitingItems` and `queueOrder` in `src/renderer/src/components/admiral/waiting-queue.ts` with stable keys per item; unit tests for every kind, the order, and held items hidden
- [x] 2.2 Rebuild `JobSheet`'s `waitingOnClient` on `waitingItems` with no change to what the sheet shows; existing sheet tests pass
- [x] 2.3 Make `waitingCount` count pending settings cards; test that it matches the queue length once details are loaded
- [x] 2.4 Add `useJobDetails(jobIds)` to `agency-store.ts` for every open job with waiting items that need details, and `loading` items from the snapshot hints while a detail loads
- [x] 2.5 Show the amber count badge on the Bridge tab in `JobTabs.tsx` in place of the lobby dot; test it from a job tab

## 3. Phase 3 - The queue on the Bridge

- [ ] 3.1 Add `BridgeQueue` in place of the lobby `JobSheet` in `AdmiralWorkspace`, with the client file notice, leftovers, past jobs, first-run explainer and settings box below the queue; keep the narrow-pane toggle
- [ ] 3.2 Add `QueueCard` per kind, with a one-line row for a `loading` item, and inline actions: Allow once and Deny; Approve, Change and Reject; question picks and free answer; the existing settings, delivered and needs-you actions; refusals on the card
- [ ] 3.3 Send plan and question decisions from the Bridge through `hold`, and show a held decision as one line with Undo and a countdown
- [ ] 3.4 Add the empty state and the Done today list from `snapshot.decisions`
- [ ] 3.5 Check every state against canvas row A with fleet-drive screenshots in light and dark themes, at a wide and a narrow pane

## 4. Phase 4 - The reader

- [ ] 4.1 Add `bridge-store.ts` with `reading` per pane, and `QueueReader` in the main column with the `AgentThread` kept mounted and hidden; Esc, Previous, Next, "N of M waiting", and moving on when the item leaves the queue
- [ ] 4.2 Export the `PlanCard` pieces and build `PlanReader`: brief, summary, budget, week share, crew count, every step with role, runtime, model, skills, hands back, waits on and cap, uses with sources, new roles, starts from, env files, cautions; fixed footer with the decision bar
- [ ] 4.3 Add `layout: 'reader'` to `PermissionCard`: full target, time left, why it came, the job's PR checks, the pane lines from `crewScreen` every 2 seconds as plain text, Peek, and Deny with a reason
- [ ] 4.4 Add `layout: 'reader'` to `QuestionCard`: context, every option with detail and the Admiral's pick, free answer, answers through `hold`
- [ ] 4.5 Show the other kinds (settings, delivered, needs you) in the reader as their existing cards at full width
- [ ] 4.6 Component tests for the reader: open, Esc keeps the draft, item resolved while open, long plan scrolls with the footer in view

## 5. Phase 5 - Ask for a change and what changed

- [ ] 5.1 Add the "What should change?" box to the plan reader footer: click a step to add it as a chip, Cmd+Enter sends `revise` through `hold`, Esc cancels; keep "Edit the plan" for the direct edit
- [ ] 5.2 Add `PlanDiffView` from `previous`: the client's note, old values struck through for budget, week share and crew count, moved, changed, added and removed steps marked, a Show changes switch, and a link to the version before
- [ ] 5.3 Tests for the diff view on moved, changed, added and removed steps, and for a v2 with no note

## 6. Phase 6 - Keys, polish, docs

- [ ] 6.1 Add the key handler on the Bridge root with roving focus in the queue; J, K, Enter, Esc, A, D, C, R press the matching enabled button; tests that typing in the composer and modifier keys do nothing
- [ ] 6.2 Show key hints in the queue header and on reader buttons; check focus rings and screen reader names
- [ ] 6.3 Update `docs/admiral.md` with the queue, the reader, change requests, undo and the keys
- [ ] 6.4 E2E with fleet-drive in a throwaway git repository with its own Admiral: two jobs with waiting items, decide from the Bridge, Undo an approval before it hires crew, ask for a change and read v2, deny with a reason; never approve a plan in a way that hires real crew, and never touch jobs j23 and j24 in the main dev app
- [ ] 6.5 Write a learning in `docs/learnings/` for any mistake found on the way; run typecheck, lint, `npm test`, `ripwire . --quality-delta`
