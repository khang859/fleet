# Pane rename died instantly because xterm stole focus back

## What happened

Double-clicking a terminal pane's title bar appeared to do nothing.
The rename field never stayed on screen, so the pane could not be renamed by mouse.

Three diagnoses were wrong before the real one:

1. "The toolbar covers the bar." It did reserve layout width it should not have, but it was never on top of the title.
2. "The active-pane ring covers the bar." `box-shadow` cannot capture pointer events; probing 30 points across the bar showed the header was topmost at every one.
3. "The double-click handler is on too small a target." True and worth fixing, but not the cause.

## The actual cause

`TerminalPane`'s container has `onClick={() => { onFocus(); focus(); }}`, where `focus()` puts the caret in xterm.
Header clicks bubble to that container.

So the sequence was:

- `dblclick` opens the rename `<input>` and an effect focuses it.
- The next click - the trailing click of the double-click, or the user clicking into the field to type - bubbles to the container.
- `focus()` runs, `xterm-helper-textarea` takes focus, the input blurs.
- `onBlur` calls `commitRename()`, which sets `isEditing` false and the field disappears.

The field really did open every single time.
It was destroyed a few milliseconds later, which reads as "nothing happened".

## The fix

`PaneHeader` swallows bubbling clicks while `isEditing`:

```tsx
const handleClick = useCallback(
  (e: React.MouseEvent) => {
    if (isEditing) e.stopPropagation();
  },
  [isEditing]
);
```

Bubble phase, not capture, so the input still receives the click and can place the caret.
Guarding on `isEditing` keeps click-to-focus-the-terminal working the rest of the time.

## How it was found

Nothing in the DOM explained it, and driving the window over CDP could not reproduce it, because the CDP `dblclick` produced no trailing third click.

What found it was recording real events from the user's own hand.
A capture-phase listener on `document` for `mousedown`/`click`/`dblclick`/`focusin`, pushing to `window.__RLOG`, installed with `npm run drive -- eval` and read back after the user tried the gesture:

```
dblclick | 363,53 | SPAN  | inHeader=true | detail=2
focusin  |         INPUT  | inHeader=true          <- opens
mousedown| 363,53 | INPUT | detail=3
click    | 363,53 | INPUT | detail=3
focusin  |      TEXTAREA  | xterm-helper-textarea  <- stolen
```

`focusin` is the load-bearing one.
Any "my click does nothing" bug in this app should log `focusin` before anything else, because a stolen focus and an ignored click look identical from the outside.

## The other trap in the same session

The user was clicking `/Applications/Fleet.app` (v2.97.1), not the `npm run dev` window, for several rounds of back-and-forth.
Both windows are titled "Fleet" and look nearly identical.

Check it before debugging anything the user reports about a UI change:

```bash
osascript -e 'tell application "System Events" to set p to first application process whose frontmost is true' \
          -e 'tell application "System Events" to return (name of p) & " | pid " & (unix id of p)'
```

The dev window's process name is `Electron`; the installed app's is `Fleet`.
An empty `window.__RLOG` after the user says they clicked is the same signal.
