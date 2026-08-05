# A shared "empty" constant that callers mutate

## What happened

`replaySession` in `src/shared/agent-session.ts` built its result by spreading a
module-level constant:

```ts
export const EMPTY_REPLAY: AgentSessionReplay = { messages: [], /* ... */ };

export function replaySession(contents: string): AgentSessionReplay {
  const replay: AgentSessionReplay = { ...EMPTY_REPLAY };
  // ...
  replay.messages.push(event.message); // <- mutates EMPTY_REPLAY.messages
}
```

The spread is shallow, so every replay in the process shared one `messages`
array - the one hanging off the constant. Each `push` appended to it, and the
next session read back its own turns plus every turn read before it.

The symptom was four failing store tests with a distinctive shape:

```
expected [ 'a', 'a', 'a', 'b' ] to deeply equal [ 'a', 'b' ]
```

Repeated elements in a test that only wrote one, growing with the number of
tests that had run before it. That looks exactly like leaked state between
tests, so the first instinct was to hunt for a missing `beforeEach` reset -
which is the wrong place entirely, since the leak was inside the production
function under test.

## The fix

Make it a factory, so each caller gets its own arrays:

```ts
export function emptyReplay(): AgentSessionReplay {
  return { messages: [], /* ... */ };
}
```

## The rule

A constant is only safe to share if nothing ever writes to it. The moment a
shape holds an array or object *and* a caller mutates it in place, spreading a
constant is a shared reference, not a fresh value. Either return it from a
function, or freeze it and never mutate.

Watch for the tell: cross-test contamination that survives a fresh fixture
directory and a fresh store instance is usually not the test harness. It is a
value the module itself is holding onto.
