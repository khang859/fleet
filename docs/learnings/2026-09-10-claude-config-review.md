# Claude Config review findings (PR #576)

Reviewed commit `18553a15ec46ff2ddad5d3f5e87f8597e61379e9`. These are verified review findings; implementation fixes are pending.

- **Blank map rows disappear:** the Environment and Enabled plugins Add handlers create an empty key, then their commit helper removes empty keys. Both actual handlers produce `undefined` for an empty map. Correction: keep row drafts separately until their keys are ready to commit.
- **Undo crosses file boundaries:** one CodeMirror history is reused when changing paths, and loading the next file is an undoable replacement. A state/history reproduction restores the User document into the Project draft. Correction: isolate editor history by document and exclude programmatic loads from user history. Reference: https://codemirror.net/docs/ref/#state.Transaction.addToHistory
- **In-flight reads erase edits:** the store checks dirty state before awaiting IPC but unconditionally replaces text afterward. A deferred-read test failed because the new draft was replaced by the old disk text. Correction: guard completion with a document/edit generation and preserve intervening edits.

The existing 202 tests in the 11 targeted config suites, typecheck, and lint pass. The additional load-race reproduction was temporary and is retained at `/private/tmp/fleet-pr576-load-repro.test.ts`; it is not part of the product test suite.

## Fixes and how they were verified (2026-09-10)

All three findings are fixed on `feat/claude-config-editor`.

- **Blank map rows:** `KeyValueList` now holds its own row list, extracted as a pure model in `src/renderer/src/lib/claude-key-value-rows.ts` with 10 unit tests.
Only named rows are committed, so an empty row no longer marks the file dirty.
Verified live: Name inputs went 7 to 8 on Add, `dirty` stayed false until the row was named.
- **Undo crossing files:** the editor creation effect now depends on `[edit, path]`, so each document gets its own `EditorView` and its own `history()`.
Programmatic loads carry `Transaction.addToHistory.of(false)`.
Verified live in both directions: with the fix, three undos after a scope switch changed nothing; with the deps reverted to `[edit]`, the Project local draft became the User file's 3647 characters of private `env` values.
- **In-flight reads:** `load()` captures the text at request time and defers to the newer draft unless the caller forced a reload.
Two deferred-read tests were added to the store suite.

## Two fleet-drive traps that made the undo bug look unreproducible

`npm run drive -- type` and `keys` report success but change nothing in CodeMirror unless the editor is focused first.
Click `.cm-content` before sending any key, or the keystrokes go to the document body and are silently dropped.

A `text=` selector matches the smallest element containing the string, which is often body prose rather than the control.
`text=Project local` matched the intro sentence "Project local overrides Shared project...", so the scope never switched and the test measured the wrong file.
Use `role=button[name="..."]` with the button's full accessible name instead.
