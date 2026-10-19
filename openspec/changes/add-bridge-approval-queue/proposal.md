## Why

A client who runs several jobs at once must open each job tab to approve a plan, answer a question or allow a crew request.
Each switch costs focus, and a permission card can expire while the client is on another tab.
The approved design (canvas https://claude.ai/artifact/EZwBXMUsBEBAhrZZQ6yx1a, row A) puts everything that waits on the client in one queue on the Bridge, with a wide reader for long plans.

## What Changes

- The Bridge's right column becomes a **Waiting on you** queue.
  It lists every item that waits on the client across all open jobs of the project: permission requests, plan versions, questions, settings changes, delivered jobs to accept, and crew that need the client in their pane.
  Permissions that expire come first, then the oldest item.
- Each queue item is a compact card with its main actions inline: Allow once and Deny, Approve plan, Change and Reject, the question's picks and a free answer.
- The Bridge tab shows an amber count of all waiting items, so the count is visible from every job tab.
- A plan approval, a plan rejection or a question answer given from the Bridge waits 5 seconds before Fleet sends it, with an Undo in the queue.
  Permission answers go at once, because a crew member waits on them.
- **Reader**: Enter or a click on a queue card opens the full item in the wide main column, in place of the chat.
  Esc goes back to the chat.
  The reader has a fixed footer with the actions, and Previous and Next through the queue.
  - The plan reader shows the brief, the budget and Claude week share, the crew, every step with its role, runtime, model, skills, what it hands back, what it waits on and its cap, and the preferences the plan uses.
  - The permission reader shows the command, why it came to the client, the job's PR checks, and the last lines of the crew pane, with env values masked.
  - The question reader shows the question, its options and the free answer box at full width.
- **Ask for a change**: Change opens a "What should change?" box in the reader footer.
  The client can click steps to point at them.
  The Admiral gets the note and writes the next version; nothing starts until the client approves it.
  This is a new plan action next to the existing direct edit.
- **What changed**: every plan version after the first shows what changed since the version before it, whatever became of that version, and the note the client gave.
  Old values show struck through next to new ones, and moved, added and removed steps are marked.
- **Deny and say why**: the client can deny a permission with a short reason, which the crew member gets in the deny.
- **All clear**: an empty queue says that nothing waits, and a **Done today** list shows the client's decisions of the day.
- Keys J and K move through the queue, Enter opens the reader, A approves or allows, D denies, C asks for a change and R replies.
  They work only while focus is in the queue or the reader, never while typing.
- The job sheet on each job tab stays as it is.

## Capabilities

### New Capabilities

- `bridge-approvals`: The Bridge queue of everything that waits on the client, its inline actions and undo, the reader for plans, permissions and questions, asking for a plan change with a note, the changes since the previous plan version, deny with a reason, the all clear state, and the queue keys.

### Modified Capabilities

None.
The Admiral pane and job behavior live in the in-flight change `add-admiral-agency`, which has no main spec yet; this change adds to it without changing its requirements.

## Impact

- **Main**: `src/main/agency/jobs/index.ts` (new `revise` plan action, diff against the previous version), `src/main/agency/crew/permissions.ts` and the permission answer path (optional reason), `src/main/agency/agency-ipc.ts` (crew screen tail, args), the snapshot builder (today's client decisions), `src/main/pty-manager.ts` (read of a mirrored crew screen, already there).
- **Shared types**: `src/shared/agency-jobs.ts` (`PlanAction`, `AgencyPlanVersion`), `src/shared/agency-permissions.ts` (`PermissionAnswerRequest`), `src/shared/agency.ts` (`AgencySnapshot`).
- **Preload**: `src/preload/index.ts` for the new calls.
- **Renderer**: `src/renderer/src/components/admiral/` (new queue, reader and diff components; `AdmiralPane.tsx`, `JobTabs.tsx`, `PlanCard.tsx`, `PermissionCard.tsx`, `QuestionCard.tsx` get compact or reader forms), `src/renderer/src/store/agency-store.ts` (queue selectors, details for every job with waiting items), a new store for decisions held for undo.
- **Docs**: `docs/admiral.md`.
- No new dependencies.
