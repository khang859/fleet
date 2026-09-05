# Reading `window.fleet` at module scope breaks the test suite

## What happened

Adding the Scratch chat needed the renderer to know one fixed path, `~/.fleet/scratch`.
It was written as a module-level constant:

```ts
export const SCRATCH_DIR = join(ctx, window.fleet.homeDir, '.fleet', 'scratch');
```

111 tests across 9 files started failing with `TypeError: Cannot read properties of undefined (reading 'length')` from inside `join`.

The cause is that `src/test-setup.ts` polyfills `window.fleet` as an empty object.
That is enough for every test that never touches the bridge, but a module-level read happens on *import*, so merely importing anything that transitively reached this file - the workspace store, and so most of the renderer - evaluated `window.fleet.homeDir` as `undefined` and threw before a single test ran.

## Fix

Make it a lazy, memoized function, and tolerate a bridge that is not up:

```ts
let cached: string | null = null;
export function scratchDir(): string {
  if (cached !== null) return cached;
  const bridge = ...; // see below
  cached = join(ctx, bridge?.homeDir ?? '', '.fleet', 'scratch');
  return cached;
}
```

The home directory does not change while the app runs, so this is still a constant in every way that matters - it is just computed on first use rather than on import.

A second wrinkle: `window.fleet` is *typed* as always present with every field on it, so `window.fleet?.homeDir` trips `@typescript-eslint/no-unnecessary-condition`, and a type assertion trips `no-unsafe-type-assertion`.
The codebase already had the answer, in `src/test-setup.ts`'s `existingLocalStorage`: read it through a function with a declared return type, which survives where a `const` annotation is narrowed back by its initializer.

```ts
function bridge(): Partial<typeof window.fleet> | undefined {
  return window.fleet;
}
```

## Prevention

In renderer code, treat the preload bridge as something that exists at *call* time, not at *import* time.
Anything derived from `window.fleet` belongs inside a function, a hook, or a store action - never at module scope.
Patching the nine test mocks instead would have been the wrong fix: a module that explodes when the bridge is absent is fragile in the app too, not only under test.
