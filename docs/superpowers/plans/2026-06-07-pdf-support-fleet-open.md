# PDF support for `fleet open` — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `fleet open file.pdf` opens the PDF in a Fleet tab rendered by a bundled pdf.js viewer with Fleet-styled, dark-themed page/zoom controls.

**Architecture:** Thread a new `'pdf'` pane type through the existing file-open chain (shared registry → CLI → socket-server → IPC → workspace-store → PaneGrid), exactly as `'image'`/`'markdown'` already flow. A new `PdfViewerPane` React component fetches PDF bytes over a new non-standard `fleet-pdf://` custom protocol and renders pages to a `<canvas>` with pdf.js. CMap/standard-font assets are copied from `pdfjs-dist` into the renderer's `public/` dir at build time.

**Tech Stack:** Electron 39 + electron-vite + React + TypeScript; `pdfjs-dist@4.10.38` (pinned — see Task 3); xterm/shadcn unchanged.

**Design spec:** `docs/superpowers/specs/2026-06-07-pdf-support-fleet-open-design.md`

---

## File Structure

| File | Action | Responsibility |
|---|---|---|
| `src/shared/file-open.ts` | modify | Add `.pdf` → `'pdf'`; remove `.pdf` from binary blocklist |
| `src/shared/__tests__/file-open.test.ts` | modify | Assert `.pdf` is openable as `'pdf'` |
| `src/shared/types.ts` | modify | Add `'pdf'` to `Tab.type` + `PaneLeaf.paneType` |
| `src/shared/ipc-api.ts` | modify | Add `'pdf'` to `FileOpenInTabPayload` |
| `src/main/fleet-cli.ts` | modify | Widen `files` element type; update `open` help text |
| `src/main/socket-server.ts` | modify | Add `'pdf'` branch in `file.open` coercion |
| `src/main/index.ts` | modify | Register + handle `fleet-pdf://` scheme |
| `src/renderer/src/store/workspace-store.ts` | modify | Map `'pdf'` paneType → tab `type: 'pdf'` |
| `src/renderer/src/components/PaneGrid.tsx` | modify | Route `'pdf'` leaf → `<PdfViewerPane>` |
| `src/renderer/src/components/PdfViewerPane.tsx` | **create** | The pdf.js viewer component |
| `src/renderer/src/lib/file-icons.tsx` | modify | Map `.pdf` → `FileText` icon |
| `src/renderer/src/components/Sidebar.tsx` | modify | Treat `'pdf'` tabs as file tabs |
| `src/renderer/src/App.tsx` | modify | Mini-sidebar icon for `'pdf'` tabs |
| `scripts/copy-pdfjs-assets.mjs` | **create** | Copy cmaps/standard_fonts into `public/` |
| `package.json` | modify | Add dep + `copy:pdfjs` script wiring |
| `.gitignore` | modify | Ignore generated `public/pdfjs/` |
| `electron.vite.config.ts` | none | publicDir default (`src/renderer/public`) already correct |

---

## Task 1: Shared file-open registry (TDD)

**Files:**
- Test: `src/shared/__tests__/file-open.test.ts`
- Modify: `src/shared/file-open.ts`

- [ ] **Step 1: Update the failing test**

In `src/shared/__tests__/file-open.test.ts`, replace the `detects blocked binary files` test (lines 21–24) and add a PDF pane-type assertion. The block currently is:

```ts
  it('detects blocked binary files', () => {
    expect(isBinaryBlockedFilePath('/tmp/report.pdf')).toBe(true);
    expect(isBinaryBlockedFilePath('/tmp/report.txt')).toBe(false);
  });
```

Replace it with:

```ts
  it('returns pdf pane type for pdf files', () => {
    expect(getPaneTypeForFilePath('/tmp/report.pdf')).toBe('pdf');
  });

  it('does not block pdf files (now openable)', () => {
    expect(isBinaryBlockedFilePath('/tmp/report.pdf')).toBe(false);
  });

  it('detects blocked binary files', () => {
    expect(isBinaryBlockedFilePath('/tmp/archive.zip')).toBe(true);
    expect(isBinaryBlockedFilePath('/tmp/report.txt')).toBe(false);
  });
```

