# A transform turned an optional field required, and old sessions lost their tool calls

Date: 2026-08-08
Found while: adding the subagents card to the Agent pane, on three test failures that were already red on main

## What happened

Three `replaySession` tests had been failing on `main`, all of them about files
written by older versions of Fleet:

```
× replays one written before messages had parts, text first
× leaves out the empty text of a turn that only used tools
× replays a call from before a tool could come back with a picture
```

Each one hands `replaySession` a version-4 line - a tool call as Fleet wrote it
before the task list existed - and each one came back with `skipped: 1` and no
tool call in the message.

The field they all trip over is `todos` on `ToolCallSchema`, which is deliberately
never written to disk and always read back as `null`:

```ts
todos: z.unknown().transform((): AgentTodoItem[] | null => null)
```

`z.unknown()` on its own accepts a missing key. Putting a `.transform()` on top of
it does not: in zod 4 the transform wraps the schema in a way that makes the key
itself required, so an object with no `todos` property fails with

```
Invalid input: expected nonoptional, received undefined
```

A tool call that fails to parse is a line `replaySession` skips, so every tool
call in a session written before the task list shipped was dropped on reopen.
The messages came back; what the agent had actually done in them did not.

It hid for so long because nothing in normal use produces a line without the key.
The in-memory call object carries `todos: null`, `JSON.stringify` writes
`"todos":null`, and `null` parses fine - so every session written by a current
build round-trips, and only genuinely old files on a user's disk hit it. The
fixtures in the test file were the only place the absent-key case existed.

## The fix

Say optional where optional is meant, rather than relying on `z.unknown()`'s own
tolerance:

```ts
todos: z
  .unknown()
  .optional()
  .transform((): AgentTodoItem[] | null => null)
```

The two fields beside it were already right - `image` and `task` both use
`.nullish()` for exactly this reason, with comments explaining which version
started writing them. `todos` was the one that leaned on an implicit behaviour
instead.

## What to take from it

- `z.unknown()` and `z.unknown().transform(...)` do not accept the same inputs.
  If a key may be absent, write `.optional()` or `.nullish()` and let the schema
  say so, whatever the base type appears to tolerate.
- A schema that parses everything the writer produces is not the same as a schema
  that parses everything on disk. Backward compatibility is only ever exercised by
  fixtures written by hand, which makes those tests the load-bearing ones - a red
  one is a claim about users' files, not about the test.
