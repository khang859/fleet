# Scroll container won't scroll: grid `auto` row, not just flex `min-h-0`

## Symptom

The Sessions details panel (`TranscriptView`) could not scroll vertically for long
transcripts — the content ran off the bottom with no scrollbar. Wide content (long
tool output / paths) also clipped off-screen.

## First (wrong) diagnosis — `min-h-0` alone

I assumed the only issue was the classic flex gotcha: a `flex-1 overflow-y-auto`
child defaults to `min-height: auto` and grows to its content instead of scrolling.
I added `min-h-0` to the scroll container (shipped in v2.62.2). **It did not fix
it.** `min-h-0` lets a flex child shrink relative to *its flex parent* — but the
parent (`TranscriptView`) was itself being given a content-tall height from above.

## Real root cause — the grid track

`SessionsTab` is `grid h-full` with `gridTemplateColumns: '320px 1fr'` and **no
`grid-template-rows`** → a single *implicit `auto` row*. An `auto` (or plain `1fr`)
grid track has an automatic minimum of `min-content`, so it **grows to its content
and overflows the container** when content is tall (`align-content: stretch` only
*adds* free space; it never shrinks a row below its content). So:

1. The auto row expands to the full transcript height (taller than the viewport).
2. `TranscriptView`'s `h-full` resolves to that oversized row.
3. An ancestor (`<main overflow-hidden>`) clips the overflow → no scrollbar.
4. `min-h-0` on the inner container is moot — its parent height is already
   content-tall, so `flex-1` fills it without ever needing to overflow.

Verified with a headless-Electron repro of the exact chain: with the `auto` row the
scroll container's `clientHeight == scrollHeight` (3724px) and `scrollTop` stays 0
*even with `min-h-0` present*; with `minmax(0, 1fr)` the `clientHeight` drops to the
viewport height and it scrolls fully.

## Fix

- `SessionsTab`: add `gridTemplateRows: 'minmax(0, 1fr)'` so the row is capped at the
  container height instead of growing to content. **This is the load-bearing fix.**
- Keep `min-h-0` on the `flex-1` scroll container (necessary once the row is bounded).
- `min-w-0` on the transcript column + `break-words` on text/tool blocks handle the
  horizontal axis (the `1fr` column has the same `min-width: auto` blowout).

## Rule of thumb

`min-height: 0` is for flex children; **`minmax(0, 1fr)` is its grid-track analog.**
When a child of a `grid`/`flex` container "won't scroll" or overflows, an
intermediate track/item with an `auto` minimum is almost always the cause — fix it
at the track (`minmax(0,1fr)`) AND the flex child (`min-h-0`), not just one.
