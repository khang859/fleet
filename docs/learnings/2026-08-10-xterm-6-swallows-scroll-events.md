# Three things xterm 6 stopped doing for us, none of which threw

Date: 2026-08-10

Upgrading `@xterm/xterm` 5.5 -> 6.0 removed three behaviours the app depended on: it stopped letting scroll events bubble, stopped painting the theme background, and stopped using a native scrollbar.
No errors, no warnings, all 2374 tests green.
Each one is written up below.

## Scroll events no longer bubble

The upgrade left the terminal looking perfect and behaving subtly wrong.
Scrolling worked, output followed, nothing threw, all 2374 tests passed.
But the "Scroll to bottom" button never appeared, and scrolling up in a pane that was still producing output snapped the view straight back to the bottom on the next chunk.
Reading scrollback in a live pane had become impossible.

## Why it happened

Two independent v6 changes, each of which disables one half of the pin/unpin logic in `use-terminal.ts`.

### 1. The viewport no longer scrolls natively

v6 renders the viewport through VS Code's scrollable element (`.xterm-scrollable-element`, with `scrollbar` and `slider` children), which moves content by transform.
`.xterm-viewport` still exists, but its `scrollTop` stays 0 and it never fires a DOM `scroll` event.
The listener Fleet hung off that event to re-pin after macOS trackpad momentum was dead code the moment the version changed.

### 2. The scrollable element calls `stopPropagation()`

This is the one that actually hurt.
Fleet unpins a pane from the bottom in bubble-phase `wheel` and `keydown` listeners on the pane container.
v6 consumes both events before they bubble, so neither listener fires at all:

```
wheelReachedContainer: { capture: 1, bubble: 0 }
keyReachedContainer:   { capture: 3, bubble: 1 }   // only the bare `Shift` keydown got through
```

`pinnedToBottom` therefore stayed `true` while the user was reading scrollback, and `writeToTerm` calls `term.scrollToBottom()` on every flush whenever that flag is set.

## The fix

Register both listeners in the capture phase, and remove them with a matching capture flag, since the flag is part of a listener's identity:

```ts
container.addEventListener('wheel', wheelHandler, { passive: true, capture: true });
container.addEventListener('keydown', keyScrollHandler, true);
// ...
container.removeEventListener('wheel', wheelHandler, { capture: true });
container.removeEventListener('keydown', keyScrollHandler, true);
```

The re-pin that used to come from the `.xterm-viewport` scroll event now comes from `term.onScroll`, which in v6 reports user scrolling as well as content scrolling.
The rule that `onScroll` must never *unpin* still holds: `viewportY` lags `baseY` during fast output, and that lag is not the user scrolling away.

## How it was caught

Only by driving real input.
A synthetic `new WheelEvent(...)` does not move v6's scrollable element at all, and fleet-drive has no wheel verb, so the first two attempts to reproduce produced confidently wrong "all good" results.
What worked was attaching Playwright over the same CDP port as fleet-drive and using `page.mouse.wheel()`, then asserting on something the user would actually notice:

```js
// scroll up, emit more output, and check the view did not move
{ topBefore: "2961", topAfter: "4164", snappedToBottom: true }   // before the fix
{ topBefore: "2961", topAfter: "2961", snappedToBottom: false }  // after
```

## Nothing in v6 paints the theme background

The worst of the three, and the one that looked like a Fleet bug rather than an upgrade bug.
The terminal pane went solid black: the wallpaper behind it disappeared, and a light terminal theme rendered dark text on a dark pane.

`xterm.css` has always carried this, and still does:

```css
.xterm .xterm-viewport {
    /* On OS X this is required in order for the scroll bar to appear fully opaque */
    background-color: #000;
}
```

Through 5.5 it never showed, because the Viewport component rewrote that property from the theme on every refresh, alpha and all.
v6 replaced the component with the scrollable element, which does not touch the background - and nothing else picks the job up.
`.xterm`, `.xterm-viewport`, `.xterm-screen` and `.xterm-rows` are all transparent under v6; the row colour still tracks the theme foreground, so the giveaway is a terminal where the *text* follows the theme and the *background* does not.

So the theme background has to be painted by the app now.
`resolveXtermTheme` already computes it, so `use-terminal` publishes it as a custom property and `index.css` consumes it:

```ts
containerRef.current?.style.setProperty('--fleet-term-bg', theme.background ?? 'transparent');
```

Set it *before* the `if (!term) return` guard: on mount this effect can run before the one that creates the terminal, and its deps would not fire again to correct the miss.

## The scrollbar came with it

Same root cause, cosmetic rather than functional.
Under 5.5 the viewport scrolled natively, so the terminal picked up the global `*::-webkit-scrollbar` rules in `index.css` for free: 6px, teal, rounded.
v6's scrollbar is a DIV, so those rules never touch it, and it defaults to a 14px slider painted in the theme foreground at 20% - the one scroll port in the app that was neither teal nor 6px.

Colour is a supported theme option, so it belongs in `resolveXtermTheme` next to the derived `selectionInactiveBackground`, not in CSS:

```ts
theme.scrollbarSliderBackground = '#2dd4bf33';
theme.scrollbarSliderHoverBackground = '#2dd4bf66';
theme.scrollbarSliderActiveBackground = '#2dd4bf99';
```

xterm regenerates its injected `.slider` stylesheet whenever `term.options.theme` is reassigned, so this survives a live theme switch - verified by switching to Dracula and back.

Width has no option, and the slider's geometry is written inline on every scroll, so CSS must not fight it.
Keep the 14px box as the grab target and paint only 6px of it:

```css
.xterm .xterm-scrollable-element > .scrollbar.vertical > .slider {
  box-sizing: border-box;
  border-left: calc(14px - var(--fleet-scrollbar)) solid transparent;
  background-clip: content-box;
}
```

The `.vertical` in the selector is load-bearing twice over: it scopes the inset to the axis where it means anything, and it outranks xterm's own `.xterm .xterm-scrollable-element > .scrollbar > .slider` rule, whose `background` shorthand would otherwise reset `background-clip` back to `border-box`.

## Lessons

A library upgrade that changes *event propagation* produces no error anywhere.
The listener is still attached, the handler is still correct, it simply never runs.
When upgrading a component that owns input handling, assert that your own handlers fire, not just that the feature looks right.

Synthetic DOM events are not a substitute for trusted input when the library under test does its own event handling.
Both of the fake-input reproductions here returned a clean bill of health for a broken build.

## Related

- `docs/learnings/2026-08-05-fleet-drive-stale-electron-steals-port.md` - hit again on the way to this one. An orphaned Electron held the derived debug port while `session.json` named a different pid, so fleet-drive timed out connecting. The documented `pkill` sequence fixed it.
- xterm 6's addons are published on the `beta` dist-tag only (`addon-webgl@0.20.0-beta`, `addon-fit@0.12.0-beta`), and those betas peer-depend on the beta core `^6.1.0-beta.301`. The 5.x-era stable addons do work against stable 6.0.0, which is the combination Fleet ships.
