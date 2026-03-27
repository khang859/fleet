# Socket Server Missing `await` on Proxy Service Calls

**Date:** 2026-03-21
**Issue:** [#114](https://github.com/khang859/fleet/issues/114) — `fleet crew deploy` returns `BAD_REQUEST: empty prompt` even though `fleet missions show` correctly displays the prompt.

## What Happened

The `SocketServer.dispatch()` method calls service methods (e.g., `missionService.getMission()`) without `await`. The services provided to the socket server are **proxies** from `createSocketRuntimeServices()` that return Promises via `runtime.invoke()`, but they're typed as the original synchronous services using `as unknown as ServiceRegistry['missionService']` casts.

This caused:

- `missionService.getMission(id)` to return a `Promise` object (truthy), not the actual `MissionRow`
- `mission.prompt` to be `undefined` (Promises don't have a `.prompt` property)
- The empty-prompt guard to fire every time

## Why `missions show` Worked

The `mission.status` handler returns the Promise directly:

```ts
const mission = missionService.getMission(Number(rawId));
return mission; // Returns the Promise itself
```

The outer `await this.dispatch()` in `handleLine()` resolves the Promise, so the caller gets the actual data. The null check (`if (!mission)`) silently passes because a Promise is truthy, but this is harmless since the return value is resolved later.

## Why `crew deploy` Broke

The `crew.deploy` handler uses the result inline:

```ts
const mission = missionService.getMission(missionId); // Promise, not awaited
const prompt = mission.prompt; // undefined — Promises don't have .prompt
```

## Root Cause

`createSocketRuntimeServices()` uses `as unknown as ServiceRegistry['missionService']` to cast Promise-returning proxy methods as synchronous methods. TypeScript can't catch the missing `await` because the types are forced to match.

## Fix

Added `await` to all service proxy calls in `dispatch()` where results are used inline (not just returned). This is safe because `await` on a synchronous value is a no-op — it wraps the value in a resolved Promise and returns it immediately.

## Lesson

When services are replaced with async proxies (IPC, RPC, etc.) but typed as synchronous via `as unknown as`, TypeScript won't catch missing `await`s. Either:

1. Make the `ServiceRegistry` interface use `Promise` return types, or
2. Always `await` service calls even if the type says synchronous
