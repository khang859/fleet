# Pi `fleet_open` opened images as plain text

## What happened

The Pi extension `resources/pi-extensions/fleet-files.ts` sends a bridge request with only `{ path }`.

On the Fleet side, `src/main/index.ts` handled that `file.open` bridge request by hard-coding:

```ts
paneType: 'file'
```

So every file opened through the Pi bridge was treated as a text file, even when the path was an image or markdown file. That is why images could show up as plain text instead of opening in the image viewer.

## Why it was easy to miss

The normal `fleet open` CLI path already had extension-based classification for images and markdown. The Pi bridge path was a separate implementation and had drifted from the CLI behavior.

## Fix

- Added shared file-opening helpers in `src/shared/file-open.ts`
- Updated `src/main/index.ts` bridge handling to:
  - resolve the path
  - reject directories
  - reject blocked binary formats
  - classify the pane type from the file extension
- Updated `src/main/fleet-cli.ts` to use the same shared helper so CLI and Pi bridge stay consistent
- Added `src/shared/__tests__/file-open.test.ts` for the shared classification logic

## Takeaway

When the same behavior exists in both CLI and bridge code paths, keep the file-type classification in one shared helper instead of duplicating extension lists in multiple places.