- [ ] **Step 2: Run the test, verify it fails**

Run: `npx vitest run src/shared/__tests__/file-open.test.ts`
Expected: FAIL — `returns pdf pane type` gets `'file'`, and `does not block pdf` gets `true`.

- [ ] **Step 3: Implement the registry change**

In `src/shared/file-open.ts`:

1. Add a PDF set after `MARKDOWN_EXTENSIONS` (line 12):

```ts
const PDF_EXTENSIONS = new Set(['.pdf']);
```

2. Remove the `'.pdf',` line from `BINARY_BLOCKLIST` (line 36).

3. Add `'pdf'` to the `OpenablePaneType` union (line 53):

```ts
export type OpenablePaneType = 'file' | 'image' | 'markdown' | 'pdf';
```

4. Add the PDF branch in `getPaneTypeForFilePath` before the `'file'` fallback (after line 64):

```ts
export function getPaneTypeForFilePath(filePath: string): OpenablePaneType {
  const ext = getFileExtension(filePath);
  if (IMAGE_EXTENSIONS.has(ext)) return 'image';
  if (MARKDOWN_EXTENSIONS.has(ext)) return 'markdown';
  if (PDF_EXTENSIONS.has(ext)) return 'pdf';
  return 'file';
}
```

- [ ] **Step 4: Run the test, verify it passes**

Run: `npx vitest run src/shared/__tests__/file-open.test.ts`
Expected: PASS (all assertions green).

- [ ] **Step 5: Commit**

```bash
git add src/shared/file-open.ts src/shared/__tests__/file-open.test.ts
git commit -m "feat(file-open): recognize .pdf as openable 'pdf' pane type"
```

> Note: `npm run typecheck` is intentionally **not** green yet — widening `getPaneTypeForFilePath`'s return surfaces type errors in producers, fixed in Task 2.

---

## Task 2: Thread `'pdf'` through types, IPC, CLI, socket-server, store

This task threads the new literal through every union and producer so `npm run typecheck` is green again. Each step is one file.

**Files:**
- Modify: `src/shared/types.ts`
- Modify: `src/shared/ipc-api.ts`
- Modify: `src/main/socket-server.ts:226-237`
- Modify: `src/main/fleet-cli.ts:692`, `:440-464`
- Modify: `src/renderer/src/store/workspace-store.ts:213`, `:1075-1080`

- [ ] **Step 1: `src/shared/types.ts` — widen both pane-type unions**

Add `'pdf'` to `Tab.type` (the union ending at line 40). After `| 'artifacts';`, the literal `| 'pdf'` is inside the union; final form:

```ts
  type?:
    | 'terminal'
    | 'file'
    | 'image'
    | 'images'
    | 'settings'
    | 'annotate'
    | 'pi'
    | 'markdown'
    | 'kanban'
    | 'artifacts'
    | 'pdf';
```

And add `'pdf'` to `PaneLeaf.paneType` (line 70):

```ts
  paneType?:
    | 'terminal'
    | 'file'
    | 'image'
    | 'images'
    | 'pi'
    | 'markdown'
    | 'kanban'
    | 'artifacts'
    | 'pdf';
```

- [ ] **Step 2: `src/shared/ipc-api.ts:136` — widen the IPC payload**

```ts
export type FileOpenInTabPayload = {
  files: Array<{ path: string; paneType: 'file' | 'image' | 'markdown' | 'pdf'; label: string }>;
};
```

- [ ] **Step 3: `src/main/socket-server.ts:226-237` — add the `'pdf'` branch**

The `file.open` handler currently coerces unknown pane types to `'file'`, silently dropping `'pdf'`. Replace the `payload` block (lines 226–237):

