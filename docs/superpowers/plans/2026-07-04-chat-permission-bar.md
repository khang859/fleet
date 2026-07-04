# Chat Permission Bar Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move Chat tool-call approvals out of the scrolling message stream into a pinned overlay bar above the composer, showing one request at a time with fast batch approval.

**Architecture:** A new `PermissionBar` overlay renders the first undecided permission request just above the composer (no flex reflow). A pure `permission-queue` helper derives which request is active and which are queued. The main-process `PermissionManager` retro-applies a freshly-remembered rule to still-pending requests and emits a new `CHAT_PERMISSION_RESOLVED` event so their cards drop; a renderer "Allow all" batch-decides the current queue.

**Tech Stack:** Electron (main/preload/renderer), React + TypeScript, zustand store, Tailwind, Vitest (node environment - no jsdom, so React components are verified by typecheck/lint + fleet-drive E2E, and all unit-tested logic lives in pure modules and the store).

## Global Constraints

- Never use the em dash character; use a plain dash.
- No unsafe type assertions (`as`) or `eslint-disable` in `src/`; use proper types (zod only where runtime validation is needed - not needed here).
- Match existing file style; surgical changes only.
- Verification commands: `npm run typecheck`, `npm run lint`, `npx vitest run <file>` for a single test file.
- Permission rule syntax is `Tool(pattern)`; `*` is the only wildcard; a bare `Tool` means `Tool(*)`. `suggestRememberRule` yields `Bash(npm run *)` for `npm run build`, `WebFetch(<origin>/*)` for a URL, and `Tool(<exact value>)` for other tools. So retro-apply clears queued requests the new rule covers (repeated `npm run *`, same-origin fetches, identical non-Bash calls); heterogeneous queues are handled by "Allow all".

---

## File Structure

New files:

- `src/renderer/src/components/chat/permission-queue.ts` - pure derivation of the bar's view from store state (active request, queued peek, counts, undecided ids). Unit-tested.
- `src/renderer/src/components/chat/__tests__/permission-queue.test.ts` - tests for the helper.
- `src/renderer/src/components/chat/PermissionBar.tsx` - the overlay component.

Modified files:

- `src/shared/ipc-channels.ts` - add `CHAT_PERMISSION_RESOLVED`.
- `src/shared/chat-permissions.ts` - add `PermissionResolvedPayload`.
- `src/main/chat/permissions/permission-manager.ts` - store tool/command/streamId per pending entry; retro-apply on `allow-always`; emit resolved.
- `src/main/chat/permissions/__tests__/permission-manager.test.ts` - retro-apply tests.
- `src/preload/index.ts` - `onPermissionResolved` bridge.
- `src/renderer/src/store/chat-store.ts` - `decidedRequests` state, decided marking, `allowAllPermissions`, `onPermissionResolved` subscription, resets.
- `src/renderer/src/store/__tests__/chat-store.test.ts` - store tests.
- `src/renderer/src/components/chat/ToolCallCard.tsx` - optional controlled `decided` prop + height clamp.
- `src/renderer/src/components/chat/MessageList.tsx` - remove the inline permission block + unused selectors.
- `src/renderer/src/components/chat/ChatView.tsx` - mount `PermissionBar` as an overlay above the composer.

---

## Task 1: Main-process retro-apply + shared plumbing

Resolve still-pending requests that a freshly-remembered rule now covers, and notify the renderer so their cards drop. This is the homogeneous-batch fix and is fully unit-testable in isolation.

**Files:**
- Modify: `src/shared/ipc-channels.ts:305-307`
- Modify: `src/shared/chat-permissions.ts:59-63`
- Modify: `src/main/chat/permissions/permission-manager.ts`
- Test: `src/main/chat/permissions/__tests__/permission-manager.test.ts`

**Interfaces:**
- Produces: `IPC_CHANNELS.CHAT_PERMISSION_RESOLVED = 'chat:permission-resolved'` (main -> renderer).
- Produces: `PermissionResolvedPayload = { requestId: string; streamId: string; outcome: PermissionOutcome }`.
- Consumes: existing `evaluatePermission`, `PermissionOutcome`, `PermissionManager` internals.

- [ ] **Step 1: Add the IPC channel constant**

In `src/shared/ipc-channels.ts`, after the `CHAT_PERMISSION_DECIDE` line (307), add a `RESOLVED` channel:

```ts
  // Permission gate (tool-call approval). REQUEST is main→renderer; DECIDE is renderer→main.
  CHAT_PERMISSION_REQUEST: 'chat:permission-request',
  CHAT_PERMISSION_DECIDE: 'chat:permission-decide',
  // Main→renderer: a still-pending request was auto-resolved (a remembered rule
  // now covers it), so the renderer drops its card without a second prompt.
  CHAT_PERMISSION_RESOLVED: 'chat:permission-resolved',
```

