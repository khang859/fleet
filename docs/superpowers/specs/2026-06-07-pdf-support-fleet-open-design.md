# PDF support for `fleet open`

Date: 2026-06-07
Status: Approved design (pending implementation plan)

## Goal

`fleet open file.pdf` opens the PDF in a Fleet tab, rendered by a bundled
**pdf.js** viewer with Fleet-styled, dark-themed page/zoom controls. Today the
CLI rejects PDFs with `Error: unsupported binary file`.

Success criteria:

- `fleet open /tmp/fleet-test.pdf` opens a PDF tab that renders the page(s).
- `fleet open a.pdf b.png c.ts` opens all three in their correct tab types.
- A restored workspace containing a PDF tab re-renders correctly (no terminal
  spawned in its place).
- `npm run typecheck` and `npm run lint` pass; the existing `file-open` test is
  updated to reflect that `.pdf` is now openable.

## Decision log

**Renderer: bundled pdf.js (`pdfjs-dist`), not Chromium's built-in viewer.**

The original plan — a custom `fleet-pdf://` scheme rendered by Chromium's
built-in PDF viewer in an `<iframe>` — **does not work on this app's Electron
version (39.x, `package.json` declares `^39.2.6`).** Chromium's built-in PDF
viewer is a Chrome *extension* that only activates for `file://` and
`http(s)://` schemes, never custom schemes. The `allowExtensions` protocol
privilege that fixes this shipped only in Electron 40+. Evidence:
electron/electron #24859, #33907, PR #49951.

`fetch`/XHR *do* work through custom schemes, so pdf.js can fetch PDF bytes over
`fleet-pdf://`. pdf.js gives us version-independent rendering, full control of
the UI, and dark theming to match Fleet — at the cost of one dependency and a
bundled worker. Chosen over upgrading Electron (major-version blast radius) and
over the `file://`-in-iframe native viewer (version-flaky, light-themed only).

**Byte transport: `fleet-pdf://` custom scheme, not IPC `readBinary`.**

pdf.js loads the document via `getDocument({ url: 'fleet-pdf://<abs-path>' })`.
A streaming custom scheme avoids pulling the whole file through IPC as base64
and lets pdf.js fetch progressively. (`readBinary` exists but buffers the full
file in renderer memory — worse for large PDFs.)

## Architecture & data flow

```
fleet open x.pdf
  └─ fleet-cli.ts: getPaneTypeForFilePath('x.pdf') -> 'pdf'
       └─ socket "file.open" { path, paneType: 'pdf' }
            └─ socket-server.ts: maps paneType (must accept 'pdf')
                 └─ emits 'file-open' -> main forwards FILE_OPEN_IN_TAB
                      └─ workspace-store.openFileInTab: tab.type/paneType = 'pdf'
                           └─ PaneGrid: paneType 'pdf' -> <PdfViewerPane filePath/>
                                └─ pdf.js getDocument({ url: 'fleet-pdf://'+path })
                                     └─ main protocol.handle('fleet-pdf') -> net.fetch(file://)
```

The Fleet Bridge path (`index.ts`, used by Pi agent extensions) already calls
`getPaneTypeForFilePath` and forwards the result without an independent
whitelist, so it gets PDF support for free once the shared helper changes.

## Changes by file

### Shared type/plumbing

**`src/shared/file-open.ts`**
- Add `const PDF_EXTENSIONS = new Set(['.pdf'])`.
- Add `'pdf'` to the `OpenablePaneType` union.
- `getPaneTypeForFilePath()` returns `'pdf'` for `.pdf` (before the generic
  `'file'` fallback).
- **Remove `.pdf` from `BINARY_BLOCKLIST`** — this is the line that currently
  produces "unsupported binary file".

**`src/shared/types.ts`**
- Add `'pdf'` to `Tab.type` (≈ line 30) and `PaneLeaf.paneType` (≈ line 70).

**`src/shared/ipc-api.ts`**
- Widen `FileOpenInTabPayload.paneType` (≈ line 136) to include `'pdf'`. Both
  IPC senders (socket forward + Fleet Bridge) ship through this type.

### CLI

**`src/main/fleet-cli.ts`**
- Widen the `files` array element type (≈ line 692) from
  `'file' | 'image' | 'markdown'` to include `'pdf'` — otherwise the value
  returned by `getPaneTypeForFilePath` (line 712) fails to assign (compile
  error). No other logic change.
- Update `open` help text (≈ line 447): mention PDF alongside images.

### Main process

**`src/main/socket-server.ts`** (the path `fleet open` actually uses)
- The `file.open` handler (≈ lines 229–230) hard-codes
  `paneType === 'image' ? 'image' : paneType === 'markdown' ? 'markdown' : 'file'`,
  which silently coerces `'pdf'` to `'file'`. **Add a `'pdf'` branch** and widen
  the local type. Without this, `fleet open x.pdf` opens a plaintext editor.