```ts
        const payload = {
          files: files.map((f) => {
            const filePath = typeof f.path === 'string' ? f.path : '';
            const paneType: 'file' | 'image' | 'markdown' | 'pdf' =
              f.paneType === 'image'
                ? 'image'
                : f.paneType === 'markdown'
                  ? 'markdown'
                  : f.paneType === 'pdf'
                    ? 'pdf'
                    : 'file';
            return {
              path: filePath,
              paneType,
              label: filePath.split('/').pop() ?? filePath
            };
          })
        };
```

- [ ] **Step 4: `src/main/fleet-cli.ts:692` — widen the `files` array element type**

```ts
    const files: Array<{ path: string; paneType: 'file' | 'image' | 'markdown' | 'pdf' }> = [];
```

- [ ] **Step 5: `src/main/fleet-cli.ts:440-464` — update `open` help text**

Replace line 447 and line 456 so PDF is documented. New line 447:

```
Supports code files, common image formats (png, jpg, gif, webp, svg), and PDFs.
```

New line 456:

```
            Images open in image viewer tabs; PDFs in a PDF viewer; other files in code tabs.
```

Add a PDF example to the examples block (after line 463 `fleet open ./README.md ...`):

```
fleet open report.pdf
```

- [ ] **Step 6: `src/renderer/src/store/workspace-store.ts` — widen signature + map type**

Widen the `openFileInTab` interface signature (line 213):

```ts
  openFileInTab: (
    files: Array<{ path: string; paneType: 'file' | 'image' | 'markdown' | 'pdf'; label: string }>
  ) => void;
```

Map `'pdf'` to the tab `type` in the body (replace the ternary at lines 1075–1080):

```ts
          type:
            file.paneType === 'image'
              ? 'image'
              : file.paneType === 'markdown'
                ? 'markdown'
                : file.paneType === 'pdf'
                  ? 'pdf'
                  : 'file',
```

(The `PaneLeaf` at line 1063 sets `paneType: file.paneType` directly — now valid since `PaneLeaf.paneType` accepts `'pdf'`.)

- [ ] **Step 7: Verify typecheck passes**

Run: `npm run typecheck`
Expected: PASS (both `typecheck:node` and `typecheck:web`). This confirms the whole producer chain now accepts `'pdf'`.

- [ ] **Step 8: Commit**

```bash
git add src/shared/types.ts src/shared/ipc-api.ts src/main/socket-server.ts src/main/fleet-cli.ts src/renderer/src/store/workspace-store.ts
git commit -m "feat(pdf): thread 'pdf' pane type through types, ipc, cli, socket-server, store"
```

---

## Task 3: Add `pdfjs-dist` dependency + asset copy pipeline

**Files:**
- Modify: `package.json`
- Create: `scripts/copy-pdfjs-assets.mjs`
- Modify: `.gitignore`

> **Version note:** the spec said "latest 4.x". As of implementation, `pdfjs-dist` latest is **6.x**, which changed the render/packaging API. Pin **4.10.38** (last 4.x) so the code below — validated against the 4.x `getDocument`/`page.render({ canvasContext, viewport, transform })` API — is correct. Revisit a v6 upgrade as a separate change.

- [ ] **Step 1: Install the pinned dependency**

Run: `npm install pdfjs-dist@4.10.38 --save-exact`
Expected: `pdfjs-dist` appears in `dependencies` as `"pdfjs-dist": "4.10.38"`.

- [ ] **Step 2: Create the asset-copy script**

Create `scripts/copy-pdfjs-assets.mjs`:

```js
// Copies pdf.js CMap + standard-font assets into the renderer publicDir so the
// bundled viewer can render the 14 base fonts and CJK text. Run on
// install/dev/build. Generated output is gitignored.
import { cpSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const srcDir = join(root, 'node_modules', 'pdfjs-dist');
const destDir = join(root, 'src', 'renderer', 'public', 'pdfjs');

for (const sub of ['cmaps', 'standard_fonts']) {
  const from = join(srcDir, sub);
  const to = join(destDir, sub);
  if (!existsSync(from)) {
    console.error(`[copy-pdfjs-assets] missing ${from} — is pdfjs-dist installed?`);
    process.exit(1);
  }
  mkdirSync(dirname(to), { recursive: true });
  cpSync(from, to, { recursive: true });
  console.log(`[copy-pdfjs-assets] copied ${sub} -> ${to}`);
}
```

