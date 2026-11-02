# Local UI state outlives the value it was for

## What happened

The workflow agent Model field is a select with an "Other…" entry that opens a text box.
Whether the text box shows lives in local `useState` (`typing`), because picking "Other…" does not change the model value yet.

Switching the agent from Pi to Claude Code cleared the model through `switchProgram`, but the field kept `typing = true`.
The select stayed on "Other…" with an empty text box, instead of going back to "Program default".

Unit tests passed: they cover `switchProgram` and the TOML, not the field's own state.
It only showed when driving the editor with `fleet-drive`: pick Other, type a model, then change the program.

## The fix

Key the field by what its local state belongs to, so React mounts a fresh one when that changes:

```tsx
<ModelField key={program} ... />            // inside ModelFields
<ModelFields key={`${at.stage}:${at.agent}`} ... />  // one per agent in the stage editor
<ModelFields key={picked} ... />             // one per job in Add agent
```

## The lesson

When a component holds UI state that only makes sense for one value or one item, ask what resets it.
If the parent can swap that value or item under it, give the component a `key` for it rather than syncing state in an effect.
