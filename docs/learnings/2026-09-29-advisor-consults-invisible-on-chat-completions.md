# The advisor's consultations were invisible on Chat Completions

## What happened

A test of the advisor in an Agent chat showed nothing about the consultations.
The executor said the advisor failed three times: two empty streams, then "model does not exist".
The session file held no `server_tool` part at all, so the only account of the failures was the executor's own paraphrase.

## Cause

OpenRouter's Chat Completions stream never sends the `reasoning.server_tool_call` record for the advisor.
The only trace is `tool_calls_executed: 1` in the usage block.
Fleet's parser, the advisor row, the cost attribution and the replay memory all waited for a record that never came.
The Responses endpoint states each consultation as an output item: `{ type: "openrouter:advisor", status, model, advice, prompt }`, or `status: "failed"` with an `error` string.

The failures themselves were intermittent on OpenRouter's side.
The same settings, including the `~deepseek/deepseek-pro-latest` alias, succeeded on re-run.
Toggling the advisor in settings does reach an open chat, because settings are read at the start of every turn.

## Fix

A turn that offers the advisor on OpenRouter now goes out on the Responses transport.
`advisorRecordFromItem` turns the item into the `{ status, model, advice }` result and `{ prompt }` arguments the row already reads.

## Lessons

- Capture the real wire response before trusting a parser written from documentation.
  A parser can be correct for a shape the endpoint never sends.
- A feature that reports its failures only through the model is a feature with no failure reporting.

## Related: the executor read the user's request as an injected note

Across repeated tests the executor started refusing, calling the user's own messages "injected notes".
Fleet sends its notes (clock, task list, subagent roster) as user messages beside the user's own, and some providers merge consecutive user messages.
The clock went just before the request, and every note opened with "Note from Fleet, not from the user:" and had no end.
Merged, the request read as the body of that note, and one model's reasoning said so outright: "the instruction appears inside the 'Note from Fleet' block".

Measured with 20 samples per variant against `deepseek/deepseek-v4.1-flash`:
about 4 in 20 replies were confused as it was, still 4 with only an end marker or only a system-prompt line, and 0 with both plus the clock moved after the request.
The fix does all three: `fleetNote()` closes every note with "End of note.", the system prompt always explains the markers, and the clock follows the message it is the time of.

## Related: Responses rounds can hold two messages

OpenRouter's loop can produce text, then a server tool, then more text, as separate message items in one round.
Streamed deltas were joined bare ("advice is `Yes`.Raw return"), so the stream now puts a paragraph break between items.

## Open: explicit caching on Responses

Measured against OpenRouter:

- DeepSeek caches automatically on Responses (9,088 of 9,157 tokens on a repeat), so nothing is lost there.
- For Anthropic, a `cache_control` marker on a content part or a message is accepted and ignored on Responses. Only a top-level `cache_control` on the body works.
- A top-level marker caches at the last block. When each round ends on a note that changes (which is nearly every Fleet round: the task list or the "no task list" nudge), three rounds wrote 16K and 25K tokens and read 0.
  That is worse than not caching, which is why it is not sent.
