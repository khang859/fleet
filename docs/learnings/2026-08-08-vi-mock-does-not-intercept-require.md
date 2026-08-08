# `vi.mock` does not intercept `require`, so the test suite wrote to the real log

## What happened

Running `npm test` appended about 42 KB per run to the live app's daily log, `~/.fleet/logs/fleet-<date>.log`.
The fixtures landed among real entries and read exactly like real events:

```
warn agent-mcp        MCP server failed to connect {"error":"the database is on fire","server":"broken"}
warn agent:classifier classifier failed {"error":"Error: 502 Bad Gateway","model":"anthropic/claude-haiku-4.5"}
```

None of it happened.
While diagnosing an unrelated auto-mode problem, those `502 Bad Gateway` lines looked like a live classifier failure and sent the investigation down a dead end before they were traced back to `classifier.test.ts`.
A log the app shares with its own test fixtures cannot be read back as evidence of what the app did, and the diagnostics feature reads it back.

## Why the existing mocks did not stop it

`src/test-setup.ts` already mocked both of the things involved, and had done for months:

```ts
vi.mock('electron', () => ({ app: { getPath: (name) => (name === 'home' ? '/tmp/fleet-test' : '/tmp') } }));
vi.mock('winston-daily-rotate-file', () => { /* ... */ });   // "avoid real file I/O in tests"
```

Neither reaches `src/main/logger.ts`, because that module deliberately reads both through `require` rather than `import`:

```ts
const electron: unknown = require('electron');
const DailyRotateFile = require('winston-daily-rotate-file');
```

**`vi.mock` only intercepts ESM `import`. A `require` call goes straight to the real module.**

The `require` is not a mistake - the comment above it explains that the logger is bundled into `starbase-runtime-process`, a plain Node child where a static `import { app } from 'electron'` would fail.
So the module was correct and the mocks were correct, and they simply never met.

The failure was silent in both directions:

- `require('electron')` returns the real package, which outside Electron is not an object with an `app`, so the type guard rejected it and `resolveElectronApp()` returned `null` - falling back to the real `homedir()`.
- `require('winston-daily-rotate-file')` returned the real transport, so the file writing the mock was meant to prevent happened anyway.

A mock that is bypassed does not warn. It just quietly stops being true, and the comment beside it keeps claiming otherwise.

## The fix

`FLEET_LOG_DIR` now takes precedence in `logger.ts`, and `vitest.config.ts` sets it via `test.env`:

```ts
const logDir =
  process.env.FLEET_LOG_DIR ?? join(electronApp ? electronApp.home : homedir(), '.fleet', 'logs');
```

Set in `test.env` rather than in `src/test-setup.ts` because `logDir` is computed at module load, and the env has to be in place before any module reads it.
This also keeps the test runner out of `src/`: the source honours a documented env var and knows nothing about vitest.

Verified by measurement, not by inspection - a full suite run moved the real log by 0 bytes, against 42 KB before.

## What to take from this

- **Reach for `require` and you have opted out of `vi.mock`.** If a module uses `require` for good reason, it cannot be mocked from the setup file; it needs a seam of its own, such as an env var or an injected dependency.
- **A comment claiming a mock prevents something is not evidence that it does.** Two mocks named exactly for this problem sat above it while it happened.
- **Test an escape like this by measuring the artefact**, not by reading the code. `stat -f%z` on the log before and after a run answers the question in a way that reasoning about module resolution does not.
- Anything falling back to `homedir()` is worth a second look. Under test, CLI tools, and child processes, that fallback points at the user's live data.