**`src/main/index.ts`**
- Register the scheme alongside the others (≈ line 274). It must be
  **non-standard** (like `fleet-image`, not `fleet-asset`) so absolute POSIX
  paths round-trip through `new URL(...).pathname`:

  ```ts
  { scheme: 'fleet-pdf', privileges: { supportFetchAPI: true, stream: true } }
  ```

  Rationale: a `standard` scheme parses the URL as `host + path`, mangling
  `/Users/...` into `host=users`. `fleet-asset` is `standard` because it
  reassembles a *relative* path under a base dir; `fleet-pdf` serves absolute
  paths, so it must mirror `fleet-image`.

- Add the handler (≈ after line 286). Use `fileURLToPath` (already imported) for
  correct round-tripping of spaces / unicode / `#` / `?` / `%`, and `net.fetch`
  so Content-Type (`application/pdf`) is inferred and the file streams:

  ```ts
  protocol.handle('fleet-pdf', async (request) => {
    const filePath = fileURLToPath(`file://${new URL(request.url).pathname}`)
    if (!filePath.toLowerCase().endsWith('.pdf')) {
      return new Response('Forbidden', { status: 403 })
    }
    return net.fetch(pathToFileURL(filePath).toString())
  })
  ```

  Notes: **no `..` check** — it is meaningless for absolute paths (cargo-culted
  from `fleet-asset`, which has a base dir to escape). The `.pdf` extension
  allowlist is a cheap hardening so a hypothetical renderer-XSS can't repurpose
  the scheme to read arbitrary files; the read surface otherwise already exists
  via `fleet-image`. Import `pathToFileURL` from `node:url`.

### Renderer

**`src/renderer/src/store/workspace-store.ts`**
- Widen the `openFileInTab` signature `paneType` union (≈ line 213) to include
  `'pdf'`.
- In the body (≈ lines 1075–1080), map `paneType === 'pdf'` → tab `type: 'pdf'`.

**`src/renderer/src/components/PaneGrid.tsx`**
- In the leaf dispatch (≈ lines 156–177), add a branch before the terminal
  fallback:
  ```tsx
  if (leaf.node.paneType === 'pdf') {
    return <div key={leaf.id} style={rectStyle(leaf.rect)}>
      <PdfViewerPane filePath={leaf.node.filePath ?? ''} />
    </div>
  }
  ```
  Import `PdfViewerPane`.

**`src/renderer/src/components/Sidebar.tsx`**
- The `isFile` check (≈ line 1250) gates icon + non-terminal treatment; add
  `|| tab.type === 'pdf'`. Give PDF tabs a dedicated icon (lucide `FileText`),
  or let `getFileIcon(basename)` handle the `.pdf` extension.

**`src/renderer/src/App.tsx`**
- The collapsed mini-sidebar icon ternary (≈ line 674) renders a `Terminal`
  icon for unknown types; add a `'pdf'` branch (FileText / `getFileIcon`).
  No change needed to the main content area — `'pdf'` falls through to
  `<PaneGrid>` like `file`/`image`/`markdown`.

### New component

**`src/renderer/src/components/PdfViewerPane.tsx`** — mirrors
`ImageViewerPane.tsx` conventions (props `{ filePath }`, dark status bar with
filename + size, error state).

Behavior:
1. `useEffect` on `filePath`: `window.fleet.file.stat(filePath)` first. If it
   fails or `size === 0`, render the error state ("File not found / unreadable")
   and do **not** load — pdf.js errors are otherwise opaque.
2. Load: `pdfjs.getDocument({ url: \`fleet-pdf://${encodeURI(filePath)}\` }).promise`.
   Build the URL with `encodeURI` (or `pathToFileURL(...).pathname`) — raw
   interpolation breaks on `#`/`?` in filenames.
3. Render the current page to a `<canvas>` (see Worker/render below), with
   HiDPI handling (`devicePixelRatio` outputScale + transform).
4. Controls (Fleet-styled, in the status bar): prev/next page with `1 / N`
   indicator, zoom −/+/fit. Re-render the canvas on page or zoom change; queue
   re-renders so a new render waits for the in-flight `RenderTask` (cancel via
   `renderTask.cancel()` on change/unmount).
5. Cleanup: `page.cleanup()` and `pdfDocument.destroy()` on unmount / filePath
   change to avoid worker leaks.

All loading/error/control/zoom/page motion follows the **Motion & interaction
design** section below — reuse `ToolbarButton`, snap zoom/page, show a
`Loader2` spinner during parse, render errors instantly.

### pdf.js worker & font assets

**Dependency:** add `pdfjs-dist` (latest 4.x).

**Worker (Vite/electron-vite renderer is ESM):**
```ts
import * as pdfjs from 'pdfjs-dist'
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
pdfjs.GlobalWorkerOptions.workerSrc = workerUrl
```
The `?url` suffix lets Vite emit the worker as an asset and hand back its URL —
the standard bundler-safe pattern (avoids hardcoding `node_modules` paths).

**Standard fonts / CMaps:** recent pdf.js renders the 14 base fonts (Helvetica,
etc.) and CJK text only when `standardFontDataUrl` / `cMapUrl` are provided.
Copy `pdfjs-dist/standard_fonts/` and `pdfjs-dist/cmaps/` into the renderer's
served assets (via electron-vite `publicDir` or a small copy step) and pass:
```ts
getDocument({ url, cMapUrl, cMapPacked: true, standardFontDataUrl })
```
The hand-made test PDF uses Helvetica, so this is required for it to render
text — verify with `/tmp/fleet-test.pdf`.

## Motion & interaction design (NN/g + Baymard-grounded)

Guiding principle from the research: this is a **productivity pane next to
terminals/editors — devs value speed, so motion must be functional, never
decorative.** NN/g: *"gratuitous animations distract and annoy"*; response-time
limits are 0.1s (instant) / 1s (flow preserved) / 10s (attention lost). Fleet's
existing viewer conventions already match this (ImageViewerPane snaps zoom, shows
errors instantly), so the rule is **reuse existing primitives, stay 100–250ms,
snap where ImageViewerPane snaps.** Sources: NN/g *Response Time Limits*,
*Animation Duration & Easing*, *The Role of Animation and Motion in UX*,
*Skeleton Screens 101*, *Error-Message Guidelines*, *Empty States*; Baymard
*Making a Slow Site Appear Fast* (secondary).

| Interaction | Behavior | Primitive (file:line) |
|---|---|---|
| Control press/hover (prev/next, zoom −/+/fit) | Feedback <0.1s. Reuse the `ToolbarButton` pattern: `transition-colors hover:bg-white/10 active:scale-[0.97] disabled:active:scale-100`. Auto reduced-motion-safe. | `ImageViewerPane.tsx:304-325` |
| Zoom change | **Snap, no transition** on the canvas (instant feel; a scale tween reads sluggish). Show the level as a persistent `%` in the status bar, click-to-fit. | `ImageViewerPane.tsx:234,258` |
| Page change | **Snap** — render the new page directly, no slide/fade. Research: animated page-turns are distracting on a repeated low-stakes action. Optional nice-to-have: ~150ms ease-out emphasis on the `1 / N` indicator so success registers. | convention |
| Initial document load | **Deviation from ImageViewerPane (which shows nothing):** PDF parse commonly exceeds the 1s flow limit, so show a centered `<Loader2 className="animate-spin" />` + `Loading…` after load begins. Under 1s it'll flash-and-go — acceptable; do **not** fake a skeleton (no known layout to mimic, and no Skeleton component exists). | `EnvSyncModal.tsx:62`, `MarkdownPane.tsx:253` |
| Large-PDF progress (>10s) | *Nice-to-have:* if pdf.js `getDocument(...).onProgress` yields real monotonic progress, show a determinate bar (`transition-all duration-300`). Only with real progress — a stuttery bar makes users "watch the clock" (Baymard). Otherwise keep the spinner. | `UpdatesSection.tsx:111` |
| Error state (missing / invalid PDF) | Shown instantly, centered `text-neutral-400 text-sm`, **no entrance animation** (match ImageViewerPane). Message must be explicit + give a next step; never signal by motion/color alone. | `ImageViewerPane.tsx:216-220` |
| Empty state (pane with no doc) | Designed, not blank — short "No PDF loaded" line. No animation. | NN/g *Empty States* |
| Transient feedback (e.g. "Reached last page") | *Nice-to-have:* `useToastStore().show(msg)` — never build a new notifier. | `store/toast-store.ts` |

**Reduced motion:** handled globally by `index.css:136-149` (neutralizes
`animate-in/out`, `animate-pulse`, `active:scale-*`). Since zoom/page **snap**
(no CSS transition), nothing extra is needed. The loader's `animate-spin` is not
covered by that block; acceptable for v1 (it's a loader, not decorative) — note
it as a known minor gap.

**Skip (decorative):** spring/bounce/overshoot easing, canvas zoom tweens,
directional/page-curl transitions, simultaneous animations, animating status-bar
text. NN/g explicitly warns against these for productivity tools.

### Tests

**`src/shared/__tests__/file-open.test.ts`** — the assertion at ≈ line 22
(`isBinaryBlockedFilePath('/tmp/report.pdf') === true`) will fail. Flip it to
`false` and add `getPaneTypeForFilePath('/tmp/x.pdf') === 'pdf'`.

## Confirmed safe (no change needed)

- Workspace persistence/restore spreads tabs/panes through unchanged; a restored
  `'pdf'` pane routes to the new PaneGrid branch and spawns no PTY.
- Fleet Bridge `file.open` (`index.ts`) forwards `getPaneTypeForFilePath` with no
  independent whitelist — accepts `'pdf'` for free.
- Drag-drop-from-OS is not a supported open path (window globally
  prevent-defaults drops), so no DnD handling is needed.
- No CSP meta tag / `onHeadersReceived` exists, so the custom scheme isn't
  CSP-blocked. `plugins: true` is **not** needed (legacy, unrelated to pdf.js).

## Out of scope (YAGNI)

- Text selection / search inside the PDF, thumbnails sidebar, annotations,
  printing, in-app PDF generation.
- Range-request optimization beyond what pdf.js does by default.
- Retro-fixing the latent `encodeURI` bug in existing `fleet-image://` call
  sites (separate issue; note it but don't expand scope here).