- [ ] **Step 2: Add the payload type**

In `src/shared/chat-permissions.ts`, after `PermissionDecisionPayload` (lines 59-63), add:

```ts
/**
 * Sent main → renderer when a queued request is auto-resolved because a rule
 * the user just remembered now covers it. The renderer marks it decided so its
 * card drops from the pending bar. `outcome` is always an allow variant today.
 */
export type PermissionResolvedPayload = {
  requestId: string;
  /** Stream the request belonged to, so the renderer can gate to the right convo. */
  streamId: string;
  outcome: PermissionOutcome;
};
```

- [ ] **Step 3: Write the failing tests**

Add to `src/main/chat/permissions/__tests__/permission-manager.test.ts`. First add a mutable-rules helper near the top (after the existing `makeManager`, around line 21) so `persistAllowRule` actually widens the live rules the way real settings do:

```ts
// Like makeManager, but persistAllowRule mutates the live rule set (as the real
// settings-backed persist does), so retro-apply can see the newly added rule.
function makeMutableManager(overrides: Partial<PermissionRules> = {}) {
  const rules: PermissionRules = { allow: [], ask: [], deny: [], ...overrides };
  const emitted: Array<{ channel: string; payload: unknown }> = [];
  const mgr = new PermissionManager({
    getRules: () => rules,
    persistAllowRule: (rule) => {
      if (!rules.allow.includes(rule)) rules.allow.push(rule);
    },
    emit: (channel, payload) => emitted.push({ channel, payload })
  });
  const reqPayloads = (): PermissionRequestPayload[] =>
    emitted
      .filter((e) => e.channel === IPC_CHANNELS.CHAT_PERMISSION_REQUEST)
      .map((e) => e.payload as PermissionRequestPayload);
  const resolvedPayloads = (): PermissionResolvedPayload[] =>
    emitted
      .filter((e) => e.channel === IPC_CHANNELS.CHAT_PERMISSION_RESOLVED)
      .map((e) => e.payload as PermissionResolvedPayload);
  return { mgr, rules, emitted, reqPayloads, resolvedPayloads };
}
```

Import the new type at the top of the file (extend the existing import from `chat-permissions`):

```ts
import type {
  PermissionRequestPayload,
  PermissionResolvedPayload,
  PermissionRules
} from '../../../../shared/chat-permissions';
```

Then add this describe block at the end of the file:

```ts
describe('PermissionManager retro-apply', () => {
  it('allow-always resolves other queued requests the new rule now covers', async () => {
    const { mgr, reqPayloads, resolvedPayloads } = makeMutableManager();
    const p1 = mgr.request({ streamId: 's', tool: 'Bash', command: 'npm run build' });
    const p2 = mgr.request({ streamId: 's', tool: 'Bash', command: 'npm run test' });
    const [first, second] = reqPayloads();

    mgr.decide(first.requestId, 'allow-always'); // persists Bash(npm run *)

    expect(await p1).toBe('allow');
    expect(await p2).toBe('allow'); // auto-resolved, never re-prompted
    const resolved = resolvedPayloads();
    expect(resolved).toHaveLength(1);
    expect(resolved[0].requestId).toBe(second.requestId);
    expect(resolved[0].streamId).toBe('s');
  });

  it('leaves queued requests the new rule does not cover still pending', async () => {
    const { mgr, reqPayloads, resolvedPayloads } = makeMutableManager();
    const p1 = mgr.request({ streamId: 's', tool: 'Bash', command: 'npm run build' });
    const p2 = mgr.request({ streamId: 's', tool: 'Bash', command: 'git push' });
    const [first, second] = reqPayloads();

    mgr.decide(first.requestId, 'allow-always'); // Bash(npm run *) does not cover git push

    expect(await p1).toBe('allow');
    expect(resolvedPayloads()).toHaveLength(0);
    // p2 is still pending: deciding it explicitly still works.
    mgr.decide(second.requestId, 'deny');
    expect(await p2).toBe('deny');
  });

  it('allow-once does not retro-apply to the queue', async () => {
    const { mgr, reqPayloads, resolvedPayloads } = makeMutableManager();
    const p1 = mgr.request({ streamId: 's', tool: 'Bash', command: 'npm run build' });
    const p2 = mgr.request({ streamId: 's', tool: 'Bash', command: 'npm run test' });
    const [first, second] = reqPayloads();

    mgr.decide(first.requestId, 'allow-once'); // persists nothing

    expect(await p1).toBe('allow');
    expect(resolvedPayloads()).toHaveLength(0);
    mgr.decide(second.requestId, 'deny');
    expect(await p2).toBe('deny');
  });
});
```

- [ ] **Step 4: Run the tests to verify they fail**

