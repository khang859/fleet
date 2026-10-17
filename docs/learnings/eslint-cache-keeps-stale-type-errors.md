# ESLint's cache keeps type-aware errors a fix already removed

Building the Admiral pane, `npm run lint` reported dozens of `no-unsafe-*` errors on every file that used `useAgencyStore`.
The store's type had collapsed to `any`.

## The real cause

`agency-store.ts` called `useAgencyStore.getState()` inside its own `create()` initializer.
That makes the store's type depend on itself, so TypeScript gives up and infers `any`, which every caller then inherits.
Using the `get` argument zustand passes to the initializer breaks the cycle:

```ts
export const useAgencyStore = create<AgencyStore>((set, get) => ({
  answer: async (req) => {
    /* get().refresh(...) - not useAgencyStore.getState() */
  }
}));
```

## Why the fix looked like it did nothing

`npm run lint` runs `eslint --cache`.
The cache is keyed on each file's own contents, but the type-aware rules depend on the types of the files it imports.
A file that did not change kept its cached result, errors and all, after the store it imports was fixed.

`npx eslint --no-cache .` gives the true result.
Use it to confirm any fix to a type that other files lint against.

## Two more from the same pane

- **An autosize textarea measured at mount stays that size.**
  The composer set its height from `scrollHeight` only when its text changed.
  When a pane mounts while its split is still being laid out, the box is briefly a sliver wide, the placeholder wraps one word per line, and the box stays hundreds of pixels tall with nothing in it.
  It now measures again whenever its width changes (`useElementWidth`).
- **A tab's status was the newest activity of any of its panes.**
  An idle shell split beside an agent that was asking hid the question from the sidebar.
  `getTabActivity` now puts a `needs_me` pane first.
