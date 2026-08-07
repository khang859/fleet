# A ResizeObserver that follows the tail steals the reader's place

Date: 2026-08-06
Area: `src/renderer/src/components/agent/AgentThread.tsx`

## What happened

In the agent pane, opening any collapsed tool row ("Read src/...", "Search ...") threw the
transcript to the bottom.
Scroll to the top of a long thread, click one row open, and the view landed at the end of the
conversation instead of on the thing that was just opened.

Measured with fleet-drive: `scrollTop` went `0` to `2096`, finishing 19px from the bottom.

## Why

The transcript follows a streaming reply in two ways.
The obvious one is an effect keyed on the message text.
The second is a `ResizeObserver` on the content element, added because a reply keeps growing after
React is done with it - a code block is highlighted asynchronously and lands taller than the space
that was held for it, which is enough to push the end of an answer below the fold.

That observer only asked whether the content had grown, never who grew it or where the reader was:

```ts
const observer = new ResizeObserver(() => {
  const grown = content.getBoundingClientRect().height;
  if (grown <= height) { height = grown; return; }
  height = grown;
  endRef.current?.scrollIntoView({ block: 'end' });  // always
});
```

Growth is not only the reply arriving.
Opening a disclosure grows the transcript too, and it is local state in `AgentToolRow`, so nothing
about the message data changes - the observer is the only thing that fires, and it reads an
expansion as new content to chase.

## The fix

Follow the tail only for a reader who was already at it.
A ref records whether the container is parked at the end, written **only from real scroll events**,
so when the content grows underneath it still reports where the reader was before it did:

```ts
const atTail = useRef(true);
// onScroll:
atTail.current = el.scrollHeight - el.scrollTop - el.clientHeight <= TAIL_SLACK_PX;
// in the observer, after the height bookkeeping:
if (!atTail.current) return;
```

Someone who scrolled up to open a tool call is asking to look there, not to be taken to the end.
Someone sitting at the bottom watching a reply still gets the late code-block growth followed,
which is the case the observer was written for.

`TAIL_SLACK_PX` is 24: measuring at the very bottom returned a distance of `-0.5`, so an exact
`=== 0` test would have failed on fractional scroll heights.

## Rules of thumb

- A `ResizeObserver` used for "keep up with growing content" needs a second question: was the user
  following in the first place? Height alone cannot tell an arriving reply from a disclosure the
  user just opened.
- Derive "is the user at the bottom" from scroll events, not from inside the resize callback.
  By the time the callback runs the content has already grown, so measuring there answers a
  question about the new layout, not about the reader's intent.
- Reproduce scroll bugs by asserting on `scrollTop` before and after, not by eye. The first time
  this was seen it was misread as "the click did not land".
