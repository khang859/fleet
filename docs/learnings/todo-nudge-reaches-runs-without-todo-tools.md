# The task-list nudge reached runs that had no task-list tools

## What happened

Writing the Admiral turn, the last round note on the wire was not the Admiral's snapshot but "You have no task list for this conversation ... start one with `todo_add`".
The Admiral is never offered `todo_add`, so the note told it to call a tool it did not have.

`runRounds` always splices `withTodoReminder(messages, todos.items, todos.streak)`.
`renderTodoBlock` answers an empty list with `NO_LIST_NUDGE` rather than `null`, so every run starting from `todos: []` got the nudge.
That included subagents whose definition leaves the task list out, which is both bundled ones.

## The fix

`withTodoReminder` takes a fourth argument, `offered`, and `runRounds` passes whether the run's tool list holds `todo_add`.
A run without the tools gets no task-list note at all.

## The lesson

A round note is an instruction, so it has to follow the tool list the same way the system prompt's blocks do.
When a new run shape gets a narrower tool list, check every `with*` splice in `runRounds`, not just the prompt.
