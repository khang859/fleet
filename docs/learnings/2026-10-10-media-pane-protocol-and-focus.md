# Media pane: standard scheme, byte ranges, and a focused `<video>`

Three things went wrong while building the media viewer pane, which plays video and audio files.

## 1. A `<video>` will not load from a non-standard custom scheme

**What happened:** The first `fleet-media` scheme copied `fleet-image` (`supportFetchAPI` + `stream`, not `standard`).
`fetch()` against it returned a correct `206` with `Content-Range`, but the `<video>` element failed with `MEDIA_ELEMENT_ERROR: Format error` and `readyState` 0.

**Why:** Chromium's media loader validates the origin of every follow-up range request.
A non-standard scheme has an opaque origin, so the check fails even though the bytes are fine.
See electron/electron#38749.

**Fix:** Register the scheme with `standard: true, secure: true` as well.
A standard URL needs a host, so the URL is `fleet-media://local/<encoded path>` (`FLEET_MEDIA_ORIGIN` in `src/shared/path-platform.ts`), and the handler strips the host before `parseFleetUrl`.

**Rule:** A working `fetch()` does not prove a media element can use a scheme.
Test with the real element.

## 2. `net.fetch(fileUrl)` drops the `Range` header

The `fleet-image` and `fleet-pdf` handlers call `net.fetch(pathToFileURL(...))`, which makes a new request without the incoming headers.
That is fine for an image and useless for a video, which cannot seek without a `206`.
`src/main/media-protocol.ts` reads the range itself and streams with `fs.createReadStream({ start, end })`.
This also covers the WSL UNC share, so there is no whole-file `readFile` branch.

## 3. A focused `<video controls>` handles keys on its own

**What happened:** After a click on the video, Space toggled playback twice, and ArrowUp changed the volume and walked the sidebar at once.
`preventDefault()` in a `window` keydown listener did not stop it.

**Fix:** The video never keeps focus.
Its `onFocus` moves focus to the pane container (`tabIndex={-1}`), so keys reach only Fleet's handlers.
The mouse still works the native controls.

## Also found: `getBasename` never handled Windows paths

`filePath.split('/').pop() || filePath.split('\\').pop()` returns the whole string for a backslash path, because the first `pop()` is truthy.
The image and PDF status bars showed the full path on Windows.
The shared helper in `src/renderer/src/lib/file-display.ts` splits on `/[\\/]/` and has a test.
