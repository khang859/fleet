# State that tests share must not live in a module tests mock

Date: 2026-10-18
Found while: Phase 5 of `add-admiral-agency` (env value redaction)

## What happened

`maskInLogs` and the set of env values the logger masks first lived in `src/main/logger.ts`.
Many test files replace that module with `vi.mock('../logger', () => ({ createLogger: ... }))`.
In those files the mock has no `maskInLogs`, so agency code that called it failed with `maskInLogs is not a function`.
Adding `maskInLogs` to every logger mock would have hidden the bug, not fixed it.

## Fix

The log secrets and `maskInLogs` moved to `src/main/redactor.ts`, which no test mocks.
`logger.ts` only reads them through `logRedactor()` in its winston format, once per log line.
Code that adds secrets imports from `redactor.ts`, so it works the same with a real or a mocked logger.

## Rule

Keep module-level state that other modules write in a small module of its own.
A module that tests often mock, such as the logger, should only read that state.
