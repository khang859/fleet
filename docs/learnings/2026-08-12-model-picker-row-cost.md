# The model picker mounted every row it could

## Symptom

Opening the Agent settings' model picker, and picking anything in it, felt sluggish - a visible pause rather than a frame drop.
Scrolling the list stuttered.

## Two different causes, and only one was real

The stutter was not the app.
Three `npm run dev` instances were running at once, sharing one `--user-data-dir` and one remote-debugging port.
They competed for the GPU and raced each other writing `settings.json`, which is also why a setting changed by hand kept reverting.
With exactly one instance running, scrolling measured a median frame of 16.7ms and a p95 of 17ms - clean 60fps, nothing to fix.

**Check for a running dev server before starting one.** A second instance does not fail loudly; it degrades everything and lies about the cause.

## The real cause

The pick latency was real, and it was not new: opening the _coding_ picker - untouched by the image-model work - cost 81ms against the image picker's 41ms.

Both lists were rendered with `filtered.slice(0, 200)`, so the completions picker mounted 200 rows on every open and unmounted them on every close.
A row is a button with a title, a subtitle and a meta line of glyphs, and it measures at about **0.3ms to mount**.
The arithmetic is the whole bug:

| Rows mounted | Time to open |
| ------------ | ------------ |
| 200          | 83ms         |
| 42           | 33ms         |

Five frames of work, every open and every close, for rows nobody had scrolled to.
The `.slice(0, 200)` was not a performance guard - it was the cost.

## Fix

A growing window in `ModelPicker`: mount `PAGE = 24` rows, and add another page whenever a scroll lands within 160px of the bottom.
`shown` resets to one page when the query changes or the popover reopens, because a new set of matches is a new list to walk.

This also **removed** the 200-row cap rather than tightening it, so the lists are now complete: the coding picker pages up to all 278 tool-capable models and the image picker to all 41, instead of silently truncating.

Measured after: coding open 83ms → 32.7ms, image 33.1ms.
Both sit at the measurement floor, since the benchmark waits two animation frames (~33ms) before reading.

## What to watch for

Virtualization was not needed and there is no virtualization library in this repo.
A picker only ever shows about eight rows at a time, so a page of 24 is already three screens of scroll runway - the cheapest correct answer.

Reach for the measurement before the fix.
"Changing the selection is laggy" pointed at the code that had just changed; the picker that had _not_ changed was twice as slow, which is what identified the cost as row-mounting rather than the new list.