- [ ] **Step 3: Wire the script into package.json**

In `package.json` `scripts`:

1. Add a standalone script (place near `build:hook`):

```json
    "copy:pdfjs": "node scripts/copy-pdfjs-assets.mjs",
```

2. Change `predev` from `"npm run rebuild:electron"` to:

```json
    "predev": "npm run rebuild:electron && npm run copy:pdfjs",
```

3. Change `build` from `"npm run typecheck && electron-vite build"` to:

```json
    "build": "npm run copy:pdfjs && npm run typecheck && electron-vite build",
```

4. Append the copy to `postinstall` (so fresh clones get assets). Change the tail of `postinstall` from `... && npm run build:hook || true` to:

```json
    "postinstall": "electron-builder install-app-deps && chmod +x node_modules/node-pty/prebuilds/darwin-*/spawn-helper 2>/dev/null || true && npm run build:hook && npm run copy:pdfjs || true",
```

- [ ] **Step 4: Ignore the generated assets**

Add to `.gitignore` (after the `out` line):

```
src/renderer/public/pdfjs/
```

- [ ] **Step 5: Run the copy and verify**

Run: `npm run copy:pdfjs && ls src/renderer/public/pdfjs/standard_fonts | head && ls src/renderer/public/pdfjs/cmaps | head`
Expected: lists font files (e.g. `FoxitSans.pfb`) and cmap files (e.g. `Adobe-Japan1-0.bcmap`).

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json scripts/copy-pdfjs-assets.mjs .gitignore
git commit -m "build(pdf): add pdfjs-dist@4.10.38 and cmap/font asset copy step"
```

---

## Task 4: Register the `fleet-pdf://` custom protocol (main process)

**Files:**
- Modify: `src/main/index.ts:7` (import), `:274-280` (register), `:282-286` (handle)

- [ ] **Step 1: Import `pathToFileURL`**

`src/main/index.ts:7` currently is `import { fileURLToPath } from 'url';`. Replace with:

```ts
import { fileURLToPath, pathToFileURL } from 'url';
```

- [ ] **Step 2: Register the scheme as privileged**

In the `protocol.registerSchemesAsPrivileged([...])` array (lines 274–280), add the `fleet-pdf` entry alongside `fleet-image` (it must be **non-standard**, like `fleet-image`, so absolute POSIX paths survive `new URL(...).pathname`):

```ts
protocol.registerSchemesAsPrivileged([
  { scheme: 'fleet-image', privileges: { supportFetchAPI: true, stream: true } },
  { scheme: 'fleet-pdf', privileges: { supportFetchAPI: true, stream: true } },
  {
    scheme: 'fleet-asset',
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true }
  }
]);
```

- [ ] **Step 3: Add the protocol handler**

Inside `app.whenReady().then(...)`, immediately after the `fleet-image` handler (after line 286), add:

```ts
  // Serve local PDFs to the bundled pdf.js viewer (fetch works through custom
  // schemes even though Chromium's native PDF viewer does not on Electron 39).
  protocol.handle('fleet-pdf', async (request) => {
    const filePath = fileURLToPath(`file://${new URL(request.url).pathname}`);
    if (!filePath.toLowerCase().endsWith('.pdf')) {
      return new Response('Forbidden', { status: 403 });
    }
    return net.fetch(pathToFileURL(filePath).toString());
  });
```

Notes: no `..` check — meaningless for absolute paths (the read surface already exists via `fleet-image`). The `.pdf` allowlist is cheap hardening. `net.fetch` streams the file and infers `application/pdf`.

- [ ] **Step 4: Verify typecheck passes**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/main/index.ts
git commit -m "feat(pdf): register fleet-pdf:// protocol to stream local PDFs"
```

---

## Task 5: Create the `PdfViewerPane` component

**Files:**
- Create: `src/renderer/src/components/PdfViewerPane.tsx`

