# CodeMirror legacy modes can tokenize without coloring

## What happened

`.env` files got the `properties` legacy mode in `FileEditorPane`, but keys and values both rendered in the plain text color.
The mode names keys `def` and values `quote`.
`StreamLanguage` maps `def` to `variableName.definition`, which One Dark paints the same ivory as plain text.
`quote` maps to `tags.quote`, which One Dark does not style at all.

## Wrong fix

Passing `tokenTable: { def: tags.propertyName, quote: tags.string }` to `StreamLanguage.define` fixed `quote` but not `def`.
`TokenTable.resolve` checks its built-in table first, so `tokenTable` only fills names that have no default meaning.

## Fix

Wrap the mode's `token` function and rename the styles before CodeMirror sees them (`keyValueToken` in `FileEditorPane.tsx`).
Style names like `propertyName` and `string` resolve straight to `@lezer/highlight` tags, so no extra dependency is needed.

## Takeaway

When adding a legacy mode, open a sample file in the dev app and check each token kind has a visible color in One Dark.
A mode that loads without errors can still look like plain text.
