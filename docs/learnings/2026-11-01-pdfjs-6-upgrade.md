# Upgrading pdfjs-dist from 4 to 6: what actually bit

Security upgrade from 4.10.38 to 6.5.438.
The type checks found only part of this. Opening a PDF in the app found the rest.

## The PDF pane failed on a custom scheme before the upgrade

The pane showed "Failed to load PDF" in dev and in a packaged build.
pdfjs 4.10.38 failed in the same way when it loaded the same URL, so the upgrade did not cause it.

`PDFFetchStream` accepts only `http(s)`, so pdf.js uses XHR for any other URL.
Chromium blocks XHR and `fetch` to `fleet-pdf://` from both `http://localhost` and `file://`:

```text
Cross origin requests are only supported for protocol schemes: chrome, chrome-extension, chrome-untrusted, data, http, https.
```

`corsEnabled` plus `Access-Control-Allow-Origin` was not used, because any page in any Electron web content could then read a local PDF.

The pane now reads the file over IPC, not by URL (see the next section for how).
That call also honors `pathContext`, so it works for WSL paths.
The `fleet-pdf` scheme had no other user, so it was removed.

## A large PDF crashed the app when it was read whole

A 377 MB PDF crashed Fleet after 64 s with `OOM error in V8: invalid array length`.
`readBinary` made a base64 string of the whole file, and the pane decoded it again, so the file was in memory 3 to 4 times.

The pane now gives pdf.js a `PDFDataRangeTransport` (`src/renderer/src/lib/pdf-range-transport.ts`).
pdf.js asks for byte ranges, and `file.readRange` reads only those from disk.
Set `disableAutoFetch: true` and `disableStream: true`, or pdf.js reads the rest of the file in the background.
The same file now shows its first page in 0.16 s.

pdf.js keeps each range that it read, so a viewer that goes through every page still holds the file once.
Firefox works the same way.

The transport must ignore a range that arrives after `abort()`, because pdf.js throws on a chunk that it did not ask for.

Each range opens the file again, so the open view has no fixed copy.
A rewrite (a build) or a delete (remote cache eviction) would mix bytes from two versions.
The pane sends the size and change time from `stat` with each read, and `readFileRange` returns null when they changed.
The pane then shows "The file changed on disk." with a Reload button.
`fleet open` on the same file only focuses the open pane, so a "reopen it" message would not help.

## The text layer needs CSS that a type check cannot see

pdf.js 5 and later moved span sizes out of inline styles.
`.textLayer` now needs `--total-scale-factor`, `--scale-round-x` and `--scale-round-y`, and rules that turn `--font-height`, `--scale-x` and `--rotate` into a size.
A short copy of `pdf_viewer.css`, like `pdf-text-layer.css`, must be compared to the new file on each upgrade.

A rotated page also needs the `[data-main-rotation]` rules.
Without them the layer stays unrotated, and selection does not line up with the page.

To check it, compare the rects of `.textLayer` and the canvas, then select the text and look at a screenshot.

## API changes

- `PDFDocumentProxy.destroy()` is gone. Call `destroy()` on the loading task.
- `isEvalSupported` is gone.
- `render()` takes `canvas`. Do not call `getContext` first.
- JPEG 2000, JBIG2 and CMYK need `wasmUrl` and `iccUrl`, so `scripts/copy-pdfjs-assets.mjs` copies `wasm` and `iccs`.

## The Node build works without `@napi-rs/canvas`

An x64 Mac build made on an arm64 runner may not have this optional package.
pdfjs logs a warning, and text extraction still works in an Electron worker thread.
Only rendering needs the package, and Fleet does not render in the main process.

## Checking a packaged build with `fleet open`

`FLEET_DEV=1` gives a packaged app a different sandbox id than the checkout, so `out/main/fleet-cli.mjs` cannot find its socket.
`drive` cannot attach either, because it looks for `http://localhost`.
Use `lsof -a -U -p <pid>` to find the socket, and use Playwright `connectOverCDP` on the debug port.
