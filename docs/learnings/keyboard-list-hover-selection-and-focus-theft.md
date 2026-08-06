# Keyboard lists: hover selection scroll-jumps, and clicks that steal the keyboard

Two bugs that travel together in any "search field on top, keyboard-navigable list below" component.
The Agent folder dialog had both; the ⌘K palette and any future picker can grow them the same way.

## 1. Hover-to-select + scrollIntoView is a feedback loop

The shape that causes it:

```tsx
<Row onMouseEnter={() => setSelectedIndex(index)} />
// ...
useEffect(() => {
  listRef.current?.querySelector(`[data-index="${selectedIndex}"]`)?.scrollIntoView({ block: 'nearest' });
}, [selectedIndex]);
```

Hovering a row that is clipped at the top or bottom edge of the scroller selects it, which scrolls it
into view, which slides different content under a cursor that never moved.
Measured in the live app: resting the pointer on a partly visible bottom row moved `scrollTop` from 30 to 37 unprompted.
It reads as stutter or jitter rather than as a scroll, because nothing the user did asked for it.

`block: 'nearest'` keeps it from spinning forever - the row lands flush against the edge and settles -
so it never looks like a hang, only like the list is fighting you.

There is a second cost with no visual tell: hover-selection silently retargets the confirm button.
Arrow-key to a folder, then move the mouse toward "Open Agent", and crossing the list on the way changes what that button does.

**The fix is to stop hover from selecting at all**, not to suppress the scroll.
Hover gets a background tint (what am I about to click); selection moves only on click and arrow keys.
Once mouse movement cannot change `selectedIndex`, the `scrollIntoView` effect only ever runs for
keyboard navigation, where scrolling the cursor into view is exactly right - so the effect needs no
modality flag and no change at all.

## 2. A click on a row takes the keyboard with it, silently

Rows are `<button>`s. Chromium focuses a button on mousedown. If the keydown handler lives on the
search `<input>`, then one click anywhere in the list moves focus off the input and **every binding
dies at once** - arrows, Enter, and whatever key goes up a level:

```
after clicking a folder row → document.activeElement = BUTTON "Desktop"
ArrowDown / ArrowLeft / Backspace / Enter → nothing happens
```

Nothing on screen says why, and the only recovery is clicking back into the search field, which no
user thinks to do. It presents as "the dialog is broken" or "I can't go back up a folder".

Two changes, both needed:

- `onMouseDown={(e) => e.preventDefault()}` on every clickable thing inside the panel that does not
  close it - rows, per-row buttons, breadcrumb segments. The click still fires; focus never leaves
  the search field, so typing keeps working after a click too.
- Bind `onKeyDown` to a wrapper `<div>` around the whole panel instead of to the input. Keydown from
  the focused input bubbles to it, so it works either way, and no future focusable child can quietly
  break navigation again.

## 3. Related: a listing inherits the previous folder's scroll offset

Changing the directory re-renders the list but does not reset `scrollTop`, so drilling into a folder
drops the user partway down a listing they have not seen, with the group headings scrolled off above.
Measured at `scrollTop: 32` right after entering a folder. Reset it explicitly in a `useLayoutEffect`
keyed on the directory - do not rely on the browser clamping it when the content happens to be shorter.

## Verifying this class of bug

`scrollIntoView` and focus theft are both invisible in unit tests and in screenshots. Drive the real
window (`npm run drive`) and measure:

```
npm run drive -- eval '(async () => {
  const before = list.scrollTop;
  row.dispatchEvent(new MouseEvent("mouseover", {bubbles:true, clientX:x, clientY:y}));
  await new Promise(r => setTimeout(r, 200));
  return { before, after: list.scrollTop, under: document.elementFromPoint(x, y)?.dataset.index };
})()'
```

One caveat that cost time: **synthetic `KeyboardEvent`s dispatched from `eval` do not reliably reach
React handlers**, while synthetic `MouseEvent`s and `.click()` do. Arrow keys appeared dead when the
component was fine. Use `npm run drive -- keys 'ArrowDown'` (a real Playwright key press) for
anything keyboard-related, and keep `eval` for mouse and for reading state.
