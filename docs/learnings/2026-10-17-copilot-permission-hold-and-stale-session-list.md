# Copilot: answers sent to a dead hook, and a session list that never updated

Two copilot bugs found while polishing the copilot panel.

## 1. Fleet held a permission longer than the Go hook waited for it

### Problem

An Allow or Deny clicked late in the copilot panel was reported as delivered, but Claude Code still showed its own prompt and ignored the answer.

### Root Cause

`PermissionBroker` held the hook socket for 310 s.
The Go hook (`hooks/fleet-copilot-go/main.go`, `timeoutSeconds`) gives up after 300 s and falls back to Claude Code's own prompt.
Its exit is not always seen on the Fleet side, so for 10 s Fleet wrote answers to a socket nobody read and called them delivered.

### Fix

`PERMISSION_HOLD_MS` in `src/main/claude-sessions/hook-server.ts` is now 295 s, shorter than the Go wait.
Fleet lets go first, clears the request, and the terminal prompt takes over.
A test in `src/main/claude-sessions/__tests__/hook-server.test.ts` reads `timeoutSeconds` from the Go source and fails if the hold is not shorter.
The panel also shows a "Fleet can no longer answer this one" row with a go-to-terminal button when an answer is not delivered.

### Lesson

When two processes each have a timeout for the same request, the side that answers must give up first.
Tie the two numbers together with a test, not a comment.

## 2. A zustand selector that returned a stable function

### Problem

The copilot session list did not change when sessions changed, until something else made it render.

### Root Cause

`SessionList` used `useCopilotStore((s) => s.filteredSessions)` and then called it.
The selector returned the action itself, which is the same function on every store change, so zustand never re-rendered the list.

### Fix

Select the result, not the function: `useCopilotStore(useShallow((s) => s.filteredSessions()))`.
`useShallow` is needed because `filteredSessions()` builds a new array each call.

### Lesson

A derived-value getter in a zustand store must be called inside the selector.
Selecting the getter itself subscribes to nothing.
