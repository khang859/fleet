# A settings array mutated from a click loses writes

Date: 2026-08-12
Found while: adding "Set as background" and "Add to slideshow" to images in the Agent pane.

## What happened

`addToSlideshow` appends one path to `terminalBackground.slideshow.filePaths`.
The only way to do that is read-modify-write: read the list out of the renderer's settings store, push onto a copy, send the copy back.

Two clicks a second apart are fine, because the first write has landed by the time the second reads.
Two clicks in the same second are not.
Both read the list as it was before either wrote, and the second write - a whole array, not a merge - replaces the first one's addition.
The picture the user added simply is not there, with no error and nothing in the log.

## Why it is easy to miss

`SettingsStore.set()` deep-merges *objects* key by key, so it is natural to assume it merges everything.
It does not merge arrays.
`DeepPartial<T>` maps `T[K] extends Array<infer U>` to `U[]`, and `set()` spreads the patch over the current value, so an array in a patch replaces the stored array wholesale.
That is the right semantics - a saved list is authoritative, and merging element-wise would make removal impossible - but it means every array in settings is a lost-update hazard.

The pre-existing writers never hit it because every one of them is behind a native file dialog.
`addSlideshowFiles`, `removeSlideshowFile`, `reorderSlideshowFile` are all in the Settings pane, and a modal picker serialises the user for you.
Putting the same mutation behind a plain button in a transcript removes that accidental lock, and the race becomes the ordinary case rather than an exotic one: adding two images from one conversation is the whole point of the feature.

## Fix

Serialise the mutation on a module-level promise chain, in `src/renderer/src/lib/background-actions.ts`:

```ts
let slideshowQueue: Promise<void> = Promise.resolve();

export async function addToSlideshow(path: string): Promise<void> {
  const task = slideshowQueue.then(async () => addToSlideshowNow(path));
  slideshowQueue = task.catch(() => undefined);
  return task;
}
```

Two details matter.
Both statements run before the function first suspends, so clicks queue in the order they arrived.
The queue tracks `task.catch(...)` rather than `task`, so one failed add cannot wedge every add behind it, while the caller still sees the rejection through the returned promise.

This works because `updateSettings` awaits the IPC round trip *and* the refetch that writes the result back into the store, so the next queued call reads a list that already contains the previous one's addition.

## What to watch for

Any array in `FleetSettings` mutated by read-modify-write from something a user can click twice.
Ask what is serialising the caller.
If the answer is "a file dialog", the safety is accidental, and it disappears the moment the same mutation is offered from anywhere else.

`eslint`'s `promise-function-async` will fight the queue helper if it returns a promise without `async`.
Annotating the return type and marking it `async` satisfies it without changing the ordering, since the synchronous prefix of an async function still runs on call - see [eslint-async-rule-triangle](eslint-async-rule-triangle.md).
