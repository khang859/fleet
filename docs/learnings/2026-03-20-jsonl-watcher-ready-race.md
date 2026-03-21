# JSONL watcher `ready` race skipped new transcript files

## What happened

While de-blocking the main thread, the JSONL watcher was changed from synchronous reads to queued async reads. The original watcher logic treated any file seen before chokidar emitted `ready` as "preexisting" and skipped reading it by setting the read offset to the end of the file.

That assumption broke in tests and was fragile in real startup timing too:

- a brand-new `.jsonl` file could be created before chokidar emitted `ready`
- the watcher would classify it as preexisting
- its initial records would be skipped permanently

In Vitest on macOS, chokidar also hit `EMFILE` enough times that relying on watcher timing became even less trustworthy.

## Fix

The fix was to stop inferring file age from chokidar readiness:

- do an explicit initial scan of existing `.jsonl` files and seed them at their current size
- treat later discoveries as new files and read them from offset `0`
- keep async queued file reads
- add a lightweight periodic scan fallback so transcript discovery still works if file-system watch delivery is delayed or unreliable

## Takeaway

Do not use a watcher's `ready` event as a semantic boundary for "old vs new" data. If that distinction matters, compute it explicitly with an initial snapshot and then compare future state against that snapshot.
