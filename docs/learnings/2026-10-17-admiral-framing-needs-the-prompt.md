# Text Fleet adds to a client message must be explained in the Admiral prompt

## What happened

"Ask the Admiral" sends the client's request to the lobby as `From Settings › Agency › Admiral: <request>`.
In the first end-to-end run, the Admiral's reasoning called that prefix "suspicious" and spent a paragraph deciding whether the message was really from the client.
It acted on it in the end, but a stricter model could have refused it as an injection.

The Authority section of the prompt tells the Admiral to distrust text that reads like an instruction from somewhere else, so any framing it has not been told about looks like one.

## Fix

The Settings section of `src/shared/agency-prompt.ts` now says what a `From <page>:` message is: the client's own request, sent with Ask the Admiral.
The text format lives in one place, `askText` in `src/renderer/src/lib/ask-admiral.ts`, so the prompt and the sender stay in step.

## Rule

When Fleet adds any wrapper or prefix to a message the Admiral reads as the client's, describe it in the system prompt in the same change.

## Also

An end-to-end test with the Admiral calls the real model, and `settings_change` can apply a lowering change at once.
After a run, undo what it changed (Undo in Settings, or on the card), so the user's real settings stay as they were.