Run: `npx vitest run src/main/chat/permissions/__tests__/permission-manager.test.ts`
Expected: the three new tests FAIL (`p2` never resolves / no resolved event emitted), existing tests PASS.

- [ ] **Step 5: Implement the retro-apply in PermissionManager**

In `src/main/chat/permissions/permission-manager.ts`:

Extend the import (line 3-8) to include the new type:

```ts
import type {
  PermissionOutcome,
  PermissionRequestPayload,
  PermissionResolvedPayload,
  PermissionRules,
  PermissionVerdict
} from '../../../shared/chat-permissions';
```

Extend the `Pending` type (lines 22-25) so a pending entry carries what retro-apply needs to re-evaluate it:

```ts
type Pending = {
  resolve: (verdict: 'allow' | 'deny') => void;
  rememberRule: string;
  tool: string;
  command: string;
  streamId: string;
};
```

In `request()`, update the `this.pending.set(...)` call (line 75) to store the new fields:

```ts
      this.pending.set(requestId, {
        resolve,
        rememberRule,
        tool: req.tool,
        command: req.command,
        streamId: req.streamId
      });
```

Update `decide()` (lines 92-97) to retro-apply after a persist:

```ts
  /** Relay the user's click. No-op if the request already settled. */
  decide(requestId: string, outcome: PermissionOutcome): void {
    const entry = this.pending.get(requestId);
    if (!entry) return;
    if (outcome === 'allow-always') this.deps.persistAllowRule(entry.rememberRule);
    this.settle(requestId, outcome === 'deny' ? 'deny' : 'allow');
    // A freshly persisted allow rule may now cover other queued requests; resolve
    // them without a second prompt so a fanned-out batch clears in one click.
    if (outcome === 'allow-always') this.resolveNewlyAllowed();
  }

  /** Settle every still-pending request the current rules now auto-allow. */
  private resolveNewlyAllowed(): void {
    const rules = this.deps.getRules();
    for (const [id, entry] of [...this.pending]) {
      if (evaluatePermission(rules, entry.tool, entry.command) !== 'allow') continue;
      this.settle(id, 'allow');
      const payload: PermissionResolvedPayload = {
        requestId: id,
        streamId: entry.streamId,
        outcome: 'allow-once'
      };
      this.deps.emit(IPC_CHANNELS.CHAT_PERMISSION_RESOLVED, payload);
    }
  }
```

Note: iterate a copy (`[...this.pending]`) because `settle` deletes entries mid-loop.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run src/main/chat/permissions/__tests__/permission-manager.test.ts`
Expected: all tests PASS (new + existing).

- [ ] **Step 7: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 8: Commit**

```bash
git add src/shared/ipc-channels.ts src/shared/chat-permissions.ts src/main/chat/permissions/permission-manager.ts src/main/chat/permissions/__tests__/permission-manager.test.ts
git commit -m "feat(chat): retro-apply remembered permission rules to the pending queue"
```

---

## Task 2: Pure permission-queue helper

Derive the bar's view (which request is active, which are queued, how many, the ids to batch-approve) from raw store state. Pure and node-testable.

**Files:**
- Create: `src/renderer/src/components/chat/permission-queue.ts`
- Test: `src/renderer/src/components/chat/__tests__/permission-queue.test.ts`

**Interfaces:**
- Produces: `type PermissionView = { active: PermissionRequestPayload | null; undecidedCount: number; more: number; queued: PermissionRequestPayload[]; undecidedIds: string[] }`.
- Produces: `permissionView(requests: PermissionRequestPayload[], decided: Record<string, PermissionOutcome>): PermissionView`.
- Consumes: `PermissionRequestPayload`, `PermissionOutcome` from `src/shared/chat-permissions`.

- [ ] **Step 1: Write the failing tests**

Create `src/renderer/src/components/chat/__tests__/permission-queue.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { permissionView } from '../permission-queue';
import type { PermissionRequestPayload } from '../../../../../shared/chat-permissions';

const req = (id: string): PermissionRequestPayload => ({
  requestId: id,
  streamId: 's',
  tool: 'WebSearch',
  command: `q-${id}`
});