- [ ] **Step 1: Write the component**

Create `src/renderer/src/components/PdfViewerPane.tsx` with the full content below. It mirrors `ImageViewerPane.tsx` conventions (props `{ filePath }`, dark status bar, instant error state, local `ToolbarButton`), adds a `Loader2` spinner during parse (justified deviation per the spec's Motion section), snaps zoom/page with no transition, queues renders with cancel, and cleans up the document on unmount.

```tsx
import { useEffect, useRef, useState, useCallback } from 'react';
import { Loader2 } from 'lucide-react';
import * as pdfjs from 'pdfjs-dist';
import type { PDFDocumentProxy, RenderTask } from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

// publicDir assets — absolute URLs resolved against the document so the pdf.js
// worker (which resolves relative URLs against itself) fetches them correctly
// in both dev (base '/') and packaged (base './') builds.
const CMAP_URL = new URL(`${import.meta.env.BASE_URL}pdfjs/cmaps/`, window.location.href).href;
const STANDARD_FONT_DATA_URL = new URL(
  `${import.meta.env.BASE_URL}pdfjs/standard_fonts/`,
  window.location.href
).href;

const MIN_ZOOM = 0.25;
const MAX_ZOOM = 4;
const ZOOM_STEP = 0.25;

function getBasename(filePath: string): string {
  return filePath.split('/').pop() || filePath.split('\\').pop() || filePath;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

type PdfViewerPaneProps = {
  filePath: string;
};

export function PdfViewerPane({ filePath }: PdfViewerPaneProps): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const docRef = useRef<PDFDocumentProxy | null>(null);
  const renderTaskRef = useRef<RenderTask | null>(null);

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [numPages, setNumPages] = useState(0);
  const [pageNum, setPageNum] = useState(1);
  const [zoom, setZoom] = useState(1);
  const [fileSize, setFileSize] = useState<number | null>(null);

  const filename = getBasename(filePath);

  // Load the document (stat first so missing files give a clear error rather
  // than an opaque pdf.js failure).
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setNumPages(0);
    setPageNum(1);
    setZoom(1);
    setFileSize(null);

    const load = async (): Promise<void> => {
      const stat = await window.fleet.file.stat(filePath);
      if (cancelled) return;
      if (!stat.success || !stat.data || stat.data.size === 0) {
        setError('File not found or unreadable');
        setLoading(false);
        return;
      }
      setFileSize(stat.data.size);
      try {
        const task = pdfjs.getDocument({
          url: `fleet-pdf://${encodeURI(filePath)}`,
          cMapUrl: CMAP_URL,
          cMapPacked: true,
          standardFontDataUrl: STANDARD_FONT_DATA_URL
        });
        const doc = await task.promise;
        if (cancelled) {
          void doc.destroy();
          return;
        }
        docRef.current = doc;
        setNumPages(doc.numPages);
        setLoading(false);
      } catch {
        if (cancelled) return;
        setError('Failed to load PDF');
        setLoading(false);
      }
    };
    void load();

    return () => {
      cancelled = true;
      renderTaskRef.current?.cancel();
      renderTaskRef.current = null;
      const doc = docRef.current;
      docRef.current = null;
      if (doc) void doc.destroy();
    };
  }, [filePath]);

  // Render the current page whenever page or zoom changes. Cancels any in-flight
  // render first and snaps to the new page/scale with no transition.
  useEffect(() => {
    const doc = docRef.current;
    const canvas = canvasRef.current;
    if (!doc || !canvas || loading || error) return;
    let cancelled = false;

    const render = async (): Promise<void> => {
      renderTaskRef.current?.cancel();
      const page = await doc.getPage(pageNum);
      if (cancelled) return;
      const viewport = page.getViewport({ scale: zoom });
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      const outputScale = window.devicePixelRatio || 1;
      canvas.width = Math.floor(viewport.width * outputScale);
      canvas.height = Math.floor(viewport.height * outputScale);
      canvas.style.width = `${Math.floor(viewport.width)}px`;
      canvas.style.height = `${Math.floor(viewport.height)}px`;
      const transform = outputScale !== 1 ? [outputScale, 0, 0, outputScale, 0, 0] : undefined;
      const task = page.render({ canvasContext: ctx, viewport, transform });
      renderTaskRef.current = task;
      try {
        await task.promise;
      } catch {
        // Render cancelled (page/zoom changed mid-render) — expected, ignore.
      } finally {
        page.cleanup();
      }
    };
    void render();

    return () => {
      cancelled = true;
    };
  }, [pageNum, zoom, loading, error, numPages]);

  const adjustZoom = useCallback((delta: number) => {
    setZoom((prev) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, prev + delta)));
  }, []);

  const fitToWidth = useCallback(async () => {
    const doc = docRef.current;
    const container = containerRef.current;
    if (!doc || !container) return;
    const page = await doc.getPage(pageNum);
    const vp = page.getViewport({ scale: 1 });
    const avail = container.clientWidth - 32;
    setZoom(Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, avail / vp.width)));
  }, [pageNum]);

  const goPrev = useCallback(() => setPageNum((n) => Math.max(1, n - 1)), []);
  const goNext = useCallback(() => setPageNum((n) => Math.min(numPages, n + 1)), [numPages]);

  const zoomPercent = Math.round(zoom * 100);

  return (
    <div className="flex flex-col h-full w-full bg-neutral-900 select-none">
      {/* Document viewport */}
      <div ref={containerRef} className="flex-1 overflow-auto relative flex justify-center">
        {error && (
          <div className="absolute inset-0 flex items-center justify-center text-neutral-400 text-sm">
            {error}
          </div>
        )}
        {!error && loading && (
          <div className="absolute inset-0 flex items-center justify-center gap-2 text-neutral-400 text-sm">
            <Loader2 className="animate-spin" size={16} />
            Loading…
          </div>
        )}
        {!error && (
          <canvas ref={canvasRef} className="my-4 shadow-lg shadow-black/40 h-fit" />
        )}
      </div>

      {/* Status bar */}
      <div className="flex-shrink-0 flex items-center gap-3 px-3 h-7 bg-neutral-950/80 border-t border-neutral-800 text-xs text-neutral-400">
        <span className="text-neutral-300 truncate max-w-xs">{filename}</span>
        {fileSize !== null && <span className="text-neutral-500">{formatSize(fileSize)}</span>}
        {!error && numPages > 0 && (
          <div className="ml-auto flex items-center gap-0.5">
            <ToolbarButton onClick={goPrev} title="Previous Page" disabled={pageNum <= 1}>
              ‹
            </ToolbarButton>
            <span className="font-mono w-12 text-center text-neutral-400">
              {pageNum} / {numPages}
            </span>
            <ToolbarButton onClick={goNext} title="Next Page" disabled={pageNum >= numPages}>
              ›
            </ToolbarButton>
            <div className="w-px h-3.5 bg-neutral-700 mx-1" />
            <ToolbarButton onClick={() => adjustZoom(-ZOOM_STEP)} title="Zoom Out">
              −
            </ToolbarButton>
            <span className="font-mono w-10 text-center text-neutral-400">{zoomPercent}%</span>
            <ToolbarButton onClick={() => adjustZoom(ZOOM_STEP)} title="Zoom In">
              +
            </ToolbarButton>
            <div className="w-px h-3.5 bg-neutral-700 mx-1" />
            <ToolbarButton onClick={() => void fitToWidth()} title="Fit Width">
              Fit
            </ToolbarButton>
          </div>
        )}
      </div>
    </div>
  );
}

