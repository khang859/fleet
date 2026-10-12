# Video backgrounds: what went wrong while building and testing them

## A media fragment reaches the protocol handler as part of the path

Video thumbnails in the slideshow grid use `fleet-media://local/<path>#t=0.1` so Chromium paints a still frame.
They rendered blank, with `DEMUXER_ERROR_COULD_NOT_OPEN` on the element.
For a custom scheme, Electron's `protocol.handle` receives `request.url` with the fragment still attached.
The handler treated `clip.mp4#t=0.1` as the file name, the extension allowlist did not match, and it answered 403.
The fix is in the `fleet-media` handler in `src/main/index.ts`: cut the URL at the first `#` before resolving the path.
This is safe because `buildFleetUrl` percent-encodes every path segment, so a `#` that belongs to a file name arrives as `%23`.
The background layer itself never hit this, because it uses the URL without a fragment.
Only a screenshot of the settings pane showed it, so look at every surface that draws the new thing.

## A deleted video keeps playing until the app restarts

Deleting a stored video and reloading the renderer did not produce an error.
Chromium served the file from its cache, even a 1080p one, and playback carried on.
To test the "file is gone" path, restart the whole app, not just the page.

## The page never reports hidden under the drive tool or in `npm run dev`

Videos pause on `visibilitychange`, and two separate things hid that from testing.
Playwright, which `fleet-drive` attaches with, turns on focus emulation, and a page under focus emulation always reports `visible`.
Kill the drive daemon and read page state through `webContents.executeJavaScript` from the main process instead.
The dev build also creates the window with `backgroundThrottling: !IS_FLEET_DEV`, and with throttling off a minimized window still reports `visible`.
So in `npm run dev` a video background keeps playing while minimized, and in a packaged build it pauses.
To test the packaged behaviour in dev, call `win.webContents.setBackgroundThrottling(true)` from the main process.

## Reaching the main process of a running dev app

Electron does not support CDP's `Browser.getWindowForTarget`, and there is no `xdotool` on Wayland, so the window cannot be minimized from outside.
Sending `SIGUSR1` to the Electron main process opens the Node inspector on `127.0.0.1:9229`.
The main process is ESM, so `require` is not defined there.
Use `process.getBuiltinModule('module').createRequire(...)('electron')` to get `BrowserWindow` and `app`.

## The dev app shares the real settings and background store

`npm run dev` reads `~/.config/Fleet` and `~/.fleet/backgrounds`, the same ones the installed Fleet uses.
Every background settings write prunes unreferenced files from the store, so experimenting there can delete the user's real wallpaper.
Run the dev app under a throwaway `HOME` when testing anything that writes settings or the store.
Keep that `HOME` path short, or symlink to it from a short path.
A long one overflows the unix socket path limit, and the app comes up blank with `EADDRINUSE`.

## Pruning must not race a copy that is still in flight

A video copy can take seconds, and the store is pruned on every settings write, including each tick of a slider.
A freshly copied file is not referenced by settings until the copy finishes and the setting is saved, so the sweep would delete it.
`pruneBackgroundStore` now leaves alone anything modified in the last ten minutes.
Re-picking a file that is already stored bumps its mtime for the same reason.

## A crossfade to a video cannot run on a clock

An image can be decoded before it is shown, but a video's first frame arrives when it arrives.
Starting both fades on a timer faded in an empty layer while the old background faded out, and the wallpaper dipped to the bare theme colour.
The layer now mounts the new background unseen, keeps the old one untouched until the video fires `loadeddata`, and only then crosses them.
That logic is the pure reducer in `src/renderer/src/lib/background-stack.ts`.

## Removing a `<video>` from the page does not free its decoder

An element taken out of the DOM is only paused, and its player lives until garbage collection.
Call `removeAttribute('src')` then `load()` to let go of it straight away.
Set `src` in an effect rather than as a prop so the same effect owns the release, which also keeps StrictMode's double mount honest.

## GIFs cost nothing worth pausing for

A 1080p 30 fps GIF measured 2 to 5 clock ticks of renderer plus GPU time over 8 seconds, visible or minimized.
An H.264 1080p video read 0.37 on the renderer's `percentCPUUsage` from `app.getAppMetrics()` while visible and 0 while hidden.
So only video needs the pause, and a GIF needs no freeze-frame handling.

## A video can load with no picture

An HEVC file with an AAC track fires `loadeddata` on a Chromium build without HEVC, with `videoWidth` 0, because the audio opens fine.
Treating `loadeddata` alone as "ready" would crossfade to an empty layer with no toast.
Both the pick-time probe (`canPlayVideo`) and the layer (`BackgroundVideo`) check `videoWidth > 0`.
Folder slideshows are the case that matters, since their files are never probed at pick time.

## A long thumbnail grid can use up the page's media players

Chromium allows a page a limited number of media players.
One `<video preload="metadata">` per tile in the slideshow grid would take a player per file for as long as Settings is open.
`VideoThumb` in `BackgroundThumbnails.tsx` mounts its video only while the tile is on screen, and releases it when it leaves.
