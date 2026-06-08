# 2026-06-08: Web typecheck can fail when `pdfjs-dist` is missing from `node_modules`

## What happened

While validating a focused renderer change with `npm run typecheck:web`, TypeScript failed before checking the changed area:

```text
src/renderer/src/components/PdfViewerPane.tsx(3,24): error TS2307: Cannot find module 'pdfjs-dist' or its corresponding type declarations.
src/renderer/src/components/PdfViewerPane.tsx(4,51): error TS2307: Cannot find module 'pdfjs-dist' or its corresponding type declarations.
```

`package.json` lists `pdfjs-dist`, but `node_modules/pdfjs-dist` was absent in the local checkout.

## Fix / workaround

Refresh dependencies before relying on the full web typecheck:

```bash
npm install
# or, if the lockfile should be enforced:
npm ci
```

Then rerun:

```bash
npm run typecheck:web
```

For small renderer-only edits, a targeted ESLint run on the changed file can still catch syntax/style issues while dependency installation is fixed.