function ToolbarButton({
  children,
  onClick,
  title,
  disabled
}: {
  children: React.ReactNode;
  onClick: () => void;
  title?: string;
  disabled?: boolean;
}): React.JSX.Element {
  return (
    <button
      className="text-neutral-300 hover:text-white text-xs px-1.5 py-0.5 rounded hover:bg-white/10 transition-colors disabled:opacity-50 disabled:pointer-events-none active:scale-[0.97] disabled:active:scale-100"
      onClick={onClick}
      title={title}
      disabled={disabled}
    >
      {children}
    </button>
  );
}
```

- [ ] **Step 2: Verify typecheck passes**

Run: `npm run typecheck`
Expected: PASS. (`?url` import is typed via `vite/client` in `src/renderer/src/env.d.ts`; pdf.js types ship with the package.)

- [ ] **Step 3: Verify lint passes for the new file**

Run: `npx eslint src/renderer/src/components/PdfViewerPane.tsx`
Expected: no errors (no `as` casts, no `any`).

- [ ] **Step 4: Commit**

```bash
git add src/renderer/src/components/PdfViewerPane.tsx
git commit -m "feat(pdf): add PdfViewerPane component (pdf.js canvas renderer)"
```

---

## Task 6: Wire renderer routing + icons

**Files:**
- Modify: `src/renderer/src/components/PaneGrid.tsx:6-8` (import), `:177` (route)
- Modify: `src/renderer/src/lib/file-icons.tsx:36-38`
- Modify: `src/renderer/src/components/Sidebar.tsx:1250`
- Modify: `src/renderer/src/App.tsx:666-684`

- [ ] **Step 1: Route `'pdf'` leaves to `PdfViewerPane` in PaneGrid**

Add the import after line 6 (`import { ImageViewerPane } ...`):

```ts
import { PdfViewerPane } from './PdfViewerPane';
```

In the leaf dispatch, add a branch before the terminal fallback (immediately after the `image` branch closes at line 177):

```tsx
        if (leaf.node.paneType === 'pdf') {
          return (
            <div key={leaf.id} style={rectStyle(leaf.rect)}>
              <PdfViewerPane filePath={leaf.node.filePath ?? ''} />
            </div>
          );
        }
