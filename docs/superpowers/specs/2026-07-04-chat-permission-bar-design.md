# Chat Permission Bar - Design

## Problem

The Chat tool renders AI-agent messages, reasoning blocks, and tool calls (e.g. WebSearch) in a scrolling message stream.
When a tool call needs approval, a permission card appears with Allow once / Allow &amp; remember / Deny, flipping to "Allowed"/"Denied" after a decision.

Today these cards render as the last block *inside* the scrollable stream (`MessageList.tsx`), after all messages and the in-flight streaming turn.
When the agent fans out several tool calls, its narration stacks at the top while the approval cards pile at the bottom, detached from the text that triggered each one, and they scroll away with the content.
The user reported the cards as "out of order" and asked to make it a sticky box at the bottom "so we don't jam it into the chat window."

## Goals

- Lift approvals out of the scroll stream into a fixed action surface that is always in view.
- Keep the stream as pure transcript.
- Make batch approval of a fan-out (e.g. 5 identical searches) fast, not a serialized click-wait grind.
- No layout jank, no click targets moving under the cursor, no focus theft from the composer.

## Non-goals

- Redesigning `ToolCallCard`'s internals or the deny/settle/abort core.
- Changing how decided tool calls persist into the transcript (unchanged `ToolCallView` path).
- Changing the settings-backed permission rule store or the rule-matching semantics.

## Architecture overview

Two coordinated changes:

1. **Renderer** - a new overlay `PermissionBar` component, plus store bookkeeping so the bar can show "one at a time" and advance the queue without a store-mutating timer.
2. **Main process** - retro-apply a freshly-remembered rule to already-pending requests, and a new main-&gt;renderer channel to withdraw the auto-resolved cards.

### Current-code grounding

