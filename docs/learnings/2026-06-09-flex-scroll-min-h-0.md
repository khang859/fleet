# Flex child won't scroll without `min-h-0`

## Symptom

The Sessions details panel (`TranscriptView`) could not scroll vertically for long
transcripts — the content just ran off the bottom with no scrollbar. Wide content
(long tool output / paths) also clipped off-screen with no horizontal scroll.

## Cause

The scroll container was `flex-1 overflow-y-auto` inside a `flex flex-col` parent:

```tsx
<div className="flex h-full flex-col">
  <header .../>
  <div className="flex-1 overflow-y-auto ...">{messages}</div>  // ❌ never scrolls
</div>
```

A flex item defaults to `min-height: auto`, which prevents it from shrinking below
its content's intrinsic height. So `flex-1` grows to fit ALL content instead of
being capped at the available space, and `overflow-y-auto` never has anything to
clip → no scrollbar. The overflowing content is then clipped by an ancestor
`overflow-hidden`, so it's invisible AND unscrollable.

Separately, the `1fr` grid track in `SessionsTab` (`320px 1fr`) defaults to
`min-width: auto`, so very wide content blew the track past the viewport.

## Fix

- Add `min-h-0` to the `flex-1` scroll container so it can shrink and actually scroll.
- Add `min-w-0` to the transcript column root so the `1fr` grid track stays bounded.
- Add `break-words` (alongside `whitespace-pre-wrap`) on text/tool blocks so long
  unbreakable tokens wrap instead of forcing horizontal overflow.

## Rule of thumb

Any `flex-1 overflow-y-auto` (or `overflow-auto`) child of a flex container needs
`min-h-0` (or `min-w-0` for horizontal). This is already the established pattern in
`Sidebar.tsx` and `MarkdownPane.tsx`. When a scroll container "doesn't scroll,"
check for the missing `min-h-0`/`min-w-0` first.
