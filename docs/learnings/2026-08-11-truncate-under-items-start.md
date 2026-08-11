# `truncate` does nothing under `items-start`

Date: 2026-08-11
Found while: fixing a long image prompt running off the side of the Agent pane

## What happened

An `image` tool row puts the whole prompt in its target slot.
With a real prompt - a few hundred characters of scene description - the row ran off the right edge of the pane and kept going, and the transcript grew a horizontal scrollbar.

Measured in the live window with `fleet-drive`:

```
column width      672
tool row width   4068
truncate span    3954
transcript       scrollWidth 4207 vs clientWidth 893
```

The row carried `truncate` the whole time.
It never truncated.

## Why

`truncate` is `overflow: hidden; text-overflow: ellipsis; white-space: nowrap`.
The `nowrap` is the problem: it makes the span's **min-content width the entire string**, because there is no longer anywhere to break it.

The turn container in `AgentThread.tsx` is:

```
flex w-fit max-w-full flex-col items-start gap-2
```

`items-start` is `align-items: flex-start`, which means every child is sized in the cross axis by shrink-to-fit:

```
min(max-content, max(min-content, available))
```

With a min-content of 3954px and only 672px available, the `max()` picks min-content and the row resolves to ~4000px wide.
The container is capped by `max-w-full`, the row is not, so the row walks straight out of it.

And a box that is never narrower than its text has nothing to trim - which is why the ellipsis never appeared.
`truncate` only does something once an ancestor forces the box to be smaller than the text.

## The fix

One class on the turn container:

```diff
-  className="flex w-fit max-w-full flex-col items-start gap-2 rounded-xl"
+  className="flex w-fit max-w-full flex-col items-start gap-2 rounded-xl [&>*]:max-w-full"
```

Row 4068px to 616px, transcript `scrollWidth === clientWidth`, ellipsis appears.

It goes on the container rather than on each row deliberately.
`items-start` is the thing that breaks the cap, so the cap belongs beside it - otherwise every row type added later has to remember to defend itself, and `AgentToolRow`, `AgentToolGroup`, `AgentTaskCard` and `AgentPermissionRow` had all already forgotten.

## The general rule

**`truncate` is a request, not a guarantee.** It needs an ancestor that bounds the width.
The two things that quietly remove that bound:

- `items-start` / `items-end` / `align-self` anything but `stretch` in a column flex container - the child is now content-sized, not container-sized
- a missing `min-w-0` on a flex item in a **row** flex container - the more familiar version of the same trap

If a row is meant to truncate, measure it.
`e.scrollWidth > e.clientWidth` on the truncating span is the one-line check for whether the ellipsis is actually engaging, and `sc.scrollWidth - sc.clientWidth` on the scroll port says whether anything escaped.
See `2026-08-08-measuring-transcript-scroll-with-fleet-drive.md` for driving that from outside the app.

## What was assumed and was wrong

`transcript-row-layout.md` ends with "The target keeps `truncate`, so a long path still absorbs the width and the summary stays visible."
That was the assumption, and it held for paths only because paths are short.
Nothing about the layout was ever actually doing it.
