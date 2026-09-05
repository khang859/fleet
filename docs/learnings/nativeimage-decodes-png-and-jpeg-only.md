# `nativeImage` decodes PNG and JPEG only

## What happened

The Agent pane generates WebP images.
Two separate features tried to hand one of those files to Electron's `nativeImage` and both failed silently.

The first was "Copy image", implemented in the main process as `nativeImage.createFromPath(path)` followed by `clipboard.writeImage`.
It put nothing on the clipboard, with no error anywhere.

The second was the drag-out-to-Finder gesture, which needs an icon to drag with.
`event.sender.startDrag` throws on an empty icon rather than dragging without one, so the handler guarded with `isEmpty()` and returned early.
The guard fired on every generated image, so the drag never started and the gesture looked like nothing had been wired up at all.

## Why

`nativeImage` is Chromium's image *resource* loader, not its content decoder.
It reads PNG and JPEG, and returns an empty image for everything else rather than throwing.
A probe against the installed Electron confirms it, by path and by buffer alike:

```
webpViaPath_empty:   true      pngViaPath_empty:   false
webpViaBuffer_empty: true      pngViaBuffer_empty: false
```

`isEmpty()` returning true is the only symptom.
There is no exception, no log line, and no way to tell "wrong format" from "file missing" at the call site.

## The fix

Let the renderer decode.
Chromium in the renderer has already decoded the file in order to display it, and `createImageBitmap` plus `OffscreenCanvas.convertToBlob({ type: 'image/png' })` re-encodes it as something `nativeImage` will accept.

For copy, the whole action moved to the renderer: it needs a decoder and a clipboard, both of which the renderer has, and no file access at all.
For drag, the file handle has to come from main, so the renderer sends PNG bytes of the thumbnail alongside the path and main prefers those, falling back to `createFromPath` for the formats that do decode.

## The rule

Before passing a path to `nativeImage`, ask what format it is.
If the answer is anything other than PNG or JPEG, decode in the renderer and send bytes.
And when writing a probe for this, remember that Electron's own argv entries shift the indices: filter `process.argv` rather than indexing into it, or the probe reports every input empty and sends you chasing the wrong bug.
