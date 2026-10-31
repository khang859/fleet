# A debounced input loses its last edit when it unmounts

The Custom Agent Command field in Settings saves through `useDebouncedCallback`.
That hook clears its timer on unmount, so a pending save is dropped, not flushed.

## What happened

The field shows only while Default Agent is Custom.
Typing a command and switching Default Agent within 300 ms removed the field, and the text was never saved.
A review found this, and the dev app reproduced it: `customAgentCommand` stayed empty after the switch.

## The fix

Save on `onBlur` as well as on the debounced change.
The field loses focus before it unmounts, so the last text is saved.
After the fix, the same steps in the dev app kept the text.

## The rule

Any debounced field that can unmount needs a save on blur.
Check this first for fields that another control can hide.

## Related: focus in a cmdk list with no input

Radix moves focus to `Popover.Content` when a popover opens.
A cmdk list with no search input then gets no arrow keys.
Use `onOpenAutoFocus` to call `preventDefault()` and focus the `Command` root.