```

- [ ] **Step 2: Add a `.pdf` icon**

In `src/renderer/src/lib/file-icons.tsx`, add to `ICON_MAP` in the "Markup / docs" group (after line 32 `'.rst': FileText,`):

```ts
  '.pdf': FileText,
```

- [ ] **Step 3: Treat `'pdf'` tabs as file tabs in the Sidebar**

`src/renderer/src/components/Sidebar.tsx:1250` — extend `isFile`:

```ts
              const isFile =
                tab.type === 'file' ||
                tab.type === 'image' ||
                tab.type === 'markdown' ||
                tab.type === 'pdf';
```

(The icon branch at line 1278 already calls `getFileIcon(fileBasename, 14)` for non-image file tabs, so the `.pdf` mapping from Step 2 gives PDF tabs a `FileText` icon automatically.)

- [ ] **Step 4: Mini-sidebar icon for `'pdf'` tabs in App.tsx**

`src/renderer/src/App.tsx` — the collapsed mini-sidebar icon ternary (lines 666–684) renders the file icon only for `tab.type === 'file'`. Extend that first condition to also cover `'pdf'` so it uses `getFileIcon` (which now returns `FileText` for `.pdf`):

```tsx
                      {tab.type === 'file' || tab.type === 'pdf' ? (
                        <span className={isActive ? 'text-fleet-text' : 'text-fleet-text-subtle'}>
                          {getFileIcon(
                            collectPaneLeafs(tab.splitRoot)[0]?.filePath?.split('/').pop() ??
                              tab.label,
                            16
                          )}
                        </span>
                      ) : tab.type === 'image' ? (
```

(Leave the rest of the ternary unchanged.)

- [ ] **Step 5: Verify typecheck + lint**

Run: `npm run typecheck && npm run lint`
Expected: typecheck PASS. Lint: no **new** errors introduced by these files (the repo lint baseline is pre-existing-red; confirm none of the touched files newly fail).

- [ ] **Step 6: Commit**

```bash
git add src/renderer/src/components/PaneGrid.tsx src/renderer/src/lib/file-icons.tsx src/renderer/src/components/Sidebar.tsx src/renderer/src/App.tsx
git commit -m "feat(pdf): route pdf panes to PdfViewerPane and add pdf tab icons"
```

---

## Task 7: End-to-end verification

**Files:** none (manual verification + full build).

- [ ] **Step 1: (Re)create the test PDF**

If `/tmp/fleet-test.pdf` no longer exists, recreate it:

```bash
python3 - <<'PY'
pdf = b"""%PDF-1.4
1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj
2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj
3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 300 144]/Resources<</Font<</F1 4 0 R>>>>/Contents 5 0 R>>endobj
4 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj
5 0 obj<</Length 56>>stream
BT /F1 24 Tf 40 80 Td (Fleet Test PDF) Tj ET
endstream endobj
xref
0 6
0000000000 65535 f 
0000000009 00000 n 
0000000052 00000 n 
0000000101 00000 n 
0000000209 00000 n 
0000000276 00000 n 
trailer<</Size 6/Root 1 0 R>>
startxref
382
%%EOF"""
open('/tmp/fleet-test.pdf','wb').write(pdf)
print('wrote /tmp/fleet-test.pdf', len(pdf), 'bytes')
PY
```

- [ ] **Step 2: Full build**

Run: `npm run build`
Expected: `copy:pdfjs` runs, typecheck passes, electron-vite build succeeds with no errors.

- [ ] **Step 3: Launch the app and open the PDF**

Run: `npm run dev` (in a background/separate shell). Once the window is up, in another terminal run:

```bash
fleet open /tmp/fleet-test.pdf
```

Expected:
- A new tab opens with a `FileText` icon labeled `fleet-test.pdf` (NOT a terminal, NOT a plaintext editor).
- The page renders showing the text **"Fleet Test PDF"** (this confirms standard-font assets are wired — Helvetica resolves).
- Status bar shows `fleet-test.pdf`, the file size, `1 / 1`, zoom %, and working −/+/Fit + page buttons.
- Output: `Opened 1 file(s) in Fleet`.

- [ ] **Step 4: Verify multi-file routing**

```bash
fleet open /tmp/fleet-test.pdf src/main/index.ts
```

Expected: two tabs — a PDF viewer and a code editor — each with the correct icon and pane.

- [ ] **Step 5: Verify restore**

Quit and relaunch the app (`npm run dev`). Expected: the persisted PDF tab re-opens and re-renders the page — **no terminal is spawned** in its place.

- [ ] **Step 6: Run the unit tests**

Run: `npm run test`
Expected: `file-open` suite passes (and no regressions elsewhere).

- [ ] **Step 7: Final commit (if any verification fixups were needed)**

```bash
git add -A
git commit -m "test(pdf): verify fleet open renders PDFs end-to-end"
```

(If no fixups were needed, skip — Tasks 1–6 already committed all source changes.)

---

## Self-Review notes (resolved)

- **Spec coverage:** registry (T1), type/IPC/CLI/socket/store threading (T2), dependency + fonts/cmaps assets (T3), `fleet-pdf://` scheme (T4), `PdfViewerPane` incl. motion/loader/error/cleanup/HiDPI/queue-cancel (T5), PaneGrid routing + Sidebar/App/mini-sidebar icons (T6), end-to-end + restore + multi-file (T7). All spec sections map to a task.
- **Version divergence:** spec said "latest 4.x"; pinned `4.10.38` and flagged it (T3 note) because current latest (6.x) changed the API. All component code matches the 4.x API confirmed via Context7.
- **Type consistency:** the union `'file' | 'image' | 'markdown' | 'pdf'` is used identically in `OpenablePaneType`, `FileOpenInTabPayload`, the CLI `files` array, the socket-server local `paneType`, and the store signature. `Tab.type`/`PaneLeaf.paneType` both gain `'pdf'`. Component refs/handlers (`renderTaskRef`, `docRef`, `goPrev`/`goNext`, `adjustZoom`, `fitToWidth`) are defined once and referenced consistently.
- **Asset-URL robustness:** CMap/font URLs are made absolute against `window.location.href` so the pdf.js worker resolves them in both dev (`base: '/'`) and packaged (`base: './'`) builds.
- **No placeholders:** every code/command step shows full content.
