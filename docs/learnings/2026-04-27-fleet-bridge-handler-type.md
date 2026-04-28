# Fleet bridge handler return type and lint

## Symptom

While adding the Pi plan-open bridge command, changing `FleetBridgeServer`'s `RequestHandler` from `Promise<unknown>` to `unknown | Promise<unknown>` made lint report:

- `@typescript-eslint/no-redundant-type-constituents` because `unknown` absorbs the union
- `@typescript-eslint/await-thenable` at the call site that awaited the handler result

## Fix

Keep `RequestHandler` as `Promise<unknown>` and keep bridge request handlers `async`. If a handler is currently synchronous, use a real async boundary rather than changing the framework type.

## Lesson

Do not use `unknown | Promise<unknown>` for async callback return types in this codebase. It looks flexible, but lint treats `unknown` as overriding the promise branch and then flags awaited values as non-thenable.
