# The three async ESLint rules that can trap a handler in a loop

Date: 2026-08-07
Found while: adding the skills IPC handlers (`src/main/agent/skills/skills-ipc.ts`)

## What happened

A one-line `ipcMain.handle` that just forwards to an async function could not be
made to satisfy ESLint. Each fix produced the next error, in a cycle:

```ts
ipcMain.handle(CHANNEL, async () => listInstalled());
// @typescript-eslint/require-await: Async arrow function has no 'await' expression.

ipcMain.handle(CHANNEL, () => listInstalled());
// @typescript-eslint/promise-function-async: Functions that return promises must be async.

ipcMain.handle(CHANNEL, async () => await listInstalled());
// @typescript-eslint/return-await: Returning an awaited promise is not allowed in this context.
```

Three rules, each correct on its own, with no arrangement of `async`/`await`
that satisfies all three - as long as the function has no return type annotation.

## Why

`require-await` exempts an async function whose body is a returned promise, but
only when it can see the return type is a promise. Without an annotation on an
arrow function whose body is a bare expression, it does not, and the exemption
does not fire.

## The fix

Annotate the return type. The `async` form then passes all three:

```ts
ipcMain.handle(CHANNEL, async (): Promise<InstalledSkill[]> => listInstalled());
```

Note the neighbouring handler that already had an annotation
(`async (_e, cwd: unknown): Promise<FoundSkill[]> => detectSkills(...)`) never
errored - which is the tell. If one handler in a file is flagged and its
identical neighbour is not, compare the annotations before touching the
`async`.

## Related

A handler that is genuinely synchronous should just be synchronous.
`shell.showItemInFolder` returns `void`, so its handler drops `async`
altogether rather than being wrapped to satisfy a rule. `ipcMain.handle`
accepts a sync return.
