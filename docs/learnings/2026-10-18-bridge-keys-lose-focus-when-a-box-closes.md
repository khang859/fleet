# Bridge keys stop working when a box closes

## What happened

The Bridge queue keys (J, K, A, D, C, R) listen on the Bridge root and act only when focus is inside the queue or the reader.
Closing the "What should change?" box, or the permission reason box, removed the focused textarea.
Chromium then moved focus to `<body>`, which is outside both scopes, so every key did nothing until the client clicked a card again.
The same happened when a decision took the focused card out of the queue.

## Fix

`useKeepFocus(ref, fallback)` in `src/renderer/src/components/admiral/use-bridge-queue.ts` listens for a native `focusout` on the queue and on the reader.
Chromium fires `focusout` with `relatedTarget` null when the focused element is removed.
On the next frame, if focus landed on `<body>`, it focuses the fallback: the reader itself, or the queue's current card.
`pressIn` in `queue-keys.ts` also refocuses the card that takes a decided card's place.

## Also

Key hints made the plan reader's footer buttons wider, and the budget text was cut to "$10...".
The footer now wraps the buttons to a line of their own on a narrow reader instead of truncating.
Check every footer and button row again whenever a hint or badge is added to a button.
