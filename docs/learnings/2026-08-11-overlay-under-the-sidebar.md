# A `z-50` modal painted under the sidebar

Date: 2026-08-11
Found while: opening a generated image full size in the Agent pane

## What happened

Opening an image full size dimmed the window and drew the picture over it - and the sidebar's Annotate and Sessions cards sat on top of the picture, undimmed, still clickable.

Every modal in the app goes through `components/Overlay.tsx`, whose backdrop is `fixed inset-0 z-50`.
Fifty is the highest z-index in the codebase. It still lost.

## Why

`z-index` only ranks an element against its siblings inside the nearest stacking context.
The layout puts the panes and the sidebar in one:

```
div.relative.z-10            ← the row that holds sidebar + panes
├─ …  div.relative.z-20      ← a sidebar tool card
└─ div.relative.z-10         ← the pane column
   └─ …  div.fixed.inset-0.z-50   ← the overlay, opened from a pane
```

The overlay's 50 is compared against its siblings *inside* the pane column.
The pane column as a whole is a 10, and the sidebar card is a 20, so the entire pane column - overlay included - is painted first.
No number written inside the pane can win, which is the part that is easy to get wrong: the fix is never a bigger z-index.

## The fix

Render the overlay into `document.body`:

```diff
-  return (
+  return createPortal(
     <div data-state={state} … className="fixed inset-0 z-50 …">
       …
-    </div>
-  );
+    </div>,
+    document.body
+  );
```

Now it is a sibling of `#root` rather than a descendant of a pane, so it is above everything, and all 21 overlays in the app were fixed by the one change.
`Escape` and backdrop-click already worked and still do; React portals bubble events through the React tree, not the DOM tree, so nothing above it noticed.

## The general rule

A modal is a child of the window, whatever it was opened from.
If it is written inline in a pane it inherits that pane's stacking context, and a `fixed inset-0` that covers the viewport geometrically can still be painted under a sibling of its ancestor.
`position: fixed` inside a transformed ancestor is the same trap wearing different clothes - the portal is the answer to both.

To check whether a modal is really on top, ask the browser rather than the screenshot:

```js
document.elementFromPoint(x, y)          // what is actually hit at that point
document.body.lastElementChild            // what the portal put at the end of the body
```
