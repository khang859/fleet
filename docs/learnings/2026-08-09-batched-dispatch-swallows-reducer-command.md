# A command produced by a reducer is lost when two actions share a render

Voice dictation's keyboard routes - `Cmd+Shift+V` and Space/Enter on the focused mic button - never started a recording, and worse, they left the mic button permanently disabled with "Waiting for the microphone…" until the composer was unmounted by a tab switch.
The pointer route worked perfectly, which is what made it look like a keyboard-event problem rather than a state problem.

## What was actually happening

`use-voice-dictation` pairs a reducer state with the side effect that state asks for:

```ts
type Store = { state: VoiceState; command: VoiceCommand };
```

and an effect keyed on `store.command` performs it - `request` calls `getUserMedia`, `stop` stops the recorder.

The keyboard routes emulated a tap by sending both halves of a press:

```ts
voice.pressDown();
voice.pressUp();
```

React batches both dispatches into one render.
The reducer runs twice, but only the *final* store is committed: `press-down` produced `{kind: 'request'}`, then `press-up` on the now-`requesting` state produced `{kind: 'none'}` and overwrote it.
The effect never saw `request`, so nothing ever asked for the microphone, and the machine sat in `requesting` forever - a phase that renders the button `disabled`, so it could not even be clicked back to life.

The pointer path escaped this only by accident of timing: `pointerdown` and `pointerup` are separate events in separate renders, so each command got its own commit.

## The fix

A tap that happens in one keystroke has to be one action, not two:

```ts
| { kind: 'toggle' }
```

`toggle` goes idle/error/denied → `requesting` with `command: 'request'`, and `recording` → `transcribing` with `command: 'stop'`.
Both keyboard routes dispatch it, and neither command can be overwritten by a sibling in the same batch.

## The rule

**When a reducer's state carries a side effect for an effect to perform, that effect only ever sees the last value of a batch.**
Any two dispatches in the same event handler will silently drop the first one's command.
Either model the whole interaction as a single action, or give commands identity (a queue, or an incrementing id the effect drains) so none can be swallowed.

The unit tests missed it because they drive the reducer one transition at a time, which is exactly the sequencing the real batch does not give you.
`voice-intent.test.ts` now covers `toggle` end to end for that reason.

## A second one found alongside it

`disabled` on a button pulls focus off it.
`requesting` is a phase the mic button *passes through*, so a keyboard user who pressed Space to start lost the button before they could press Space again to stop.
`aria-disabled` plus `pointer-events-none` keeps the control inert without stealing focus - the state machine already ignores presses in those phases.
