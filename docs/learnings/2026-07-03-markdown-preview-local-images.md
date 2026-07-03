# Learnings: Local images don't render in the markdown preview (2026-07-03)

## Problem

Opening a `.md` file in the markdown preview pane (`MarkdownPane.tsx`) and referencing a local image with a relative path - `![alt](./foo.png)` or `![alt](images/bar.png)` - showed a broken image. Remote `http(s)` images worked; local ones never loaded.

## Root cause

`MarkdownPane` renders with `react-markdown` and only overrode the `pre` and `a` components. There was **no `img` override and no `urlTransform`**, so a relative `src` was emitted verbatim as `<img src="./foo.png">`. The browser resolves that against the renderer's document base URL (the app bundle - `http://localhost:5173/...` in dev, `file://.../out/renderer/` when packaged), not the markdown file's directory, so it 404s.

Two extra traps:

- **react-markdown v10 removed `transformImageUri`.** The old `transformImageUri` prop no longer exists; the correct mechanism is an `img` component override (or `urlTransform`, but that only receives the URL string, not enough for a clean fleet-image conversion).
- A bare `file://` path is not loadable from the renderer either - the app serves local images through a registered `fleet-image://` protocol.

The odd part: the fix machinery already existed and was used by every other image surface (ImageViewer, ChatImage, Sidebar cards, background thumbnails, file-search) - only the markdown preview never wired it in. The file's directory was even already computed as `baseDir` and used for relative **link** resolution, just not for images.

## Fix

Add an `img` override to `markdownComponents` that resolves local paths against `baseDir` and converts them to the app's local-image protocol via `toFleetImageUrl`, while passing remote/inline URLs through:

```tsx
img: ({ src, alt, ...props }) => {
  const resolvedSrc =
    src && !/^(https?:|data:|fleet-image:)/i.test(src)
      ? toFleetImageUrl(resolve(baseDir, src.replace(/^file:\/\//i, '')))
      : src;
  return <img src={resolvedSrc} alt={alt ?? ''} {...props} />;
}
```

## Takeaways

- When adding a local-image or local-file surface in the renderer, always route through `toFleetImageUrl` / `fleet-image://` (from `shared/path-platform.ts`). Never emit a raw relative or `file://` path.
- CSP is **not** a factor here - the main window sets no CSP, so the only blocker was the unresolved relative URL.
- On react-markdown v10+, transform image/link URLs via component overrides, not the removed `transformImageUri`.