- `MessageList.tsx` renders the scroll stream in a `StickToBottom` container; the permission cards are `permissionRequests.map(req =&gt; <ToolCallCard/>)` as the last child inside `StickToBottom.Content`.
- `ChatView.tsx` is a flex column: `MessageList` (scroll area) -&gt; `UsageMeter` -&gt; `Composer`.
- `ToolCallCard.tsx` is the approve/deny card with internal "decided" state showing "Allowed"/"Denied".
- Store (`chat-store.ts`, zustand): `permissionRequests: PermissionRequestPayload[]` is the pending queue, appended on the `onPermissionRequest` IPC subscription and bulk-cleared at turn boundaries (stream-done, stream-error, user-abort, initial state, conversation switch).
  `decidePermission(requestId, outcome)` forwards the decision over IPC and intentionally does NOT remove the card (per issue #424, so it can show the "Allowed/Denied" confirmation).
- Main process (`permission-manager.ts`): `PermissionManager.request()` short-circuits to `allow`/`deny` synchronously when current rules already decide it; otherwise it mints a `requestId`, computes `suggestRememberRule(tool, command)`, stores a `Pending` (`{ resolve, rememberRule }`) in a `Map<requestId, Pending>`, and emits `CHAT_PERMISSION_REQUEST` to the renderer.
  `decide(requestId, outcome)` persists the rule when `allow-always`, then `settle()` resolves the awaiting tool-call promise and deletes the map entry.
  Rule matching lives in `rule-evaluator.ts` (`evaluatePermission`, `suggestRememberRule`).
  Remembered rules persist to `settingsStore.ai.chat.permissions.allow`; `getRules()` always reads live settings, so a newly persisted rule is visible to the next evaluation.

## Renderer design

### PermissionBar (new component `src/renderer/src/components/chat/PermissionBar.tsx`)

Placement: an **absolute overlay** pinned to the bottom of the message-list region, floating just above the composer.
It does NOT take space in the flex column, so `MessageList` and `Composer` never reflow when it appears or dismisses.
This eliminates layout shift under the cursor and StickToBottom resize jank; it obscures the last line or two of the stream, which is acceptable and conventional.
Mounted inside the `StickToBottom` container region in `ChatView.tsx` (which is already positioned), or as a sibling overlay in the same relative wrapper - whichever keeps it pinned above the composer without entering the flex flow.

Rendering:

- Hidden entirely when there is no request to show (no pending and no lingering decided card).
- Shows the **first undecided** request via the existing `ToolCallCard`, rendered with `key={request.requestId}`.
  The key is required: without it, when the next request shifts into the first slot React reuses the instance and the new card mounts already showing "Allowed" with dead buttons.
- A **"+N more"** counter when more undecided requests are queued (`undecidedCount - 1`).
  The counter is **click-to-expand** into a read-only peek listing each queued request's tool name and truncated command.
- An **"Allow all N"** button when more than one request is pending.
- The card body is wrapped with a `max-h` + `overflow-y-auto` container so a large bash command or JSON arg cannot eat the message list from a pinned position.

Accessibility and input:

- `aria-live="polite"` on the bar so screen readers announce the request and the Allowed/Denied flip.
- The bar never steals focus; the user may be mid-sentence in the composer.
- The bar sits between the messages and the composer in tab order.
- Keyboard shortcuts while the bar is visible: **Alt+Enter = allow once**, **Alt+Backspace = deny** the active card.
  Modifier-based so they do not conflict with composer typing.

### Store changes (`chat-store.ts`)

- Add `decidedRequests: Record<string, PermissionOutcome>` (or an equivalent map) alongside `permissionRequests`.
  This records which requestIds have been decided and with what outcome, so the bar can compute "first undecided" and skip resolved cards.
  Both `permissionRequests` and `decidedRequests` are wiped by the existing bulk-clear at turn boundaries - no new lifecycle.
- `decidePermission(requestId, outcome)`: unchanged IPC send; additionally marks `decidedRequests[requestId] = outcome`.
  Still does not remove from `permissionRequests` (the array is cleared at turn end as today).
- **"Allow all"**: a helper that loops over every pending (undecided) requestId and calls `decidePermission(id, 'allow-once')`.
  Pure renderer; no new `PermissionOutcome` and no main-process change for this path.
  This is a one-shot batch rubber-stamp of what is queued right now - it does NOT persist a permanent rule.
  The click-to-expand peek keeps it from being a blind approval.
- New IPC subscription `onPermissionResolved({ requestId, outcome })`: marks `decidedRequests[requestId] = outcome` for requests the main process auto-resolved (the retro-apply path below), so their cards drop from view.

### Linger / advance behavior

Driven entirely by local component presence (`usePresence`), no store-mutating timer:

- Active card decided, another undecided request remains: ~150ms crossfade to the next card (matches the repo's snappy-150ms convention).
- Active card decided, it was the last one: linger ~700ms showing "Allowed"/"Denied", then fade the bar out.
- The linger timer is local component state and is cleared on unmount, so it cannot race the turn-finalize bulk-clear.

Retro-applied and "Allow all" cards are marked decided and simply are not shown (they were never the active card), so there is no visible per-card linger for them - the bar just empties.

## Main-process design (retro-apply)

The batch fix so "Allow &amp; remember" on the first of N identical calls clears the rest instantly.

- Extend the `Pending` map entry in `permission-manager.ts` to also store `tool` and `command` (today it holds only `resolve` and `rememberRule`).
  These are needed to re-evaluate a pending request against updated rules.
- In `PermissionManager.decide()`, after `persistAllowRule(entry.rememberRule)` runs for an `allow-always` outcome:
  - Loop the remaining `pending` entries.
  - For each, call `evaluatePermission(getRules(), pending.tool, pending.command)`; if it now returns `'allow'`, `settle(id, 'allow')` to resolve the awaiting tool call.
  - Emit the new `CHAT_PERMISSION_RESOLVED` channel with `{ requestId, outcome: 'allow' }` for each auto-resolved request.
- New IPC channel `CHAT_PERMISSION_RESOLVED` (main -&gt; renderer) added to `ipc-channels.ts`, bridged in preload as `onPermissionResolved`, consumed by the store subscription above.
  This is the withdraw path; no per-request cancel channel exists today (the renderer only bulk-clears at turn boundaries).

## Data flow

1. Agent calls a tool needing approval -&gt; `PermissionManager.request()` emits `CHAT_PERMISSION_REQUEST` -&gt; store appends to `permissionRequests` -&gt; `PermissionBar` shows the first undecided card.
2. Concurrent fan-out appends more entries; the bar shows "+N more" and "Allow all N".
3. User clicks Allow &amp; remember on the active card:
   - `decidePermission(id, 'allow-always')` -&gt; main `decide()` persists the rule, settles the clicked request, then retro-applies to matching pending entries and emits `CHAT_PERMISSION_RESOLVED` for each.
   - Renderer marks the clicked id and the resolved ids decided; the bar advances or empties.
4. Alternatively user clicks Allow all -&gt; renderer loops `decidePermission(id, 'allow-once')` over all pending ids; the bar empties.
5. Turn finalizes -&gt; existing bulk-clear wipes `permissionRequests` and `decidedRequests`; decided tool calls persist into the transcript via the unchanged path.

## Error handling and edge cases

- **Timer vs finalize race**: avoided by construction - the linger timer is local and cleared on unmount; queue advancement derives from store state, not from a store-mutating timer.
- **Stale resolve after abort**: `settle()` already no-ops on an unknown/settled requestId; `CHAT_PERMISSION_RESOLVED` for an id the renderer already cleared is a no-op mark.
- **Abort/stop while pending**: existing behavior - the queue clears at the turn boundary and the main-process abort signal settles orphaned requests as deny; the bar simply vanishes.
- **Heterogeneous queue + Allow all**: approves everything currently pending as allow-once; the expandable peek lets the user verify what they are approving before clicking.
- **Unbounded card content**: clamped via the `max-h` + internal-scroll wrapper.

## Files touched

Renderer:

- `src/renderer/src/components/chat/PermissionBar.tsx` (new)
- `src/renderer/src/components/chat/MessageList.tsx` (remove the inline `permissionRequests.map(...)` block and its now-unused store selectors)
- `src/renderer/src/components/chat/ChatView.tsx` (mount `PermissionBar` as an overlay above the composer)
- `src/renderer/src/components/chat/ToolCallCard.tsx` (add `key` usage at the call site; add the height-clamp wrapper; expose decided display if needed for external control)
- `src/renderer/src/store/chat-store.ts` (`decidedRequests`, updated `decidePermission`, `allowAll` helper, `onPermissionResolved` subscription)

Main / shared:

- `src/main/chat/permissions/permission-manager.ts` (`Pending` gains `tool`/`command`; `decide()` retro-apply loop + emit)
- `src/shared/ipc-channels.ts` (`CHAT_PERMISSION_RESOLVED`)
- `src/preload/index.ts` (`onPermissionResolved` bridge)
- `src/shared/chat-permissions.ts` (a `PermissionResolvedPayload` type if warranted)

## Testing

- Unit: `PermissionManager.decide()` retro-apply - persisting a rule resolves matching pending entries and leaves non-matching ones pending; emits `CHAT_PERMISSION_RESOLVED` only for resolved ids.
- Unit: store `allowAll` decides every pending id as allow-once; `decidedRequests` tracks outcomes; bulk-clear wipes both maps.
- Component/E2E (fleet-drive): fan out multiple tool calls, verify the overlay shows one card + "+N more", verify Allow &amp; remember clears matching queued cards, verify Allow all empties the queue, verify the bar never reflows the composer, verify the last-card linger then fade, verify keyboard shortcuts.