describe('permissionView', () => {
  it('is empty when there are no requests', () => {
    const v = permissionView([], {});
    expect(v.active).toBeNull();
    expect(v.undecidedCount).toBe(0);
    expect(v.more).toBe(0);
    expect(v.queued).toEqual([]);
    expect(v.undecidedIds).toEqual([]);
  });

  it('picks the first request as active and the rest as queued', () => {
    const v = permissionView([req('a'), req('b'), req('c')], {});
    expect(v.active?.requestId).toBe('a');
    expect(v.undecidedCount).toBe(3);
    expect(v.more).toBe(2);
    expect(v.queued.map((r) => r.requestId)).toEqual(['b', 'c']);
    expect(v.undecidedIds).toEqual(['a', 'b', 'c']);
  });

  it('skips decided requests when choosing active and counting', () => {
    const v = permissionView([req('a'), req('b'), req('c')], { a: 'allow-once' });
    expect(v.active?.requestId).toBe('b');
    expect(v.undecidedCount).toBe(2);
    expect(v.more).toBe(1);
    expect(v.queued.map((r) => r.requestId)).toEqual(['c']);
    expect(v.undecidedIds).toEqual(['b', 'c']);
  });

  it('has no active request when all are decided', () => {
    const v = permissionView([req('a'), req('b')], { a: 'deny', b: 'allow-once' });
    expect(v.active).toBeNull();
    expect(v.undecidedCount).toBe(0);
    expect(v.more).toBe(0);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/renderer/src/components/chat/__tests__/permission-queue.test.ts`
Expected: FAIL with "permissionView is not a function" / module not found.

- [ ] **Step 3: Implement the helper**

Create `src/renderer/src/components/chat/permission-queue.ts`:

```ts
import type { PermissionOutcome, PermissionRequestPayload } from '../../../../shared/chat-permissions';

/** The pending bar's derived view: what to show now and what's queued behind it. */
export type PermissionView = {
  /** The first still-undecided request, or null when nothing needs a decision. */
  active: PermissionRequestPayload | null;
  /** Count of still-undecided requests (including the active one). */
  undecidedCount: number;
  /** How many undecided requests are queued behind the active one (>= 0). */
  more: number;
  /** The undecided requests behind the active one (for the "+N more" peek). */
  queued: PermissionRequestPayload[];
  /** Every undecided request id, in order (for "Allow all"). */
  undecidedIds: string[];
};

/**
 * Derive the pending bar's view from the raw permission queue and the set of
 * already-decided request ids. Decided requests are skipped so the bar always
 * surfaces the next thing actually awaiting the user.
 */
export function permissionView(
  requests: PermissionRequestPayload[],
  decided: Record<string, PermissionOutcome>
): PermissionView {
  const undecided = requests.filter((r) => !decided[r.requestId]);
  const [active = null, ...queued] = undecided;
  return {
    active,
    undecidedCount: undecided.length,
    more: Math.max(0, undecided.length - 1),
    queued,
    undecidedIds: undecided.map((r) => r.requestId)
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/renderer/src/components/chat/__tests__/permission-queue.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/components/chat/permission-queue.ts src/renderer/src/components/chat/__tests__/permission-queue.test.ts
git commit -m "feat(chat): pure permission-queue view helper"
```

---

## Task 3: Preload bridge + store wiring

Add the renderer plumbing: a `decidedRequests` map, decided-marking in `decidePermission`, an `allowAllPermissions` batch action, and the `onPermissionResolved` subscription. Reset the new map wherever `permissionRequests` is reset.

**Files:**
- Modify: `src/preload/index.ts:937-940`
- Modify: `src/renderer/src/store/chat-store.ts`
- Test: `src/renderer/src/store/__tests__/chat-store.test.ts`

**Interfaces:**
- Consumes: `IPC_CHANNELS.CHAT_PERMISSION_RESOLVED`, `PermissionResolvedPayload` (Task 1).
- Produces: `window.fleet.chat.onPermissionResolved(cb)` bridge.
- Produces store additions: `decidedRequests: Record<string, PermissionOutcome>` and `allowAllPermissions: () => void`.

- [ ] **Step 1: Add the preload bridge**

In `src/preload/index.ts`, import the payload type where `PermissionRequestPayload` is imported (find that import and extend it), then add the bridge right after `decidePermission` (line 940):

```ts
    decidePermission: async (requestId: string, outcome: PermissionOutcome): Promise<void> =>
      typedInvoke(IPC_CHANNELS.CHAT_PERMISSION_DECIDE, { requestId, outcome }),
    onPermissionResolved: (cb: (p: PermissionResolvedPayload) => void): Unsubscribe =>
      onChannel<PermissionResolvedPayload>(IPC_CHANNELS.CHAT_PERMISSION_RESOLVED, cb),
```

To find the import to extend: search `src/preload/index.ts` for `PermissionRequestPayload` and add `PermissionResolvedPayload` to that same `import type { ... } from '.../chat-permissions'` statement. `FleetApi = typeof fleetApi` (line 960) means `window.fleet.chat.onPermissionResolved` is typed automatically - no `env.d.ts` change needed.

- [ ] **Step 2: Write the failing store tests**

In `src/renderer/src/store/__tests__/chat-store.test.ts`, add `onPermissionResolved` to the `fleet.chat` mock (next to `onPermissionRequest`, around line 67) so the store's new subscription has something to bind:

```ts
      onPermissionRequest: (cb: Listener) => {
        listeners.set(IPC_CHANNELS.CHAT_PERMISSION_REQUEST, cb);
        return () => {};
      },
      onPermissionResolved: (cb: Listener) => {
        listeners.set(IPC_CHANNELS.CHAT_PERMISSION_RESOLVED, cb);
        return () => {};
      },
      decidePermission: vi.fn().mockResolvedValue(undefined),
```

Then add this describe block at the end of the file:

```ts
describe('permission bar store wiring', () => {
  it('decidePermission marks the request decided and calls the IPC', async () => {
    await useChatStore.getState().decidePermission('r1', 'allow-once');
    expect(useChatStore.getState().decidedRequests.r1).toBe('allow-once');
    expect(window.fleet.chat.decidePermission).toHaveBeenCalledWith('r1', 'allow-once');
  });

  it('allowAllPermissions decides only the undecided pending requests as allow-once', async () => {
    useChatStore.setState({
      permissionRequests: [
        { requestId: 'a', streamId: 's', tool: 'WebSearch', command: 'q1' },
        { requestId: 'b', streamId: 's', tool: 'WebSearch', command: 'q2' },
        { requestId: 'c', streamId: 's', tool: 'WebSearch', command: 'q3' }
      ],
      decidedRequests: { b: 'allow-once' }
    });
    useChatStore.getState().allowAllPermissions();
    expect(window.fleet.chat.decidePermission).toHaveBeenCalledWith('a', 'allow-once');
    expect(window.fleet.chat.decidePermission).toHaveBeenCalledWith('c', 'allow-once');
    expect(window.fleet.chat.decidePermission).not.toHaveBeenCalledWith('b', 'allow-once');
    expect(useChatStore.getState().decidedRequests).toMatchObject({
      a: 'allow-once',
      b: 'allow-once',
      c: 'allow-once'
    });
  });

  it('a stream-done event clears decidedRequests', async () => {
    await useChatStore.getState().init();
    useChatStore.setState({
      streamId: 's1',
      permissionRequests: [{ requestId: 'a', streamId: 's1', tool: 'WebSearch', command: 'q' }],
      decidedRequests: { a: 'allow-once' }
    });
    listeners.get(IPC_CHANNELS.CHAT_STREAM_DONE)?.({
      streamId: 's1',
      message: { id: 'm', conversationId: 'c1', role: 'assistant', content: 'done', createdAt: 9 }
    });
    expect(useChatStore.getState().permissionRequests).toEqual([]);
    expect(useChatStore.getState().decidedRequests).toEqual({});
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx vitest run src/renderer/src/store/__tests__/chat-store.test.ts`
Expected: new tests FAIL (`decidedRequests` undefined, `allowAllPermissions` not a function).

- [ ] **Step 4: Add `decidedRequests` state + `allowAllPermissions` to the store type**

In `src/renderer/src/store/chat-store.ts`, in `ChatStoreState`, right after `permissionRequests` (line 57) add:

```ts
  permissionRequests: PermissionRequestPayload[];
  /** Request ids already decided this turn, mapped to their outcome. Drives the
   *  pending bar's "first undecided" selection and the Allowed/Denied label. */
  decidedRequests: Record<string, PermissionOutcome>;
```

In the actions section, right after the `decidePermission` signature (line 84) add:

```ts
  decidePermission: (requestId: string, outcome: PermissionOutcome) => Promise<void>;
  /** Batch-approve every still-undecided pending request as allow-once. */
  allowAllPermissions: () => void;
```

- [ ] **Step 5: Add the unsubscribe var + subscription**

Near the other `unsub*` module vars (lines 113-121), add:

```ts
let unsubResolved: (() => void) | null = null;
```

In `subscribeToStreamEvents`, add `unsubResolved?.();` to the teardown block (after `unsubPerm?.();`, line 168-ish), and register the listener right after the `unsubPerm = ...` block (line 283-287):

```ts
    unsubResolved = window.fleet.chat.onPermissionResolved((p: PermissionResolvedPayload) =>
      onStreamEvent(p.streamId, () =>
        set((s) => ({ decidedRequests: { ...s.decidedRequests, [p.requestId]: p.outcome } }))
      )
    );
```

Import `PermissionResolvedPayload`: extend the existing import on line 14:

```ts
import type {
  PermissionOutcome,
  PermissionRequestPayload,
  PermissionResolvedPayload
} from '../../../shared/chat-permissions';
```

- [ ] **Step 6: Initialize + reset `decidedRequests` everywhere `permissionRequests` is touched**

Add `decidedRequests: {}` to the initial state (right after `permissionRequests: []`, line 316):

```ts
    permissionRequests: [],
    decidedRequests: {},
```

Add `decidedRequests: {}` alongside every `permissionRequests: []` reset. There are four such resets:
- stream-done handler `set` (line 193, in the object that ends `permissionRequests: []`)
- stream-error aborted `set` (line 226)
- stream-error failure `set` (line 245)
- `selectConversation` `set` (line 414)

In each, change the `permissionRequests: []` line to two lines:

```ts
          permissionRequests: [],
          decidedRequests: {},
```

- [ ] **Step 7: Mark decided in `decidePermission` and implement `allowAllPermissions`**

Replace `decidePermission` (lines 386-392) with:

```ts
    decidePermission: async (requestId, outcome) => {
      // Mark decided so the pending bar advances to the next request (or empties)
      // and the card shows its Allowed/Denied confirmation; the whole map is
      // cleared with permissionRequests when the turn ends.
      set((s) => ({ decidedRequests: { ...s.decidedRequests, [requestId]: outcome } }));
      await window.fleet.chat.decidePermission(requestId, outcome);
    },

    allowAllPermissions: () => {
      const { permissionRequests, decidedRequests } = get();
      for (const r of permissionRequests) {
        if (!decidedRequests[r.requestId]) void get().decidePermission(r.requestId, 'allow-once');
      }
    },
```

- [ ] **Step 8: Run the store tests to verify they pass**

Run: `npx vitest run src/renderer/src/store/__tests__/chat-store.test.ts`
Expected: PASS (new + existing).

- [ ] **Step 9: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 10: Commit**

```bash
git add src/preload/index.ts src/renderer/src/store/chat-store.ts src/renderer/src/store/__tests__/chat-store.test.ts
git commit -m "feat(chat): store wiring for the pending permission bar"
```

---

## Task 4: ToolCallCard controlled decided prop + height clamp

Let the bar drive the card's decided display (so a lingering card keeps showing "Allowed") and stop a large command/diff/output from eating the pinned bar.

**Files:**
- Modify: `src/renderer/src/components/chat/ToolCallCard.tsx`

**Interfaces:**
- Produces: `ToolCallCard` gains an optional `decided?: PermissionOutcome | null` prop. When provided (not `undefined`) it fully controls the decided display; when omitted it falls back to internal click state (unchanged for any other caller).

- [ ] **Step 1: Add the controlled `decided` prop**

In `src/renderer/src/components/chat/ToolCallCard.tsx`, extend `Props` (lines 8-13):

```ts
type Props = {
  request: PermissionRequestPayload;
  /** Live stdout/stderr once a call is approved and running (Phase 2 feeds this). */
  output?: string;
  /** When set, the parent controls the decided state (used by the pending bar so a
   *  lingering card keeps its Allowed/Denied label). Omit for internal click state. */
  decided?: PermissionOutcome | null;
  onDecide: (outcome: PermissionOutcome) => void;
};
```

Replace the internal state + `decide` (lines 21-28) so a controlled `decided` wins when provided:

```ts
export function ToolCallCard({
  request,
  output,
  decided: decidedProp,
  onDecide
}: Props): React.JSX.Element {
  const [expanded, setExpanded] = useState(true);
  const [internalDecided, setInternalDecided] = useState<PermissionOutcome | null>(null);
  const decided = decidedProp !== undefined ? decidedProp : internalDecided;

  const decide = (outcome: PermissionOutcome): void => {
    setInternalDecided(outcome);
    onDecide(outcome);
  };
```

The rest of the component already reads `decided` (lines 47, 88) and needs no further change.

- [ ] **Step 2: Clamp the command block height**

The expanded body's command `<pre>` (lines 58-60) can be arbitrarily tall. Add a max height + scroll so the pinned bar stays bounded. Change:

```tsx
          <pre className="overflow-x-auto whitespace-pre-wrap break-words font-mono text-xs text-fleet-text">
            {request.command}
          </pre>
```

to:

```tsx
          <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-words font-mono text-xs text-fleet-text">
            {request.command}
          </pre>
```

(The `diff` and `output` blocks already have `max-h-64` / `max-h-48`.)

- [ ] **Step 3: Typecheck + lint**

Run: `npm run typecheck && npm run lint`
Expected: no new errors. (There is no jsdom test harness for `.tsx`; this prop + class change is verified by typecheck/lint here and by the E2E in Task 5.)

- [ ] **Step 4: Commit**

```bash
git add src/renderer/src/components/chat/ToolCallCard.tsx
git commit -m "feat(chat): let ToolCallCard's decided state be controlled + clamp height"
```

---

## Task 5: PermissionBar overlay + mount + remove inline cards

Build the overlay, mount it above the composer, and delete the inline permission block from the stream. This is the visible deliverable and is verified end-to-end with fleet-drive.

**Files:**
- Create: `src/renderer/src/components/chat/PermissionBar.tsx`
- Modify: `src/renderer/src/components/chat/ChatView.tsx:53-61`
- Modify: `src/renderer/src/components/chat/MessageList.tsx:565-566, 581-587`

**Interfaces:**
- Consumes: `permissionView` (Task 2); store `permissionRequests`, `decidedRequests`, `decidePermission`, `allowAllPermissions` (Task 3); `ToolCallCard` controlled `decided` (Task 4); `usePresence` (`src/renderer/src/hooks/use-presence.ts`).

- [ ] **Step 1: Create the PermissionBar component**

Create `src/renderer/src/components/chat/PermissionBar.tsx`:

```tsx
import { useEffect, useState } from 'react';
import { useChatStore } from '../../store/chat-store';
import { usePresence } from '../../hooks/use-presence';
import { useReducedMotion } from '../../hooks/use-reduced-motion';
import { permissionView } from './permission-queue';
import { ToolCallCard } from './ToolCallCard';
import type { PermissionOutcome } from '../../../../shared/chat-permissions';

const LINGER_MS = 700;

/**
 * Pending tool-call approvals, pinned as an overlay just above the composer
 * instead of inline in the scroll stream. Shows one request at a time with a
 * "+N more" peek and an "Allow all" batch action; a decided last card lingers
 * briefly (showing Allowed/Denied) then the bar fades out. All timing is local
 * so it can't race the turn-end store reset.
 */
export function PermissionBar(): React.JSX.Element | null {
  const permissionRequests = useChatStore((s) => s.permissionRequests);
  const decidedRequests = useChatStore((s) => s.decidedRequests);
  const decidePermission = useChatStore((s) => s.decidePermission);
  const allowAllPermissions = useChatStore((s) => s.allowAllPermissions);
  const reduced = useReducedMotion();

  const view = permissionView(permissionRequests, decidedRequests);
  const targetId = view.active?.requestId ?? null;

  // The request currently on screen. Advances to the next pending request
  // immediately; when nothing is pending it lingers on the last decided card
  // for LINGER_MS so its confirmation is visible before the bar fades out.
  const [renderId, setRenderId] = useState<string | null>(targetId);
  useEffect(() => {
    if (targetId) {
      setRenderId(targetId);
      return;
    }
    if (renderId === null) return;
    const t = setTimeout(() => setRenderId(null), reduced ? 0 : LINGER_MS);
    return () => clearTimeout(t);
  }, [targetId, renderId, reduced]);

  const shown = renderId ? permissionRequests.find((r) => r.requestId === renderId) ?? null : null;
  const { mounted, state } = usePresence(shown !== null, reduced ? 0 : 150);

  const [peekOpen, setPeekOpen] = useState(false);

  // Keyboard: Alt+Enter allows, Alt+Backspace denies the active card, regardless
  // of composer focus. Modifier-based so plain typing is never intercepted.
  useEffect(() => {
    const active = view.active;
    if (!active) return;
    const onKey = (e: KeyboardEvent): void => {
      if (!e.altKey) return;
      if (e.key === 'Enter') {
        e.preventDefault();
        void decidePermission(active.requestId, 'allow-once');
      } else if (e.key === 'Backspace' || e.key === 'Delete') {
        e.preventDefault();
        void decidePermission(active.requestId, 'deny');
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [view.active, decidePermission]);

  if (!mounted || !shown) return null;

  const decided: PermissionOutcome | null = decidedRequests[shown.requestId] ?? null;

  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-0 z-10 px-4 pb-2">
      <div
        role="region"
        aria-label="Pending tool approval"
        aria-live="polite"
        className={`pointer-events-auto mx-auto w-full max-w-3xl rounded-lg border border-fleet-border bg-fleet-surface-1 shadow-lg transition-all duration-150 ${
          state === 'open' ? 'translate-y-0 opacity-100' : 'translate-y-1 opacity-0'
        }`}
      >
        {view.more > 0 && (
          <div className="flex items-center justify-between gap-2 border-b border-fleet-border px-3 py-1.5 text-xs text-fleet-text-muted">
            <button
              type="button"
              onClick={() => setPeekOpen((v) => !v)}
              aria-expanded={peekOpen}
              className="focus-ring rounded hover:text-fleet-text"
            >
              +{view.more} more pending
            </button>
            <button
              type="button"
              onClick={() => allowAllPermissions()}
              className="rounded bg-fleet-surface-3 px-2 py-0.5 text-fleet-text hover:bg-fleet-surface-2"
            >
              Allow all {view.undecidedCount}
            </button>
          </div>
        )}
        {peekOpen && view.more > 0 && (
          <ul className="max-h-32 space-y-1 overflow-auto border-b border-fleet-border px-3 py-2 text-xs">
            {view.queued.map((r) => (
              <li key={r.requestId} className="flex gap-2 text-fleet-text-secondary">
                <span className="shrink-0 font-medium text-fleet-text">{r.tool}</span>
                <code className="min-w-0 flex-1 truncate font-mono text-fleet-text-muted">
                  {r.command}
                </code>
              </li>
            ))}
          </ul>
        )}
        <ToolCallCard
          key={shown.requestId}
          request={shown}
          decided={decided}
          onDecide={(outcome) => void decidePermission(shown.requestId, outcome)}
        />
      </div>
    </div>
  );
}
```

Note: `ToolCallCard`'s root has `mx-4 my-2`; inside the bar that inset is harmless (keeps it off the border). Leave it - do not edit ToolCallCard's root just for this.

- [ ] **Step 2: Mount PermissionBar as an overlay in ChatView**

In `src/renderer/src/components/chat/ChatView.tsx`, import it (after the `Composer` import, line 6):

```ts
import { Composer } from './Composer';
import { PermissionBar } from './PermissionBar';
```

Wrap `MessageList` in a `relative` flex container and drop the bar inside it so it overlays the bottom of the stream (above the meter/composer), without taking flex space. Replace lines 54-60:

```tsx
          <>
            <div className="relative flex min-h-0 flex-1 flex-col">
              <MessageList defaultModel={defaultModel} showUsage={usage.showMeter} />
              <PermissionBar />
            </div>
            {usage.showMeter && <UsageMeter budgetWarnUsd={usage.budgetWarnUsd} />}
            {/* Key on activeId so the composer remounts on conversation switch —
                its draft/attachments/mentions are local state and must not bleed
                across conversations (a draft for A could otherwise send to B). */}
            <Composer key={activeId} defaultModel={defaultModel} />
          </>
```

- [ ] **Step 3: Remove the inline permission cards from MessageList**

In `src/renderer/src/components/chat/MessageList.tsx`, delete the two now-unused store selectors (lines 565-566):

```ts
  const permissionRequests = useChatStore((s) => s.permissionRequests);
  const decidePermission = useChatStore((s) => s.decidePermission);
```

and delete the inline block (lines 581-587):

```tsx
          {permissionRequests.map((req) => (
            <ToolCallCard
              key={req.requestId}
              request={req}
              onDecide={(outcome) => void decidePermission(req.requestId, outcome)}
            />
          ))}
```

Then remove the now-unused `ToolCallCard` import at the top of `MessageList.tsx` (search for `import { ToolCallCard }` and delete that line - the bar owns it now).

- [ ] **Step 4: Typecheck + lint**

Run: `npm run typecheck && npm run lint`
Expected: no errors, and no "unused import/variable" warnings for `ToolCallCard` / `permissionRequests` / `decidePermission` in `MessageList.tsx`.

- [ ] **Step 5: Run the full unit test suite**

Run: `npx vitest run`
Expected: all tests PASS.

- [ ] **Step 6: E2E verify with fleet-drive**

Start the app (`npm run dev` in one shell). Then from the repo root drive it (see `scripts/drive/README.md`):

1. Open the Chat tool, start a conversation with a tools-capable model, and prompt something that fans out multiple gated tool calls (e.g. a few web searches).
2. `npm run drive -- screenshot` and read the PNG. Verify:
   - The approval card sits in a **pinned bar just above the composer**, NOT inline in the scroll stream, and the stream shows only transcript.
   - Only one card shows, with a **"+N more pending"** control and an **"Allow all N"** button when several are queued.
   - Clicking the peek lists the queued tool + command lines.
   - Scrolling the transcript does **not** move the bar.
3. Approve the active card; verify it flips to "Allowed" and the next queued request slides in (or, if it was the last, the bar lingers ~700ms then fades out) - and the composer does **not** jump as the bar appears/dismisses.
4. Trigger repeated same-prefix commands (e.g. `npm run build` then `npm run test`), click **Allow & remember** on the first, and verify the queued matching one clears without a second prompt.
5. Trigger a mixed queue and click **Allow all**; verify the whole queue clears.
6. With a card showing, press **Alt+Enter** (allows) and, on a fresh one, **Alt+Backspace** (denies); verify both work without the composer stealing the keystroke.
7. Confirm the decided tool calls still appear in the transcript after the turn finalizes.

Fix any visual/behavioral issue found (pixel alignment of the bar to the reading column, fade smoothness, overlap with the composer) before committing.

- [ ] **Step 7: Commit**

```bash
git add src/renderer/src/components/chat/PermissionBar.tsx src/renderer/src/components/chat/ChatView.tsx src/renderer/src/components/chat/MessageList.tsx
git commit -m "feat(chat): pinned overlay permission bar above the composer"
```

---

## Verification checklist (whole feature)

- [ ] `npm run typecheck` - clean.
- [ ] `npm run lint` - clean.
- [ ] `npx vitest run` - all green (retro-apply, permission-queue, store wiring).
- [ ] fleet-drive E2E (Task 5 Step 6) - all points confirmed by screenshot/observation.
- [ ] Add a `docs/learnings/` note if any non-obvious bug surfaced during E2E (per repo CLAUDE.md).
